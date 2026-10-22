// Pomůcky API /api/v1: ověření tokenu a rozsahů, limit požadavků, čtení polí z JSON i multipart, chyby česky.
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiToken } from '../../db/types.js';
import { casPraha } from '../../lib/datum.js';
import { klicIp, vytvorLimit } from '../../lib/limit.js';
import { souboryZPole, type NahranySoubor } from '../../web/nahravani.js';
import type { ApiTokenySluzba, Rozsah } from './tokeny.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiToken?: ApiToken | null;
  }
}

export type Telo = Record<string, unknown>;

export class ApiChyba extends Error {
  constructor(
    public status: number,
    zprava: string,
    public pole?: string,
  ) {
    super(zprava);
  }
}

export const chyba = (status: number, zprava: string, pole?: string) => new ApiChyba(status, zprava, pole);

/** požadavků na jeden token za 15 minut; neplatných pokusů z jedné IP za 15 minut */
export const LIMIT_TOKENU = 600;
export const LIMIT_NEPLATNYCH = 30;

export function vytvorOvereni(app: FastifyInstance, tokeny: ApiTokenySluzba) {
  const naToken = vytvorLimit(LIMIT_TOKENU, 15);
  const neplatne = vytvorLimit(LIMIT_NEPLATNYCH, 15);

  /** ověří token z hlavičky (jednou za požadavek); vyhazuje ApiChyba 401/429 */
  async function overToken(req: FastifyRequest): Promise<ApiToken> {
    if (req.apiToken) return req.apiToken;
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
    const ip = klicIp(req.ip);
    if (!m) throw chyba(401, 'Chybí hlavička Authorization: Bearer <token>.');
    const t = await tokeny.over(m[1]!);
    if (!t) {
      if (!neplatne.zkus(ip)) throw chyba(429, 'Příliš mnoho neplatných pokusů — zkuste to za 15 minut.');
      throw chyba(401, 'Neplatný nebo zrušený token.');
    }
    if (!naToken.zkus(t.id)) throw chyba(429, 'Překročen limit požadavků tokenu (600 za 15 minut).');
    req.apiToken = t;
    await tokeny.zapisPouziti(t, req.ip).catch((e) => req.log.warn({ err: e }, 'api: zápis použití tokenu'));
    return t;
  }

  /** preHandler: platný token s aspoň jedním z rozsahů */
  function vyzaduj(...rozsahy: Rozsah[]) {
    return async (req: FastifyRequest) => {
      const t = await overToken(req);
      if (!rozsahy.some((r) => t.rozsahy.includes(r)))
        throw chyba(403, `Token nemá oprávnění (potřeba: ${rozsahy.join(' nebo ')}).`);
    };
  }

  // multipart na /api/v1 smí jen platný token (kontrola ještě před čtením těla, viz web/nahravani.ts)
  app.apiNahrani.over = async (req) => {
    try {
      await overToken(req);
      return true;
    } catch {
      return false;
    }
  };

  return { overToken, vyzaduj, limity: { naToken, neplatne } };
}

export function chybaDoOdpovedi(e: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (e instanceof ApiChyba)
    return reply
      .code(e.status)
      .header('cache-control', 'no-store')
      .send({ chyba: e.message, ...(e.pole ? { pole: e.pole } : {}) });
  const x = e as Error & { statusCode?: number; code?: string };
  if (x.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || x.code === 'FST_REQ_FILE_TOO_LARGE' || x.statusCode === 413)
    return reply.code(413).send({ chyba: 'Požadavek nebo soubor je příliš velký.' });
  if (x.message === 'neplatny_token') return reply.code(401).send({ chyba: 'Neplatný nebo zrušený token.' });
  if (x.code === '22P02') return reply.code(404).send({ chyba: 'Nenalezeno.' });
  if (x.statusCode === 415)
    return reply
      .code(415)
      .send({ chyba: 'Nepodporovaný typ těla — použijte application/json nebo multipart/form-data.' });
  if (x.statusCode && x.statusCode >= 400 && x.statusCode < 500)
    return reply.code(x.statusCode).send({ chyba: `Neplatný požadavek (${x.message}).` });
  req.log.error({ err: e, url: req.url }, 'api: neošetřená chyba');
  return reply.code(500).send({ chyba: 'Chyba serveru.' });
}

// --- čtení polí ---

export function text(b: Telo, k: string, max = 10_000): string | undefined {
  const v = b[k];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return text({ x: v[0] }, 'x', max);
  if (typeof v === 'object') throw chyba(400, `Pole „${k}“ musí být text.`, k);
  return String(v).trim().slice(0, max);
}

export function bool(b: Telo, k: string): boolean | undefined {
  const v = Array.isArray(b[k]) ? (b[k] as unknown[])[0] : b[k];
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === false) return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'ano', 'yes'].includes(s)) return true;
  if (['false', '0', 'ne', 'no'].includes(s)) return false;
  throw chyba(400, `Pole „${k}“ musí být true nebo false.`, k);
}

export function cislo(b: Telo, k: string): number | undefined {
  const v = Array.isArray(b[k]) ? (b[k] as unknown[])[0] : b[k];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw chyba(400, `Pole „${k}“ musí být číslo.`, k);
  return n;
}

export function seznamTextu(b: Telo, k: string): string[] {
  const v = b[k];
  if (v === undefined || v === null || v === '') return [];
  const pole = Array.isArray(v) ? v : String(v).split(',');
  return pole.map((x) => String(x).trim()).filter(Boolean);
}

const JEN_DATUM = /^(\d{4}-\d{2}-\d{2})$/;
const MISTNI = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * Datum/čas z API: „YYYY-MM-DD“ (den; čas = `vychoziHodina` pražského času), „YYYY-MM-DDTHH:MM“ (pražský čas)
 * nebo plné ISO 8601 se zónou („2026-10-03T07:30:00+02:00“, „…Z“). Vrací Date, nebo vyhodí 400.
 */
export function datum(b: Telo, k: string, vychoziHodina = 0): { kdy: Date; jenDen: boolean } | undefined {
  const s = text(b, k, 40);
  if (!s) return undefined;
  let d: Date | null = null;
  let jenDen = false;
  const m1 = JEN_DATUM.exec(s);
  const m2 = MISTNI.exec(s);
  if (m1) {
    d = casPraha(m1[1]!, vychoziHodina, 0);
    jenDen = true;
  } else if (m2) {
    const h = Number(m2[2]);
    const min = Number(m2[3]);
    d = h <= 23 && min <= 59 ? casPraha(m2[1]!, h, min) : null;
  } else if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    d = Number.isNaN(t) ? null : new Date(t);
  }
  if (!d || Number.isNaN(d.getTime()))
    throw chyba(400, `Pole „${k}“ není platné datum (YYYY-MM-DD, YYYY-MM-DDTHH:MM nebo ISO 8601).`, k);
  return { kdy: d, jenDen };
}

/** soubory z multipart pole; oříznutý (nad limit) → 413 */
export function soubory(req: FastifyRequest, pole: string): NahranySoubor[] {
  const s = souboryZPole(req, pole);
  for (const x of s)
    if (x.oriznuto) throw new ApiChyba(413, `Soubor „${x.nazev}“ je příliš velký (max. 30 MB).`, pole);
  return s;
}

export async function obsahSouboru(s: NahranySoubor): Promise<Buffer> {
  return fs.readFile(s.cesta);
}

/** tělo požadavku jako objekt (JSON nebo zploštělá multipart pole) */
export function telo(req: FastifyRequest): Telo {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw chyba(400, 'Tělo požadavku musí být objekt JSON.');
  return b as Telo;
}
