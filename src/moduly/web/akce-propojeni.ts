// Propojení akcí webu s rezervačním systémem (docs/AKCE-PROPOJENI.md).
// Jedna akce = jeden záznam obsahu typu „akce“; termín v rezervacích se k němu připojí přes rezervace_ref.
// Synchronizace (cron à 10 min + při otevření „Akce ke zpracování“) je idempotentní: pro veřejný termín bez
// propojení buď navrhne propojení s podobnou akcí webu (stejný den + podobný název nebo překryv času), nebo
// založí KONCEPT akce (nikdy rovnou zveřejněný). Změny termínu a zrušené rezervace jen ukazuje — web se sám
// nemění, rozhoduje redaktor. Nic se nemaže natvrdo: koncept jde do koše, „jen v kalendáři“ = záznam ignorovaných.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { WebObsah } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { datumPraha } from '../../lib/datum.js';
import { escapujHtml } from '../../lib/html.js';
import { bezDiakritiky } from '../../lib/kontakty.js';
import { podpisTerminu, type ExterniAkce, type ExterniKalendar } from './akce-externi.js';
import { PRAZDNA_POLE, poleZRadku, type ObsahSluzba, type PoleObsahu } from './obsah.js';

const DVE_HODINY = 2 * 3600_000;

/** slova názvu bez diakritiky a velikosti písmen (krátká slova a spojky se nepočítají) */
export function slovaNazvu(nazev: string): string[] {
  return bezDiakritiky(nazev)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

/** podobné názvy: jeden obsahuje druhý, nebo mají společné aspoň jedno delší slovo */
export function podobneNazvy(a: string, b: string): boolean {
  const na = slovaNazvu(a).join(' ');
  const nb = slovaNazvu(b).join(' ');
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const sb = new Set(nb.split(' '));
  return na.split(' ').some((w) => sb.has(w));
}

type AkceProShodu = Pick<WebObsah, 'id' | 'titulek' | 'datum' | 'akce_konec' | 'akce_cely_den'>;

/** odpovídá akce webu termínu z rezervací? Stejný den (u vícedenní akce kterýkoli její den) a podobný název
 * nebo překryv času (jen když oba mají konkrétní čas). */
export function jeShoda(akce: AkceProShodu, e: ExterniAkce): boolean {
  if (!akce.datum) return false;
  const denOd = datumPraha(akce.datum);
  const denDo = akce.akce_konec ? datumPraha(akce.akce_konec) : denOd;
  if (e.den < denOd || e.den > denDo) return false;
  if (podobneNazvy(akce.titulek, e.titulek)) return true;
  if (akce.akce_cely_den || e.akce_cely_den) return false;
  const aOd = akce.datum.getTime();
  const aDo = akce.akce_konec?.getTime() ?? aOd + DVE_HODINY;
  const eOd = e.datum.getTime();
  const eDo = e.akce_konec?.getTime() ?? eOd + DVE_HODINY;
  return aOd < eDo && eOd < aDo;
}

/** pole konceptu akce z termínu v rezervacích */
export function poleZTerminu(e: ExterniAkce, textPredprodeje: string): PoleObsahu {
  const odkaz = e.url && /^https:\/\//.test(e.url) ? e.url : null;
  return {
    ...PRAZDNA_POLE,
    titulek: e.titulek.slice(0, 250) || '—',
    perex: (e.opakovani ? `${e.opakovani.replace(/, nejbližší.*$/, '')}.` : e.perex).slice(0, 600),
    obsah_html: odkaz ? `<p><a href="${escapujHtml(odkaz)}">${escapujHtml(textPredprodeje)}</a></p>` : '',
    datum: e.datum.toISOString(),
    akce_konec: e.akce_konec ? e.akce_konec.toISOString() : null,
    akce_cely_den: e.akce_cely_den,
    akce_misto: e.akce_misto.slice(0, 200),
  };
}

export interface NavrhPropojeni {
  termin: ExterniAkce;
  kandidati: { id: string; titulek: string; datum: Date | null; stav: string }[];
}
export interface ZmenaTerminu {
  akce: WebObsah;
  termin: ExterniAkce;
}
export interface PrehledZpracovani {
  dostupny: boolean;
  /** koncepty založené synchronizací, které čekají na redaktora */
  koncepty: (WebObsah & { termin: ExterniAkce | null })[];
  navrhy: NavrhPropojeni[];
  /** veřejné termíny bez akce na webu a bez konceptu (zakládání konceptů vypnuté) */
  bezAkce: ExterniAkce[];
  zmeny: ZmenaTerminu[];
  zrusene: WebObsah[];
}

export class AkcePropojeniSluzba {
  constructor(
    private db: Db,
    private obsah: ObsahSluzba,
    private kalendar: ExterniKalendar,
    private volby: () => { koncepty: boolean; textPredprodeje: string },
  ) {}

  /** propojené akce webu (nesmazané) podle odkazů */
  private propojeneVse() {
    return this.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('typ', '=', 'akce')
      .where('rezervace_ref', 'is not', null)
      .where('smazano_at', 'is', null)
      .execute();
  }

  /** zveřejněné akce propojené s danými termíny (pro kalendář a úvod) */
  async zverejnenePropojene(refs: string[]) {
    if (!refs.length) return [];
    return this.db
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
        'o.rezervace_ref',
        's.alt as obrazek_alt',
        's.puvodni_nazev as obrazek_nazev',
      ])
      .where('o.typ', '=', 'akce')
      .where('o.stav', '=', 'zverejneno')
      .where('o.smazano_at', 'is', null)
      .where('o.rezervace_ref', 'in', refs)
      .execute();
  }

  private async ignorovane(): Promise<Set<string>> {
    const r = await this.db.selectFrom('web_akce_ignorovane').select('ref').execute();
    return new Set(r.map((x) => x.ref));
  }

  /** odkazy, které už nějaký záznam má — i v koši (smazaný koncept = redaktor ho nechce, nezakládat znovu) */
  private async znameRefs(): Promise<Set<string>> {
    const r = await this.db
      .selectFrom('web_obsah')
      .select('rezervace_ref')
      .where('rezervace_ref', 'is not', null)
      .execute();
    return new Set(r.map((x) => x.rezervace_ref!));
  }

  /** nepropojené akce webu, které by mohly odpovídat termínu */
  private async kandidati(od: Date) {
    return this.db
      .selectFrom('web_obsah')
      .select(['id', 'titulek', 'datum', 'akce_konec', 'akce_cely_den', 'stav'])
      .where('typ', '=', 'akce')
      .where('rezervace_ref', 'is', null)
      .where('smazano_at', 'is', null)
      .where(sql<Date>`coalesce(akce_konec, datum + interval '1 day')`, '>=', od)
      .orderBy('datum')
      .execute();
  }

  /** koncept akce ze synchronizace = založený systémem a nikdy nezveřejněný */
  private jeKonceptSynchronizace(o: WebObsah) {
    return o.zdroj === 'rezervace' && o.stav === 'koncept' && !o.zverejneno_at;
  }

  /**
   * Synchronizace s rezervacemi: koncepty pro nové veřejné termíny bez shody, u konceptů ze synchronizace
   * (ještě nezveřejněných) tiché srovnání termínu. Vrací počet založených konceptů. Bez dostupného zdroje nic.
   */
  async synchronizuj(ted = new Date()): Promise<{ zalozeno: number }> {
    const { dostupny, akce } = await this.kalendar.nacti(ted);
    if (!dostupny) return { zalozeno: 0 };
    const [ignorovane, zname, kandidati, propojene] = await Promise.all([
      this.ignorovane(),
      this.znameRefs(),
      this.kandidati(new Date(ted.getTime() - 86_400_000)),
      this.propojeneVse(),
    ]);
    // koncepty ze synchronizace: termín v rezervacích se změnil → koncept se srovná sám (na webu ještě není)
    const podleRef = new Map(akce.map((e) => [e.ref, e]));
    for (const o of propojene) {
      const e = podleRef.get(o.rezervace_ref!);
      if (!e || !this.jeKonceptSynchronizace(o)) continue;
      // přejmenování v rezervacích: koncept, na který redaktor ještě nesáhl, převezme nový název
      const nazev = e.titulek.slice(0, 250) || '—';
      if (!o.upravil_id && !o.koncept && o.titulek !== nazev) {
        await this.obsah.uloz(o.id, 'akce', { ...poleZRadku(o), titulek: nazev }, 'koncept', null, null, {
          zdroj: 'rezervace',
        });
        o.titulek = nazev;
      }
      if (podpisTerminu(e) !== o.rezervace_termin)
        await this.nastavTermin(o, e, null, 'web.akce_termin_sync');
    }
    let zalozeno = 0;
    if (!this.volby().koncepty) return { zalozeno };
    for (const e of akce) {
      if (zname.has(e.ref) || ignorovane.has(e.ref)) continue;
      if (kandidati.some((k) => jeShoda(k, e))) continue; // návrh propojení ukáže správa
      if (await this.zalozKoncept(e, null)) zalozeno++;
    }
    return { zalozeno };
  }

  /** založí koncept akce k termínu; vrací id, nebo null, když termín mezitím propojil někdo jiný */
  async zalozKoncept(e: ExterniAkce, aktorId: string | null, ip?: string | null): Promise<string | null> {
    try {
      return await this.obsah.uloz(
        null,
        'akce',
        poleZTerminu(e, this.volby().textPredprodeje),
        'koncept',
        aktorId,
        ip,
        { zdroj: 'rezervace', rezervaceRef: e.ref, rezervaceTermin: podpisTerminu(e) },
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
  }

  /** co čeká na redaktora (stránka „Akce ke zpracování“) */
  async prehled(ted = new Date()): Promise<PrehledZpracovani> {
    const { dostupny, akce } = await this.kalendar.nacti(ted);
    const [ignorovane, zname, kandidati, propojene] = await Promise.all([
      this.ignorovane(),
      this.znameRefs(),
      this.kandidati(new Date(ted.getTime() - 86_400_000)),
      this.propojeneVse(),
    ]);
    const podleRef = new Map(akce.map((e) => [e.ref, e]));
    const neprobehla = (o: WebObsah) =>
      !!o.datum && (o.akce_konec ?? new Date(o.datum.getTime() + 86_400_000)) >= ted;
    const v: PrehledZpracovani = { dostupny, koncepty: [], navrhy: [], bezAkce: [], zmeny: [], zrusene: [] };
    for (const o of propojene) {
      const e = podleRef.get(o.rezervace_ref!);
      if (!e) {
        // zmizení z rezervací poznáme jen při dostupném zdroji; proběhlá akce z API vypadne přirozeně
        if (dostupny && neprobehla(o)) v.zrusene.push(o);
        continue;
      }
      if (this.jeKonceptSynchronizace(o)) v.koncepty.push({ ...o, termin: e });
      else if (o.rezervace_termin !== podpisTerminu(e)) v.zmeny.push({ akce: o, termin: e });
    }
    for (const e of akce) {
      if (zname.has(e.ref) || ignorovane.has(e.ref)) continue;
      const k = kandidati.filter((x) => jeShoda(x, e));
      if (k.length)
        v.navrhy.push({
          termin: e,
          kandidati: k.map((x) => ({ id: x.id, titulek: x.titulek, datum: x.datum, stav: x.stav })),
        });
      else v.bezAkce.push(e);
    }
    v.koncepty.sort((a, b) => (a.datum?.getTime() ?? 0) - (b.datum?.getTime() ?? 0));
    return v;
  }

  async pocet(ted = new Date()): Promise<number> {
    const p = await this.prehled(ted);
    return p.koncepty.length + p.navrhy.length + p.bezAkce.length + p.zmeny.length + p.zrusene.length;
  }

  /** termín z aktuálních dat rezervací */
  async termin(ref: string, ted = new Date()): Promise<ExterniAkce | undefined> {
    return (await this.kalendar.nacti(ted)).akce.find((e) => e.ref === ref);
  }

  /** nabídka pro editor akce: nadcházející veřejné termíny bez propojení (+ termín této akce) */
  async nabidkaProEditor(akceId: string | null, ted = new Date()) {
    const { akce } = await this.kalendar.nacti(ted);
    const obsazene = await this.db
      .selectFrom('web_obsah')
      .select(['rezervace_ref', 'id'])
      .where('rezervace_ref', 'is not', null)
      .where('smazano_at', 'is', null)
      .execute();
    // koncept ze synchronizace termín „drží“ jen do propojení s jinou akcí — nabízí se taky
    const drzi = new Map(obsazene.map((x) => [x.rezervace_ref!, x.id]));
    const koncepty = new Set(
      (
        await this.db
          .selectFrom('web_obsah')
          .select('id')
          .where('zdroj', '=', 'rezervace')
          .where('stav', '=', 'koncept')
          .where('zverejneno_at', 'is', null)
          .where('smazano_at', 'is', null)
          .execute()
      ).map((x) => x.id),
    );
    return akce.filter((e) => {
      const kdo = drzi.get(e.ref);
      return !kdo || kdo === akceId || koncepty.has(kdo);
    });
  }

  /**
   * Propojí akci webu s termínem. Termín držený konceptem ze synchronizace přejde (koncept do koše);
   * termín propojený s jinou akcí se nepřebírá. Termín se musí dát najít v rezervacích.
   */
  async propoj(
    akceId: string,
    ref: string,
    aktorId: string,
    ip?: string | null,
  ): Promise<'ok' | 'nenalezeno' | 'obsazeno'> {
    const akce = await this.obsah.podleId(akceId);
    if (!akce || akce.typ !== 'akce' || akce.smazano_at) return 'nenalezeno';
    if (akce.rezervace_ref === ref) return 'ok';
    const e = await this.termin(ref);
    if (!e) return 'nenalezeno';
    const drzitel = await this.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('rezervace_ref', '=', ref)
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
    if (drzitel && !this.jeKonceptSynchronizace(drzitel)) return 'obsazeno';
    try {
      await this.db.transaction().execute(async (trx) => {
        if (drzitel) {
          await trx
            .updateTable('web_obsah')
            .set({ rezervace_ref: null, rezervace_termin: null, smazano_at: new Date() })
            .where('id', '=', drzitel.id)
            .execute();
          await zapisAudit(trx, {
            uzivatelId: aktorId,
            akce: 'web.kos',
            detail: { id: drzitel.id, typ: 'akce', titulek: drzitel.titulek, duvod: 'propojeni' },
            ip,
          });
        }
        await trx
          .updateTable('web_obsah')
          .set({ rezervace_ref: ref, rezervace_termin: podpisTerminu(e) })
          .where('id', '=', akceId)
          .execute();
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'obsazeno';
      throw err;
    }
    await this.db.deleteFrom('web_akce_ignorovane').where('ref', '=', ref).execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.akce_propojeni',
      detail: { id: akceId, ref, z_konceptu: drzitel?.id ?? null },
      ip,
    });
    this.obsah.zmena();
    return 'ok';
  }

  /** zruší propojení (akce zůstává, jen bez vazby na rezervace) */
  async odpoj(akceId: string, aktorId: string, ip?: string | null) {
    const akce = await this.obsah.podleId(akceId);
    if (!akce?.rezervace_ref) return;
    await this.db
      .updateTable('web_obsah')
      .set({ rezervace_ref: null, rezervace_termin: null })
      .where('id', '=', akceId)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.akce_odpojeni',
      detail: { id: akceId, ref: akce.rezervace_ref },
      ip,
    });
    this.obsah.zmena();
  }

  /** „jen v kalendáři“: termín se zapamatuje, koncept ze synchronizace (je-li) jde do koše */
  async ignoruj(ref: string, aktorId: string, ip?: string | null) {
    const e = await this.termin(ref);
    const koncept = await this.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('rezervace_ref', '=', ref)
      .where('smazano_at', 'is', null)
      .executeTakeFirst();
    await this.db
      .insertInto('web_akce_ignorovane')
      .values({ ref, nazev: (e?.titulek ?? koncept?.titulek ?? '').slice(0, 250), kdo: aktorId })
      .onConflict((oc) => oc.column('ref').doNothing())
      .execute();
    if (koncept && this.jeKonceptSynchronizace(koncept)) {
      await this.db
        .updateTable('web_obsah')
        .set({ rezervace_ref: null, rezervace_termin: null })
        .where('id', '=', koncept.id)
        .execute();
      await this.obsah.doKose(koncept.id, true, aktorId, ip);
    }
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.akce_ignorovani',
      detail: { ref, nazev: e?.titulek ?? null, koncept: koncept?.id ?? null },
      ip,
    });
  }

  /** zrušení „jen v kalendáři“ — při další synchronizaci se termín zpracuje znovu */
  async zrusIgnorovani(ref: string, aktorId: string, ip?: string | null) {
    await this.db.deleteFrom('web_akce_ignorovane').where('ref', '=', ref).execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.akce_ignorovani_zruseno',
      detail: { ref },
      ip,
    });
  }

  seznamIgnorovanych() {
    return this.db.selectFrom('web_akce_ignorovane').selectAll().orderBy('kdy', 'desc').limit(200).execute();
  }

  /** převezme termín z rezervací do akce (zveřejněná se změní hned — rozhodl redaktor) */
  async prevezmiTermin(akceId: string, aktorId: string, ip?: string | null): Promise<boolean> {
    const akce = await this.obsah.podleId(akceId);
    if (!akce?.rezervace_ref) return false;
    const e = await this.termin(akce.rezervace_ref);
    if (!e) return false;
    await this.nastavTermin(akce, e, aktorId, 'web.akce_termin', ip);
    return true;
  }

  /** změnu termínu vzít na vědomí, akce na webu zůstane, jak je */
  async ponechTermin(akceId: string, aktorId: string, ip?: string | null): Promise<boolean> {
    const akce = await this.obsah.podleId(akceId);
    if (!akce?.rezervace_ref) return false;
    const e = await this.termin(akce.rezervace_ref);
    if (!e) return false;
    await this.db
      .updateTable('web_obsah')
      .set({ rezervace_termin: podpisTerminu(e) })
      .where('id', '=', akceId)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: 'web.akce_termin_ponechan',
      detail: { id: akceId, ref: akce.rezervace_ref, termin: podpisTerminu(e) },
      ip,
    });
    return true;
  }

  private async nastavTermin(
    akce: WebObsah,
    e: ExterniAkce,
    aktorId: string | null,
    auditAkce: string,
    ip?: string | null,
  ) {
    const termin = {
      datum: e.datum.toISOString(),
      akce_konec: e.akce_konec ? e.akce_konec.toISOString() : null,
      akce_cely_den: e.akce_cely_den,
    };
    // rozpracované změny redaktora (koncept u zveřejněné akce) dostanou nový termín taky
    const koncept = akce.koncept
      ? JSON.stringify({ ...poleZRadku(akce), ...(akce.koncept as Partial<PoleObsahu>), ...termin })
      : null;
    await this.db
      .updateTable('web_obsah')
      .set({
        datum: e.datum,
        akce_konec: e.akce_konec,
        akce_cely_den: e.akce_cely_den,
        rezervace_termin: podpisTerminu(e),
        ...(koncept ? { koncept } : {}),
        upraveno_at: new Date(),
        ...(aktorId ? { upravil_id: aktorId } : {}),
      })
      .where('id', '=', akce.id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: auditAkce,
      detail: {
        id: akce.id,
        ref: akce.rezervace_ref,
        puvodne: akce.datum?.toISOString() ?? null,
        nove: termin.datum,
      },
      ip,
    });
    this.obsah.zmena();
  }
}
