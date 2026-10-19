// Služba účtů: hledání/zakládání podle telefonu, role, souhlas, profil. Vše, co s účty dělají routy i OIDC.
import type { Db } from '../../db/index.js';
import type { Role, Uzivatel } from '../../db/types.js';
import { ROLE } from '../../db/types.js';
import { zapisAudit } from '../../lib/audit.js';
import { hashujHeslo, overHeslo, overHesloNaprazdno, potrebujeRehash } from '../../lib/krypto.js';

export { ROLE };

// Oprávnění: admin smí vše; správce obce má i práva redaktora. Ostatní role jsou přesné.
export function maRoli(u: Uzivatel | null | undefined, ...pozadovane: Role[]): boolean {
  if (!u) return false;
  const role = new Set<Role>(u.role ?? []);
  if (role.has('admin')) return true;
  // správce obce smí všechno obsahové; vstupné a účetní se mu automaticky nedávají
  if (role.has('spravce')) for (const r of ['web', 'deska', 'redaktor'] as const) role.add(r);
  return pozadovane.some((r) => role.has(r));
}

export function jeUrad(u: Uzivatel | null | undefined): boolean {
  return !!u && (u.role?.length ?? 0) > 0;
}

export function celeJmeno(u: Pick<Uzivatel, 'jmeno' | 'prijmeni' | 'prezdivka' | 'telefon'>): string {
  const j = `${u.jmeno} ${u.prijmeni}`.trim();
  return j || u.prezdivka || u.telefon;
}

export class UctySluzba {
  constructor(private db: Db) {}

  podleId(id: string) {
    return this.db.selectFrom('uzivatele').selectAll().where('id', '=', id).executeTakeFirst();
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
  async nastavRole(cilId: string, role: Role[], aktor: Uzivatel, ip?: string | null) {
    const platne = role.filter((r): r is Role => (ROLE as readonly string[]).includes(r));
    await this.db
      .updateTable('uzivatele')
      .set({ role: platne, upraven_at: new Date() })
      .where('id', '=', cilId)
      .execute();
    await zapisAudit(this.db, {
      uzivatelId: aktor.id,
      akce: 'sprava.role',
      detail: { cil: cilId, role: platne },
      ip,
    });
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
