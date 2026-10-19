// Úřední deska — doménová logika: vyvěšení/sejmutí, zákonné minimum doby vyvěšení, rozpočtová dokumentace
// („zveřejněno do schválení nového“), přílohy, hledání. Čisté funkce (zkontrolujDobu, coNahrazuje) bez DB kvůli testům.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { UdKategorie } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { datumPraha, konecDne, rozdilDni, zacatekDne } from '../../lib/datum.js';
import { odpovida, tsDotaz } from '../../lib/hledani.js';

// Typy rozpočtové dokumentace (zák. 250/2000 Sb., § 3, § 11, § 17). Klíče jsou stabilní, popisky v i18n.
export const TYPY_ROZPOCTU = [
  'navrh_rozpoctu',
  'rozpocet',
  'rozpoctove_opatreni',
  'navrh_vyhledu',
  'vyhled',
  'navrh_zu',
  'zaverecny_ucet',
] as const;
export type TypRozpoctu = (typeof TYPY_ROZPOCTU)[number];

/**
 * Co nový dokument daného typu nahrazuje — tj. které dosud vyvěšené dokumenty se k datu jeho vyvěšení samy sejmou.
 * Pravidla podle zákona: návrh visí do schválení (schválený dokument téhož roku ho nahradí); schválený rozpočet,
 * výhled a závěrečný účet visí do zveřejnění dalšího. Rozpočtové opatření visí po dobu zveřejnění rozpočtu, který
 * mění (§ 16 odst. 5) — sejme se, až se zveřejní schválený rozpočet následujícího roku.
 */
export function coNahrazuje(typ: TypRozpoctu): { typ: TypRozpoctu; rok: 'starsi' | 'nejvyse_stejny' }[] {
  switch (typ) {
    case 'navrh_rozpoctu':
      return [{ typ: 'navrh_rozpoctu', rok: 'starsi' }];
    case 'rozpocet':
      // rozpočtová opatření visí po dobu zveřejnění rozpočtu, který mění (§ 16 odst. 5) → sejmou se s ním
      return [
        { typ: 'navrh_rozpoctu', rok: 'nejvyse_stejny' },
        { typ: 'rozpocet', rok: 'starsi' },
        { typ: 'rozpoctove_opatreni', rok: 'starsi' },
      ];
    case 'navrh_vyhledu':
      return [{ typ: 'navrh_vyhledu', rok: 'starsi' }];
    case 'vyhled':
      return [
        { typ: 'navrh_vyhledu', rok: 'nejvyse_stejny' },
        { typ: 'vyhled', rok: 'starsi' },
      ];
    case 'navrh_zu':
      return [{ typ: 'navrh_zu', rok: 'starsi' }];
    case 'zaverecny_ucet':
      return [
        { typ: 'navrh_zu', rok: 'nejvyse_stejny' },
        { typ: 'zaverecny_ucet', rok: 'starsi' },
      ];
    default:
      return [];
  }
}

export type ChybaDoby = 'od_neplatne' | 'do_neplatne' | 'do_pred_od' | 'kratke';

/** kontrola doby vyvěšení podle kategorie (datumy 'YYYY-MM-DD'; do = poslední den na desce, null = do odvolání) */
export function zkontrolujDobu(
  kat: Pick<UdKategorie, 'min_dni'>,
  od: string,
  do_: string | null,
): { ok: true } | { chyba: ChybaDoby; minDo?: string } {
  if (!zacatekDne(od)) return { chyba: 'od_neplatne' };
  if (do_ === null) return { ok: true };
  if (!zacatekDne(do_)) return { chyba: 'do_neplatne' };
  const dni = rozdilDni(od, do_);
  if (dni < 0) return { chyba: 'do_pred_od' };
  // § 25 správního řádu: vyvěšeno 1. 10. → 15. den je 16. 10. (poslední den na desce)
  if (kat.min_dni > 0 && dni < kat.min_dni) {
    const min = new Date(Date.parse(od + 'T12:00:00Z') + kat.min_dni * 86_400_000).toISOString().slice(0, 10);
    return { chyba: 'kratke', minDo: min };
  }
  return { ok: true };
}

export interface DataDokumentu {
  nazev: string;
  kategorieId: number;
  cisloJednaci: string;
  puvodce: string;
  popis: string;
  od: string; // YYYY-MM-DD
  do: string | null;
  typRozpoctu: TypRozpoctu | null;
  rok: number | null;
}

export type Filtr = { kategorie?: string; q?: string; rok?: number; stranka?: number };
const NA_STRANKU = 30;

export class DeskaSluzba {
  constructor(private db: Db) {}

  kategorie(jenAktivni = true) {
    let q = this.db.selectFrom('ud_kategorie').selectAll().orderBy('poradi').orderBy('nazev');
    if (jenAktivni) q = q.where('aktivni', '=', true);
    return q.execute();
  }

  kategoriePodleId(id: number) {
    return this.db.selectFrom('ud_kategorie').selectAll().where('id', '=', id).executeTakeFirst();
  }

  private zaklad() {
    return this.db
      .selectFrom('ud_dokumenty as d')
      .innerJoin('ud_kategorie as k', 'k.id', 'd.kategorie_id')
      .selectAll('d')
      .select(['k.nazev as kategorie', 'k.slug as kategorie_slug'])
      .select((eb) =>
        eb
          .selectFrom('ud_prilohy')
          .whereRef('ud_prilohy.dokument_id', '=', 'd.id')
          .select(eb.fn.countAll<number>().as('n'))
          .as('priloh'),
      )
      .where('d.smazano_at', 'is', null);
  }

  private filtruj<Q extends ReturnType<DeskaSluzba['zaklad']>>(q: Q, f: Filtr): Q {
    let out = q;
    if (f.kategorie) out = out.where('k.slug', '=', f.kategorie) as Q;
    const dotaz = tsDotaz(f.q);
    if (dotaz)
      out = out.where(
        odpovida(sql`d.nazev || ' ' || d.popis || ' ' || d.cislo_jednaci`, dotaz),
      ) as unknown as Q;
    if (f.rok)
      out = out.where(
        sql<boolean>`extract(year from d.vyveseno_od AT TIME ZONE 'Europe/Prague') = ${f.rok}`,
      ) as Q;
    return out;
  }

  /** právě vyvěšené dokumenty (veřejně) */
  async aktualni(f: Filtr = {}, ted = new Date()) {
    return this.filtruj(this.zaklad(), f)
      .where('d.vyveseno_od', '<=', ted)
      .where((eb) => eb.or([eb('d.sejmuto_do', 'is', null), eb('d.sejmuto_do', '>', ted)]))
      .orderBy('d.vyveseno_od', 'desc')
      .limit(500)
      .execute();
  }

  /**
   * sejmuté dokumenty (veřejný archiv), stránkovaně — bez kategorií s neveřejným archivem (dokumenty jiných úřadů:
   * exekuce, dražby, doručování; po sejmutí nemají důvod zůstat veřejné, GDPR — zůstávají ve správě)
   */
  async archiv(f: Filtr = {}, ted = new Date()) {
    const strana = Math.max(1, f.stranka ?? 1);
    const radky = await this.filtruj(this.zaklad(), f)
      .where('d.sejmuto_do', '<=', ted)
      .where('k.archiv_verejny', '=', true)
      .orderBy('d.sejmuto_do', 'desc')
      .limit(NA_STRANKU + 1)
      .offset((strana - 1) * NA_STRANKU)
      .execute();
    return { radky: radky.slice(0, NA_STRANKU), dalsi: radky.length > NA_STRANKU, strana };
  }

  async rokyArchivu() {
    const r = await sql<{ rok: number }>`
      SELECT DISTINCT extract(year from d.vyveseno_od AT TIME ZONE 'Europe/Prague')::int AS rok
      FROM ud_dokumenty d JOIN ud_kategorie k ON k.id = d.kategorie_id
      WHERE d.smazano_at IS NULL AND d.sejmuto_do <= now() AND k.archiv_verejny ORDER BY rok DESC`.execute(
      this.db,
    );
    return r.rows.map((x) => x.rok);
  }

  /** pro správu: vše v daném stavu */
  async proSpravu(stav: 'vyveseno' | 'pripraveno' | 'sejmuto' | 'kos', q = '', ted = new Date()) {
    let dotaz = this.db
      .selectFrom('ud_dokumenty as d')
      .innerJoin('ud_kategorie as k', 'k.id', 'd.kategorie_id')
      .selectAll('d')
      .select(['k.nazev as kategorie']);
    if (stav === 'kos') dotaz = dotaz.where('d.smazano_at', 'is not', null);
    else {
      dotaz = dotaz.where('d.smazano_at', 'is', null);
      if (stav === 'pripraveno') dotaz = dotaz.where('d.vyveseno_od', '>', ted);
      if (stav === 'vyveseno')
        dotaz = dotaz
          .where('d.vyveseno_od', '<=', ted)
          .where((eb) => eb.or([eb('d.sejmuto_do', 'is', null), eb('d.sejmuto_do', '>', ted)]));
      if (stav === 'sejmuto') dotaz = dotaz.where('d.sejmuto_do', '<=', ted);
    }
    const tsq = tsDotaz(q);
    if (tsq) dotaz = dotaz.where(odpovida(sql`d.nazev || ' ' || d.popis || ' ' || d.cislo_jednaci`, tsq));
    return dotaz
      .orderBy(stav === 'sejmuto' ? 'd.sejmuto_do' : 'd.vyveseno_od', 'desc')
      .limit(300)
      .execute();
  }

  async pocty(ted = new Date()) {
    const r = await sql<{ vyveseno: number; pripraveno: number; konci: number }>`
      SELECT
        count(*) FILTER (WHERE vyveseno_od <= ${ted} AND (sejmuto_do IS NULL OR sejmuto_do > ${ted}))::int AS vyveseno,
        count(*) FILTER (WHERE vyveseno_od > ${ted})::int AS pripraveno,
        count(*) FILTER (WHERE sejmuto_do > ${ted} AND sejmuto_do <= ${ted}::timestamptz + interval '3 days')::int AS konci
      FROM ud_dokumenty WHERE smazano_at IS NULL`.execute(this.db);
    return r.rows[0]!;
  }

  async detail(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const d = await this.db
      .selectFrom('ud_dokumenty as d')
      .innerJoin('ud_kategorie as k', 'k.id', 'd.kategorie_id')
      .selectAll('d')
      .select(['k.nazev as kategorie', 'k.slug as kategorie_slug', 'k.min_dni', 'k.archiv_verejny'])
      .where('d.id', '=', id)
      .executeTakeFirst();
    if (!d) return null;
    const prilohy = await this.prilohy(id);
    return { ...d, prilohy };
  }

  /**
   * soubor patří jen k dokumentům, které veřejnost nevidí (sejmuté z kategorie s neveřejným archivem, koš,
   * připravené) — pak ho /soubory nevydá anonymům. Soubor bez vazby na desku (web, obrázky) je veřejný.
   */
  async souborNeverejny(souborId: string, ted = new Date()): Promise<boolean> {
    const r = await sql<{ verejne: number; celkem: number }>`
      SELECT count(*)::int AS celkem,
        count(*) FILTER (WHERE d.smazano_at IS NULL AND d.vyveseno_od <= ${ted}
          AND (d.sejmuto_do IS NULL OR d.sejmuto_do > ${ted} OR k.archiv_verejny))::int AS verejne
      FROM ud_prilohy p JOIN ud_dokumenty d ON d.id = p.dokument_id JOIN ud_kategorie k ON k.id = d.kategorie_id
      WHERE p.soubor_id = ${souborId}`.execute(this.db);
    const x = r.rows[0]!;
    return x.celkem > 0 && x.verejne === 0;
  }

  prilohy(dokumentId: string) {
    return this.db
      .selectFrom('ud_prilohy as p')
      .innerJoin('soubory as s', 's.id', 'p.soubor_id')
      .selectAll('s')
      .select('p.poradi')
      .where('p.dokument_id', '=', dokumentId)
      .orderBy('p.poradi')
      .orderBy('s.vytvoren_at')
      .execute();
  }

  async pridejPrilohy(dokumentId: string, souborIds: string[]) {
    if (!souborIds.length) return;
    const max = await this.db
      .selectFrom('ud_prilohy')
      .select((eb) => eb.fn.max('poradi').as('m'))
      .where('dokument_id', '=', dokumentId)
      .executeTakeFirst();
    let poradi = Number(max?.m ?? -1) + 1;
    await this.db
      .insertInto('ud_prilohy')
      .values(souborIds.map((soubor_id) => ({ dokument_id: dokumentId, soubor_id, poradi: poradi++ })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async odeberPrilohy(dokumentId: string, souborIds: string[]) {
    if (!souborIds.length) return;
    // soubor zůstává v úložišti (nic se nemaže) — jen se odpojí od dokumentu
    await this.db
      .deleteFrom('ud_prilohy')
      .where('dokument_id', '=', dokumentId)
      .where('soubor_id', 'in', souborIds)
      .execute();
  }

  async uloz(
    id: string | null,
    data: DataDokumentu,
    aktorId: string | null,
    ip?: string | null,
    puvodniUrl?: string | null,
  ): Promise<string> {
    const hodnoty = {
      nazev: data.nazev,
      kategorie_id: data.kategorieId,
      cislo_jednaci: data.cisloJednaci,
      puvodce: data.puvodce,
      popis: data.popis,
      vyveseno_od: zacatekDne(data.od)!,
      sejmuto_do: data.do ? konecDne(data.do)! : null,
      typ_rozpoctu: data.typRozpoctu,
      rok: data.rok,
      upraveno_at: new Date(),
    };
    let novyId: string;
    if (id) {
      await this.db.updateTable('ud_dokumenty').set(hodnoty).where('id', '=', id).execute();
      novyId = id;
    } else {
      const r = await this.db
        .insertInto('ud_dokumenty')
        .values({ ...hodnoty, autor_id: aktorId, puvodni_url: puvodniUrl ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      novyId = r.id;
    }
    const nahrazeno = data.typRozpoctu ? await this.nahradStarsi(novyId, data) : 0;
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: id ? 'deska.uprava' : 'deska.vyveseni',
      detail: { id: novyId, nazev: data.nazev, od: data.od, do: data.do, nahrazeno },
      ip,
    });
    return novyId;
  }

  // rozpočtová dokumentace: starší dokumenty, které nový nahrazuje, se sejmou k datu jeho vyvěšení
  private async nahradStarsi(id: string, data: DataDokumentu): Promise<number> {
    if (!data.typRozpoctu || !data.rok) return 0;
    const od = zacatekDne(data.od)!;
    let n = 0;
    for (const pravidlo of coNahrazuje(data.typRozpoctu)) {
      const r = await this.db
        .updateTable('ud_dokumenty')
        .set({ sejmuto_do: od, sejmuti_duvod: `nahrazeno: ${data.nazev}`, upraveno_at: new Date() })
        .where('id', '!=', id)
        .where('smazano_at', 'is', null)
        .where('typ_rozpoctu', '=', pravidlo.typ)
        .where('rok', pravidlo.rok === 'starsi' ? '<' : '<=', data.rok)
        .where('vyveseno_od', '<', od)
        .where((eb) => eb.or([eb('sejmuto_do', 'is', null), eb('sejmuto_do', '>', od)]))
        .executeTakeFirst();
      n += Number(r.numUpdatedRows ?? 0);
    }
    return n;
  }

  /** předčasné sejmutí (před koncem lhůty) — vždy s důvodem, auditováno */
  async sejmiHned(id: string, duvod: string, aktorId: string, ip?: string | null) {
    await this.db
      .updateTable('ud_dokumenty')
      .set({ sejmuto_do: new Date(), sejmuti_duvod: duvod, upraveno_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'deska.sejmuti', detail: { id, duvod }, ip });
  }

  async doKose(id: string, smazat: boolean, aktorId: string, ip?: string | null) {
    await this.db
      .updateTable('ud_dokumenty')
      .set({ smazano_at: smazat ? new Date() : null })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktorId,
      akce: smazat ? 'deska.kos' : 'deska.obnoveni',
      detail: { id },
      ip,
    });
  }

  async nastavHlaseni(id: string, hlaseniId: string) {
    await this.db.updateTable('ud_dokumenty').set({ hlaseni_id: hlaseniId }).where('id', '=', id).execute();
  }

  /** rozpočtová dokumentace pro stránku /rozpocet: platné (vyvěšené) a archiv po typech */
  async rozpocet(ted = new Date()) {
    const radky = await this.zaklad()
      .where('d.typ_rozpoctu', 'is not', null)
      .where('d.vyveseno_od', '<=', ted)
      .orderBy('d.rok', 'desc')
      .orderBy('d.vyveseno_od', 'desc')
      .execute();
    const platne = radky.filter((r) => !r.sejmuto_do || r.sejmuto_do > ted);
    const archiv = radky.filter((r) => r.sejmuto_do && r.sejmuto_do <= ted);
    return { platne, archiv };
  }

  // kategorie: úprava úřadem
  async ulozKategorii(
    id: number | null,
    k: {
      nazev: string;
      minDni: number;
      vychoziDni: number;
      rozpocet: boolean;
      poradi: number;
      aktivni: boolean;
      archivVerejny?: boolean;
    },
    slug: string,
  ) {
    const h = {
      ...(k.archivVerejny === undefined ? {} : { archiv_verejny: k.archivVerejny }),
      nazev: k.nazev,
      min_dni: k.minDni,
      vychozi_dni: k.vychoziDni,
      rozpocet: k.rozpocet,
      poradi: k.poradi,
      aktivni: k.aktivni,
    };
    if (id) await this.db.updateTable('ud_kategorie').set(h).where('id', '=', id).execute();
    else
      await this.db
        .insertInto('ud_kategorie')
        .values({ ...h, slug })
        .onConflict((oc) => oc.column('slug').doNothing())
        .execute();
  }
}

export function dnesPraha() {
  return datumPraha(new Date());
}
