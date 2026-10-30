// Kontaktní formulář na stránce Kontakt (2026-10-23, Dušan): zpráva odchází e-mailem starostovi/starostce,
// místostarostovi/místostarostce (podle funkce v profilu obce, obec.lide) a na oficiální e-mail obce (obec.kontakt.email).
// Bez ukládání do databáze (jen audit bez obsahu). Ochrana: CSRF (globálně), limit podle IP (app.limity.podani),
// past na roboty (skryté pole „web“ — vyplněné = tváříme se, že je odesláno) a od 2026-10-30 bodování podezření
// (`kontakt-spam.ts`: token z JavaScriptu, doba od zobrazení, odkazy, angličtina, reklamní slova).
import type { FastifyInstance } from 'fastify';
import { zapisAudit } from '../lib/audit.js';
import { hlidejLimit } from '../lib/limit.js';
import { ohodnotZpravu, overOvereni, PRAH, vytvorOvereni } from './kontakt-spam.js';

export interface KontaktniZprava {
  jmeno?: string;
  email?: string;
  telefon?: string;
  zprava?: string;
  web?: string;
  /** token z `data-overeni`, opíše ho JavaScript (bez JS zůstane prázdný) */
  overeni?: string;
}

const FUNKCE = /^(starost|místostarost)/i;

/** adresáti: vedení obce podle funkce + oficiální e-mail obce (bez duplicit) */
export function adresatiKontaktu(obec: {
  kontakt: { email?: string | null };
  lide: { funkce?: string | null; email?: string | null }[];
}): string[] {
  const s = new Set<string>();
  for (const c of obec.lide ?? [])
    if (c.email && FUNKCE.test(String(c.funkce ?? '').trim())) s.add(c.email.trim());
  if (obec.kontakt?.email) s.add(obec.kontakt.email.trim());
  return [...s];
}

export function overZpravu(f: KontaktniZprava): { ok: boolean; chyby: Record<string, string> } {
  const chyby: Record<string, string> = {};
  const jmeno = String(f.jmeno ?? '').trim();
  const email = String(f.email ?? '').trim();
  const telefon = String(f.telefon ?? '').trim();
  const zprava = String(f.zprava ?? '').trim();
  if (!jmeno || jmeno.length > 120) chyby.jmeno = 'Vyplňte jméno (nejvýš 120 znaků).';
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email) || email.length > 160)
    chyby.email = 'Vyplňte platný e-mail, ať vám můžeme odpovědět.';
  if (telefon && !/^[+\d][\d \-/()]{5,24}$/.test(telefon))
    chyby.telefon = 'Telefon zadejte jen číslicemi (např. 777 123 456).';
  if (zprava.length < 5 || zprava.length > 5000) chyby.zprava = 'Napište zprávu (5 až 5000 znaků).';
  return { ok: !Object.keys(chyby).length, chyby };
}

/** token pro šablonu stránky Kontakt; zároveň si sezení pamatuje první zobrazení (záloha pro odeslání bez JS) */
export function kontaktOvereni(
  tajemstvi: string,
  req: { session: { sessionId?: string; kontaktZobrazen?: number | null } },
): string {
  const ted = Date.now();
  const z = req.session.kontaktZobrazen;
  if (!z || ted - z > 24 * 3600 * 1000) req.session.kontaktZobrazen = ted;
  return vytvorOvereni(tajemstvi, req.session.sessionId ?? '', ted);
}

export default async function kontaktFormular(app: FastifyInstance) {
  app.post<{ Body: KontaktniZprava }>(
    '/kontakt/zprava',
    { preHandler: hlidejLimit(app.limity.podani) },
    async (req, reply) => {
      const f = req.body ?? {};
      if (String(f.web ?? '').trim()) {
        req.log.info('kontakt: vyplněná past na roboty, zpráva zahozena');
        req.session.flash = { typ: 'ok', text: 'Děkujeme, zprávu jsme odeslali obecnímu úřadu.' };
        return reply.redirect('/kontakt#zprava', 303);
      }
      const v = overZpravu(f);
      if (!v.ok) {
        req.session.kontaktFormular = {
          f: { jmeno: f.jmeno, email: f.email, telefon: f.telefon, zprava: f.zprava },
          chyby: v.chyby,
        };
        return reply.redirect('/kontakt#zprava', 303);
      }
      const komu = adresatiKontaktu(app.obec.obec);
      const jmeno = String(f.jmeno).replace(/\s+/g, ' ').trim(), // jeden řádek — jde do předmětu e-mailu
        email = String(f.email).trim(),
        telefon = String(f.telefon ?? '').trim();
      const zprava = String(f.zprava).trim().replace(/\r\n/g, '\n');
      const zTokenu = overOvereni(app.env.SESSION_SECRET, req.session.sessionId ?? '', f.overeni);
      const h = ohodnotZpravu(
        { jmeno, email, telefon, zprava },
        { jsOk: zTokenu != null, zobrazeno: zTokenu ?? req.session.kontaktZobrazen ?? null },
      );
      if (h.skore >= PRAH.ZAHODIT) {
        req.log.info({ skore: h.skore, duvody: h.duvody }, 'kontakt: zpráva vyhodnocena jako spam, zahozena');
        await zapisAudit(app.db, {
          akce: 'kontakt.spam',
          detail: {
            skore: h.skore,
            duvody: h.duvody,
            delka: zprava.length,
            domena: email.split('@')[1] ?? '',
          },
          ip: req.ip,
        });
        req.session.flash = { typ: 'ok', text: 'Děkujeme, zprávu jsme odeslali obecnímu úřadu.' };
        return reply.redirect('/kontakt#zprava', 303);
      }
      const podezrela = h.skore >= PRAH.OZNACIT;
      try {
        if (!komu.length) throw new Error('obec nemá v profilu e-mail');
        await app.mail.posli({
          komu: komu.join(', '),
          predmet: `${podezrela ? '[možný spam] ' : ''}Zpráva z webu obce: ${jmeno}`,
          replyTo: email,
          text: [
            ...(podezrela
              ? [
                  `⚠️ Zpráva má známky spamu (${h.duvody.join(', ')}). Pokud je to reklama, neodpovídejte a smažte ji.`,
                  ``,
                ]
              : []),
            `Zpráva z kontaktního formuláře na webu ${app.env.BASE_URL.replace(/\/$/, '')}/kontakt`,
            ``,
            `Od: ${jmeno}`,
            `E-mail: ${email}`,
            ...(telefon ? [`Telefon: ${telefon}`] : []),
            `Odesláno: ${new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' })}`,
            ``,
            zprava,
            ``,
            `—`,
            `Odpověď tlačítkem „Odpovědět“ půjde přímo odesílateli.`,
          ].join('\n'),
        });
      } catch (e) {
        req.log.error({ err: e }, 'kontakt: e-mail se nepodařilo odeslat');
        req.session.kontaktFormular = {
          f: { jmeno, email, telefon, zprava },
          chyby: {
            odeslani:
              'Zprávu se teď nepodařilo odeslat. Zkuste to prosím za chvíli, nebo napište přímo na e-mail obce.',
          },
        };
        return reply.redirect('/kontakt#zprava', 303);
      }
      await zapisAudit(app.db, {
        akce: 'kontakt.zprava',
        detail: {
          adresatu: komu.length,
          delka: zprava.length,
          skore: h.skore,
          ...(podezrela ? { duvody: h.duvody } : {}),
        },
        ip: req.ip,
      });
      req.session.flash = {
        typ: 'ok',
        text: 'Děkujeme, zprávu jsme odeslali obecnímu úřadu. Odpovíme na váš e-mail.',
      };
      return reply.redirect('/kontakt#zprava', 303);
    },
  );
}

declare module 'fastify' {
  interface Session {
    /** vyplněný formulář a chyby po neúspěšném odeslání (zobrazí se jednou) */
    kontaktFormular?: { f: KontaktniZprava; chyby: Record<string, string> } | null;
    /** první zobrazení formuláře Kontakt (ms) — záloha pro odeslání bez JavaScriptu */
    kontaktZobrazen?: number | null;
  }
}
