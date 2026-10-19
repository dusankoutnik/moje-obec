// Nahrávání souborů (multipart). Soubory se streamují na disk do dočasné složky (galerie s 30 fotkami se do paměti
// nevejde), textová pole jsou k dispozici v req.body ještě před CSRF kontrolou. Po odpovědi se dočasné soubory mažou.
//
// Ochrana disku: multipart se přijímá JEN na cestách správy, které soubory opravdu potřebují (CESTY_NAHRAVANI), a to
// až po ověření přihlášení a role — kontrola běží v háčku preParsing, tedy dřív, než se začne číst tělo požadavku.
// Cizí stránka formulář neodešle (sezení má SameSite=lax, navíc se odmítá Sec-Fetch-Site: cross-site); úplná CSRF
// kontrola tokenem z formuláře proběhne jako u ostatních formulářů v preHandleru (token je až v těle).
// Limit velikosti: 30 MB na soubor; redaktor webu ve správě videí až 300 MB. Nad limit se soubor ořízne a označí
// `oriznuto`. Celý požadavek má navíc strop MAX_CELKEM. Při přerušeném spojení se soubory mažou hned
// (onRequestAbort) a pravidelný úklid maže v tmp/ vše starší než STARI_TMP_MS.
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import fastifyMultipart, { type MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Role } from '../db/types.js';
import { MAX_VELIKOST, MAX_VELIKOST_VIDEA } from '../lib/soubory.js';
import { maRoli } from '../moduly/ucty/sluzba.js';

/** cesty, kam se nahrávají videa (větší limit) */
const CESTY_VIDEA = /^\/sprava\/web\/videa(\/|\?|$)/;

/** jediné cesty, které přijímají multipart, a role, kterou musí mít přihlášený uživatel */
const CESTY_NAHRAVANI: { cesta: RegExp; role: Role }[] = [
  { cesta: /^\/sprava\/web(\/|\?|$)/, role: 'web' },
  { cesta: /^\/sprava\/deska(\/|\?|$)/, role: 'deska' },
];

/** nejvýš souborů v jednom požadavku (galerie se nahrává po dávkách) */
export const MAX_SOUBORU = 40;
/** strop součtu velikostí všech souborů jednoho požadavku */
export const MAX_CELKEM = MAX_VELIKOST_VIDEA + 100 * 1024 * 1024;
/** dočasné soubory starší než tohle maže pravidelný úklid (i pozůstatky po pádu procesu) */
const STARI_TMP_MS = 6 * 3600_000;
const UKLID_KAZDYCH_MS = 30 * 60_000;

export function limitNahrani(req: FastifyRequest): number {
  return CESTY_VIDEA.test(req.url) && maRoli(req.uzivatel, 'web') ? MAX_VELIKOST_VIDEA : MAX_VELIKOST;
}

/** role potřebná k nahrávání na danou cestu, nebo null, když cesta multipart nepřijímá */
export function roleProNahrani(url: string): Role | null {
  return CESTY_NAHRAVANI.find((c) => c.cesta.test(url))?.role ?? null;
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
    /** součet přijatých bajtů souborů v požadavku */
    nahranoCelkem?: number;
    /** spojení skončilo (odpověď nebo přerušení) — další soubory se už neukládají */
    nahravaniUkonceno?: boolean;
  }
}

function chyba(status: number, zprava: string) {
  const e = new Error(zprava) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

/** smaže v adresáři soubory starší než `stari` ms; vrací počet smazaných */
export async function uklidTmp(adresar: string, stari = STARI_TMP_MS, ted = Date.now()): Promise<number> {
  let smazano = 0;
  const nazvy = await fs.readdir(adresar).catch(() => [] as string[]);
  for (const n of nazvy) {
    const p = path.join(adresar, n);
    try {
      const st = await fs.stat(p);
      if (st.isFile() && ted - st.mtimeMs > stari) {
        await fs.rm(p, { force: true });
        smazano++;
      }
    } catch {
      // soubor mezitím zmizel
    }
  }
  return smazano;
}

export default fp(async function nahravani(app: FastifyInstance) {
  const tmp = path.join(path.resolve(app.env.DATA_DIR), 'tmp');
  await fs.mkdir(tmp, { recursive: true });

  const uklid = () =>
    uklidTmp(tmp)
      .then((n) => {
        if (n) app.log.info({ smazano: n }, 'úklid dočasných nahraných souborů');
      })
      .catch((e: unknown) => app.log.warn({ err: e }, 'úklid tmp selhal'));
  void uklid();
  const casovac = setInterval(uklid, UKLID_KAZDYCH_MS);
  casovac.unref();
  app.addHook('onClose', async () => clearInterval(casovac));

  // Brána před čtením těla: multipart jen na povolených cestách, jen přihlášenému s rolí.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (!/^multipart\//i.test(req.headers['content-type'] ?? '')) return payload;
    const role = roleProNahrani(req.url);
    if (!role) throw chyba(415, 'multipart_nepovolen');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw chyba(403, 'forbidden');
    const id = req.session?.uzivatelId;
    const u = id
      ? await app.db.selectFrom('uzivatele').selectAll().where('id', '=', id).executeTakeFirst()
      : undefined;
    if (!u || u.blokovan_at || !maRoli(u, role)) throw chyba(403, 'forbidden');
    req.uzivatel = u;
    return payload;
  });

  await app.register(fastifyMultipart, {
    attachFieldsToBody: true,
    limits: { fileSize: MAX_VELIKOST_VIDEA, files: MAX_SOUBORU, fields: 200, fieldSize: 2 * 1024 * 1024 },
    async onFile(this: FastifyRequest, part: MultipartFile) {
      if (!part.filename || this.nahravaniUkonceno) {
        part.file.resume();
        return;
      }
      const cesta = path.join(tmp, randomUUID());
      const limit = limitNahrani(this);
      const s: NahranySoubor = {
        pole: part.fieldname,
        nazev: part.filename,
        mime: part.mimetype,
        cesta,
        velikost: 0,
        oriznuto: false,
      };
      // zapsat do seznamu hned — úklid po přerušení smaže i rozepsaný soubor
      (this.docasneSoubory ??= []).push(s);
      let prijato = 0;
      let nadLimit = false;
      const omezeni = new Transform({
        // šipka: `this` je požadavek (onFile), ne Transform
        transform: (kus: Buffer, _k, hotovo) => {
          const celkem = this.nahranoCelkem ?? 0;
          if (nadLimit || prijato + kus.length > limit || celkem + kus.length > MAX_CELKEM) {
            nadLimit = true;
            return hotovo(); // zbytek se dočte a zahodí
          }
          prijato += kus.length;
          this.nahranoCelkem = celkem + kus.length;
          hotovo(null, kus);
        },
      });
      try {
        await pipeline(part.file, omezeni, createWriteStream(cesta));
      } catch (e) {
        await fs.rm(cesta, { force: true }).catch(() => undefined);
        throw e;
      }
      if (this.nahravaniUkonceno) {
        await fs.rm(cesta, { force: true }).catch(() => undefined);
        return;
      }
      s.velikost = (await fs.stat(cesta)).size;
      s.oriznuto = nadLimit || part.file.truncated;
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

  const smazDocasne = async (req: FastifyRequest) => {
    req.nahravaniUkonceno = true;
    for (const s of req.docasneSoubory ?? []) await fs.rm(s.cesta, { force: true }).catch(() => undefined);
  };
  app.addHook('onResponse', smazDocasne);
  // přerušené spojení: onResponse neproběhne
  app.addHook('onRequestAbort', smazDocasne);
});

export function souboryZPole(req: FastifyRequest, pole: string): NahranySoubor[] {
  return (req.docasneSoubory ?? []).filter((s) => s.pole === pole && s.velikost > 0);
}
