// Citlivé změny účtu (e-mail, heslo) jen po čerstvém ověření — nález bezpečnostního testera.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfZ, devKodZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
// všechny požadavky jdou z jedné IP — limity podle IP mezi testy nulovat
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

function emailKodZ(html: string): string {
  const m = /kód z e-mailu je (\d{6})/.exec(html);
  if (!m) throw new Error('kód z e-mailu nenalezen');
  return m[1]!;
}

async function uzivatel(telefon: string) {
  return t.db.selectFrom('uzivatele').selectAll().where('telefon', '=', telefon).executeTakeFirstOrThrow();
}

// projde ověření SMS kódem, výsledkem je stránka, kam ověření pokračuje
async function overSms(p: Prohlizec, dalsi: string) {
  const strana = await p.get(`/ucet/overeni?dalsi=${encodeURIComponent(dalsi)}`);
  const poslano = await p.post('/ucet/overeni/sms', { _csrf: csrfZ(strana.text), dalsi });
  return p.post('/ucet/overeni/kod', { _csrf: csrfZ(poslano.text), dalsi, kod: devKodZ(poslano.text) });
}

async function nastavEmail(p: Prohlizec, email: string) {
  const form = await overSms(p, '/ucet/email');
  expect(form.url).toContain('/ucet/email');
  const kod = await p.post('/ucet/email', { _csrf: csrfZ(form.text), email });
  expect(kod.text).toContain('Potvrzení nového e-mailu');
  return p.post('/ucet/email/potvrdit', { _csrf: csrfZ(kod.text), kod: emailKodZ(kod.text) });
}

describe('bez čerstvého ověření nic', () => {
  it('změna hesla i e-mailu bez ověření přesměruje na ověření a nic nezmění', async () => {
    const p = new Prohlizec(t.base);
    const ucet = await prihlasTelefonem(p, '777200100');
    const csrf = csrfZ(ucet.text);
    const heslo = await p.post(
      '/ucet/heslo',
      { _csrf: csrf, heslo: 'velmi-tajne-heslo', heslo2: 'velmi-tajne-heslo' },
      false,
    );
    expect(heslo.res.status).toBe(302);
    expect(heslo.res.headers.get('location')).toContain('/ucet/overeni');
    const email = await p.post('/ucet/email', { _csrf: csrf, email: 'utocnik@example.cz' }, false);
    expect(email.res.headers.get('location')).toContain('/ucet/overeni');
    const odebrat = await p.post('/ucet/email', { _csrf: csrf, akce: 'odebrat' }, false);
    expect(odebrat.res.headers.get('location')).toContain('/ucet/overeni');
    // starý profilový formulář e-mail už nepřijímá
    await p.post('/ucet', { _csrf: csrf, jmeno: 'Eva', email: 'utocnik@example.cz' });
    const u = await uzivatel('+420777200100');
    expect(u.heslo_hash).toBeNull();
    expect(u.email).toBeNull();
    expect(u.email_cekajici).toBeNull();
    expect(u.jmeno).toBe('Eva');
    expect(t.mail.odeslane.some((m) => m.komu === 'utocnik@example.cz')).toBe(false);
  });

  it('ověření nesmí přesměrovat jinam než na citlivé stránky', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200150');
    const po = await overSms(p, 'https://zlo.example/');
    expect(po.url).toContain('/ucet');
    expect(po.url).not.toContain('zlo');
  });

  it('ověření vyprší po 10 minutách', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200160');
    const form = await overSms(p, '/ucet/heslo');
    expect(form.url).toContain('/ucet/heslo');
    const u = await uzivatel('+420777200160');
    await sql`UPDATE sezeni SET data = jsonb_set(data, '{overenoDo}', '0') WHERE data->>'uzivatelId' = ${u.id}`.execute(
      t.db,
    );
    const znovu = await p.get('/ucet/heslo');
    expect(znovu.url).toContain('/ucet/overeni');
  });
});

describe('e-mail', () => {
  it('nový e-mail čeká na potvrzení, platí až po kódu; upozornění SMS a odhlášení ostatních', async () => {
    const p = new Prohlizec(t.base);
    const druhe = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200200');
    await prihlasTelefonem(druhe, '777200200');
    expect((await druhe.get('/ucet')).url).toContain('/ucet');

    const form = await overSms(p, '/ucet/email');
    expect(t.sms.odeslane.at(-1)?.text).toContain('Kod pro zmenu uctu');
    const kodStrana = await p.post('/ucet/email', { _csrf: csrfZ(form.text), email: 'Eva@Example.cz' });
    let u = await uzivatel('+420777200200');
    expect(u.email).toBeNull();
    expect(u.email_cekajici).toBe('eva@example.cz');
    expect(t.mail.odeslane.at(-1)?.komu).toBe('eva@example.cz');

    const spatne = await p.post('/ucet/email/potvrdit', { _csrf: csrfZ(kodStrana.text), kod: '000000' });
    expect(spatne.text).toContain('Kód nesouhlasí');
    const ok = await p.post('/ucet/email/potvrdit', {
      _csrf: csrfZ(spatne.text),
      kod: emailKodZ(kodStrana.text),
    });
    expect(ok.text).toContain('je potvrzený');
    u = await uzivatel('+420777200200');
    expect(u.email).toBe('eva@example.cz');
    expect(u.email_overen_at).not.toBeNull();
    expect(u.email_cekajici).toBeNull();
    expect(t.sms.odeslane.at(-1)?.text).toContain('byl zmenen e-mail');
    // ostatní sezení odhlášeno, aktuální ne
    expect((await druhe.get('/ucet')).url).toContain('/oidc/interaction/');
    expect((await p.get('/ucet')).url).toContain('/ucet');
    const akce = (
      await t.db.selectFrom('audit_log').select('akce').where('uzivatel_id', '=', u.id).execute()
    ).map((a) => a.akce);
    expect(akce).toEqual(
      expect.arrayContaining([
        'ucet.overeni',
        'ucet.email_zadost',
        'ucet.email_zmenen',
        'ucet.odhlaseni_ostatnich',
      ]),
    );
  });

  it('čekající e-mail nejde použít k přihlášení heslem ani obsadit cizí', async () => {
    const a = new Prohlizec(t.base);
    await prihlasTelefonem(a, '777200300');
    await nastavEmail(a, 'adam@example.cz');
    const form = await overSms(a, '/ucet/heslo');
    await a.post('/ucet/heslo', {
      _csrf: csrfZ(form.text),
      heslo: 'adamovo-heslo-1',
      heslo2: 'adamovo-heslo-1',
    });

    // B chce Adamův e-mail → obsazeno
    const b = new Prohlizec(t.base);
    await prihlasTelefonem(b, '777200301');
    const bForm = await overSms(b, '/ucet/email');
    const obsazeno = await b.post('/ucet/email', { _csrf: csrfZ(bForm.text), email: 'adam@example.cz' });
    expect(obsazeno.text).toContain('už používá jiný účet');

    // A požádá o nový e-mail, ale nepotvrdí — přihlášení heslem s novým e-mailem neprojde, se starým ano
    const aForm = await a.get('/ucet/email');
    await a.post('/ucet/email', { _csrf: csrfZ(aForm.text), email: 'adam-novy@example.cz' });
    const u = await t.app.ucty.prihlasHeslem('adam-novy@example.cz', 'adamovo-heslo-1');
    expect(u).toBeNull();
    expect(await t.app.ucty.prihlasHeslem('adam@example.cz', 'adamovo-heslo-1')).not.toBeNull();
  });

  it('odebrání e-mailu zruší i heslo', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200400');
    await nastavEmail(p, 'odebrat@example.cz');
    const f = await overSms(p, '/ucet/heslo');
    await p.post('/ucet/heslo', {
      _csrf: csrfZ(f.text),
      heslo: 'nejake-heslo-12',
      heslo2: 'nejake-heslo-12',
    });
    const e = await p.get('/ucet/email');
    const po = await p.post('/ucet/email', { _csrf: csrfZ(e.text), akce: 'odebrat' });
    expect(po.text).toContain('odebrali');
    const u = await uzivatel('+420777200400');
    expect(u.email).toBeNull();
    expect(u.heslo_hash).toBeNull();
  });
});

describe('heslo', () => {
  it('účet s heslem se ověřuje starým heslem; špatné neprojde; SMS jako záloha', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200500');
    await nastavEmail(p, 'heslo@example.cz');
    const f = await overSms(p, '/ucet/heslo');
    const hotovo = await p.post('/ucet/heslo', {
      _csrf: csrfZ(f.text),
      heslo: 'prvni-heslo-123',
      heslo2: 'prvni-heslo-123',
    });
    expect(hotovo.text).toContain('heslo je nastavené');
    expect(t.sms.odeslane.at(-1)?.text).toContain('zmeneno heslo');

    // ověření vyprší → znovu, teď už heslem
    const u = await uzivatel('+420777200500');
    await sql`UPDATE sezeni SET data = jsonb_set(data, '{overenoDo}', '0') WHERE data->>'uzivatelId' = ${u.id}`.execute(
      t.db,
    );
    const overeni = await p.get('/ucet/heslo');
    expect(overeni.text).toContain('Vaše současné heslo');
    const spatne = await p.post('/ucet/overeni/heslo', {
      _csrf: csrfZ(overeni.text),
      heslo: 'tohle-neni-ono',
      dalsi: '/ucet/heslo',
    });
    expect(spatne.text).toContain('Heslo nesouhlasí');
    const dobre = await p.post('/ucet/overeni/heslo', {
      _csrf: csrfZ(spatne.text),
      heslo: 'prvni-heslo-123',
      dalsi: '/ucet/heslo',
    });
    expect(dobre.url).toContain('/ucet/heslo');
    const nesouhlasi = await p.post('/ucet/heslo', {
      _csrf: csrfZ(dobre.text),
      heslo: 'druhe-heslo-123',
      heslo2: 'jine-heslo-1234',
    });
    expect(nesouhlasi.text).toContain('neshodují');
    const druhe = await p.post('/ucet/heslo', {
      _csrf: csrfZ(nesouhlasi.text),
      heslo: 'druhe-heslo-123',
      heslo2: 'druhe-heslo-123',
    });
    expect(druhe.text).toContain('heslo je nastavené');
    expect(await t.app.ucty.prihlasHeslem('heslo@example.cz', 'druhe-heslo-123')).not.toBeNull();
    const selhalo = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('uzivatel_id', '=', u.id)
      .where('akce', '=', 'ucet.overeni_selhalo')
      .execute();
    expect(selhalo.length).toBe(1);
  });

  it('špatné kódy ověření narazí na IP limit (429)', async () => {
    t.app.limity.overit.reset();
    const p = new Prohlizec(t.base);
    p.hlavicky['x-forwarded-for'] = '203.0.113.77';
    await prihlasTelefonem(p, '777200600');
    let strana = await p.get('/ucet/overeni?dalsi=/ucet/heslo');
    let posledni = 0;
    for (let i = 0; i < 21; i++) {
      const r = await p.post(
        '/ucet/overeni/kod',
        { _csrf: csrfZ(strana.text), kod: '111111', dalsi: '/ucet/heslo' },
        false,
      );
      posledni = r.res.status;
      if (r.res.status === 200) strana = r;
    }
    expect(posledni).toBe(429);
    t.app.limity.overit.reset();
  });
});
