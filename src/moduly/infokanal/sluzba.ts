// Infokanál — doménová logika: odběratelé, kategorie, výběr příjemců, založení hlášení.
// Čisté funkce (vyberPrijemce) jsou oddělené od DB, aby se daly testovat bez Postgresu.
import type { Db } from '../../db/index.js';
import type { KanalPreference, Odberatel } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { nahodnyToken } from '../../lib/krypto.js';
import { rozpoznejKontakt } from '../../lib/kontakty.js';

export interface Kategorie {
  id: number;
  slug: string;
  nazev: string;
  povinna: boolean;
  poradi: number;
}

export interface Prijemce {
  odberatelId: string | null;
  kanal: 'sms' | 'email';
  kontakt: string;
}

export interface VyberVolby {
  kategorie: Kategorie;
  odberatele: Pick<
    Odberatel,
    'id' | 'telefon' | 'email' | 'cast_obce' | 'kanal' | 'overen_at' | 'odhlasen_at'
  >[];
  optouty: { odberatel_id: string; kategorie_id: number }[];
  cil: 'vse' | 'casti';
  cilDetail: string[];
  maSms: boolean;
  maEmail: boolean;
  krizove: boolean;
  /** SMS jen těm, kdo nemají e-mail (šetří SMS; krizové ignorují) */
  smsJenBezEmailu?: boolean;
  /** odhlásitelná kategorie, která se přesto doručuje jako důležitá (výstrahy) */
  dulezite?: boolean;
  dalsiKontakty?: string[];
}

// Kanál podle preference odběratele:
//   sms     = vše SMSkou (e-mail jen když SMS verze není)
//   email   = vše e-mailem; krizové navíc SMSkou
//   smisene = důležité (povinná kategorie / krizové / výstrahy) SMSkou, ostatní e-mailem
export function vyberPrijemce(v: VyberVolby): Prijemce[] {
  const dulezite = v.krizove || v.kategorie.povinna || !!v.dulezite;
  let subs = v.odberatele.filter((s) => s.overen_at && !s.odhlasen_at);
  if (v.cil === 'casti') {
    const set = new Set(v.cilDetail);
    subs = subs.filter((s) => set.has(s.cast_obce));
  }
  if (!v.kategorie.povinna) {
    const out = new Set(
      v.optouty.filter((o) => o.kategorie_id === v.kategorie.id).map((o) => o.odberatel_id),
    );
    subs = subs.filter((s) => !out.has(s.id));
  }
  const seznam: Prijemce[] = [];
  const videno = new Set<string>();
  const pridej = (odberatelId: string | null, kanal: 'sms' | 'email', kontakt: string | null) => {
    if (!kontakt) return;
    const klic = `${kanal}:${kontakt}`;
    if (videno.has(klic)) return;
    videno.add(klic);
    seznam.push({ odberatelId, kanal, kontakt });
  };
  for (const s of subs) {
    if (v.krizove) {
      if (v.maSms) pridej(s.id, 'sms', s.telefon);
      if (v.maEmail) pridej(s.id, 'email', s.email);
      continue;
    }
    const muzeSms = v.maSms && !!s.telefon && (!v.smsJenBezEmailu || !s.email);
    const muzeEmail = v.maEmail && !!s.email;
    const pref: KanalPreference = s.kanal;
    const smsNeboEmail = () =>
      muzeSms ? pridej(s.id, 'sms', s.telefon) : muzeEmail ? pridej(s.id, 'email', s.email) : undefined;
    const emailNeboSms = () =>
      muzeEmail ? pridej(s.id, 'email', s.email) : muzeSms ? pridej(s.id, 'sms', s.telefon) : undefined;
    if (pref === 'sms') smsNeboEmail();
    else if (pref === 'email') emailNeboSms();
    else if (dulezite) smsNeboEmail();
    else emailNeboSms();
  }
  for (const raw of v.dalsiKontakty ?? []) {
    const k = rozpoznejKontakt(raw);
    if (!k) continue;
    if (k.typ === 'telefon' && v.maSms) pridej(null, 'sms', k.hodnota);
    if (k.typ === 'email' && v.maEmail) pridej(null, 'email', k.hodnota);
  }
  return seznam;
}

export interface NoveHlaseni {
  kategorieId: number;
  krizove: boolean;
  cil: 'vse' | 'casti';
  cilDetail: string[];
  smsText: string | null;
  emailPredmet: string | null;
  emailText: string | null;
  emailHtml?: string | null;
  clanekTitulek?: string | null;
  clanekHtml?: string | null;
  naplanovanoNa?: Date | null;
  smsJenBezEmailu?: boolean;
  dulezite?: boolean;
  zdrojAutomatu?: string | null;
  dalsiKontakty?: string[];
}

export class InfokanalSluzba {
  constructor(private db: Db) {}

  kategorie(): Promise<Kategorie[]> {
    return this.db.selectFrom('ik_kategorie').selectAll().orderBy('poradi').execute();
  }

  kategoriePodleId(id: number) {
    return this.db.selectFrom('ik_kategorie').selectAll().where('id', '=', id).executeTakeFirst();
  }

  odberatelPodleTelefonu(telefon: string) {
    return this.db.selectFrom('ik_odberatele').selectAll().where('telefon', '=', telefon).executeTakeFirst();
  }

  odberatelPodleId(id: string) {
    return this.db.selectFrom('ik_odberatele').selectAll().where('id', '=', id).executeTakeFirst();
  }

  odberatelPodleTokenu(token: string) {
    return this.db.selectFrom('ik_odberatele').selectAll().where('token', '=', token).executeTakeFirst();
  }

  optoutyOdberatele(id: string) {
    return this.db
      .selectFrom('ik_optouty')
      .select('kategorie_id')
      .where('odberatel_id', '=', id)
      .execute()
      .then((r) => r.map((x) => x.kategorie_id));
  }

  // Přihlášení k odběru z webu: založí/obnoví odběratele (neověřeného); ověření udělá OTP.
  async zalozNeboObnov(data: {
    jmeno: string;
    telefon: string | null;
    email: string | null;
    castObce: string;
    kanal: KanalPreference;
    optouty: number[];
    zdroj: string;
    overeno: boolean;
    souhlas: boolean;
    uzivatelId?: string | null;
  }): Promise<Odberatel> {
    const existujici = data.telefon
      ? await this.odberatelPodleTelefonu(data.telefon)
      : data.email
        ? await this.db
            .selectFrom('ik_odberatele')
            .selectAll()
            .where((eb) => eb(eb.fn('lower', ['email']), '=', data.email!.toLowerCase()))
            .executeTakeFirst()
        : undefined;
    const hodnoty = {
      jmeno: data.jmeno,
      email: data.email,
      cast_obce: data.castObce,
      kanal: data.kanal,
      odhlasen_at: null,
      souhlas_at: data.souhlas ? new Date() : null,
      uzivatel_id: data.uzivatelId ?? null,
      ...(data.overeno ? { overen_at: new Date() } : {}),
    };
    let o: Odberatel;
    if (existujici) {
      o = await this.db
        .updateTable('ik_odberatele')
        .set(hodnoty)
        .where('id', '=', existujici.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      o = await this.db
        .insertInto('ik_odberatele')
        .values({ ...hodnoty, telefon: data.telefon, token: nahodnyToken(16), zdroj: data.zdroj })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    await this.nastavOptouty(o.id, data.optouty);
    return o;
  }

  async nastavOptouty(odberatelId: string, kategorieIds: number[]) {
    await this.db.deleteFrom('ik_optouty').where('odberatel_id', '=', odberatelId).execute();
    const povinne = new Set((await this.kategorie()).filter((k) => k.povinna).map((k) => k.id));
    const radky = [...new Set(kategorieIds)]
      .filter((id) => !povinne.has(id))
      .map((kategorie_id) => ({ odberatel_id: odberatelId, kategorie_id }));
    if (radky.length) await this.db.insertInto('ik_optouty').values(radky).execute();
  }

  async over(odberatelId: string) {
    await this.db
      .updateTable('ik_odberatele')
      .set({ overen_at: new Date(), odhlasen_at: null })
      .where('id', '=', odberatelId)
      .execute();
  }

  async uprav(
    odberatelId: string,
    data: { jmeno?: string; email?: string | null; castObce?: string; kanal?: KanalPreference },
    optouty?: number[],
  ) {
    const set: Record<string, unknown> = {};
    if (data.jmeno !== undefined) set.jmeno = data.jmeno;
    if (data.email !== undefined) set.email = data.email;
    if (data.castObce !== undefined) set.cast_obce = data.castObce;
    if (data.kanal !== undefined) set.kanal = data.kanal;
    if (Object.keys(set).length)
      await this.db.updateTable('ik_odberatele').set(set).where('id', '=', odberatelId).execute();
    if (optouty) await this.nastavOptouty(odberatelId, optouty);
  }

  async odhlas(odberatelId: string, zpusob: string) {
    await this.db
      .updateTable('ik_odberatele')
      .set({ odhlasen_at: new Date() })
      .where('id', '=', odberatelId)
      .execute();
    await zapisAudit(this.db, { akce: 'infokanal.odhlaseni', detail: { odberatel: odberatelId, zpusob } });
  }

  async seznamOdberatelu() {
    return this.db.selectFrom('ik_odberatele').selectAll().orderBy('jmeno').orderBy('vytvoren_at').execute();
  }

  async statistiky() {
    const r = await this.db
      .selectFrom('ik_odberatele')
      .select((eb) => [
        eb.fn.countAll<number>().as('celkem'),
        eb.fn.count<number>('telefon').as('sms'),
        eb.fn.count<number>('email').as('email'),
      ])
      .where('overen_at', 'is not', null)
      .where('odhlasen_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { celkem: Number(r.celkem), sms: Number(r.sms), email: Number(r.email) };
  }

  // Založení hlášení + fronty příjemců (v jedné transakci). Vrací počet příjemců.
  async zalozHlaseni(
    autorId: string | null,
    h: NoveHlaseni,
  ): Promise<{ id: string; prijemcu: number } | { chyba: 'zadny_kanal' | 'zadny_prijemce' | 'kategorie' }> {
    const maSms = !!h.smsText?.trim();
    const maEmail = !!(h.emailPredmet?.trim() && h.emailText?.trim());
    if (!maSms && !maEmail && !h.clanekTitulek) return { chyba: 'zadny_kanal' };
    const kategorie = await this.kategoriePodleId(h.kategorieId);
    if (!kategorie) return { chyba: 'kategorie' };
    const odberatele = await this.db
      .selectFrom('ik_odberatele')
      .select(['id', 'telefon', 'email', 'cast_obce', 'kanal', 'overen_at', 'odhlasen_at'])
      .execute();
    const optouty = await this.db.selectFrom('ik_optouty').selectAll().execute();
    const prijemci = vyberPrijemce({
      kategorie,
      odberatele,
      optouty,
      cil: h.cil,
      cilDetail: h.cilDetail,
      maSms,
      maEmail,
      krizove: h.krizove,
      smsJenBezEmailu: h.smsJenBezEmailu,
      dulezite: h.dulezite,
      dalsiKontakty: h.dalsiKontakty,
    });
    if (!prijemci.length && !h.clanekTitulek) return { chyba: 'zadny_prijemce' };
    const stav = h.naplanovanoNa && h.naplanovanoNa > new Date() ? 'naplanovano' : 'odesila_se';
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await trx
        .insertInto('ik_hlaseni')
        .values({
          autor_id: autorId,
          kategorie_id: h.kategorieId,
          krizove: h.krizove,
          cil: h.cil,
          cil_detail: JSON.stringify(h.cilDetail),
          sms_text: maSms ? h.smsText!.trim() : null,
          email_predmet: maEmail ? h.emailPredmet!.trim() : null,
          email_text: maEmail ? h.emailText!.trim() : null,
          email_html: maEmail ? (h.emailHtml ?? null) : null,
          clanek_titulek: h.clanekTitulek?.trim() || null,
          clanek_html: h.clanekHtml ?? null,
          stav,
          naplanovano_na: h.naplanovanoNa ?? null,
          zdroj_automatu: h.zdrojAutomatu ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (prijemci.length) {
        await trx
          .insertInto('ik_prijemci')
          .values(
            prijemci.map((p) => ({
              hlaseni_id: r.id,
              odberatel_id: p.odberatelId,
              kanal: p.kanal,
              kontakt: p.kontakt,
            })),
          )
          .execute();
      } else {
        await trx
          .updateTable('ik_hlaseni')
          .set({ stav: 'hotovo', dokonceno_at: new Date() })
          .where('id', '=', r.id)
          .execute();
      }
      return r.id;
    });
    await zapisAudit(this.db, {
      uzivatelId: autorId,
      akce: 'infokanal.hlaseni',
      detail: { id, prijemcu: prijemci.length, krizove: h.krizove, stav },
    });
    return { id, prijemcu: prijemci.length };
  }

  async zrusHlaseni(id: string, aktorId: string | null) {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('ik_hlaseni')
        .set({ stav: 'zruseno', dokonceno_at: new Date() })
        .where('id', '=', id)
        .where('stav', 'in', ['naplanovano', 'odesila_se'])
        .execute();
      await trx
        .updateTable('ik_prijemci')
        .set({ stav: 'vzdano', posledni_chyba: 'zrušeno úřadem' })
        .where('hlaseni_id', '=', id)
        .where('stav', '=', 'ceka')
        .execute();
    });
    await zapisAudit(this.db, { uzivatelId: aktorId, akce: 'infokanal.zruseni', detail: { id } });
  }

  async seznamHlaseni(limit = 50) {
    return this.db
      .selectFrom('ik_hlaseni')
      .leftJoin('ik_kategorie', 'ik_kategorie.id', 'ik_hlaseni.kategorie_id')
      .leftJoin('uzivatele', 'uzivatele.id', 'ik_hlaseni.autor_id')
      .select([
        'ik_hlaseni.id',
        'ik_hlaseni.krizove',
        'ik_hlaseni.sms_text',
        'ik_hlaseni.email_predmet',
        'ik_hlaseni.clanek_titulek',
        'ik_hlaseni.stav',
        'ik_hlaseni.vytvoreno_at',
        'ik_hlaseni.naplanovano_na',
        'ik_hlaseni.zdroj_automatu',
        'ik_kategorie.nazev as kategorie',
        'uzivatele.jmeno',
        'uzivatele.prijmeni',
      ])
      .select((eb) => [
        eb
          .selectFrom('ik_prijemci')
          .whereRef('ik_prijemci.hlaseni_id', '=', 'ik_hlaseni.id')
          .select(eb.fn.countAll<number>().as('n'))
          .as('prijemcu'),
        eb
          .selectFrom('ik_prijemci')
          .whereRef('ik_prijemci.hlaseni_id', '=', 'ik_hlaseni.id')
          .where('ik_prijemci.stav', 'in', ['odeslano', 'doruceno'])
          .select(eb.fn.countAll<number>().as('n'))
          .as('odeslano'),
      ])
      .orderBy('ik_hlaseni.vytvoreno_at', 'desc')
      .limit(limit)
      .execute();
  }

  async detailHlaseni(id: string) {
    const h = await this.db
      .selectFrom('ik_hlaseni')
      .leftJoin('ik_kategorie', 'ik_kategorie.id', 'ik_hlaseni.kategorie_id')
      .leftJoin('uzivatele', 'uzivatele.id', 'ik_hlaseni.autor_id')
      .selectAll('ik_hlaseni')
      .select(['ik_kategorie.nazev as kategorie', 'uzivatele.jmeno', 'uzivatele.prijmeni'])
      .where('ik_hlaseni.id', '=', id)
      .executeTakeFirst();
    if (!h) return null;
    const stavy = await this.db
      .selectFrom('ik_prijemci')
      .select(['kanal', 'stav'])
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('hlaseni_id', '=', id)
      .groupBy(['kanal', 'stav'])
      .execute();
    const prijemci = await this.db
      .selectFrom('ik_prijemci')
      .selectAll()
      .where('hlaseni_id', '=', id)
      .orderBy('id')
      .limit(500)
      .execute();
    return { ...h, stavy: stavy.map((s) => ({ ...s, n: Number(s.n) })), prijemci };
  }
}
