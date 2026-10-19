// Čtení obsahu webu: adresy, strom a menu (s mezipamětí), veřejné výpisy, výpisy pro správu, revize, hledání.
// Zápis (uložení, revize, koš, pořadí) je v obsah.ts — ObsahSluzba z této třídy dědí.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { odpovida, tsDotaz } from '../../lib/hledani.js';
import { adresaS, type AdresaObsahu, type PolozkaMenu } from './obsah-pole.js';

export class ObsahCteni {
  private menuCache: { cas: number; menu: PolozkaMenu[] } | null = null;
  constructor(protected db: Db) {}

  zmena() {
    this.menuCache = null;
  }

  podleId(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(undefined);
    return this.db.selectFrom('web_obsah').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** veřejná adresa obsahu */
  async url(o: AdresaObsahu): Promise<string> {
    const rodic = o.typ === 'stranka' && o.nadrazena_id ? await this.podleId(o.nadrazena_id) : undefined;
    return adresaS(o, rodic);
  }

  /** veřejné adresy celého seznamu jedním dotazem na nadřazené stránky (hledání, dlaždice podstránek) */
  async urlMnoha(polozky: AdresaObsahu[]): Promise<string[]> {
    const ids = [
      ...new Set(polozky.filter((o) => o.typ === 'stranka' && o.nadrazena_id).map((o) => o.nadrazena_id!)),
    ];
    const rodice = ids.length
      ? await this.db.selectFrom('web_obsah').select(['id', 'typ', 'slug']).where('id', 'in', ids).execute()
      : [];
    const podleId = new Map(rodice.map((r) => [r.id, r]));
    return polozky.map((o) => adresaS(o, o.nadrazena_id ? podleId.get(o.nadrazena_id) : null));
  }

  revize(id: string) {
    return this.db
      .selectFrom('web_revize as r')
      .leftJoin('uzivatele as u', 'u.id', 'r.autor_id')
      .select(['r.id', 'r.duvod', 'r.vytvoreno_at', 'r.data', 'u.jmeno', 'u.prijmeni', 'u.prezdivka'])
      .where('r.obsah_id', '=', id)
      .orderBy('r.vytvoreno_at', 'desc')
      .orderBy('r.id', 'desc')
      .execute();
  }

  /** strom stránek a odkazů pro správu (včetně konceptů) */
  async strom() {
    const vse = await this.db
      .selectFrom('web_obsah')
      .select([
        'id',
        'typ',
        'titulek',
        'slug',
        'nadrazena_id',
        'poradi',
        'v_menu',
        'stav',
        'koncept_at',
        'odkaz_url',
        'upraveno_at',
      ])
      .where('typ', 'in', ['stranka', 'odkaz'])
      .where('smazano_at', 'is', null)
      .orderBy('poradi')
      .orderBy('titulek')
      .execute();
    const koreny = vse
      .filter((o) => !o.nadrazena_id || !vse.some((r) => r.id === o.nadrazena_id))
      // nejdřív to, co je v menu (v pořadí menu), pak stránky mimo menu
      .sort((a, b) => Number(b.v_menu) - Number(a.v_menu));
    return koreny.map((k) => ({ ...k, deti: vse.filter((o) => o.nadrazena_id === k.id) }));
  }

  /** možné nadřazené stránky (jen nejvyšší úroveň — strom má nejvýš 2 úrovně) */
  async moznaNadrazena(ignorovat: string | null) {
    let q = this.db
      .selectFrom('web_obsah')
      .select(['id', 'titulek'])
      .where('typ', '=', 'stranka')
      .where('nadrazena_id', 'is', null)
      .where('smazano_at', 'is', null);
    if (ignorovat) q = q.where('id', '!=', ignorovat);
    return q.orderBy('poradi').orderBy('titulek').execute();
  }

  async maDeti(id: string) {
    return !!(await this.db
      .selectFrom('web_obsah')
      .select('id')
      .where('nadrazena_id', '=', id)
      .where('smazano_at', 'is', null)
      .executeTakeFirst());
  }

  /** hlavní menu webu (zveřejněné položky s v_menu), keš do změny */
  async menu(): Promise<PolozkaMenu[]> {
    if (this.menuCache && Date.now() - this.menuCache.cas < 60_000) return this.menuCache.menu;
    const vse = await this.db
      .selectFrom('web_obsah')
      .select(['id', 'typ', 'titulek', 'slug', 'nadrazena_id', 'odkaz_url'])
      .where('typ', 'in', ['stranka', 'odkaz'])
      .where('stav', '=', 'zverejneno')
      .where('v_menu', '=', true)
      .where('smazano_at', 'is', null)
      .orderBy('poradi')
      .orderBy('titulek')
      .execute();
    const urlZ = (o: (typeof vse)[number], rodic?: (typeof vse)[number]) =>
      o.typ === 'odkaz' ? o.odkaz_url : rodic ? `/${rodic.slug}/${o.slug}` : `/${o.slug}`;
    const menu = vse
      .filter((o) => !o.nadrazena_id)
      .map((k) => ({
        id: k.id,
        titulek: k.titulek,
        url: urlZ(k),
        deti: vse
          .filter((o) => o.nadrazena_id === k.id)
          .map((d) => ({ id: d.id, titulek: d.titulek, url: urlZ(d, k), deti: [] })),
      }));
    this.menuCache = { cas: Date.now(), menu };
    return menu;
  }

  /** stránka podle cesty /a nebo /a/b; vrací stránku a kanonickou cestu */
  async strankaPodleCesty(segmenty: string[]): Promise<{ o: WebObsah; kanonicka: string } | null> {
    if (segmenty.length < 1 || segmenty.length > 2) return null;
    const slug = segmenty[segmenty.length - 1]!;
    const o = await this.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('typ', '=', 'stranka')
      .where('slug', '=', slug)
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
    if (!o) return null;
    return { o, kanonicka: await this.url(o) };
  }

  /** veřejný detail; naplánovaná aktualita (datum v budoucnu) ještě neexistuje */
  async podleSlugu(typ: 'aktualita' | 'akce', slug: string) {
    let q = this.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('typ', '=', typ)
      .where('slug', '=', slug)
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null);
    if (typ === 'aktualita')
      q = q.where((eb) => eb.or([eb('datum', 'is', null), eb('datum', '<=', new Date())]));
    return q.executeTakeFirst();
  }

  async podstranky(id: string) {
    return this.db
      .selectFrom('web_obsah')
      .select(['id', 'typ', 'titulek', 'slug', 'perex', 'odkaz_url', 'nadrazena_id'])
      .where('nadrazena_id', '=', id)
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .orderBy('poradi')
      .execute();
  }

  /** aktuality veřejně (stránkovaně) */
  async aktuality(v: { kategorie?: number | null; stranka?: number; naStranku?: number } = {}) {
    const n = v.naStranku ?? 12;
    const strana = Math.max(1, v.stranka ?? 1);
    let q = this.db
      .selectFrom('web_obsah as o')
      .leftJoin('soubory as s', 's.id', 'o.obrazek_id')
      .leftJoin('web_kategorie as k', 'k.id', 'o.kategorie_id')
      .select([
        'o.id',
        'o.titulek',
        'o.slug',
        'o.perex',
        'o.datum',
        'o.obrazek_id',
        's.alt as obrazek_alt',
        's.puvodni_nazev as obrazek_nazev',
        'k.nazev as kategorie',
        'k.slug as kategorie_slug',
      ])
      .where('o.typ', '=', 'aktualita')
      .where('o.stav', '=', 'zverejneno')
      .where('o.smazano_at', 'is', null)
      .where('o.datum', '<=', new Date());
    if (v.kategorie) q = q.where('o.kategorie_id', '=', v.kategorie);
    const radky = await q
      .orderBy('o.datum', 'desc')
      .limit(n + 1)
      .offset((strana - 1) * n)
      .execute();
    return { radky: radky.slice(0, n), dalsi: radky.length > n, strana };
  }

  /** akce: nadcházející (a probíhající), nebo proběhlé */
  async akce(v: { probehle?: boolean; limit?: number } = {}) {
    const ted = new Date();
    let q = this.db
      .selectFrom('web_obsah as o')
      .leftJoin('soubory as s', 's.id', 'o.obrazek_id')
      .select([
        'o.id',
        'o.titulek',
        'o.slug',
        'o.perex',
        'o.datum',
        'o.akce_konec',
        'o.akce_cely_den',
        'o.akce_misto',
        'o.obrazek_id',
        's.alt as obrazek_alt',
        's.puvodni_nazev as obrazek_nazev',
      ])
      .where('o.typ', '=', 'akce')
      .where('o.stav', '=', 'zverejneno')
      .where('o.smazano_at', 'is', null);
    const konec = sql<Date>`coalesce(o.akce_konec, o.datum + interval '1 day')`;
    q = v.probehle ? q.where(konec, '<', ted) : q.where(konec, '>=', ted);
    return q
      .orderBy('o.datum', v.probehle ? 'desc' : 'asc')
      .limit(v.limit ?? 50)
      .execute();
  }

  kategorie() {
    return this.db.selectFrom('web_kategorie').selectAll().orderBy('poradi').orderBy('nazev').execute();
  }

  /** seznam pro správu */
  async proSpravu(typ: TypObsahu, q = '', kos = false) {
    let dotaz = this.db
      .selectFrom('web_obsah as o')
      .leftJoin('uzivatele as u', 'u.id', 'o.upravil_id')
      .select([
        'o.id',
        'o.typ',
        'o.titulek',
        'o.slug',
        'o.stav',
        'o.datum',
        'o.koncept_at',
        'o.upraveno_at',
        'o.smazano_at',
        'o.zdroj',
        'u.jmeno',
        'u.prijmeni',
      ])
      .where('o.typ', '=', typ)
      .where('o.smazano_at', kos ? 'is not' : 'is', null);
    const tsq = tsDotaz(q);
    if (tsq)
      dotaz = dotaz.where(
        odpovida(
          sql`o.titulek || ' ' || o.perex || ' ' || regexp_replace(o.obsah_html, '<[^>]+>', ' ', 'g')`,
          tsq,
        ),
      );
    return dotaz
      .orderBy(typ === 'aktualita' || typ === 'akce' ? 'o.datum' : 'o.upraveno_at', 'desc')
      .limit(300)
      .execute();
  }

  async vKosi() {
    return this.db
      .selectFrom('web_obsah')
      .select(['id', 'typ', 'titulek', 'smazano_at'])
      .where('smazano_at', 'is not', null)
      .orderBy('smazano_at', 'desc')
      .limit(300)
      .execute();
  }

  /** fulltext ve zveřejněném obsahu */
  async hledej(q: string, limit = 30) {
    const tsq = tsDotaz(q);
    if (!tsq) return [];
    return (
      this.db
        .selectFrom('web_obsah')
        .select(['id', 'typ', 'titulek', 'slug', 'perex', 'nadrazena_id', 'odkaz_url', 'datum', 'obsah_html'])
        .where('stav', '=', 'zverejneno')
        .where('smazano_at', 'is', null)
        .where('typ', '!=', 'odkaz')
        // naplánované aktuality (datum v budoucnu) se nesmí najít dřív, než vyjdou
        .where((eb) =>
          eb.or([eb('typ', '!=', 'aktualita'), eb('datum', 'is', null), eb('datum', '<=', new Date())]),
        )
        .where(
          odpovida(
            sql`titulek || ' ' || perex || ' ' || regexp_replace(obsah_html, '<[^>]+>', ' ', 'g')`,
            tsq,
          ),
        )
        .orderBy(
          sql`ts_rank(to_tsvector('simple', f_unaccent(lower(titulek || ' ' || perex || ' ' || regexp_replace(obsah_html, '<[^>]+>', ' ', 'g')))), to_tsquery('simple', ${tsq}))`,
          'desc',
        )
        .orderBy('datum', 'desc')
        .limit(limit)
        .execute()
    );
  }
}
