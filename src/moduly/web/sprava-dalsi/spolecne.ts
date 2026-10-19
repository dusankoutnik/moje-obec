// Společná výbava správy dalšího obsahu webu: čtení formulářů, role a ukládání nahraných obrázků.
import { promises as fs } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { datumPraha } from '../../../lib/datum.js';
import { chybaSouboruText, lidskaVelikost, popisTypu } from '../../../lib/soubory.js';
import { souboryZPole } from '../../../web/nahravani.js';
import { urlSouboru } from '../../../web/soubory.js';
import { vyzadujRoli } from '../../ucty/opravneni.js';

export type Telo = Record<string, string | string[] | undefined>;
export const jeden = (v: unknown) =>
  (Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v)).trim();
export const vice = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
export const jeDatum = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function kontextSpravy(app: FastifyInstance) {
  const t = app.t;
  const redaktor = vyzadujRoli('web');
  const spravce = vyzadujRoli('spravce');
  const pomocnici = { urlSouboru, lidskaVelikost, popisTypu, datumPraha };

  /** uloží nahrané obrázky z pole formuláře; vrací id a chyby */
  async function ulozObrazky(
    req: FastifyRequest,
    pole: string,
    druh: 'obrazek' | 'logo',
    alt: (nazev: string, i: number) => string,
  ) {
    const ids: string[] = [];
    const chyby: string[] = [];
    let i = 0;
    for (const f of souboryZPole(req, pole)) {
      i++;
      if (f.oriznuto) {
        chyby.push(`${f.nazev}: ${chybaSouboruText(t, 'velikost')}`);
        continue;
      }
      const v = await app.soubory.uloz({
        data: await fs.readFile(f.cesta),
        nazev: f.nazev,
        druh,
        nahralId: req.uzivatel!.id,
        alt: alt(f.nazev, i),
      });
      if ('chyba' in v) chyby.push(`${f.nazev}: ${chybaSouboruText(t, v.chyba)}`);
      else if (!v.soubor.mime.startsWith('image/')) chyby.push(`${f.nazev}: ${chybaSouboruText(t, 'typ')}`);
      else ids.push(v.soubor.id);
    }
    return { ids, chyby };
  }

  return { t, redaktor, spravce, pomocnici, ulozObrazky };
}
