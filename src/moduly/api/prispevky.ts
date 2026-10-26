// API příspěvků webu: založení/úprava aktuality, akce nebo stránky přes ObsahSluzba (revize, audit, sanitace HTML),
// idempotence přes zdroj + externi_id, úvodní obrázek a přílohy ke stažení.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { escapujHtml, obrazkyBezAlt, sanitizuj } from '../../lib/html.js';
import type { Soubor } from '../../db/types.js';
import { lidskaVelikost, popisTypu, chybaSouboruText } from '../../lib/soubory.js';
import { urlSouboru } from '../../web/soubory.js';
import { PRAZDNA_POLE, poleProEditor, type PoleObsahu } from '../web/obsah.js';
import { markdownNaHtml } from './markdown.js';
import { bool, chyba, datum, obsahSouboru, seznamTextu, soubory, text, type Telo } from './spolecne.js';

export const TYPY_API: TypObsahu[] = ['aktualita', 'akce', 'stranka'];
/** zdroje, které patří platformě (import, synchronizace) — klient API je použít nesmí */
export const VYHRAZENE_ZDROJE = new Set(['', 'import', 'rezervace', 'infokanal', 'zpravodaj']);
export const ZDROJ_RE = /^[a-z0-9][a-z0-9_.:-]{0,39}$/;

export interface ZapisPrispevku {
  pole: PoleObsahu;
  zverejnit: boolean | undefined;
}

/** soubor z úložiště podle id (jen existující) */
async function souborPodleId(app: FastifyInstance, id: string, k: string): Promise<Soubor> {
  const s = /^[0-9a-f-]{36}$/i.test(id) ? await app.soubory.podleId(id) : undefined;
  if (!s) throw chyba(400, `Soubor ${id} neexistuje.`, k);
  return s as Soubor;
}

export function htmlPriloh(prilohy: Soubor[]): string {
  if (!prilohy.length) return '';
  const polozky = prilohy
    .map(
      (s) =>
        `<li><a href="${escapujHtml(urlSouboru(s))}">${escapujHtml(s.puvodni_nazev)}</a> (${escapujHtml(popisTypu(s.pripona))}, ${escapujHtml(lidskaVelikost(s.velikost))})</li>`,
    )
    .join('');
  return `<h2>Ke stažení</h2><ul>${polozky}</ul>`;
}

/** uloží nahrané soubory z pole (dokumenty); vrací uložené */
export async function ulozSoubory(
  app: FastifyInstance,
  req: FastifyRequest,
  pole: string,
  druh: 'dokument' | 'obrazek',
  nahralId: string | null,
  alt = '',
): Promise<Soubor[]> {
  const out: Soubor[] = [];
  for (const s of soubory(req, pole)) {
    const v = await app.soubory.uloz({ data: await obsahSouboru(s), nazev: s.nazev, druh, nahralId, alt });
    if ('chyba' in v)
      throw chyba(
        v.chyba === 'velikost' ? 413 : 400,
        `${s.nazev}: ${chybaSouboruText(app.t, v.chyba)}`,
        pole,
      );
    if (druh === 'obrazek' && !v.soubor.mime.startsWith('image/'))
      throw chyba(400, `${s.nazev}: ${chybaSouboruText(app.t, 'typ')}`, pole);
    out.push(v.soubor as Soubor);
  }
  return out;
}

/**
 * Pole příspěvku z požadavku. U úpravy (`o`) se mění jen poslaná pole. Vyhazuje ApiChyba 400 s názvem pole.
 */
export async function nactiPrispevek(
  app: FastifyInstance,
  req: FastifyRequest,
  b: Telo,
  typ: TypObsahu,
  o: WebObsah | null,
  nahralId: string | null,
): Promise<ZapisPrispevku> {
  const pole: PoleObsahu = o ? poleProEditor(o) : { ...PRAZDNA_POLE, v_menu: false };
  const titulek = text(b, 'titulek', 250);
  if (titulek !== undefined) pole.titulek = titulek;
  if (!o && !pole.titulek) throw chyba(400, 'Chybí titulek.', 'titulek');
  const perex = text(b, 'perex', 600);
  if (perex !== undefined) pole.perex = perex;
  const html = text(b, 'html', 2_000_000);
  const md = text(b, 'markdown', 2_000_000);
  if (html !== undefined && md !== undefined)
    throw chyba(400, 'Pošlete buď html, nebo markdown — ne obojí.', 'html');
  if (html !== undefined) pole.obsah_html = sanitizuj(html);
  if (md !== undefined) pole.obsah_html = sanitizuj(markdownNaHtml(md));
  const slug = text(b, 'slug', 120);
  if (slug) pole.slug = slug;

  // kategorie (slug nebo číslo) — aktuality a akce
  const kat = text(b, 'kategorie', 100);
  if (kat !== undefined && typ !== 'stranka') {
    if (!kat) pole.kategorie_id = null;
    else {
      const k = (await app.web.obsah.kategorie()).find((x) => x.slug === kat || String(x.id) === kat);
      if (!k) throw chyba(400, `Kategorie „${kat}“ neexistuje (seznam: GET /api/v1/kategorie).`, 'kategorie');
      pole.kategorie_id = k.id;
    }
  }
  // další kategorie (pole slugů nebo čísel); prázdné pole je zruší
  if (b.dalsi_kategorie !== undefined && typ !== 'stranka') {
    const dalsi = seznamTextu(b, 'dalsi_kategorie');
    const vse = await app.web.obsah.kategorie();
    pole.kategorie_dalsi = dalsi.map((x) => {
      const k = vse.find((y) => y.slug === x || String(y.id) === x);
      if (!k)
        throw chyba(400, `Kategorie „${x}“ neexistuje (seznam: GET /api/v1/kategorie).`, 'dalsi_kategorie');
      return k.id;
    });
  }

  if (typ === 'aktualita') {
    const d = datum(b, 'datum', 8);
    if (d) pole.datum = d.kdy.toISOString();
    else if (!pole.datum) pole.datum = new Date().toISOString();
  }
  if (typ === 'akce') {
    const celyDen = bool(b, 'akce_cely_den');
    const od = datum(b, 'akce_od');
    const do_ = datum(b, 'akce_do', 23);
    if (od) {
      pole.datum = od.kdy.toISOString();
      pole.akce_cely_den = celyDen ?? od.jenDen;
    } else if (celyDen !== undefined) pole.akce_cely_den = celyDen;
    if (!pole.datum) throw chyba(400, 'U akce chybí začátek (akce_od).', 'akce_od');
    if (do_) {
      const konec = do_.jenDen ? new Date(do_.kdy.getTime() + 59 * 60_000) : do_.kdy; // celý den do 23:59
      if (konec <= new Date(pole.datum)) throw chyba(400, 'Konec akce musí být po začátku.', 'akce_do');
      pole.akce_konec = konec.toISOString();
    } else if (b.akce_do === null || b.akce_do === '') pole.akce_konec = null;
    const misto = text(b, 'misto', 200) ?? text(b, 'akce_misto', 200);
    if (misto !== undefined) pole.akce_misto = misto;
    const vAkt = bool(b, 'v_aktualitach');
    if (vAkt !== undefined) pole.v_aktualitach = vAkt;
  }
  if (typ === 'stranka') {
    const vMenu = bool(b, 'v_menu');
    if (vMenu !== undefined) pole.v_menu = vMenu;
  }

  // úvodní obrázek: nahraný soubor (multipart „obrazek“) nebo id dříve nahraného (POST /api/v1/soubory)
  const alt = text(b, 'obrazek_alt', 300);
  const nahrane = await ulozSoubory(app, req, 'obrazek', 'obrazek', nahralId, alt ?? '');
  const obrId = text(b, 'obrazek_id', 40);
  if (nahrane[0]) pole.obrazek_id = nahrane[0].id;
  else if (obrId !== undefined) {
    if (!obrId) pole.obrazek_id = null;
    else {
      const s = await souborPodleId(app, obrId, 'obrazek_id');
      if (!s.mime.startsWith('image/')) throw chyba(400, 'Úvodní obrázek musí být obrázek.', 'obrazek_id');
      pole.obrazek_id = s.id;
    }
  }
  if (pole.obrazek_id && alt !== undefined && !nahrane[0]) await app.soubory.nastavAlt(pole.obrazek_id, alt);

  // přílohy ke stažení: nahrané soubory (multipart „prilohy“) nebo id dříve nahraných → seznam na konci textu
  const prilohy = [
    ...(await ulozSoubory(app, req, 'prilohy', 'dokument', nahralId)),
    ...(await Promise.all(seznamTextu(b, 'prilohy_id').map((id) => souborPodleId(app, id, 'prilohy_id')))),
  ];
  if (prilohy.length) pole.obsah_html = [pole.obsah_html, htmlPriloh(prilohy)].filter(Boolean).join('\n');

  const zverejnit = bool(b, 'zverejnit');
  if (zverejnit) await kontrolaPredZverejnenim(app, pole);
  return { pole, zverejnit };
}

/** stejné náležitosti jako ve správě: titulek, popis úvodního obrázku, popisy obrázků v textu (WCAG) */
export async function kontrolaPredZverejnenim(app: FastifyInstance, pole: PoleObsahu) {
  if (!pole.titulek) throw chyba(400, 'Před zveřejněním vyplňte titulek.', 'titulek');
  if (pole.obrazek_id) {
    const s = await app.soubory.podleId(pole.obrazek_id);
    if (s && !s.alt)
      throw chyba(400, 'Úvodní obrázek potřebuje popis (obrazek_alt) — zákon o přístupnosti.', 'obrazek_alt');
  }
  const bezAlt = obrazkyBezAlt(pole.obsah_html);
  if (bezAlt) throw chyba(400, `V textu je ${bezAlt} obrázků bez popisu (atribut alt).`, 'html');
}

/** veřejná podoba příspěvku pro odpověď API */
export async function vystupPrispevku(app: FastifyInstance, o: WebObsah) {
  const vse = await app.web.obsah.kategorie();
  const kategorie = o.kategorie_id ? (vse.find((k) => k.id === o.kategorie_id)?.slug ?? null) : null;
  const dalsiKategorie = (o.kategorie_dalsi ?? [])
    .map((id) => vse.find((k) => k.id === id)?.slug)
    .filter((x): x is string => !!x);
  return {
    id: o.id,
    typ: o.typ,
    titulek: o.titulek,
    slug: o.slug,
    stav: o.stav,
    rozpracovana_zmena: !!o.koncept,
    url: `${app.env.BASE_URL}${await app.web.obsah.url(o)}`,
    sprava_url: `${app.env.BASE_URL}/sprava/web/obsah/${o.id}`,
    zdroj: o.zdroj,
    externi_id: o.externi_id,
    kategorie,
    dalsi_kategorie: dalsiKategorie,
    perex: o.perex,
    datum: o.datum?.toISOString() ?? null,
    akce_konec: o.akce_konec?.toISOString() ?? null,
    akce_cely_den: o.akce_cely_den,
    misto: o.akce_misto,
    obrazek_id: o.obrazek_id,
    hlaseni_id: o.hlaseni_id,
    zverejneno_at: o.zverejneno_at?.toISOString() ?? null,
    upraveno_at: o.upraveno_at.toISOString(),
  };
}

/** příspěvek podle zdroje + externího id (nesmazaný) */
export function podleExternihoId(app: FastifyInstance, zdroj: string, externiId: string) {
  return app.db
    .selectFrom('web_obsah')
    .selectAll()
    .where('zdroj', '=', zdroj)
    .where('externi_id', '=', externiId)
    .where('smazano_at', 'is', null)
    .executeTakeFirst();
}
