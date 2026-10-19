// Nahrávání souborů (multipart). Soubory se streamují na disk do dočasné složky (galerie s 30 fotkami se do paměti
// nevejde), textová pole jsou k dispozici v req.body ještě před CSRF kontrolou. Po odpovědi se dočasné soubory mažou.
// Limit velikosti: 30 MB; jen přihlášený na cestě správy videí smí až 300 MB (multipart se čte dřív, než routa
// ověří roli — anonym tak velký soubor na disk nedostane). Nad limit se soubor ořízne a označí `oriznuto`.
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import fastifyMultipart, { type MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { MAX_VELIKOST, MAX_VELIKOST_VIDEA } from '../lib/soubory.js';

/** cesty, kam se nahrávají videa (větší limit) */
const CESTY_VIDEA = /^\/sprava\/web\/videa(\/|\?|$)/;

export function limitNahrani(req: FastifyRequest): number {
  return CESTY_VIDEA.test(req.url) && req.session?.uzivatelId ? MAX_VELIKOST_VIDEA : MAX_VELIKOST;
}

export interface NahranySoubor {
  pole: string;
  nazev: string;
  mime: string;
  cesta: string;
  velikost: number;
  oriznuto: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    docasneSoubory?: NahranySoubor[];
  }
}

export default fp(async function nahravani(app: FastifyInstance) {
  const tmp = path.join(path.resolve(app.env.DATA_DIR), 'tmp');
  await fs.mkdir(tmp, { recursive: true });

  await app.register(fastifyMultipart, {
    attachFieldsToBody: true,
    limits: { fileSize: MAX_VELIKOST_VIDEA, files: 60, fields: 200, fieldSize: 2 * 1024 * 1024 },
    async onFile(this: FastifyRequest, part: MultipartFile) {
      if (!part.filename) {
        part.file.resume();
        return;
      }
      const cesta = path.join(tmp, randomUUID());
      const limit = limitNahrani(this);
      let prijato = 0;
      let nadLimit = false;
      const omezeni = new Transform({
        transform(kus: Buffer, _k, hotovo) {
          if (nadLimit || prijato + kus.length > limit) {
            nadLimit = true;
            return hotovo(); // zbytek se dočte a zahodí
          }
          prijato += kus.length;
          hotovo(null, kus);
        },
      });
      await pipeline(part.file, omezeni, createWriteStream(cesta));
      const st = await fs.stat(cesta);
      const s: NahranySoubor = {
        pole: part.fieldname,
        nazev: part.filename,
        mime: part.mimetype,
        cesta,
        velikost: st.size,
        oriznuto: nadLimit || part.file.truncated,
      };
      (this.docasneSoubory ??= []).push(s);
    },
  });

  // multipart pole jsou objekty {value} — pro jednotnou práci v routách je převedeme na prosté hodnoty
  app.addHook('preValidation', async (req) => {
    if (!req.isMultipart() || !req.body || typeof req.body !== 'object') return;
    const plochy: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      const hodnoty = (Array.isArray(v) ? v : [v]).filter(
        (x): x is { type: string; value: unknown } =>
          !!x && typeof x === 'object' && (x as { type?: string }).type === 'field',
      );
      if (!hodnoty.length) continue;
      plochy[k] =
        hodnoty.length === 1 && !Array.isArray(v)
          ? String(hodnoty[0]!.value)
          : hodnoty.map((h) => String(h.value));
    }
    req.body = plochy;
  });

  app.addHook('onResponse', async (req) => {
    for (const s of req.docasneSoubory ?? []) await fs.rm(s.cesta, { force: true }).catch(() => undefined);
  });
});

export function souboryZPole(req: FastifyRequest, pole: string): NahranySoubor[] {
  return (req.docasneSoubory ?? []).filter((s) => s.pole === pole && s.velikost > 0);
}
