// Jméno a příjmení jsou povinné na každé cestě přihlášení (pokyn 2026-10-30) + jednotný přihlašovací dialog
// (telefon, e-mail + heslo, e-mail + kód) a brána pro starší účty bez jména (web i aplikace za proxy).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { csrfZ, devKodZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';
import { prihlasenyZeSezeni } from '../src/moduly/sluzby/proxy.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
  t.mail.odeslane.length = 0;
});

const uzivatel = (telefon: string) =>
  t.db.selectFrom('uzivatele').selectAll().where('telefon', '=', telefon).executeTakeFirstOrThrow();

async function zacniInterakci(p: Prohlizec) {
  const inter = await p.get('/prihlaseni');
  const uid = inter.url.split('/oidc/interaction/')[1]!.split('/')[0]!;
  return { uid, text: inter.text };
}

describe('jednotný přihlašovací dialog', () => {
  it('má na jedné stránce telefon, e-mail + heslo a „Neznám heslo“', async () => {
    const p = new Prohlizec(t.base);
    const { uid, text } = await zacniInterakci(p);
    expect(text).toContain(`action="/oidc/interaction/${uid}/telefon"`);
    expect(text).toContain(`action="/oidc/interaction/${uid}/heslo"`);
    expect(text).toContain(`formaction="/oidc/interaction/${uid}/email-kod"`);
    expect(text).toContain('/static/js/prihlaseni.js');
    // stará samostatná stránka hesla vede do dialogu
    const stara = await p.get(`/oidc/interaction/${uid}/heslo`, false);
    expect(stara.res.status).toBe(302);
    expect(stara.res.headers.get('location')).toBe(`/oidc/interaction/${uid}`);
  });
});

describe('povinné jméno', () => {
  it('nový účet z neznámého telefonu: po souhlasu brána jména; prázdné odmítne; uložené doplní přezdívku', async () => {
    const p = new Prohlizec(t.base);
    const { uid, text } = await zacniInterakci(p);
    const kodStranka = await p.post(`/oidc/interaction/${uid}/telefon`, {
      _csrf: csrfZ(text),
      telefon: '777200100',
    });
    const souhlas = await p.post(`/oidc/interaction/${uid}/kod`, {
      _csrf: csrfZ(kodStranka.text),
      telefon: '+420777200100',
      kod: devKodZ(kodStranka.text),
    });
    expect(souhlas.text).toContain(`/oidc/interaction/${uid}/souhlas`);
    const jmeno = await p.post(`/oidc/interaction/${uid}/souhlas`, {
      _csrf: csrfZ(souhlas.text),
      souhlas: 'ano',
    });
    expect(jmeno.text).toContain('Jak se jmenujete?');
    expect(jmeno.text).toContain(`action="/oidc/interaction/${uid}/jmeno"`);
    // bez příjmení neprojde
    const chyba = await p.post(`/oidc/interaction/${uid}/jmeno`, {
      _csrf: csrfZ(jmeno.text),
      jmeno: 'Jana',
      prijmeni: ' ',
    });
    expect(chyba.text).toContain('Vyplňte prosím jméno i příjmení');
    expect((await uzivatel('+420777200100')).jmeno).toBe('');
    const po = await p.post(`/oidc/interaction/${uid}/jmeno`, {
      _csrf: csrfZ(chyba.text),
      jmeno: '  Jana ',
      prijmeni: 'Nováková',
    });
    expect(po.url).toContain('/ucet');
    const u = await uzivatel('+420777200100');
    expect(u).toMatchObject({ jmeno: 'Jana', prijmeni: 'Nováková', prezdivka: 'Jana' });
    const audit = await t.db.selectFrom('audit_log').select('akce').where('uzivatel_id', '=', u.id).execute();
    expect(audit.map((a) => a.akce)).toContain('ucet.jmeno_doplneno');
  });

  it('starší účet bez jména: web i aplikace za proxy ho pošlou na doplnění, pak pustí dál', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200200', { jmeno: 'Petr', prijmeni: 'Starý' });
    await t.db
      .updateTable('uzivatele')
      .set({ jmeno: '', prijmeni: '' })
      .where('telefon', '=', '+420777200200')
      .execute();
    const r = await p.get('/ucet', false);
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get('location')).toBe('/ucet/jmeno?zpet=%2Fucet');
    const r2 = await p.get('/infokanal', false);
    expect(r2.res.headers.get('location')).toBe('/ucet/jmeno?zpet=%2Finfokanal');
    // odhlásit se smí i bez jména (POST s CSRF ze stránky jména)
    const stranka = await p.get('/ucet/jmeno?zpet=%2Fucet');
    expect(stranka.text).toContain('Jak se jmenujete?');

    // proxy pro aplikace (rezervace, eKnihy) pozná účet bez jména
    const prihlaseny = prihlasenyZeSezeni(t.db, t.app.env.SESSION_SECRET);
    const req = { headers: { cookie: p.hlavickaCookie() } } as unknown as FastifyRequest;
    expect(await prihlaseny(req)).toMatchObject({ bezJmena: true });

    const po = await p.post('/ucet/jmeno', {
      _csrf: csrfZ(stranka.text),
      zpet: '/ucet',
      jmeno: 'Petr',
      prijmeni: 'Starý',
    });
    expect(po.url).toContain('/ucet');
    expect(po.text).toContain('Můj účet');
    expect(await prihlaseny(req)).toMatchObject({ bezJmena: false });
    expect((await uzivatel('+420777200200')).prijmeni).toBe('Starý');
  });

  it('Můj účet nedovolí jméno smazat', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777200300', { jmeno: 'Eva', prijmeni: 'Malá' });
    const ucet = await p.get('/ucet');
    const po = await p.post('/ucet', {
      _csrf: csrfZ(ucet.text),
      jmeno: '',
      prijmeni: 'Malá',
      prezdivka: 'Evka',
    });
    expect(po.text).toContain('Vyplňte prosím jméno i příjmení');
    expect(await uzivatel('+420777200300')).toMatchObject({ jmeno: 'Eva', prezdivka: 'Eva' });
  });
});

describe('přihlášení e-mailem a kódem („Neznám heslo“)', () => {
  it('známý e-mail dostane kód a přihlásí se; neznámý dostane stejnou stránku, ale žádný kód', async () => {
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: '+420777200400',
        email: 'kod@example.cz',
        heslo_hash: null,
        jmeno: 'Karel',
        prijmeni: 'Kódový',
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const p = new Prohlizec(t.base);
    const { uid, text } = await zacniInterakci(p);
    const kodStranka = await p.post(`/oidc/interaction/${uid}/email-kod`, {
      _csrf: csrfZ(text),
      email: 'Kod@Example.cz',
    });
    expect(kodStranka.text).toContain('Pokud e-mail kod@example.cz máme');
    expect(t.mail.odeslane).toHaveLength(1);
    expect(t.mail.odeslane[0]!.komu).toBe('kod@example.cz');
    const kod = /kód je (\d{6})/.exec(t.mail.odeslane[0]!.text)![1]!;
    const spatne = await p.post(`/oidc/interaction/${uid}/email-overit`, {
      _csrf: csrfZ(kodStranka.text),
      email: 'kod@example.cz',
      kod: '000000',
    });
    expect(spatne.text).toContain('Kód nesouhlasí');
    const po = await p.post(`/oidc/interaction/${uid}/email-overit`, {
      _csrf: csrfZ(spatne.text),
      email: 'kod@example.cz',
      kod,
    });
    expect(po.url).toContain('/ucet');
    expect(po.text).toContain('Můj účet');
    const audit = await t.db
      .selectFrom('audit_log')
      .select('detail')
      .where('akce', '=', 'prihlaseni')
      .orderBy('ts', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toEqual({ zpusob: 'email' });

    // neznámý e-mail: stejná stránka, nic neodešlo, účet nevznikl
    t.mail.odeslane.length = 0;
    const q = new Prohlizec(t.base);
    const inter = await zacniInterakci(q);
    const neznamy = await q.post(`/oidc/interaction/${inter.uid}/email-kod`, {
      _csrf: csrfZ(inter.text),
      email: 'nikdo@example.cz',
    });
    expect(neznamy.text).toContain('Pokud e-mail nikdo@example.cz máme');
    expect(t.mail.odeslane).toHaveLength(0);
    const pocet = await t.db
      .selectFrom('uzivatele')
      .select(t.db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    const overeni = await q.post(`/oidc/interaction/${inter.uid}/email-overit`, {
      _csrf: csrfZ(neznamy.text),
      email: 'nikdo@example.cz',
      kod: '123456',
    });
    expect(overeni.text).toContain('Kód nesouhlasí');
    expect(
      await t.db.selectFrom('uzivatele').select(t.db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ).toEqual(pocet);
  });
});
