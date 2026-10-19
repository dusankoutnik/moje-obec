// Obsah webu: stránky (strom menu, max 2 úrovně), aktuality, akce a odkazy v menu.
// Koncept vs. zveřejněno: nový obsah je koncept, dokud ho redaktor nezveřejní. Úprava zveřejněného obsahu se
// ukládá jako rozpracovaná (sloupec koncept) a na web jde až tlačítkem Zveřejnit. Každé zveřejnění a ruční
// uložení konceptu vytvoří revizi; ze starší revize jde obsah obnovit. Smazání = koš (obnovitelné).
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { odpovida, tsDotaz } from '../../lib/hledani.js';
import { slugify } from '../../lib/slug.js';

export const TYPY: TypObsahu[] = ['stranka', 'aktualita', 'akce', 'odkaz'];
export const MAX_REVIZI = 50;

// adresy, které patří aplikaci — stránka na nejvyšší úrovni se tak jmenovat nesmí
export const REZERVOVANE = new Set([
  'aktuality',
  'akce',
  'galerie',
  'videa',
  'dokumenty',
  'dotace',
  'hledat',
  'uredni-deska',
  'rozpocet',
  'povinne-informace',
  'kontakt',
  'prihlaseni',
  'ucet',
  'sprava',
  'infokanal',
  'oidc',
  'static',
  'soubory',
  'healthz',
  'webhook',
  'api',
  'odhlaseni',
  'prohlaseni-o-pristupnosti',
  'ochrana-osobnich-udaju',
  'sluzby',
  'robots.txt',
  'favicon.ico',
  'sitemap.xml',
  'mapa-stranek',
  'velikost', // volba velikosti písma návštěvníka (/velikost?v=…)
  'manifest.webmanifest',
  'apple-touch-icon.png',
]);

/** pole, která redaktor edituje (a která se ukládají do konceptu a revizí) */
export interface PoleObsahu {
  titulek: string;
  slug: string;
  nadrazena_id: string | null;
  v_menu: boolean;
  odkaz_url: string;
  perex: string;
  obsah_html: string;
  obrazek_id: string | null;
  kategorie_id: number | null;
  datum: string | null; // ISO
  akce_konec: string | null;
  akce_cely_den: boolean;
  akce_misto: string;
}

export const PRAZDNA_POLE: PoleObsahu = {
  titulek: '',
  slug: '',
  nadrazena_id: null,
  v_menu: true,
  odkaz_url: '',
  perex: '',
  obsah_html: '',
  obrazek_id: null,
  kategorie_id: null,
  datum: null,
  akce_konec: null,
  akce_cely_den: false,
  akce_misto: '',
};

export function poleZRadku(o: WebObsah): PoleObsahu {
  return {
    titulek: o.titulek,
    slug: o.slug,
    nadrazena_id: o.nadrazena_id,
    v_menu: o.v_menu,
    odkaz_url: o.odkaz_url,
    perex: o.perex,
    obsah_html: o.obsah_html,
    obrazek_id: o.obrazek_id,
    kategorie_id: o.kategorie_id,
    datum: o.datum ? o.datum.toISOString() : null,
    akce_konec: o.akce_konec ? o.akce_konec.toISOString() : null,
    akce_cely_den: o.akce_cely_den,
    akce_misto: o.akce_misto,
  };
}

/** co se zobrazí v editoru: rozpracovaná verze, jinak zveřejněná */
export function poleProEditor(o: WebObsah): PoleObsahu {
  return o.koncept ? { ...poleZRadku(o), ...(o.koncept as Partial<PoleObsahu>) } : poleZRadku(o);
}

function doSloupcu(p: PoleObsahu) {
  return {
    titulek: p.titulek,
    slug: p.slug,
    nadrazena_id: p.nadrazena_id,
    v_menu: p.v_menu,
    odkaz_url: p.odkaz_url,
    perex: p.perex,
    obsah_html: p.obsah_html,
    obrazek_id: p.obrazek_id,
    kategorie_id: p.kategorie_id,
    datum: p.datum ? new Date(p.datum) : null,
    akce_konec: p.akce_konec ? new Date(p.akce_konec) : null,
    akce_cely_den: p.akce_cely_den,
    akce_misto: p.akce_misto,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** slug odvozený z titulku (i s příponou -2, -obec), tj. redaktor ho nezadal ručně */
export function jeOdvozenySlug(slug: string, titulek: string): boolean {
  const z = slugify(titulek);
  if (!z) return false;
  if (slug === z) return true;
  const zbytek = slug.startsWith(`${z}-`) ? slug.slice(z.length + 1) : null;
  return zbytek !== null && /^(obec|obec-\d+|\d+)$/.test(zbytek);
}

/** opakovat při kolizi unikátního indexu (souběžné uložení obsadilo stejnou adresu) */
function jeKolize(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === '23505';
}

type AdresaObsahu = Pick<WebObsah, 'typ' | 'slug' | 'nadrazena_id' | 'odkaz_url'>;

/** veřejná adresa obsahu, když už je známá nadřazená stránka */
function adresaS(o: AdresaObsahu, rodic?: Pick<WebObsah, 'typ' | 'slug'> | null): string {
  if (o.typ === 'aktualita') return `/aktuality/${o.slug}`;
  if (o.typ === 'akce') return `/akce/${o.slug}`;
  if (o.typ === 'odkaz') return o.odkaz_url || '/';
  if (o.nadrazena_id && rodic && rodic.typ === 'stranka') return `/${rodic.slug}/${o.slug}`;
  return `/${o.slug}`;
}

export interface PolozkaMenu {
  id: string;
  titulek: string;
  url: string;
  deti: PolozkaMenu[];
}

export class ObsahSluzba {
  private menuCache: { cas: number; menu: PolozkaMenu[] } | null = null;
  constructor(private db: Db) {}

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

  async unikatniSlug(
    typ: TypObsahu,
    zaklad: string,
    ignorovat: string | null,
    nejvyssi: boolean,
    db: Db = this.db,
  ): Promise<string> {
    let slug = slugify(zaklad);
    if (typ === 'stranka' && nejvyssi && REZERVOVANE.has(slug)) slug = `${slug}-obec`;
    for (let i = 1; i < 500; i++) {
      const kandidat = i === 1 ? slug : `${slug}-${i}`;
      let q = db
        .selectFrom('web_obsah')
        .select('id')
        .where('typ', '=', typ)
        .where('slug', '=', kandidat)
        .where('smazano_at', 'is', null);
      if (ignorovat) q = q.where('id', '!=', ignorovat);
      if (!(await q.executeTakeFirst())) return kandidat;
    }
    return `${slug}-${Date.now()}`;
  }

  /**
   * Pole před zápisem do sloupců: adresa unikátní (a u dosud nezveřejněného konceptu znovu odvozená z titulku,
   * pokud ji redaktor nezadal ručně), nadřazená jen existující stránka nejvyšší úrovně, obrázek a kategorie jen
   * existující. Stejné pravidlo platí pro uložení z editoru i pro obnovu revize.
   */
  private async normalizuj(
    db: Db,
    typ: TypObsahu,
    pole: PoleObsahu,
    puvodni: WebObsah | undefined,
  ): Promise<PoleObsahu> {
    const p: PoleObsahu = { ...pole };
    if (p.nadrazena_id) {
      const rodic =
        (typ === 'stranka' || typ === 'odkaz') && UUID.test(p.nadrazena_id) && p.nadrazena_id !== puvodni?.id
          ? await db
              .selectFrom('web_obsah')
              .select(['typ', 'nadrazena_id'])
              .where('id', '=', p.nadrazena_id)
              .where('smazano_at', 'is', null)
              .executeTakeFirst()
          : undefined;
      const maDeti = puvodni
        ? !!(await db
            .selectFrom('web_obsah')
            .select('id')
            .where('nadrazena_id', '=', puvodni.id)
            .where('smazano_at', 'is', null)
            .executeTakeFirst())
        : false;
      if (!rodic || rodic.typ !== 'stranka' || rodic.nadrazena_id || maDeti) p.nadrazena_id = null;
    }
    if (
      p.obrazek_id &&
      !(
        UUID.test(p.obrazek_id) &&
        (await db.selectFrom('soubory').select('id').where('id', '=', p.obrazek_id).executeTakeFirst())
      )
    )
      p.obrazek_id = null;
    if (
      p.kategorie_id !== null &&
      !(
        Number.isSafeInteger(p.kategorie_id) &&
        (await db
          .selectFrom('web_kategorie')
          .select('id')
          .where('id', '=', p.kategorie_id)
          .executeTakeFirst())
      )
    )
      p.kategorie_id = null;
    // koncept, který ještě nikdy nebyl na webu: automatická adresa jde s titulkem (jinak by zůstala
    // „bez-nazvu“ z prvního automatického uložení prázdného formuláře)
    const automaticka =
      !!puvodni &&
      !puvodni.zverejneno_at &&
      puvodni.stav !== 'zverejneno' &&
      (!p.slug || p.slug === puvodni.slug) &&
      jeOdvozenySlug(puvodni.slug, puvodni.titulek);
    p.slug = await this.unikatniSlug(
      typ,
      automaticka ? p.titulek || p.slug : p.slug || p.titulek,
      puvodni?.id ?? null,
      !p.nadrazena_id,
      db,
    );
    return p;
  }

  /**
   * Uložení z editoru. `akce`: koncept = uložit rozpracované, zverejnit = na web, autosave = tiché uložení bez revize.
   * Vrací id obsahu. Celé v jedné transakci; když souběžné uložení (automatické + ruční) obsadí stejnou adresu,
   * zkusí se znovu s novou.
   */
  async uloz(
    id: string | null,
    typ: TypObsahu,
    pole: PoleObsahu,
    akce: 'koncept' | 'zverejnit' | 'autosave',
    aktorId: string | null,
    ip?: string | null,
    navic: {
      zdroj?: string;
      puvodniUrl?: string | null;
      hlaseniId?: string | null;
      zverejnenoAt?: Date | null;
    } = {},
  ): Promise<string> {
    // už v transakci (import jedné položky) — ta se při chybě vrací celá, opakuje ji volající
    if (this.db.isTransaction) return this.ulozV(this.db, id, typ, pole, akce, aktorId, ip, navic);
    for (let pokus = 1; ; pokus++) {
      try {
        const obsahId = await this.db
          .transaction()
          .execute((trx) => this.ulozV(trx, id, typ, pole, akce, aktorId, ip, navic));
        this.zmena();
        return obsahId;
      } catch (e) {
        if (pokus < 3 && jeKolize(e)) continue;
        throw e;
      }
    }
  }

  private async ulozV(
    db: Db,
    id: string | null,
    typ: TypObsahu,
    pole: PoleObsahu,
    akce: 'koncept' | 'zverejnit' | 'autosave',
    aktorId: string | null,
    ip: string | null | undefined,
    navic: {
      zdroj?: string;
      puvodniUrl?: string | null;
      hlaseniId?: string | null;
      zverejnenoAt?: Date | null;
    },
  ): Promise<string> {
    const puvodni =
      id && UUID.test(id)
        ? await db.selectFrom('web_obsah').selectAll().where('id', '=', id).forUpdate().executeTakeFirst()
        : undefined;
    const p = await this.normalizuj(db, typ, pole, puvodni);
    const ted = new Date();
    let obsahId: string;
    if (!puvodni) {
      const r = await db
        .insertInto('web_obsah')
        .values({
          ...doSloupcu(p),
          typ,
          stav: akce === 'zverejnit' ? 'zverejneno' : 'koncept',
          zverejneno_at: akce === 'zverejnit' ? (navic.zverejnenoAt ?? ted) : null,
          poradi: typ === 'stranka' || typ === 'odkaz' ? await this.dalsiPoradi(p.nadrazena_id, db) : 0,
          autor_id: aktorId,
          upravil_id: aktorId,
          zdroj: navic.zdroj ?? '',
          puvodni_url: navic.puvodniUrl ?? null,
          hlaseni_id: navic.hlaseniId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      obsahId = r.id;
    } else {
      obsahId = puvodni.id;
      if (puvodni.stav === 'zverejneno' && akce !== 'zverejnit') {
        // zveřejněný obsah: změny jen do konceptu, web zůstává beze změny
        await db
          .updateTable('web_obsah')
          .set({ koncept: JSON.stringify(p), koncept_at: ted, upravil_id: aktorId })
          .where('id', '=', obsahId)
          .execute();
      } else {
        const presun = puvodni.nadrazena_id !== p.nadrazena_id && (typ === 'stranka' || typ === 'odkaz');
        await db
          .updateTable('web_obsah')
          .set({
            ...doSloupcu(p),
            ...(presun ? { poradi: await this.dalsiPoradi(p.nadrazena_id, db) } : {}),
            stav: akce === 'zverejnit' ? 'zverejneno' : puvodni.stav,
            zverejneno_at: akce === 'zverejnit' ? (puvodni.zverejneno_at ?? ted) : puvodni.zverejneno_at,
            koncept: null,
            koncept_at: null,
            upravil_id: aktorId,
            upraveno_at: ted,
          })
          .where('id', '=', obsahId)
          .execute();
      }
    }
    if (akce !== 'autosave') {
      await db
        .insertInto('web_revize')
        .values({
          obsah_id: obsahId,
          data: JSON.stringify(p),
          duvod: akce === 'zverejnit' ? 'zverejneni' : 'koncept',
          autor_id: aktorId,
        })
        .execute();
      await sql`DELETE FROM web_revize WHERE obsah_id = ${obsahId} AND id NOT IN (
        SELECT id FROM web_revize WHERE obsah_id = ${obsahId} ORDER BY vytvoreno_at DESC, id DESC LIMIT ${MAX_REVIZI})`.execute(
        db,
      );
      await zapisAudit(db, {
        uzivatelId: aktorId,
        akce: akce === 'zverejnit' ? 'web.zverejneni' : 'web.koncept',
        detail: { id: obsahId, typ, titulek: p.titulek },
        ip,
      });
    }
    this.zmena();
    return obsahId;
  }

  async zahodKoncept(id: string, aktorId: string) {
    await this.db
      .updateTable('web_obsah')
      .set({ koncept: null, koncept_at: null })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.koncept_zahozen', detail: { id } });
  }

  /** zveřejněný obsah stáhnout z webu zpět do konceptu */
  async skryj(id: string, aktorId: string, ip?: string | null) {
    await this.db.updateTable('web_obsah').set({ stav: 'koncept' }).where('id', '=', id).execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.skryti', detail: { id }, ip });
    this.zmena();
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

  /** obnovení starší verze: načte se jako rozpracovaná (zveřejní ji až redaktor) */
  async obnovRevizi(obsahId: string, revizeId: number, aktorId: string, ip?: string | null) {
    const r = await this.db
      .selectFrom('web_revize')
      .selectAll()
      .where('id', '=', revizeId)
      .where('obsah_id', '=', obsahId)
      .executeTakeFirst();
    const o = await this.podleId(obsahId);
    if (!r || !o) return false;
    // stejná pravidla jako při uložení: adresa mezitím mohla obsadit jiná stránka, nadřazená stránka nebo
    // obrázek mohly zmizet
    const data = await this.normalizuj(
      this.db,
      o.typ,
      { ...poleZRadku(o), ...(r.data as Partial<PoleObsahu>) },
      o,
    );
    if (o.stav === 'zverejneno') {
      await this.db
        .updateTable('web_obsah')
        .set({ koncept: JSON.stringify(data), koncept_at: new Date(), upravil_id: aktorId })
        .where('id', '=', obsahId)
        .execute();
    } else {
      // nezveřejněný (i skrytý) obsah: obnovená verze přímo do sloupců, starý rozpracovaný koncept pryč
      await this.db
        .updateTable('web_obsah')
        .set({
          ...doSloupcu(data),
          koncept: null,
          koncept_at: null,
          upravil_id: aktorId,
          upraveno_at: new Date(),
        })
        .where('id', '=', obsahId)
        .execute();
    }
    this.zmena();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.obnoveni_revize',
      detail: { id: obsahId, revize: revizeId },
      ip,
    });
    return true;
  }

  async doKose(id: string, smazat: boolean, aktorId: string, ip?: string | null) {
    const o = await this.podleId(id);
    if (!o) return;
    if (!smazat) {
      // při obnově může být adresa mezitím obsazená
      const slug = await this.unikatniSlug(o.typ, o.slug, o.id, !o.nadrazena_id);
      await this.db.updateTable('web_obsah').set({ smazano_at: null, slug }).where('id', '=', id).execute();
    } else {
      await this.db.updateTable('web_obsah').set({ smazano_at: new Date() }).where('id', '=', id).execute();
      // podstránky smazané stránky se přesunou o úroveň výš (nic se neztratí)
      await this.db
        .updateTable('web_obsah')
        .set({ nadrazena_id: null })
        .where('nadrazena_id', '=', id)
        .execute();
    }
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'web.kos' : 'web.obnoveni',
      detail: { id, typ: o.typ, titulek: o.titulek },
      ip,
    });
    this.zmena();
  }

  private async dalsiPoradi(nadrazena: string | null, db: Db = this.db) {
    let q = db
      .selectFrom('web_obsah')
      .select((eb) => eb.fn.max('poradi').as('m'))
      .where('typ', 'in', ['stranka', 'odkaz']);
    q = nadrazena ? q.where('nadrazena_id', '=', nadrazena) : q.where('nadrazena_id', 'is', null);
    const r = await q.executeTakeFirst();
    return Number(r?.m ?? 0) + 10;
  }

  /** posun ve stromu o jedno místo nahoru/dolů mezi sourozenci */
  async posun(id: string, smer: 'nahoru' | 'dolu', aktorId: string) {
    const o = await this.podleId(id);
    if (!o) return;
    let q = this.db
      .selectFrom('web_obsah')
      .select(['id', 'poradi'])
      .where('typ', 'in', ['stranka', 'odkaz'])
      .where('smazano_at', 'is', null);
    q = o.nadrazena_id ? q.where('nadrazena_id', '=', o.nadrazena_id) : q.where('nadrazena_id', 'is', null);
    const sourozenci = await q.orderBy('poradi').orderBy('titulek').execute();
    const i = sourozenci.findIndex((s) => s.id === id);
    const j = smer === 'nahoru' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= sourozenci.length) return;
    [sourozenci[i], sourozenci[j]] = [sourozenci[j]!, sourozenci[i]!];
    await this.db.transaction().execute(async (trx) => {
      for (const [k, s] of sourozenci.entries())
        await trx
          .updateTable('web_obsah')
          .set({ poradi: (k + 1) * 10 })
          .where('id', '=', s.id)
          .execute();
    });
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.poradi', detail: { id, smer } });
    this.zmena();
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
