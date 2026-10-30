// Kontaktní formulář na stránce Kontakt: adresáti (vedení obce + e-mail obce), kontrola polí, odeslání e-mailu
// s Reply-To, past na roboty, CSRF a vrácení vyplněných údajů po chybě.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adresatiKontaktu, overZpravu } from '../src/web/kontakt-formular.js';
import { MIN_SEKUND, ohodnotZpravu, overOvereni, PRAH, vytvorOvereni } from '../src/web/kontakt-spam.js';
import { csrfZ, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

const SPAM_LEADGEN = `Hi there,

You're reading this because I just used your contact form. If I were a buyer, how quickly would I get a call back?
Our software makes that call for you. Hear it for yourself: open https://ultraleadgeneration.com/ and type in your number.
No card is needed on our Basic plan. You get 14 days free.

Not interested? Unsubscribe here: https://ultraleadgeneration.com/unsubscribe.aspx?d=vlastiborice.cz`;

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

describe('ochrana před roboty (bodování)', () => {
  const ted = 1_800_000_000_000;
  const clovek = { jsOk: true, zobrazeno: ted - 60_000, ted };
  it('skutečný spam „lead generation“ se zahodí i s JavaScriptem a pomalým odesláním', () => {
    const h = ohodnotZpravu(
      { jmeno: 'Wilda', email: 'hello@amazingleadgen.com', zprava: SPAM_LEADGEN },
      clovek,
    );
    expect(h.skore).toBeGreaterThanOrEqual(PRAH.ZAHODIT);
    expect(h.duvody.join()).toMatch(/odkazy: 2.*anglický text.*reklamní slova/);
  });
  it('česká zpráva od člověka projde čistě, i s jedním odkazem', () => {
    const z = 'Dobrý den, chtěla bych se zeptat na poplatek za odpad. Děkuji, Nováková';
    expect(ohodnotZpravu({ zprava: z }, clovek).skore).toBe(0);
    expect(ohodnotZpravu({ zprava: z + ' https://example.cz/dokument.pdf' }, clovek).skore).toBeLessThan(
      PRAH.OZNACIT,
    );
  });
  it('bez JavaScriptu se česká zpráva nejvýš označí, nikdy nezahodí', () => {
    const z = 'Dobrý den, prosím o informaci k zastupitelstvu. Děkuji.';
    const h = ohodnotZpravu({ zprava: z }, { jsOk: false, zobrazeno: ted - 2000, ted }); // rychle a bez JS
    expect(h.skore).toBeGreaterThanOrEqual(PRAH.OZNACIT);
    expect(h.skore).toBeLessThan(PRAH.ZAHODIT);
    expect(ohodnotZpravu({ zprava: z }, { jsOk: false, zobrazeno: ted - 30_000, ted }).skore).toBeLessThan(
      PRAH.OZNACIT,
    );
  });
  it('robot: bez JS a za 3 s, i krátký text bez odkazů, se zahodí', () => {
    const h = ohodnotZpravu(
      { zprava: 'Hello, are you looking for more clients for your business?' },
      { jsOk: false, zobrazeno: ted - 3000, ted },
    );
    expect(h.skore).toBeGreaterThanOrEqual(PRAH.ZAHODIT);
  });
  it('baskický robot „RobertVax“: bez JS a rychle se zahodí; s JS a pomalu by se jen označil', () => {
    const f = {
      jmeno: 'RobertVax',
      email: 'aveyekoha655@gmail.com',
      telefon: '83634687879',
      zprava: 'Kaixo, zure prezioa jakin nahi nuen.',
    };
    expect(ohodnotZpravu(f, { jsOk: false, zobrazeno: ted - 3000, ted }).skore).toBeGreaterThanOrEqual(
      PRAH.ZAHODIT,
    );
    const h = ohodnotZpravu(f, clovek);
    expect(h.duvody).toEqual(['slepené jméno', 'cizí telefon']);
    expect(h.skore).toBeLessThan(PRAH.OZNACIT);
  });
  it('token: platný jen se stejným tajemstvím a sezením, nese čas zobrazení', () => {
    const tok = vytvorOvereni('tajne', 'sezeni1', ted);
    expect(overOvereni('tajne', 'sezeni1', tok)).toBe(ted);
    expect(overOvereni('tajne', 'sezeni2', tok)).toBeNull();
    expect(overOvereni('jine', 'sezeni1', tok)).toBeNull();
    expect(overOvereni('tajne', 'sezeni1', `${ted}.x`)).toBeNull();
    expect(overOvereni('tajne', 'sezeni1', '')).toBeNull();
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

  /** token, jako by člověk měl stránku otevřenou už `sekund` (a JavaScript ho opsal do skrytého pole) */
  function tokenZ(p: Prohlizec, sekund = MIN_SEKUND + 10) {
    const cookie = decodeURIComponent(/mo_sezeni=([^;]+)/.exec(p.hlavickaCookie())?.[1] ?? '');
    const sezeni = cookie.slice(0, cookie.indexOf('.'));
    return vytvorOvereni(t.app.env.SESSION_SECRET, sezeni, Date.now() - sekund * 1000);
  }

  async function odesli(data: Record<string, string>, volby: { bezJs?: boolean } = {}) {
    const p = new Prohlizec(t.base);
    const f = await p.get('/kontakt');
    expect(f.text).toContain('data-overeni="');
    expect(f.text).toContain('/static/js/kontakt.js');
    const overeni = volby.bezJs ? '' : tokenZ(p);
    return { p, r: await p.post('/kontakt/zprava', { _csrf: csrfZ(f.text), overeni, ...data }) };
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

  it('spam se tiše zahodí: odpověď jako u člověka, žádný e-mail, audit bez obsahu', async () => {
    const pred = t.mail.odeslane.length;
    const { r } = await odesli({ jmeno: 'Wilda', email: 'hello@amazingleadgen.com', zprava: SPAM_LEADGEN });
    expect(r.text).toContain('zprávu jsme odeslali');
    expect(t.mail.odeslane.length).toBe(pred);
    const a = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'kontakt.spam')
      .orderBy('ts', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(a.detail).toMatchObject({ domena: 'amazingleadgen.com' });
    expect(JSON.stringify(a.detail)).not.toContain('ultraleadgeneration');
  });

  it('hraniční zpráva (bez JavaScriptu, hned po zobrazení) odejde s označením [možný spam]', async () => {
    const pred = t.mail.odeslane.length;
    const { r } = await odesli(
      {
        jmeno: 'Jana',
        email: 'jana@example.cz',
        zprava: 'Dobrý den, prosím o informaci k poplatku. Děkuji.',
      },
      { bezJs: true },
    );
    expect(r.text).toContain('zprávu jsme odeslali');
    const nove = t.mail.odeslane.slice(pred);
    expect(nove).toHaveLength(1);
    expect(nove[0]!.predmet).toMatch(/^\[možný spam\] Zpráva z webu obce: Jana$/);
    expect(nove[0]!.text).toContain('bez JavaScriptu');
  });

  it('token z jiného sezení neplatí (počítá se jako bez JavaScriptu)', async () => {
    const cizi = new Prohlizec(t.base);
    await cizi.get('/kontakt');
    const p = new Prohlizec(t.base);
    const f = await p.get('/kontakt');
    const pred = t.mail.odeslane.length;
    await p.post('/kontakt/zprava', {
      _csrf: csrfZ(f.text),
      overeni: tokenZ(cizi),
      jmeno: 'Robot',
      email: 'r@x.com',
      zprava: 'Hello, we can get you more clients for your business, click here.',
    });
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
