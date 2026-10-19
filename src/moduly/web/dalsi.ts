// Ostatní obsah webu: fotogalerie, dokumenty ke stažení, dotace (publicita dárců), přesměrování starých adres, vzhled.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import { zapisAudit } from '../../lib/audit.js';
import { datumPraha } from '../../lib/datum.js';
import { slugify } from '../../lib/slug.js';

export class GalerieSluzba {
  constructor(private db: Db) {}

  async unikatniSlug(nazev: string, ignorovat: string | null) {
    const zaklad = slugify(nazev);
    for (let i = 1; i < 500; i++) {
      const k = i === 1 ? zaklad : `${zaklad}-${i}`;
      let q = this.db
        .selectFrom('web_galerie')
        .select('id')
        .where('slug', '=', k)
        .where('smazano_at', 'is', null);
      if (ignorovat) q = q.where('id', '!=', ignorovat);
      if (!(await q.executeTakeFirst())) return k;
    }
    return `${zaklad}-${Date.now()}`;
  }

  async uloz(
    id: string | null,
    d: { nazev: string; popis: string; datum: string | null },
    aktorId: string | null,
    puvodniUrl?: string | null,
  ) {
    const slug = await this.unikatniSlug(d.nazev, id);
    if (id) {
      await this.db
        .updateTable('web_galerie')
        .set({ ...d, slug, upraveno_at: new Date() })
        .where('id', '=', id)
        .execute();
      return id;
    }
    const r = await this.db
      .insertInto('web_galerie')
      .values({ ...d, slug, autor_id: aktorId, puvodni_url: puvodniUrl ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.galerie',
      detail: { id: r.id, nazev: d.nazev },
    });
    return r.id;
  }

  podleId(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(undefined);
    return this.db.selectFrom('web_galerie').selectAll().where('id', '=', id).executeTakeFirst();
  }

  podleSlugu(slug: string) {
    return this.db
      .selectFrom('web_galerie')
      .selectAll()
      .where('slug', '=', slug)
      .where('stav', '=', 'zverejneno')
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
  }

  fotky(galerieId: string) {
    return this.db
      .selectFrom('web_galerie_fotky as f')
      .innerJoin('soubory as s', 's.id', 'f.soubor_id')
      .select(['s.id', 's.puvodni_nazev', 's.alt', 's.sirka', 's.vyska', 'f.poradi', 'f.popisek'])
      .where('f.galerie_id', '=', galerieId)
      .orderBy('f.poradi')
      .execute();
  }

  async pridejFotky(galerieId: string, souborIds: string[]) {
    if (!souborIds.length) return;
    const m = await this.db
      .selectFrom('web_galerie_fotky')
      .select((eb) => eb.fn.max('poradi').as('m'))
      .where('galerie_id', '=', galerieId)
      .executeTakeFirst();
    let poradi = Number(m?.m ?? 0) + 10;
    await this.db
      .insertInto('web_galerie_fotky')
      .values(souborIds.map((soubor_id) => ({ galerie_id: galerieId, soubor_id, poradi: (poradi += 10) })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async odeberFotky(galerieId: string, ids: string[]) {
    if (ids.length)
      await this.db
        .deleteFrom('web_galerie_fotky')
        .where('galerie_id', '=', galerieId)
        .where('soubor_id', 'in', ids)
        .execute();
  }

  async nastavPopisek(galerieId: string, souborId: string, popisek: string) {
    await this.db
      .updateTable('web_galerie_fotky')
      .set({ popisek })
      .where('galerie_id', '=', galerieId)
      .where('soubor_id', '=', souborId)
      .execute();
  }

  async posunFotku(galerieId: string, souborId: string, smer: 'nahoru' | 'dolu') {
    const f = await this.fotky(galerieId);
    const i = f.findIndex((x) => x.id === souborId);
    const j = smer === 'nahoru' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= f.length) return;
    [f[i], f[j]] = [f[j]!, f[i]!];
    for (const [k, x] of f.entries())
      await this.db
        .updateTable('web_galerie_fotky')
        .set({ poradi: (k + 1) * 10 })
        .where('galerie_id', '=', galerieId)
        .where('soubor_id', '=', x.id)
        .execute();
  }

  async nastavStav(id: string, stav: 'koncept' | 'zverejneno', aktorId: string) {
    await this.db
      .updateTable('web_galerie')
      .set({ stav, upraveno_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.galerie_stav', detail: { id, stav } });
  }

  async doKose(id: string, smazat: boolean, aktorId: string) {
    const g = await this.podleId(id);
    if (!g) return;
    const slug = smazat ? g.slug : await this.unikatniSlug(g.nazev, id);
    await this.db
      .updateTable('web_galerie')
      .set({ smazano_at: smazat ? new Date() : null, slug })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'web.galerie_kos' : 'web.galerie_obnova',
      detail: { id },
    });
  }

  /** seznam galerií s titulní fotkou a počtem fotek */
  async seznam(v: { verejne: boolean; kos?: boolean; limit?: number }) {
    let q = this.db
      .selectFrom('web_galerie as g')
      .selectAll('g')
      .select((eb) => [
        eb
          .selectFrom('web_galerie_fotky as f')
          .whereRef('f.galerie_id', '=', 'g.id')
          .select(eb.fn.countAll<number>().as('n'))
          .as('pocet'),
        eb
          .selectFrom('web_galerie_fotky as f')
          .innerJoin('soubory as s', 's.id', 'f.soubor_id')
          .whereRef('f.galerie_id', '=', 'g.id')
          .select('s.id')
          .orderBy('f.poradi')
          .limit(1)
          .as('titulni_id'),
        eb
          .selectFrom('web_galerie_fotky as f')
          .innerJoin('soubory as s', 's.id', 'f.soubor_id')
          .whereRef('f.galerie_id', '=', 'g.id')
          .select('s.alt')
          .orderBy('f.poradi')
          .limit(1)
          .as('titulni_alt'),
      ])
      .where('g.smazano_at', v.kos ? 'is not' : 'is', null);
    if (v.verejne) q = q.where('g.stav', '=', 'zverejneno');
    return q
      .orderBy(sql`coalesce(g.datum, g.vytvoreno_at::date)`, 'desc')
      .limit(v.limit ?? 200)
      .execute();
  }
}

export class DokumentySluzba {
  constructor(private db: Db) {}

  seznam(kos = false) {
    return this.db
      .selectFrom('web_dokumenty as d')
      .innerJoin('soubory as s', 's.id', 'd.soubor_id')
      .select([
        'd.id',
        'd.nazev',
        'd.popis',
        'd.skupina',
        'd.poradi',
        'd.vytvoreno_at',
        'd.smazano_at',
        's.id as soubor_id',
        's.puvodni_nazev',
        's.pripona',
        's.velikost',
      ])
      .where('d.smazano_at', kos ? 'is not' : 'is', null)
      .orderBy('d.skupina')
      .orderBy('d.poradi')
      .orderBy('d.nazev')
      .execute();
  }

  async pridej(
    d: { nazev: string; popis: string; skupina: string; souborId: string },
    aktorId: string | null,
  ) {
    const r = await this.db
      .insertInto('web_dokumenty')
      .values({
        nazev: d.nazev,
        popis: d.popis,
        skupina: d.skupina,
        soubor_id: d.souborId,
        autor_id: aktorId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.dokument',
      detail: { id: r.id, nazev: d.nazev },
    });
    return r.id;
  }

  async uprav(id: string, d: { nazev: string; popis: string; skupina: string }) {
    await this.db.updateTable('web_dokumenty').set(d).where('id', '=', id).execute();
  }

  async doKose(id: string, smazat: boolean, aktorId: string) {
    await this.db
      .updateTable('web_dokumenty')
      .set({ smazano_at: smazat ? new Date() : null })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'web.dokument_kos' : 'web.dokument_obnova',
      detail: { id },
    });
  }

  async skupiny() {
    const r = await this.db
      .selectFrom('web_dokumenty')
      .select('skupina')
      .distinct()
      .where('smazano_at', 'is', null)
      .where('skupina', '!=', '')
      .orderBy('skupina')
      .execute();
    return r.map((x) => x.skupina);
  }
}

export interface DataDotace {
  projekt: string;
  poskytovatel: string;
  text: string;
  odkaz: string;
}

type AktivniDotace = Awaited<ReturnType<DotaceSluzba['nactiAktivni']>>;

export class DotaceSluzba {
  // pás dárců je v patičce každé stránky — keš jako u menu (minuta, zahodí se při změně)
  private kes = new Map<string, { cas: number; data: AktivniDotace }>();
  constructor(private db: Db) {}

  zmena() {
    this.kes.clear();
  }

  podleId(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(undefined);
    return this.db.selectFrom('web_dotace').selectAll().where('id', '=', id).executeTakeFirst();
  }

  loga(dotaceId: string) {
    return this.db
      .selectFrom('web_dotace_loga as l')
      .innerJoin('soubory as s', 's.id', 'l.soubor_id')
      .select(['s.id', 's.puvodni_nazev', 's.alt', 's.sirka', 's.vyska', 'l.poradi'])
      .where('l.dotace_id', '=', dotaceId)
      .orderBy('l.poradi')
      .execute();
  }

  async uloz(id: string | null, d: DataDotace, aktorId: string | null, puvodniUrl?: string | null) {
    this.zmena();
    if (id) {
      await this.db
        .updateTable('web_dotace')
        .set({ ...d, upraveno_at: new Date() })
        .where('id', '=', id)
        .execute();
      return id;
    }
    const r = await this.db
      .insertInto('web_dotace')
      .values({
        ...d,
        autor_id: aktorId,
        puvodni_url: puvodniUrl ?? null,
        zobrazit_od: datumPraha(new Date()),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.dotace',
      detail: { id: r.id, projekt: d.projekt },
    });
    return r.id;
  }

  async pridejLoga(id: string, souborIds: string[]) {
    this.zmena();
    if (!souborIds.length) return;
    const m = await this.db
      .selectFrom('web_dotace_loga')
      .select((eb) => eb.fn.max('poradi').as('m'))
      .where('dotace_id', '=', id)
      .executeTakeFirst();
    let p = Number(m?.m ?? 0);
    await this.db
      .insertInto('web_dotace_loga')
      .values(souborIds.map((soubor_id) => ({ dotace_id: id, soubor_id, poradi: (p += 10) })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async odeberLogo(id: string, souborId: string) {
    this.zmena();
    await this.db
      .deleteFrom('web_dotace_loga')
      .where('dotace_id', '=', id)
      .where('soubor_id', '=', souborId)
      .execute();
  }

  async zobrazeni(
    id: string,
    z: { od: string; do: string | null; vPaticce: boolean; poradi: number },
    aktorId: string | null,
  ) {
    this.zmena();
    await this.db
      .updateTable('web_dotace')
      .set({
        zobrazit_od: z.od,
        zobrazit_do: z.do,
        v_paticce: z.vPaticce,
        poradi: z.poradi,
        stav: 'hotovo',
        upozorneno_at: null,
        upraveno_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'web.dotace_zobrazeni', detail: { id, ...z } });
  }

  async doKose(id: string, smazat: boolean, aktorId: string) {
    this.zmena();
    await this.db
      .updateTable('web_dotace')
      .set({ smazano_at: smazat ? new Date() : null })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'web.dotace_kos' : 'web.dotace_obnova',
      detail: { id },
    });
  }

  /** dotace, které se mají právě zobrazovat (hotové, v období od–do), s logy */
  async aktivni(jenPaticka = false): Promise<AktivniDotace> {
    const dnes = datumPraha(new Date());
    const klic = `${dnes}|${jenPaticka}`;
    const k = this.kes.get(klic);
    if (k && Date.now() - k.cas < 60_000) return k.data;
    const data = await this.nactiAktivni(dnes, jenPaticka);
    this.kes.set(klic, { cas: Date.now(), data });
    return data;
  }

  /** bez keše (aktivni() je kešovaná) */
  async nactiAktivni(dnes: string, jenPaticka: boolean) {
    let q = this.db
      .selectFrom('web_dotace')
      .selectAll()
      .where('stav', '=', 'hotovo')
      .where('smazano_at', 'is', null)
      .where('zobrazit_od', '<=', dnes)
      .where((eb) => eb.or([eb('zobrazit_do', 'is', null), eb('zobrazit_do', '>=', dnes)]));
    if (jenPaticka) q = q.where('v_paticce', '=', true);
    const dotace = await q.orderBy('poradi').orderBy('vytvoreno_at').execute();
    const loga = dotace.length
      ? await this.db
          .selectFrom('web_dotace_loga as l')
          .innerJoin('soubory as s', 's.id', 'l.soubor_id')
          .select(['l.dotace_id', 's.id', 's.puvodni_nazev', 's.alt', 's.sirka', 's.vyska'])
          .where(
            'l.dotace_id',
            'in',
            dotace.map((d) => d.id),
          )
          .orderBy('l.poradi')
          .execute()
      : [];
    return dotace.map((d) => ({ ...d, loga: loga.filter((l) => l.dotace_id === d.id) }));
  }

  async seznam(kos = false) {
    return this.db
      .selectFrom('web_dotace as d')
      .selectAll('d')
      .select((eb) =>
        eb
          .selectFrom('web_dotace_loga as l')
          .whereRef('l.dotace_id', '=', 'd.id')
          .select(eb.fn.countAll<number>().as('n'))
          .as('log'),
      )
      .where('d.smazano_at', kos ? 'is not' : 'is', null)
      .orderBy('d.poradi')
      .orderBy('d.vytvoreno_at', 'desc')
      .execute();
  }

  /** dotace, jejichž zobrazení skončí do `dni` dní a správci o tom ještě nevědí */
  async koncici(dni = 30) {
    const dnes = datumPraha(new Date());
    return this.db
      .selectFrom('web_dotace')
      .selectAll()
      .where('stav', '=', 'hotovo')
      .where('smazano_at', 'is', null)
      .where('zobrazit_do', 'is not', null)
      .where('zobrazit_do', '>=', dnes)
      .where(sql<boolean>`zobrazit_do <= ${dnes}::date + ${dni}::int`)
      .orderBy('zobrazit_do')
      .execute();
  }

  async oznacUpozorneno(ids: string[]) {
    if (ids.length)
      await this.db
        .updateTable('web_dotace')
        .set({ upozorneno_at: new Date() })
        .where('id', 'in', ids)
        .execute();
  }
}

export class PresmerovaniSluzba {
  constructor(private db: Db) {}

  static normalizuj(cesta: string): string {
    let c = cesta.trim();
    try {
      if (/^https?:\/\//i.test(c)) {
        const u = new URL(c);
        c = u.pathname + u.search;
      }
    } catch {
      /* necháme jak je */
    }
    c = decodeURIComponentBezpecne(c).split('#')[0]!;
    if (!c.startsWith('/')) c = '/' + c;
    // koncové lomítko nehraje roli (WordPress ho používá, my ne)
    const [cesta2, dotaz] = c.split('?');
    const bez = cesta2!.length > 1 ? cesta2!.replace(/\/+$/, '') : cesta2!;
    return (dotaz ? `${bez}?${dotaz}` : bez).toLowerCase();
  }

  async najdi(cesta: string): Promise<string | null> {
    const klic = PresmerovaniSluzba.normalizuj(cesta);
    const bezDotazu = klic.split('?')[0]!;
    const r = await this.db
      .selectFrom('web_presmerovani')
      .select(['stara_cesta', 'nova_cesta'])
      .where('stara_cesta', 'in', [klic, bezDotazu])
      .orderBy(sql`length(stara_cesta)`, 'desc')
      .executeTakeFirst();
    if (!r) return null;
    await this.db
      .updateTable('web_presmerovani')
      .set((eb) => ({ pocet: eb('pocet', '+', 1), posledni_at: new Date() }))
      .where('stara_cesta', '=', r.stara_cesta)
      .execute();
    return r.nova_cesta;
  }

  /** cíl přesměrování bez započítání použití (pro import) */
  async cil(cesta: string): Promise<string | null> {
    const r = await this.db
      .selectFrom('web_presmerovani')
      .select('nova_cesta')
      .where('stara_cesta', '=', PresmerovaniSluzba.normalizuj(cesta))
      .executeTakeFirst();
    return r?.nova_cesta ?? null;
  }

  /**
   * Přidá (nebo změní) přesměrování. Vrací `stejna`, když by vedlo samo na sebe (i jen jinak zapsaná adresa,
   * např. /a → /a/), a `smycka`, když by se řetězec přesměrování uzavřel do kruhu (/a → /b → /a) nebo byl
   * delší než MAX_SKOKU — takové se neuloží.
   */
  async pridej(stara: string, nova: string): Promise<'ulozeno' | 'stejna' | 'smycka'> {
    const klic = PresmerovaniSluzba.normalizuj(stara);
    const cil = PresmerovaniSluzba.lokalniCil(nova);
    if (!klic || klic === '/' || (cil !== null && cil.split('?')[0] === klic.split('?')[0])) return 'stejna';
    // projít řetězec od cíle: kdyby se vrátil na starou adresu, vznikla by smyčka
    let dalsi = cil;
    for (let skok = 0; dalsi !== null; skok++) {
      if (skok >= PresmerovaniSluzba.MAX_SKOKU) return 'smycka';
      const bezDotazu = dalsi.split('?')[0]!;
      const r = await this.db
        .selectFrom('web_presmerovani')
        .select(['stara_cesta', 'nova_cesta'])
        .where('stara_cesta', 'in', [dalsi, bezDotazu])
        .orderBy(sql`length(stara_cesta)`, 'desc')
        .executeTakeFirst();
      if (!r || r.stara_cesta === klic) break; // přepisujeme právě tento záznam
      dalsi = PresmerovaniSluzba.lokalniCil(r.nova_cesta);
      if (dalsi !== null && dalsi.split('?')[0] === klic.split('?')[0]) return 'smycka';
    }
    await this.db
      .insertInto('web_presmerovani')
      .values({ stara_cesta: klic, nova_cesta: nova })
      .onConflict((oc) => oc.column('stara_cesta').doUpdateSet({ nova_cesta: nova }))
      .execute();
    return 'ulozeno';
  }

  static readonly MAX_SKOKU = 5;

  /** cíl přesměrování jako klíč tabulky, jde-li o adresu na tomto webu (cesta /…); jinak null */
  static lokalniCil(nova: string): string | null {
    const n = nova.trim();
    return /^\/(?![/\\])/.test(n) ? PresmerovaniSluzba.normalizuj(n) : null;
  }

  async smaz(stara: string) {
    await this.db.deleteFrom('web_presmerovani').where('stara_cesta', '=', stara).execute();
  }

  seznam(limit = 500) {
    return this.db
      .selectFrom('web_presmerovani')
      .selectAll()
      .orderBy('pocet', 'desc')
      .orderBy('stara_cesta')
      .limit(limit)
      .execute();
  }

  async pocet() {
    const r = await this.db
      .selectFrom('web_presmerovani')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }
}

function decodeURIComponentBezpecne(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
