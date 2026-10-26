// E-mail: `konzole` (loguje) nebo `smtp` (nodemailer). Prázdný příjemce = tiché nic (mnoho občanů e-mail nemá).
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from './logger.js';

export interface Zprava {
  komu: string;
  predmet: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface MailPoskytovatel {
  readonly nazev: string;
  posli(z: Zprava): Promise<{ id: string | null }>;
}

export class KonzoleMail implements MailPoskytovatel {
  readonly nazev = 'konzole';
  readonly odeslane: Zprava[] = [];
  constructor(private log?: Logger) {}
  async posli(z: Zprava) {
    this.odeslane.push(z);
    if (this.odeslane.length > 200) this.odeslane.shift();
    this.log?.info({ mail: { komu: z.komu, predmet: z.predmet } }, 'E-mail (konzole, neodesláno)');
    return { id: `konzole-${this.odeslane.length}` };
  }
}

export interface SmtpKonfigurace {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpMail implements MailPoskytovatel {
  readonly nazev = 'smtp';
  private t: Transporter;
  constructor(private cfg: SmtpKonfigurace) {
    this.t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
    });
  }
  async posli(z: Zprava) {
    const info = await this.t.sendMail({
      from: this.cfg.from,
      to: z.komu,
      subject: z.predmet,
      text: z.text,
      html: z.html,
      replyTo: z.replyTo,
    });
    return { id: info.messageId ?? null };
  }
}

/** poslední úspěšné a neúspěšné odeslání v tomto procesu (stránka Stav systému; po restartu prázdné) */
export interface StavMailu {
  posledniOk: Date | null;
  posledniChyba: { at: Date; zprava: string } | null;
  odeslano: number;
  chyb: number;
}

export const stavMailu: StavMailu = { posledniOk: null, posledniChyba: null, odeslano: 0, chyb: 0 };

/** text chyby bez e-mailových adres (odpovědi SMTP serveru je často obsahují) */
export function bezAdres(text: string): string {
  return text.replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, '…@…').slice(0, 300);
}

/**
 * Obal poskytovatele, který si pamatuje výsledek odeslání; ostatní vlastnosti (např. KonzoleMail.odeslane) propouští.
 * Obalená funkce se drží v uzávěru — i když někdo `posli` přepíše (testy), obal nevolá sám sebe.
 */
export function sledujMail<T extends MailPoskytovatel>(mail: T): T {
  const obaly = new WeakMap<object, MailPoskytovatel['posli']>();
  const obal =
    (f: MailPoskytovatel['posli'], cil: T): MailPoskytovatel['posli'] =>
    async (z: Zprava) => {
      try {
        const r = await f.call(cil, z);
        stavMailu.posledniOk = new Date();
        stavMailu.odeslano++;
        return r;
      } catch (e) {
        stavMailu.posledniChyba = { at: new Date(), zprava: bezAdres(String((e as Error)?.message ?? e)) };
        stavMailu.chyb++;
        throw e;
      }
    };
  return new Proxy(mail, {
    get(cil, klic, prijemce) {
      const v: unknown = Reflect.get(cil, klic, prijemce);
      if (klic !== 'posli' || typeof v !== 'function') return v;
      const f = v as MailPoskytovatel['posli'];
      let o = obaly.get(f);
      if (!o) obaly.set(f, (o = obal(f, cil)));
      return o;
    },
  });
}
