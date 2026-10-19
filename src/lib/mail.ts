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
