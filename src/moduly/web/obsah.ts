// Obsah webu: stránky (strom menu, max 2 úrovně), aktuality, akce a odkazy v menu.
// Koncept vs. zveřejněno: nový obsah je koncept, dokud ho redaktor nezveřejní. Úprava zveřejněného obsahu se
// ukládá jako rozpracovaná (sloupec koncept) a na web jde až tlačítkem Zveřejnit. Každé zveřejnění a ruční
// uložení konceptu vytvoří revizi; ze starší revize jde obsah obnovit. Smazání = koš (obnovitelné).
// Čtení je v obsah-cteni.ts, pole a pomůcky v obsah-pole.ts; tady je zápis.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { TypObsahu, WebObsah } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { slugify } from '../../lib/slug.js';
import { ObsahCteni } from './obsah-cteni.js';
import {
  doSloupcu,
  jeKolize,
  jeOdvozenySlug,
  MAX_REVIZI,
  poleZRadku,
  REZERVOVANE,
  UUID,
  type PoleObsahu,
} from './obsah-pole.js';

export {
  jeOdvozenySlug,
  MAX_REVIZI,
  PRAZDNA_POLE,
  poleProEditor,
  poleZRadku,
  REZERVOVANE,
  TYPY,
  type PoleObsahu,
  type PolozkaMenu,
} from './obsah-pole.js';

export class ObsahSluzba extends ObsahCteni {
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
}
