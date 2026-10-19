// Úložiště souborů obce: přílohy úřední desky, obrázky v obsahu, fotky galerií, loga dárců.
// Zásady (poučení z provozu): typ se pozná z OBSAHU (magic bytes), ne z přípony; náhodné názvy na disku;
// obrázky se vždy přeuloží (zmenšení, otočení podle EXIF a zahození metadat včetně GPS); SVG se nikdy
// neservíruje — loga v SVG se převedou na PNG (žádný skript v obrázku).
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
import type { Db } from '../db/index.js';
import type { Insertable } from 'kysely';
import type { DruhSouboru, Soubor, SouboryTable } from '../db/types.js';

sharp.concurrency(1); // malý server sdílený s dalšími službami — šetřit paměť
sharp.cache(false);

export const MAX_VELIKOST = 30 * 1024 * 1024;
/** video obce (MP4/WebM) — jen druh „video“; doporučeno 720p H.264 ~2–3 Mb/s, pak 5 minut ≈ 100 MB */
export const MAX_VELIKOST_VIDEA = 300 * 1024 * 1024;
const MAX_VELIKOST_TITULKU = 2 * 1024 * 1024;
// video: kontejnery, které přehraje <video> ve všech běžných prohlížečích (MOV/AVI/MKV ne)
const VIDEA: Record<string, { mime: string; pripona: string }> = {
  'video/mp4': { mime: 'video/mp4', pripona: 'mp4' },
  'video/x-m4v': { mime: 'video/mp4', pripona: 'mp4' },
  'video/webm': { mime: 'video/webm', pripona: 'webm' },
};
const OBRAZEK_MAX = 1920;
const NAHLED_MAX = 640;
const LOGO_MAX_SIRKA = 600;
const LOGO_MAX_VYSKA = 240;

// dokumenty, které úřad typicky vyvěšuje (PDF, Word, Excel, OpenDocument, RTF)
const DOKUMENTY: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/x-cfb': 'doc', // starý Word/Excel (OLE) — přesná přípona se vezme z názvu
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
};
const OBRAZKY = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/tiff',
]);

export type ChybaSouboru = 'typ' | 'velikost' | 'poskozeny' | 'prazdny';

export class SouboroveUloziste {
  readonly koren: string;
  constructor(
    private db: Db,
    dataDir: string,
  ) {
    this.koren = path.join(path.resolve(dataDir), 'soubory');
  }

  cesta(id: string, varianta: '' | 'nahled' = ''): string {
    return path.join(this.koren, id.slice(0, 2), varianta ? `${id}-${varianta}` : id);
  }

  /**
   * Nejdřív soubor na disk, teprve pak řádek v databázi: řádek bez souboru (404 navždy) tak nevznikne.
   * Když se nepovede zápis nebo vložení řádku, zapsané soubory se smažou.
   */
  private async zapisAZaloz(
    zapis: (id: string) => Promise<void>,
    hodnoty: Omit<Insertable<SouboryTable>, 'id'>,
  ): Promise<Soubor> {
    const id = randomUUID();
    await fs.mkdir(path.dirname(this.cesta(id)), { recursive: true });
    try {
      await zapis(id);
      return await this.db
        .insertInto('soubory')
        .values({ ...hodnoty, id })
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (e) {
      await Promise.all([
        fs.rm(this.cesta(id), { force: true }),
        fs.rm(this.cesta(id, 'nahled'), { force: true }),
      ]);
      throw e;
    }
  }

  async podleId(id: string): Promise<Soubor | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    return this.db.selectFrom('soubory').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Uloží soubor. `druh` říká, k čemu je: dokument (přílohy — povolí i obrázky), obrazek (jen obrázky),
   * logo (obrázky i SVG, převede na PNG s průhledností).
   */
  async uloz(v: {
    data: Buffer;
    nazev: string;
    druh: DruhSouboru;
    nahralId?: string | null;
    alt?: string;
    zdrojUrl?: string | null;
  }): Promise<{ soubor: Soubor } | { chyba: ChybaSouboru }> {
    if (!v.data.length) return { chyba: 'prazdny' };
    if (v.druh === 'video') return this.ulozVideo({ ...v, data: v.data });
    if (v.druh === 'titulky') return this.ulozTitulky(v);
    if (v.data.length > MAX_VELIKOST) return { chyba: 'velikost' };
    const puvodniNazev = bezpecnyNazev(v.nazev);
    const typ = await fileTypeFromBuffer(v.data);
    let mime = typ?.mime ?? '';
    const jeSvg = !typ && v.druh === 'logo' && /<svg[\s>]/i.test(v.data.subarray(0, 4096).toString('utf8'));
    if (!typ && !jeSvg && /^\{\\rtf/.test(v.data.subarray(0, 6).toString('latin1'))) mime = 'application/rtf';

    let vystup: Buffer;
    let pripona: string;
    let sirka: number | null = null;
    let vyska: number | null = null;
    let nahled: Buffer | null = null;

    if (jeSvg || OBRAZKY.has(mime)) {
      try {
        const r = await zpracujObrazek(v.data, v.druh === 'logo' ? 'logo' : 'foto');
        ({ data: vystup, pripona, sirka, vyska, nahled } = r);
        mime = pripona === 'png' ? 'image/png' : 'image/jpeg';
      } catch {
        return { chyba: 'poskozeny' };
      }
    } else if (v.druh === 'dokument' && DOKUMENTY[mime]) {
      vystup = v.data;
      pripona = DOKUMENTY[mime]!;
      if (mime === 'application/x-cfb') {
        const p = path.extname(puvodniNazev).slice(1).toLowerCase();
        pripona = ['doc', 'xls', 'ppt'].includes(p) ? p : 'doc';
        mime = {
          doc: 'application/msword',
          xls: 'application/vnd.ms-excel',
          ppt: 'application/vnd.ms-powerpoint',
        }[pripona]!;
      }
    } else {
      return { chyba: 'typ' };
    }

    const sha256 = createHash('sha256').update(vystup).digest('hex');
    const soubor = await this.zapisAZaloz(
      async (id) => {
        await fs.writeFile(this.cesta(id), vystup);
        if (nahled) await fs.writeFile(this.cesta(id, 'nahled'), nahled);
      },
      {
        druh: v.druh === 'dokument' && mime.startsWith('image/') ? 'obrazek' : v.druh,
        puvodni_nazev: puvodniNazev.replace(/\.[^.]+$/, '') + '.' + pripona,
        mime,
        pripona,
        velikost: vystup.length,
        sirka,
        vyska,
        alt: (v.alt ?? '').trim().slice(0, 300),
        sha256,
        zdroj_url: v.zdrojUrl ?? null,
        nahral_id: v.nahralId ?? null,
      },
    );
    return { soubor };
  }

  /**
   * Video (MP4/WebM) — z bufferu (import) nebo streamovaně z cesty na disku (nahrávání, až stovky MB, do paměti
   * se nenačítá). Typ podle obsahu, ne podle přípony. Video se nepřekódovává (platforma nemá ffmpeg) — převést
   * na rozumnou velikost má úřad předem (viz nápověda ve správě videí).
   */
  async ulozVideo(v: {
    data?: Buffer;
    cesta?: string;
    nazev: string;
    nahralId?: string | null;
    zdrojUrl?: string | null;
  }): Promise<{ soubor: Soubor } | { chyba: ChybaSouboru }> {
    const velikost = v.data ? v.data.length : v.cesta ? (await fs.stat(v.cesta)).size : 0;
    if (!velikost) return { chyba: 'prazdny' };
    if (velikost > MAX_VELIKOST_VIDEA) return { chyba: 'velikost' };
    const typ = v.data ? await fileTypeFromBuffer(v.data) : await fileTypeFromFile(v.cesta!);
    const druh = typ ? VIDEA[typ.mime] : undefined;
    if (!druh) return { chyba: 'typ' };
    const hash = createHash('sha256');
    if (v.data) hash.update(v.data);
    else for await (const kus of createReadStream(v.cesta!)) hash.update(kus as Buffer);
    const puvodniNazev = bezpecnyNazev(v.nazev);
    const soubor = await this.zapisAZaloz(
      async (id) => {
        if (v.data) await fs.writeFile(this.cesta(id), v.data);
        else await fs.copyFile(v.cesta!, this.cesta(id));
      },
      {
        druh: 'video',
        puvodni_nazev: puvodniNazev.replace(/\.[^.]+$/, '') + '.' + druh.pripona,
        mime: druh.mime,
        pripona: druh.pripona,
        velikost,
        sirka: null,
        vyska: null,
        alt: '',
        sha256: hash.digest('hex'),
        zdroj_url: v.zdrojUrl ?? null,
        nahral_id: v.nahralId ?? null,
      },
    );
    return { soubor };
  }

  /** titulky k videu: WebVTT, nebo SRT (převede se na WebVTT) — jen prostý text v UTF-8 */
  private async ulozTitulky(v: {
    data: Buffer;
    nazev: string;
    nahralId?: string | null;
    zdrojUrl?: string | null;
  }): Promise<{ soubor: Soubor } | { chyba: ChybaSouboru }> {
    if (v.data.length > MAX_VELIKOST_TITULKU) return { chyba: 'velikost' };
    const vtt = naWebVtt(v.data.toString('utf8'));
    if (!vtt) return { chyba: 'typ' };
    const data = Buffer.from(vtt, 'utf8');
    const soubor = await this.zapisAZaloz((id) => fs.writeFile(this.cesta(id), data), {
      druh: 'titulky',
      puvodni_nazev: bezpecnyNazev(v.nazev).replace(/\.[^.]+$/, '') + '.vtt',
      mime: 'text/vtt',
      pripona: 'vtt',
      velikost: data.length,
      sirka: null,
      vyska: null,
      alt: '',
      sha256: createHash('sha256').update(data).digest('hex'),
      zdroj_url: v.zdrojUrl ?? null,
      nahral_id: v.nahralId ?? null,
    });
    return { soubor };
  }

  async nastavAlt(id: string, alt: string) {
    await this.db
      .updateTable('soubory')
      .set({ alt: alt.trim().slice(0, 300) })
      .where('id', '=', id)
      .execute();
  }

  async podleZdroje(url: string) {
    return this.db.selectFrom('soubory').selectAll().where('zdroj_url', '=', url).executeTakeFirst();
  }
}

async function zpracujObrazek(data: Buffer, ucel: 'foto' | 'logo') {
  // rotate() bez parametrů = otočit podle EXIF; výstup sharp metadata (EXIF, GPS, ICC) nekopíruje
  const vstup = sharp(data, {
    failOn: 'error',
    density: 300,
    pages: 1,
    limitInputPixels: 80_000_000,
  }).rotate();
  const meta = await vstup.metadata();
  const pruhledny = !!meta.hasAlpha;
  if (ucel === 'logo') {
    const out = await vstup
      .trim({ threshold: 8 })
      .resize({ width: LOGO_MAX_SIRKA, height: LOGO_MAX_VYSKA, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true })
      .catch(() =>
        sharp(data, { density: 300 })
          .resize({ width: LOGO_MAX_SIRKA, height: LOGO_MAX_VYSKA, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer({ resolveWithObject: true }),
      );
    return { data: out.data, pripona: 'png', sirka: out.info.width, vyska: out.info.height, nahled: null };
  }
  const zmenseny = vstup.resize({
    width: OBRAZEK_MAX,
    height: OBRAZEK_MAX,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const out = pruhledny
    ? await zmenseny.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    : await zmenseny
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
  const nahled = await sharp(out.data)
    .resize({ width: NAHLED_MAX, height: NAHLED_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  return {
    data: out.data,
    pripona: pruhledny ? 'png' : 'jpg',
    sirka: out.info.width,
    vyska: out.info.height,
    nahled,
  };
}

/** WebVTT beze změny (jen bez BOM a s jednotnými konci řádků), SRT → WebVTT; jinak null */
export function naWebVtt(text: string): string | null {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex -- binární obsah (NUL) titulky nejsou
  if (/\u0000/.test(t)) return null;
  if (/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(t)) return t;
  const casy = /^\s*\d+\s*\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/;
  if (!casy.test(t)) return null;
  return (
    'WEBVTT\n\n' +
    t
      .trim()
      .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
      .replace(/<(?!\/?[biu]>)[^>]*>/g, '') +
    '\n'
  );
}

// název pro stažení: bez cest a řídicích znaků, rozumná délka
export function bezpecnyNazev(n: string): string {
  const zaklad = path.basename(String(n || 'soubor').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex -- záměrně odstraňujeme řídicí znaky z názvu souboru
  const cisty = zaklad.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return (cisty || 'soubor').slice(0, 150);
}

export function lidskaVelikost(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function popisTypu(pripona: string): string {
  const m: Record<string, string> = {
    pdf: 'PDF',
    doc: 'Word',
    docx: 'Word',
    xls: 'Excel',
    xlsx: 'Excel',
    ppt: 'PowerPoint',
    pptx: 'PowerPoint',
    odt: 'OpenDocument text',
    ods: 'OpenDocument tabulka',
    odp: 'OpenDocument prezentace',
    rtf: 'RTF',
    jpg: 'obrázek JPG',
    png: 'obrázek PNG',
    mp4: 'video MP4',
    webm: 'video WebM',
    vtt: 'titulky WebVTT',
  };
  return m[pripona] ?? pripona.toUpperCase();
}

export function chybaSouboruText(t: (k: string) => string, c: ChybaSouboru): string {
  return t(`soubory.chyba_${c}`);
}
