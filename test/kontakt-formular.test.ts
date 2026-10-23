// Kontaktní formulář na stránce Kontakt: adresáti (vedení obce + e-mail obce), kontrola polí, odeslání e-mailu
// s Reply-To, past na roboty, CSRF a vrácení vyplněných údajů po chybě.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adresatiKontaktu, overZpravu } from '../src/web/kontakt-formular.js';
import { csrfZ, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

describe('kontaktní formulář (bez DB)', () => {
  it('adresáti: starosta/místostarosta podle funkce + e-mail obce, bez duplicit', () => {
    const a = adresatiKontaktu({
      kontakt: { email: 'info@obec.cz' },
      lide: [
        { funkce: 'Starostka', email: 'starosta@obec.cz' },
        { funkce: 'Místostarosta', email: 'misto@obec.cz' },
        { funkce: 'Zastupitel', email: 'zast@obec.cz' },
        { funkce: 'Administrativa', email: 'info@obec.cz' },
      ],
    });
    expect(a).toEqual(['starosta@obec.cz', 'misto@obec.cz', 'info@obec.cz']);
  });
  it('kontrola: jméno, e-mail, telefon a délka zprávy', () => {
    expect(overZpravu({ jmeno: 'Jana', email: 'jana@x.cz', zprava: 'Dobrý den, dotaz.' }).ok).toBe(true);
    const v = overZpravu({ jmeno: '', email: 'x', telefon: 'abc', zprava: 'a' });
    expect(Object.keys(v.chyby).sort()).toEqual(['email', 'jmeno', 'telefon', 'zprava']);
  });
});

describe('kontaktní formulář v aplikaci', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await spustTestApp();
  });
  afterAll(async () => t.zavri());
  beforeEach(() => {
    for (const l of Object.values(t.app.limity)) l.reset();
  });

  async function odesli(data: Record<string, string>) {
    const p = new Prohlizec(t.base);
    const f = await p.get('/kontakt');
    return { p, r: await p.post('/kontakt/zprava', { _csrf: csrfZ(f.text), ...data }) };
  }

  it('stránka Kontakt má formulář s popisky a skrytou pastí', async () => {
    const r = await new Prohlizec(t.base).get('/kontakt');
    expect(r.text).toContain('method="post" action="/kontakt/zprava"');
    for (const id of ['kf-jmeno', 'kf-email', 'kf-telefon', 'kf-zprava'])
      expect(r.text).toMatch(new RegExp(`for="${id}"[\\s\\S]*id="${id}"`));
    expect(r.text).toContain('class="past" aria-hidden="true"');
  });

  it('odeslání: e-mail obci s Reply-To odesílatele, jméno bez zalomení v předmětu', async () => {
    const pred = t.mail.odeslane.length;
    const { r } = await odesli({
      jmeno: 'Jan\r\nBcc: x@y.cz Test',
      email: 'jan@example.cz',
      telefon: '777 123 456',
      zprava: 'Dobrý den,\r\nmám dotaz.',
    });
    expect(r.url).toMatch(/\/kontakt/);
    expect(r.text).toContain('zprávu jsme odeslali');
    const nove = t.mail.odeslane.slice(pred);
    expect(nove).toHaveLength(1);
    expect(nove[0]!.komu).toContain('obec@testov.cz');
    expect(nove[0]!.replyTo).toBe('jan@example.cz');
    expect(nove[0]!.predmet).not.toMatch(/[\r\n]/);
    expect(nove[0]!.text).toContain('mám dotaz.');
    expect(nove[0]!.text).toContain('777 123 456');
  });

  it('chyba: vyplněné údaje se vrátí a nic se neodešle', async () => {
    const pred = t.mail.odeslane.length;
    const { r } = await odesli({ jmeno: 'Jana', email: 'spatne', zprava: 'Text zprávy' });
    expect(r.text).toContain('Vyplňte platný e-mail');
    expect(r.text).toContain('Text zprávy');
    expect(t.mail.odeslane.length).toBe(pred);
  });

  it('past na roboty: tváří se jako odesláno, ale nic neodejde', async () => {
    const pred = t.mail.odeslane.length;
    const { r } = await odesli({ jmeno: 'Robot', email: 'r@x.cz', zprava: 'spam spam', web: 'http://spam' });
    expect(r.text).toContain('zprávu jsme odeslali');
    expect(t.mail.odeslane.length).toBe(pred);
  });

  it('bez CSRF tokenu se nic neodešle', async () => {
    const pred = t.mail.odeslane.length;
    const r = await new Prohlizec(t.base).post('/kontakt/zprava', {
      jmeno: 'X',
      email: 'x@x.cz',
      zprava: 'Ahoj světe',
    });
    expect(r.res.status).toBe(403);
    expect(t.mail.odeslane.length).toBe(pred);
  });
});
