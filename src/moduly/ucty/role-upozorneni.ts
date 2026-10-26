// E-mail při udělení silné role (Admin, Superadmin): dostanou ho všichni OSTATNÍ držitelé role admin nebo
// provozovatel s e-mailem (i ten, kdo roli přidělil — kdyby jeho účet zneužil někdo cizí, pozná to). Účet, který
// roli dostal, zprávu nedostává. Chyba odeslání se jen zaloguje — uložení role neovlivní.
import { sql } from 'kysely';
import type { Db } from '../../db/index.js';
import type { Role } from '../../db/types.js';
import { maskujTelefon } from '../../lib/kontakty.js';
import type { Logger } from '../../lib/logger.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import { formatujDatum } from '../../web/sablony.js';
import { definiceRole } from './role.js';
import type { UdeleniSilneRole } from './sluzba.js';

const ZDROJE: Record<string, string> = {
  'stranka-role': 'Administrace → Systém → Role',
  'detail-uctu': 'detail účtu v Administraci',
};

export function vytvorUpozorneniNaSilnouRoli(
  db: Db,
  mail: MailPoskytovatel,
  volby: { baseUrl: string; nazevObce: string; log?: Logger },
) {
  return async (z: UdeleniSilneRole): Promise<void> => {
    const cil = await db
      .selectFrom('uzivatele')
      .select(['id', 'jmeno', 'prijmeni', 'prezdivka', 'telefon'])
      .where('id', '=', z.cilId)
      .executeTakeFirst();
    if (!cil) return;
    const prijemci = await db
      .selectFrom('uzivatele')
      .select(['email'])
      .where('email', 'is not', null)
      .where('blokovan_at', 'is', null)
      .where('id', '!=', z.cilId)
      .where(sql<boolean>`role && ARRAY['admin','provozovatel']::text[]`)
      .execute();
    if (!prijemci.length) return;
    const jmeno = (u: { jmeno: string; prijmeni: string; prezdivka: string; telefon: string }) =>
      `${u.jmeno} ${u.prijmeni}`.trim() || u.prezdivka || maskujTelefon(u.telefon);
    const nazev = (r: Role) => definiceRole(r)?.nazev ?? r;
    const role = z.role
      .map((r) => {
        const doKdy = z.platnost.get(r);
        return `${nazev(r)} (${r})${doKdy ? `, platí do ${formatujDatum(doKdy, false)}` : ''}`;
      })
      .join('; ');
    const zaklad = volby.baseUrl.replace(/\/+$/, '');
    const text =
      `Účet ${jmeno(cil)} (${maskujTelefon(cil.telefon)}) právě dostal roli: ${role}.\n` +
      `Přidělil(a): ${jmeno(z.aktor)}, ${formatujDatum(new Date())}` +
      (z.zdroj ? `, ${ZDROJE[z.zdroj] ?? z.zdroj}` : '') +
      `.\n\nTato role otevírá celou administraci webu. Pokud o změně nevíte, zkontrolujte historii rolí:\n` +
      `${zaklad}/sprava/role/historie?uzivatel=${cil.id}\n\n` +
      `Zprávu dostávají všichni s rolí Admin nebo Superadmin (${volby.nazevObce}).`;
    const predmet = `[Administrace] ${jmeno(cil)} má novou roli: ${z.role.map(nazev).join(', ')}`;
    for (const p of prijemci) {
      try {
        await mail.posli({ komu: p.email!, predmet, text });
      } catch (e) {
        volby.log?.warn({ err: e }, 'upozornění na silnou roli se nepodařilo odeslat');
      }
    }
  };
}
