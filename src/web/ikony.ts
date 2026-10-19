// Ikony webu generované ze znaku obce (nahraného ve správě webu): favicon 16/32 PNG + /favicon.ico (ICO s PNG
// uvnitř), apple-touch-icon 180, ikony do manifestu 192/512. Znak se vycentruje do čtverce s průhledným
// okrajem; bez znaku se použije výchozí ikona platformy (public/favicon.svg). Výsledky se drží v paměti.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';

export const VELIKOSTI_IKON = [16, 32, 180, 192, 512] as const;

/** ICO soubor s PNG obrázky (Windows Vista+ a všechny prohlížeče PNG v ICO umí) */
export function sestavIco(obrazky: { velikost: number; png: Buffer }[]): Buffer {
  const hlavicka = Buffer.alloc(6);
  hlavicka.writeUInt16LE(0, 0);
  hlavicka.writeUInt16LE(1, 2);
  hlavicka.writeUInt16LE(obrazky.length, 4);
  const adresar = Buffer.alloc(16 * obrazky.length);
  let posun = 6 + adresar.length;
  obrazky.forEach((o, i) => {
    const b = i * 16;
    adresar.writeUInt8(o.velikost >= 256 ? 0 : o.velikost, b);
    adresar.writeUInt8(o.velikost >= 256 ? 0 : o.velikost, b + 1);
    adresar.writeUInt8(0, b + 2);
    adresar.writeUInt8(0, b + 3);
    adresar.writeUInt16LE(1, b + 4);
    adresar.writeUInt16LE(32, b + 6);
    adresar.writeUInt32LE(o.png.length, b + 8);
    adresar.writeUInt32LE(posun, b + 12);
    posun += o.png.length;
  });
  return Buffer.concat([hlavicka, adresar, ...obrazky.map((o) => o.png)]);
}

export default async function ikonyRoutes(app: FastifyInstance) {
  const vychozi = path.resolve(import.meta.dirname, '..', '..', 'public', 'favicon.svg');
  const kes = new Map<string, Buffer>();

  async function zdroj(): Promise<{ klic: string; data: Buffer }> {
    const v = app.hasDecorator('web') ? await app.web.vzhled.nacti() : null;
    if (v?.znakId) {
      try {
        return { klic: v.znakId, data: await fs.readFile(app.soubory.cesta(v.znakId)) };
      } catch {
        /* soubor chybí → výchozí */
      }
    }
    return { klic: 'vychozi', data: await fs.readFile(vychozi) };
  }

  async function png(velikost: number): Promise<Buffer> {
    const z = await zdroj();
    const klic = `${z.klic}:${velikost}`;
    if (!kes.has(klic)) {
      // malé ikony bez okraje (víc detailu), velké s 6% okrajem (iOS/Android je zakulatí)
      const okraj = velikost >= 180 ? Math.round(velikost * 0.06) : 0;
      const vnitrni = velikost - 2 * okraj;
      const obr = await sharp(z.data, { density: 384 })
        .resize(vnitrni, vnitrni, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extend({
          top: okraj,
          bottom: okraj,
          left: okraj,
          right: okraj,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
      if (kes.size > 40) kes.clear();
      kes.set(klic, obr);
    }
    return kes.get(klic)!;
  }

  for (const v of VELIKOSTI_IKON) {
    app.get(`/ikona-${v}.png`, async (_req, reply) =>
      reply
        .type('image/png')
        .header('cache-control', 'public, max-age=86400')
        .send(await png(v)),
    );
  }
  app.get('/apple-touch-icon.png', async (_req, reply) =>
    reply
      .type('image/png')
      .header('cache-control', 'public, max-age=86400')
      .send(await png(180)),
  );
  app.get('/favicon.ico', async (_req, reply) => {
    const ico = sestavIco([
      { velikost: 16, png: await png(16) },
      { velikost: 32, png: await png(32) },
      { velikost: 48, png: await png(48) },
    ]);
    return reply.type('image/x-icon').header('cache-control', 'public, max-age=86400').send(ico);
  });
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const v = app.hasDecorator('web') ? await app.web.vzhled.nacti() : null;
    return reply.type('application/manifest+json').send({
      name: app.obec.obec.nazev,
      short_name: app.obec.obec.kratky_nazev,
      lang: 'cs',
      start_url: '/',
      display: 'browser',
      theme_color: v?.schema ? undefined : (v?.paleta.primarni ?? '#1b5e20'),
      icons: [192, 512].map((s) => ({ src: `/ikona-${s}.png`, sizes: `${s}x${s}`, type: 'image/png' })),
    });
  });
}
