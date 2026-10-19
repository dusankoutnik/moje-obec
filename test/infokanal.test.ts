import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfZ, devKodZ, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());

async function kategorieId(slug: string) {
  return (
    await t.db.selectFrom('ik_kategorie').select('id').where('slug', '=', slug).executeTakeFirstOrThrow()
  ).id;
}

describe('odběr veřejně', () => {
  it('přihlášení k odběru s OTP, správa, odhlášení odkazem', async () => {
    const p = new Prohlizec(t.base);
    const form = await p.get('/infokanal');
    expect(form.text).toContain('TestKanál');
    const kultura = await kategorieId('kultura');
    const bezSouhlasu = await p.post('/infokanal', {
      _csrf: csrfZ(form.text),
      jmeno: 'Petr Test',
      telefon: '777300100',
    });
    expect(bezSouhlasu.text).toContain('Bez souhlasu');
    const overeni = await p.post('/infokanal', {
      _csrf: csrfZ(bezSouhlasu.text),
      jmeno: 'Petr Test',
      telefon: '777300100',
      email: 'petr@example.cz',
      cast_obce: 'Dolní Testov',
      kanal: 'smisene',
      kategorie: [String(kultura)],
      souhlas: 'ano',
    });
    expect(overeni.text).toContain('Ověření telefonu');
    expect(t.sms.odeslane.at(-1)?.text).toContain('Overovaci kod pro odber');
    const odber = await p.post('/infokanal/overeni', {
      _csrf: csrfZ(overeni.text),
      telefon: '+420777300100',
      kod: devKodZ(overeni.text),
    });
    expect(odber.url).toContain('/infokanal/odber');
    expect(odber.text).toContain('Odběr je potvrzený');
    const o = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('telefon', '=', '+420777300100')
      .executeTakeFirstOrThrow();
    expect(o.overen_at).not.toBeNull();
    expect(o.kanal).toBe('smisene');
    expect(o.cast_obce).toBe('Dolní Testov');
    const optouty = await t.db
      .selectFrom('ik_optouty')
      .select('kategorie_id')
      .where('odberatel_id', '=', o.id)
      .execute();
    expect(optouty.length).toBeGreaterThan(0);
    expect(optouty.map((x) => x.kategorie_id)).not.toContain(kultura);

    // úprava odběru: zapnout vše, vše SMSkou
    const vse = (await t.db.selectFrom('ik_kategorie').select('id').execute()).map((k) => String(k.id));
    const po = await p.post('/infokanal/odber', {
      _csrf: csrfZ(odber.text),
      jmeno: 'Petr Test',
      email: 'petr@example.cz',
      cast_obce: 'Testov',
      kanal: 'sms',
      kategorie: vse,
    });
    expect(po.text).toContain('Nastavení odběru je uložené');
    expect(
      await t.db.selectFrom('ik_optouty').select('kategorie_id').where('odberatel_id', '=', o.id).execute(),
    ).toHaveLength(0);

    // odhlášení odkazem z e-mailu
    const q = new Prohlizec(t.base);
    const potvrzeni = await q.get(`/infokanal/odhlasit/${o.token}`);
    expect(potvrzeni.text).toContain('Zrušení odběru');
    const hotovo = await q.post(`/infokanal/odhlasit/${o.token}`, { _csrf: csrfZ(potvrzeni.text) });
    expect(hotovo.text).toContain('Odběr je zrušený');
    const o2 = await t.db
      .selectFrom('ik_odberatele')
      .select('odhlasen_at')
      .where('id', '=', o.id)
      .executeTakeFirstOrThrow();
    expect(o2.odhlasen_at).not.toBeNull();
    expect((await q.get('/infokanal/odhlasit/neplatny-token')).res.status).toBe(404);
  });

  it('přihlášený občan se stejným telefonem se přihlásí k odběru bez dalšího kódu', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777300200');
    const pocetSms = t.sms.odeslane.length;
    const form = await p.get('/infokanal');
    expect(form.text).toContain('+420 777 300 200');
    const po = await p.post('/infokanal', {
      _csrf: csrfZ(form.text),
      jmeno: 'Účet Test',
      telefon: '+420777300200',
      kanal: 'sms',
      souhlas: 'ano',
    });
    expect(po.url).toContain('/infokanal/odber');
    expect(t.sms.odeslane.length).toBe(pocetSms);
    const o = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('telefon', '=', '+420777300200')
      .executeTakeFirstOrThrow();
    expect(o.overen_at).not.toBeNull();
    expect(o.zdroj).toBe('ucet');
    expect(o.uzivatel_id).not.toBeNull();
  });
});

describe('hlášení a rozesílka', () => {
  it('redaktor založí hlášení, fronta rozešle podle preferencí, doručenky z webhooku', async () => {
    await t.db
      .insertInto('ik_odberatele')
      .values([
        {
          jmeno: 'A',
          telefon: '+420777300301',
          email: 'a@example.cz',
          cast_obce: 'Testov',
          kanal: 'smisene',
          token: 'tok-a',
          overen_at: new Date(),
          zdroj: 'import',
        },
        {
          jmeno: 'B',
          telefon: '+420777300302',
          email: null,
          cast_obce: 'Testov',
          kanal: 'sms',
          token: 'tok-b',
          overen_at: new Date(),
          zdroj: 'import',
        },
        {
          jmeno: 'C',
          telefon: '+420777300303',
          email: 'c@example.cz',
          cast_obce: 'Dolní Testov',
          kanal: 'email',
          token: 'tok-c',
          overen_at: new Date(),
          zdroj: 'import',
        },
      ])
      .execute();
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: '+420777300400',
        email: null,
        heslo_hash: null,
        role: ['redaktor'],
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '+420777300400');
    const nove = await p.get('/infokanal/sprava/nove');
    expect(nove.res.status).toBe(200);
    const prazdne = await p.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(nove.text),
      kategorie_id: String(await kategorieId('hlaseni')),
      cil: 'vse',
    });
    expect(prazdne.text).toContain('Vyplňte aspoň SMS text nebo e-mail');
    const smsPred = t.sms.odeslane.length;
    const mailPred = t.mail.odeslane.length;
    const detail = await p.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(prazdne.text),
      kategorie_id: String(await kategorieId('hlaseni')),
      cil: 'vse',
      sms_text: 'Zítra nepoteče voda — od 8 do 12 h.',
      email_predmet: 'Odstávka vody',
      email_text: 'Zítra od 8 do 12 hodin nepoteče voda.\n\nDěkujeme za pochopení.',
    });
    expect(detail.text).toContain('rozesílá se');
    const n = await t.app.infokanalFronta.zpracujVse();
    expect(n).toBeGreaterThanOrEqual(3);
    const sms = t.sms.odeslane.slice(smsPred);
    const maily = t.mail.odeslane.slice(mailPred);
    // A smíšené + povinná kategorie → SMS; B → SMS; C → e-mail; odběratel z účtu (777300200) → SMS; odhlášený 777300100 nic
    expect(sms.map((s) => s.telefon).sort()).toEqual(['+420777300200', '+420777300301', '+420777300302']);
    expect(sms[0]!.text).toBe('TESTOV: Zitra nepotece voda - od 8 do 12 h.');
    expect(maily.map((m) => m.komu)).toEqual(['c@example.cz']);
    expect(maily[0]!.text).toContain('/infokanal/odhlasit/tok-c');
    expect(maily[0]!.html).toContain('<p>Zítra od 8 do 12 hodin nepoteče voda.</p>');
    const h = await t.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .orderBy('vytvoreno_at', 'desc')
      .executeTakeFirstOrThrow();
    expect(h.stav).toBe('hotovo');
    const prijemci = await t.db
      .selectFrom('ik_prijemci')
      .selectAll()
      .where('hlaseni_id', '=', h.id)
      .execute();
    expect(prijemci.every((r) => r.stav === 'odeslano' && r.brana_id)).toBe(true);

    // doručenka webhookem (konzolový poskytovatel webhook nemá → 0 změn, ale endpoint žije a je chráněný tajemstvím)
    const spatne = await fetch(`${t.base}/webhook/sms/spatne`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(spatne.status).toBe(404);
    const ok = await fetch(`${t.base}/webhook/sms/${'a'.repeat(24)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(ok.status).toBe(200);
    // polling doručenek: konzole hlásí doručeno
    const zmen = await t.app.infokanalFronta.aktualizujDorucenky();
    expect(zmen).toBe(sms.length);
    const stranka = await p.get(`/infokanal/sprava/hlaseni/${h.id}`);
    expect(stranka.text).toContain('doručeno');
  });

  it('krizové hlášení jde všem na oba kanály; zastavení rozesílky', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '+420777300400');
    const nove = await p.get('/infokanal/sprava/nove');
    const detail = await p.post('/infokanal/sprava/nove', {
      _csrf: csrfZ(nove.text),
      kategorie_id: String(await kategorieId('krizove')),
      krizove: 'ano',
      cil: 'vse',
      sms_text: 'Pozor, povodeň.',
      email_predmet: 'Povodeň',
      email_text: 'Pozor, povodeň.',
    });
    const h = await t.db
      .selectFrom('ik_hlaseni')
      .selectAll()
      .orderBy('vytvoreno_at', 'desc')
      .executeTakeFirstOrThrow();
    const prijemci = await t.db
      .selectFrom('ik_prijemci')
      .select(['kanal', 'kontakt'])
      .where('hlaseni_id', '=', h.id)
      .execute();
    expect(prijemci.filter((r) => r.kanal === 'sms')).toHaveLength(4);
    expect(prijemci.filter((r) => r.kanal === 'email')).toHaveLength(2);
    const po = await p.post(`/infokanal/sprava/hlaseni/${h.id}/zrusit`, { _csrf: csrfZ(detail.text) });
    expect(po.text).toContain('zrušeno');
    const zbyva = await t.db
      .selectFrom('ik_prijemci')
      .select('stav')
      .where('hlaseni_id', '=', h.id)
      .execute();
    expect(zbyva.every((r) => r.stav === 'vzdano')).toBe(true);
    expect(await t.app.infokanalFronta.zpracujVse()).toBe(0);
  });

  it('občan bez role do správy nesmí', async () => {
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777300500');
    expect((await p.get('/infokanal/sprava')).res.status).toBe(403);
  });
});
