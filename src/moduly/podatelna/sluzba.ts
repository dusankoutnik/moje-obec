// Elektronická podatelna: kontrola formuláře, uložení podání s číslem, e-mail úřadu a potvrzení podateli.
// Podání se ukládá VŽDY dřív, než se odesílají e-maily — výpadek pošty nesmí podání ztratit (úřad ho vidí ve správě).
import { sql } from 'kysely';
import type { ObecProfil } from '../../config/obec.js';
import type { Db } from '../../db/index.js';
import type { Podani } from '../../db/types.js';
import type { MailPoskytovatel } from '../../lib/mail.js';
import { normalizujEmail, normalizujTelefon, formatujTelefon } from '../../lib/kontakty.js';

export const DELKY = {
  jmeno: 120,
  ulice: 120,
  obec: 80,
  psc: 6,
  telefon: 30,
  email: 200,
  predmet: 200,
  text: 10_000,
};
export const NA_STRANKU = 50;

export interface FormularPodani {
  jmeno?: string;
  ulice?: string;
  obec?: string;
  psc?: string;
  telefon?: string;
  email?: string;
  predmet?: string;
  text?: string;
  beru_na_vedomi?: string;
  /** past na roboty — člověk pole nevidí a nevyplní */
  web?: string;
}

export interface UdajePodani {
  jmeno: string;
  ulice: string;
  obec: string;
  psc: string;
  telefon: string;
  email: string;
  predmet: string;
  text: string;
}

export type Pole = keyof UdajePodani | 'beru_na_vedomi';
export type VysledekKontroly =
  { ok: true; udaje: UdajePodani } | { ok: false; chyby: Partial<Record<Pole, string>> };

/** jeden řádek: bez řídicích znaků a zalomení (předmět jde do hlavičky e-mailu) */
function radek(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function viceRadku(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .trim()
    .slice(0, max);
}

/** klíče chyb jsou klíče překladů v sekci podatelna */
export function overFormular(f: FormularPodani): VysledekKontroly {
  const chyby: Partial<Record<Pole, string>> = {};
  const jmeno = radek(f.jmeno, DELKY.jmeno);
  const ulice = radek(f.ulice, DELKY.ulice);
  const obec = radek(f.obec, DELKY.obec);
  const pscSurove = radek(f.psc, 20).replace(/\s/g, '');
  const telefonSurovy = radek(f.telefon, DELKY.telefon);
  const emailSurovy = radek(f.email, DELKY.email);
  const predmet = radek(f.predmet, DELKY.predmet);
  const text = viceRadku(f.text, DELKY.text);

  if (jmeno.length < 3 || !/\p{L}/u.test(jmeno)) chyby.jmeno = 'chyba_jmeno';
  if (!ulice) chyby.ulice = 'chyba_ulice';
  if (!obec) chyby.obec = 'chyba_obec';
  if (!/^\d{5}$/.test(pscSurove)) chyby.psc = 'chyba_psc';
  let telefon = '';
  if (telefonSurovy) {
    const n = normalizujTelefon(telefonSurovy);
    if (n) telefon = n;
    else chyby.telefon = 'chyba_telefon';
  }
  let email = '';
  if (emailSurovy) {
    const n = normalizujEmail(emailSurovy);
    if (n) email = n;
    else chyby.email = 'chyba_email';
  }
  if (!predmet) chyby.predmet = 'chyba_predmet';
  if (!text) chyby.text = 'chyba_text';
  if (f.beru_na_vedomi !== 'ano') chyby.beru_na_vedomi = 'chyba_beru_na_vedomi';
  if (Object.keys(chyby).length) return { ok: false, chyby };
  const psc = `${pscSurove.slice(0, 3)} ${pscSurove.slice(3)}`;
  return { ok: true, udaje: { jmeno, ulice, obec, psc, telefon, email, predmet, text } };
}

/** adresa podatelny: podatelna.email > kontakt.epodatelna > kontakt.email */
export function adresaPodatelny(o: ObecProfil): string {
  return o.podatelna.email || o.obec.kontakt.epodatelna || o.obec.kontakt.email;
}

export function cisloPodani(rok: number, poradi: number): string {
  return `EP-${rok}-${String(poradi).padStart(4, '0')}`;
}

/** konec doby uchování (YYYY-MM-DD): datum přijetí + N let (29. 2. → 28. 2.) */
export function uchovatDo(prijato: Date, let_: number): string {
  const d = new Date(Date.UTC(prijato.getUTCFullYear() + let_, prijato.getUTCMonth(), prijato.getUTCDate()));
  if (d.getUTCMonth() !== prijato.getUTCMonth()) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** rok podle pražského času (podání 31. 12. ve 23:30 patří do starého roku) */
function rokVPraze(d: Date): number {
  return Number(d.toLocaleDateString('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }));
}

export class PodatelnaSluzba {
  constructor(
    private db: Db,
    private obec: ObecProfil,
    private mail: MailPoskytovatel,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  /** uloží podání s dalším číslem v roce (zámek transakce brání dvěma stejným číslům) */
  async zaloz(u: UdajePodani, ted = new Date()): Promise<Podani> {
    const rok = rokVPraze(ted);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('pod_podani'), ${rok})`.execute(trx);
      const max = await trx
        .selectFrom('pod_podani')
        .select((eb) => eb.fn.max<number>('poradi').as('max'))
        .where('rok', '=', rok)
        .executeTakeFirst();
      const poradi = (max?.max ?? 0) + 1;
      return trx
        .insertInto('pod_podani')
        .values({
          ...u,
          rok,
          poradi,
          cislo: cisloPodani(rok, poradi),
          prijato_at: ted,
          uchovat_do: uchovatDo(ted, this.obec.podatelna.uchovani_let),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * E-mail na podatelnu (Reply-To = podatel) a potvrzení doručení podateli, má-li e-mail.
   * Selhání pošty se zapíše k podání (správa ho ukáže), podání samo zůstává platně přijaté.
   */
  async odesli(p: Podani, baseUrl: string): Promise<void> {
    const nazevObce = this.obec.obec.nazev;
    const adresa = adresaPodatelny(this.obec);
    const chyby: string[] = [];
    const zmena: { odeslano_uradu_at?: Date; potvrzeni_at?: Date; chyba_odeslani?: string } = {};
    const prijato = p.prijato_at.toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });
    if (adresa) {
      try {
        await this.mail.posli({
          komu: adresa,
          predmet: `Elektronická podatelna ${p.cislo}: ${p.predmet}`,
          replyTo: p.email || undefined,
          text: [
            `Nové podání přes formulář elektronické podatelny (bez elektronického podpisu).`,
            ``,
            `Číslo podání: ${p.cislo}`,
            `Přijato: ${prijato}`,
            ``,
            `Jméno a příjmení: ${p.jmeno}`,
            `Adresa: ${p.ulice}, ${p.psc} ${p.obec}`,
            `Telefon: ${p.telefon ? formatujTelefon(p.telefon) : '—'}`,
            `E-mail: ${p.email || '—'}`,
            ``,
            `Předmět: ${p.predmet}`,
            ``,
            p.text,
            ``,
            `— — —`,
            `Podání je uložené ve správě webu: ${baseUrl}/sprava/podatelna/${p.id}`,
            p.email
              ? `Odpověď na tento e-mail půjde podateli (${p.email}).`
              : `Podatel neuvedl e-mail — potvrzení přijetí je nutné doručit jinak.`,
          ].join('\n'),
        });
        zmena.odeslano_uradu_at = new Date();
      } catch (e) {
        this.log.warn({ err: e, podani: p.cislo }, 'podatelna: e-mail úřadu se nepodařilo odeslat');
        chyby.push('e-mail úřadu');
      }
    } else chyby.push('chybí adresa podatelny');
    if (p.email) {
      try {
        await this.mail.posli({
          komu: p.email,
          predmet: `${nazevObce}: podání ${p.cislo} bylo doručeno`,
          replyTo: adresa || undefined,
          text: [
            `Dobrý den,`,
            ``,
            `Vaše podání přes elektronickou podatelnu obce bylo doručeno a zaevidováno pod číslem ${p.cislo} (${prijato}).`,
            `Toto je automatická zpráva o doručení. Přijetí podání úřad potvrdí následující úřední den podatelny.`,
            ``,
            `Předmět: ${p.predmet}`,
            ``,
            `Pokud jste podání neodeslali vy, ozvěte se prosím úřadu${adresa ? ` (${adresa})` : ''}.`,
            ``,
            nazevObce,
          ].join('\n'),
        });
        zmena.potvrzeni_at = new Date();
      } catch (e) {
        this.log.warn({ err: e, podani: p.cislo }, 'podatelna: potvrzení podateli se nepodařilo odeslat');
        chyby.push('potvrzení podateli');
      }
    }
    if (chyby.length) zmena.chyba_odeslani = chyby.join(', ');
    await this.db.updateTable('pod_podani').set(zmena).where('id', '=', p.id).execute();
  }

  async seznam(volby: { jenNevyrizene: boolean; strana: number }) {
    let q = this.db.selectFrom('pod_podani');
    if (volby.jenNevyrizene) q = q.where('vyrizeno_at', 'is', null);
    const { pocet } = await q.select((eb) => eb.fn.countAll<string>().as('pocet')).executeTakeFirstOrThrow();
    const radky = await q
      .select([
        'id',
        'cislo',
        'jmeno',
        'predmet',
        'prijato_at',
        'vyrizeno_at',
        'uchovat_do',
        'chyba_odeslani',
        'email',
      ])
      .orderBy('prijato_at', 'desc')
      .limit(NA_STRANKU)
      .offset((volby.strana - 1) * NA_STRANKU)
      .execute();
    return { radky, pocet: Number(pocet) };
  }

  async pocetNevyrizenych(): Promise<number> {
    const r = await this.db
      .selectFrom('pod_podani')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('vyrizeno_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  async detail(id: string) {
    return this.db
      .selectFrom('pod_podani as p')
      .leftJoin('uzivatele as u', 'u.id', 'p.vyridil_id')
      .selectAll('p')
      .select(['u.jmeno as vyridil_jmeno', 'u.prijmeni as vyridil_prijmeni', 'u.telefon as vyridil_telefon'])
      .where('p.id', '=', id)
      .executeTakeFirst();
  }

  /** stav: true = vyřízeno, false = znovu otevřít, null = jen poznámka (stav beze změny) */
  async nastavVyrizeni(id: string, stav: boolean | null, poznamka: string, uzivatelId: string) {
    const zmena: { poznamka: string; vyrizeno_at?: Date | null; vyridil_id?: string | null } = {
      poznamka: viceRadku(poznamka, 2000),
    };
    if (stav !== null) {
      zmena.vyrizeno_at = stav ? new Date() : null;
      zmena.vyridil_id = stav ? uzivatelId : null;
    }
    return this.db
      .updateTable('pod_podani')
      .set(zmena)
      .where('id', '=', id)
      .returning(['cislo'])
      .executeTakeFirst();
  }
}
