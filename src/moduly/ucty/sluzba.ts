// Služba účtů: hledání/zakládání podle telefonu, role, souhlas, profil. Vše, co s účty dělají routy i OIDC.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Role, Uzivatel } from '../../db/types.js';
import { ROLE } from '../../db/types.js';
import { CHRANENE_ROLE, efektivniRole, roleProAplikace } from './role.js';
import { zapisAudit } from '../../lib/audit.js';
import { hashujHeslo, overHeslo, overHesloNaprazdno, potrebujeRehash } from '../../lib/krypto.js';
import {
  klicEmail,
  klicUcet,
  stavZamku,
  zamcenoDo,
  zapisChybu,
  zrusZamek,
  type StavZamku,
} from '../../lib/zamky.js';

export { ROLE };

// Oprávnění: role zahrnují práva jiných rolí podle src/moduly/ucty/role.ts (provozovatel ⊃ admin ⊃ všechny
// ostatní kromě provozovatele; správce obce ⊃ web, deska, redaktor). Ostatní role jsou přesné.
export function maRoli(u: Uzivatel | null | undefined, ...pozadovane: Role[]): boolean {
  if (!u) return false;
  const role = efektivniRole(u.role);
  return pozadovane.some((r) => role.has(r));
}

/** chráněný účet (role provozovatel) — měnit ho smí jen držitel chráněné role */
export function jeChraneny(cil: Pick<Uzivatel, 'role'>): boolean {
  return (cil.role ?? []).some((r) => CHRANENE_ROLE.includes(r));
}

/**
 * Smí aktor úředně měnit cizí účet (údaje, blokace, role, rezident, telefon)? Chráněný účet (provozovatel) jen
 * provozovatel. Vlastní práva aktora (vyzadujRoli) a pravidlo „účet admina blokuje jen admin“ se kontrolují zvlášť.
 */
export function smiUpravitUcet(aktor: Uzivatel | null | undefined, cil: Pick<Uzivatel, 'role'>): boolean {
  if (!aktor) return false;
  return !jeChraneny(cil) || maRoli(aktor, 'provozovatel');
}

export function jeUrad(u: Uzivatel | null | undefined): boolean {
  return !!u && (u.role?.length ?? 0) > 0;
}

export function celeJmeno(u: Pick<Uzivatel, 'jmeno' | 'prijmeni' | 'prezdivka' | 'telefon'>): string {
  const j = `${u.jmeno} ${u.prijmeni}`.trim();
  return j || u.prezdivka || u.telefon;
}

/** profil účtu pro aplikace obce — stejné údaje jako OIDC claims (interní API, avíza) */
export function profilUzivatele(u: Uzivatel) {
  return {
    sub: u.id,
    cislo: u.cislo,
    mujucet_id: u.cislo,
    name: celeJmeno(u),
    given_name: u.jmeno,
    family_name: u.prijmeni,
    nickname: u.prezdivka,
    email: u.email,
    email_verified: !!u.email_overen_at,
    phone_number: u.telefon,
    phone_number_verified: !!u.telefon_overen_at,
    cast_obce: u.cast_obce,
    rezident: u.rezident,
    rezident_posouzen_at: u.rezident_posouzen_at?.toISOString() ?? null,
    rezident_posouzen_by: u.rezident_posouzen_by,
    role: roleProAplikace(u.role),
    gdpr_souhlas_at: u.gdpr_souhlas_at?.toISOString() ?? null,
    blokovan: !!u.blokovan_at,
    vytvoren_at: u.vytvoren_at.toISOString(),
  };
}

export class UctySluzba {
  constructor(private db: Db) {}

  podleId(id: string) {
    return this.db.selectFrom('uzivatele').selectAll().where('id', '=', id).executeTakeFirst();
  }

  podleCisla(cislo: number) {
    return this.db.selectFrom('uzivatele').selectAll().where('cislo', '=', cislo).executeTakeFirst();
  }

  /** neblokované účty s některou z rolí (přesná shoda; admin se k ostatním nepřidává — jen provozovatel k adminovi) */
  podleRole(role: Role[]) {
    if (role.includes('admin') && !role.includes('provozovatel')) role = [...role, 'provozovatel'];
    return this.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('blokovan_at', 'is', null)
      .where(sql<boolean>`role && ${sql.val(role)}::text[]`)
      .orderBy('cislo')
      .execute();
  }

  /** úřad přepíná rezidenta (z platformy nebo z administrace rezervací přes interní API); zároveň = posouzeno */
  async nastavRezident(
    cil: Uzivatel,
    rezident: boolean,
    aktor: Uzivatel | null,
    zdroj: string,
    ip?: string | null,
  ): Promise<Uzivatel> {
    const r = await this.db
      .updateTable('uzivatele')
      .set({
        rezident,
        rezident_posouzen_at: new Date(),
        rezident_posouzen_by: aktor?.cislo ?? null,
        upraven_at: new Date(),
      })
      .where('id', '=', cil.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, {
      uzivatelId: aktor?.id ?? null,
      akce: 'sprava.rezident',
      detail: { cil: cil.id, cislo: cil.cislo, rezident, puvodne: cil.rezident, zdroj },
      ip,
    });
    return r;
  }

  podleTelefonu(telefon: string) {
    return this.db.selectFrom('uzivatele').selectAll().where('telefon', '=', telefon).executeTakeFirst();
  }

  podleEmailu(email: string) {
    return this.db
      .selectFrom('uzivatele')
      .selectAll()
      .where((eb) => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
      .executeTakeFirst();
  }

  // Přihlášení SMS kódem: účet s tímto telefonem buď existuje, nebo vznikne (minimální, bez jména).
  async najdiNeboZaloz(telefon: string, ip?: string | null): Promise<{ uzivatel: Uzivatel; novy: boolean }> {
    const existujici = await this.podleTelefonu(telefon);
    if (existujici) {
      if (!existujici.telefon_overen_at) {
        await this.db
          .updateTable('uzivatele')
          .set({ telefon_overen_at: new Date() })
          .where('id', '=', existujici.id)
          .execute();
      }
      return { uzivatel: existujici, novy: false };
    }
    const novy = await this.db
      .insertInto('uzivatele')
      .values({ telefon, email: null, heslo_hash: null, telefon_overen_at: new Date() })
      .returningAll()
      .executeTakeFirstOrThrow();
    await zapisAudit(this.db, { uzivatelId: novy.id, akce: 'ucet.zalozen', detail: { zpusob: 'sms' }, ip });
    return { uzivatel: novy, novy: true };
  }

  async prihlasHeslem(email: string, heslo: string): Promise<Uzivatel | null> {
    const u = await this.podleEmailu(email);
    if (!u || !u.heslo_hash) return overHesloNaprazdno(heslo).then(() => null);
    if (!(await overHeslo(heslo, u.heslo_hash))) return null;
    // starší parametry scryptu → přepočítat teď, když heslo známe
    if (potrebujeRehash(u.heslo_hash)) {
      const novy = await hashujHeslo(heslo);
      await this.db.updateTable('uzivatele').set({ heslo_hash: novy }).where('id', '=', u.id).execute();
      return { ...u, heslo_hash: novy };
    }
    return u;
  }

  /** přihlášení heslem se zámkem po opakovaných chybách; neexistující e-mail se chová stejně jako existující */
  async prihlasHeslemSeZamkem(
    email: string,
    heslo: string,
    ip?: string | null,
  ): Promise<{ uzivatel: Uzivatel } | { chyba: 'heslo' | 'zamceno'; zamcenoDo?: Date }> {
    const klic = klicEmail(email);
    const zamek = await zamcenoDo(this.db, klic);
    if (zamek) return { chyba: 'zamceno', zamcenoDo: zamek };
    const u = await this.prihlasHeslem(email, heslo);
    if (u) {
      await zrusZamek(this.db, klic);
      return { uzivatel: u };
    }
    const stav = await zapisChybu(this.db, klic);
    if (!stav.zamcenoDo) return { chyba: 'heslo' };
    const ucet = await this.podleEmailu(email);
    await zapisAudit(this.db, {
      uzivatelId: ucet?.id ?? null,
      akce: 'prihlaseni.zamceno',
      detail: { cil: ucet?.id ?? null, email, chyby: stav.chyby, do: stav.zamcenoDo.toISOString() },
      ip,
    });
    return { chyba: 'zamceno', zamcenoDo: stav.zamcenoDo };
  }

  /** ověření heslem přihlášeného účtu (před citlivou změnou) — se stejným zámkem jako přihlášení */
  async overHesloUctu(u: Uzivatel, heslo: string, ip?: string | null): Promise<'ok' | 'heslo' | 'zamceno'> {
    const klic = klicUcet(u.id);
    if (await zamcenoDo(this.db, klic)) return 'zamceno';
    if (u.heslo_hash && (await overHeslo(heslo, u.heslo_hash))) {
      await zrusZamek(this.db, klic);
      return 'ok';
    }
    const stav = await zapisChybu(this.db, klic);
    if (!stav.zamcenoDo) return 'heslo';
    await zapisAudit(this.db, {
      uzivatelId: u.id,
      akce: 'prihlaseni.zamceno',
      detail: { cil: u.id, overeni: true, chyby: stav.chyby, do: stav.zamcenoDo.toISOString() },
      ip,
    });
    return 'zamceno';
  }

  /** čítače chyb přihlášení heslem pro tento účet (podle id i e-mailu) */
  zamkyUctu(u: Pick<Uzivatel, 'id' | 'email'>): Promise<StavZamku[]> {
    return stavZamku(this.db, this.kliceUctu(u));
  }

  private kliceUctu(u: Pick<Uzivatel, 'id' | 'email'>): string[] {
    return [klicUcet(u.id), ...(u.email ? [klicEmail(u.email)] : [])];
  }

  /** správce ruší zámek přihlášení heslem */
  async odemkni(cil: Pick<Uzivatel, 'id' | 'email'>, aktor: Uzivatel, ip?: string | null) {
    const n = await zrusZamek(this.db, ...this.kliceUctu(cil));
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: 'sprava.odemceni_prihlaseni',
      detail: { cil: cil.id, zruseno: n },
      ip,
    });
  }

  async nastavHeslo(id: string, heslo: string, ip?: string | null) {
    await this.db
      .updateTable('uzivatele')
      .set({ heslo_hash: await hashujHeslo(heslo), upraven_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: id, akce: 'ucet.heslo', ip });
  }

  async udelSouhlas(id: string, ip?: string | null) {
    await this.db
      .updateTable('uzivatele')
      .set({ gdpr_souhlas_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: id, akce: 'ucet.gdpr_souhlas', ip });
  }

  // Běžné údaje profilu — e-mail, heslo a telefon sem nepatří (citlivé změny jdou přes čerstvé ověření).
  async upravProfil(
    id: string,
    data: { jmeno: string; prijmeni: string; prezdivka: string; cast_obce: string },
    ip?: string | null,
  ): Promise<{ ok: true }> {
    await this.db
      .updateTable('uzivatele')
      .set({ ...data, upraven_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: id,
      akce: 'ucet.profil',
      detail: { pole: Object.keys(data) },
      ip,
    });
    return { ok: true };
  }

  // Nový e-mail se jen poznamená jako čekající; platit začne až po zadání kódu, který na něj pošleme.
  async zadostOEmail(
    id: string,
    email: string,
    ip?: string | null,
  ): Promise<{ ok: true } | { chyba: 'email_obsazeny' | 'stejny' }> {
    const u = await this.podleId(id);
    if (u?.email && u.email.toLowerCase() === email.toLowerCase()) return { chyba: 'stejny' };
    const jiny = await this.podleEmailu(email);
    if (jiny && jiny.id !== id) return { chyba: 'email_obsazeny' };
    await this.db
      .updateTable('uzivatele')
      .set({ email_cekajici: email, email_cekajici_at: new Date(), upraven_at: new Date() })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, { uzivatelId: id, akce: 'ucet.email_zadost', detail: { email }, ip });
    return { ok: true };
  }

  async potvrdEmail(
    id: string,
    ip?: string | null,
  ): Promise<{ ok: true; email: string } | { chyba: string }> {
    const u = await this.podleId(id);
    const email = u?.email_cekajici;
    if (!u || !email) return { chyba: 'nic_neceka' };
    const jiny = await this.podleEmailu(email);
    if (jiny && jiny.id !== id) return { chyba: 'email_obsazeny' };
    await this.db
      .updateTable('uzivatele')
      .set({
        email,
        email_overen_at: new Date(),
        email_cekajici: null,
        email_cekajici_at: null,
        upraven_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: id,
      akce: 'ucet.email_zmenen',
      detail: { puvodni: u.email, novy: email },
      ip,
    });
    return { ok: true, email };
  }

  // Odebrání e-mailu ruší i heslo (heslem se přihlašuje e-mailem — bez něj by heslo jen viselo).
  async odeberEmail(id: string, ip?: string | null) {
    const u = await this.podleId(id);
    await this.db
      .updateTable('uzivatele')
      .set({
        email: null,
        email_overen_at: null,
        email_cekajici: null,
        email_cekajici_at: null,
        heslo_hash: null,
        upraven_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: id,
      akce: 'ucet.email_odebran',
      detail: { puvodni: u?.email ?? null, heslo_zruseno: !!u?.heslo_hash },
      ip,
    });
  }

  async zrusCekajiciEmail(id: string) {
    await this.db
      .updateTable('uzivatele')
      .set({ email_cekajici: null, email_cekajici_at: null })
      .where('id', '=', id)
      .execute();
  }

  // Po citlivé změně: odhlásit všechna ostatní sezení (i u OIDC providera → externí aplikace se musí přihlásit znovu).
  async odhlasOstatni(id: string, ponechatSid: string | null): Promise<number> {
    let q = this.db.deleteFrom('sezeni').where((eb) => eb(eb.ref('data', '->>').key('uzivatelId'), '=', id));
    if (ponechatSid) q = q.where('sid', '!=', ponechatSid);
    const r = await q.executeTakeFirst();
    await this.db
      .deleteFrom('oidc_payloads')
      .where((eb) => eb(eb.ref('payload', '->>').key('accountId'), '=', id))
      .execute();
    return Number(r.numDeletedRows ?? 0);
  }

  // --- správa úřadem ---
  /** nastaví role účtu (neznámé zahodí); kontrolu pravidel dělá volající přes kontrolaZmenyRoli */
  async nastavRole(
    cilId: string,
    role: Role[],
    aktor: Uzivatel,
    ip?: string | null,
    detail: Record<string, unknown> = {},
  ) {
    const platne = [...new Set(role.filter((r): r is Role => (ROLE as readonly string[]).includes(r)))];
    const puvodni = await this.db
      .selectFrom('uzivatele')
      .select('role')
      .where('id', '=', cilId)
      .executeTakeFirst();
    await this.db
      .updateTable('uzivatele')
      .set({ role: platne, upraven_at: new Date() })
      .where('id', '=', cilId)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: 'sprava.role',
      detail: { cil: cilId, role: platne, puvodne: puvodni?.role ?? [], ...detail },
      ip,
    });
  }

  /** počet neblokovaných účtů s rolí provozovatel (pojistka, aby instalace nezůstala bez provozovatele) */
  async pocetProvozovatelu(): Promise<number> {
    const r = await this.db
      .selectFrom('uzivatele')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('blokovan_at', 'is', null)
      .where(sql<boolean>`'provozovatel' = ANY(role)`)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /**
   * Smí aktor změnit role cíle z jeho současných na `nove`? Vrací null (smí) nebo klíč chyby:
   * jen administrátor přiděluje role; vlastní role mění jen provozovatel; roli provozovatel přidělí/odebere
   * jen provozovatel; chráněný účet mění jen provozovatel; poslední provozovatel si roli neodebere.
   */
  async kontrolaZmenyRoli(
    aktor: Uzivatel,
    cil: Uzivatel,
    nove: Role[],
  ): Promise<null | 'nema_pravo' | 'sam_sobe' | 'jen_provozovatel' | 'chraneny' | 'posledni_provozovatel'> {
    if (!maRoli(aktor, 'admin')) return 'nema_pravo';
    const buh = maRoli(aktor, 'provozovatel');
    if (cil.id === aktor.id && !buh) return 'sam_sobe';
    if (jeChraneny(cil) && !buh) return 'chraneny';
    const mel = cil.role.includes('provozovatel');
    const bude = nove.includes('provozovatel');
    if (mel !== bude && !buh) return 'jen_provozovatel';
    if (mel && !bude && !cil.blokovan_at && (await this.pocetProvozovatelu()) <= 1)
      return 'posledni_provozovatel';
    return null;
  }

  async blokuj(cilId: string, blokovat: boolean, aktor: Uzivatel, ip?: string | null) {
    await this.db
      .updateTable('uzivatele')
      .set({ blokovan_at: blokovat ? new Date() : null, upraven_at: new Date() })
      .where('id', '=', cilId)
      .execute();
    if (blokovat) {
      // okamžité odhlášení všude: vlastní sezení i sezení/granty/tokeny u OIDC providera
      await this.db
        .deleteFrom('sezeni')
        .where((eb) => eb(eb.ref('data', '->>').key('uzivatelId'), '=', cilId))
        .execute();
      await this.db
        .deleteFrom('oidc_payloads')
        .where((eb) => eb(eb.ref('payload', '->>').key('accountId'), '=', cilId))
        .execute();
    }
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: blokovat ? 'sprava.blokace' : 'sprava.odblokovani',
      detail: { cil: cilId },
      ip,
    });
  }

  async seznam(hledat = '', limit = 200) {
    let q = this.db
      .selectFrom('uzivatele')
      .selectAll()
      .orderBy('prijmeni')
      .orderBy('jmeno')
      .orderBy('vytvoren_at')
      .limit(limit);
    const h = hledat.trim();
    if (h) {
      const like = `%${h.replace(/[%_]/g, '')}%`;
      q = q.where((eb) =>
        eb.or([
          eb('jmeno', 'ilike', like),
          eb('prijmeni', 'ilike', like),
          eb('prezdivka', 'ilike', like),
          eb('telefon', 'ilike', like.replace(/\s+/g, '')),
          eb('email', 'ilike', like),
        ]),
      );
    }
    return q.execute();
  }

  async pocet() {
    const r = await this.db
      .selectFrom('uzivatele')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }
}
