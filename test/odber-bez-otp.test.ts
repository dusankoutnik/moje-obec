// Přihláška k odběru nesmí bez ověření kódem nic změnit u existujícího odběratele (code review 19. 10. 2026, H2)
// a správa odběru kódem nesmí ani při limitu prozradit, zda číslo odebírá (S7).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csrfZ, devKodZ, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

async function obet() {
  const { o } = await t.app.infokanal.zalozNeboObnov({
    jmeno: 'Oběť',
    telefon: '+420777800001',
    email: 'obet@example.cz',
    castObce: 'Testov',
    kanal: 'smisene',
    optouty: [],
    zdroj: 'urad',
    overeno: true,
    souhlas: true,
  });
  await t.app.infokanal.odhlas(o.id, 'test');
  return t.db.selectFrom('ik_odberatele').selectAll().where('id', '=', o.id).executeTakeFirstOrThrow();
}

describe('přihláška k odběru bez kódu', () => {
  it('cizí číslo: bez kódu se odběratel neobnoví ani nezmění e-mail; po správném kódu ano', async () => {
    const pred = await obet();
    const utocnik = new Prohlizec(t.base);
    const f = await utocnik.get('/infokanal');
    const overeni = await utocnik.post('/infokanal', {
      _csrf: csrfZ(f.text),
      jmeno: 'Útočník',
      telefon: '777800001',
      email: 'utocnik@example.cz',
      kanal: 'email',
      souhlas: 'ano',
    });
    expect(overeni.text).toContain('Ověření telefonu');
    const po = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('id', '=', pred.id)
      .executeTakeFirstOrThrow();
    expect(po.email).toBe('obet@example.cz');
    expect(po.jmeno).toBe('Oběť');
    expect(po.kanal).toBe('smisene');
    expect(po.odhlasen_at).not.toBeNull();
    // špatný kód nic nezmění
    await utocnik.post('/infokanal/overeni', {
      _csrf: csrfZ(overeni.text),
      telefon: '+420777800001',
      kod: '000000',
    });
    expect(
      (
        await t.db
          .selectFrom('ik_odberatele')
          .select('email')
          .where('id', '=', pred.id)
          .executeTakeFirstOrThrow()
      ).email,
    ).toBe('obet@example.cz');

    // majitel čísla (zná kód) změny potvrdí
    const majitel = new Prohlizec(t.base);
    const f2 = await majitel.get('/infokanal');
    const ov2 = await majitel.post('/infokanal', {
      _csrf: csrfZ(f2.text),
      jmeno: 'Oběť Nová',
      telefon: '777800001',
      email: 'nova@example.cz',
      kanal: 'email',
      souhlas: 'ano',
    });
    const hotovo = await majitel.post('/infokanal/overeni', {
      _csrf: csrfZ(ov2.text),
      telefon: '+420777800001',
      kod: devKodZ(ov2.text),
    });
    expect(hotovo.url).toContain('/infokanal/odber');
    const nove = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('id', '=', pred.id)
      .executeTakeFirstOrThrow();
    expect(nove.email).toBe('nova@example.cz');
    expect(nove.jmeno).toBe('Oběť Nová');
    expect(nove.odhlasen_at).toBeNull();
  });

  it('nový odběratel vznikne až po ověření kódem', async () => {
    const p = new Prohlizec(t.base);
    const f = await p.get('/infokanal');
    const ov = await p.post('/infokanal', {
      _csrf: csrfZ(f.text),
      jmeno: 'Nováček',
      telefon: '777800002',
      souhlas: 'ano',
    });
    expect(await t.app.infokanal.odberatelPodleTelefonu('+420777800002')).toBeUndefined();
    await p.post('/infokanal/overeni', {
      _csrf: csrfZ(ov.text),
      telefon: '+420777800002',
      kod: devKodZ(ov.text),
    });
    const o = await t.app.infokanal.odberatelPodleTelefonu('+420777800002');
    expect(o?.overen_at).not.toBeNull();
    expect(o?.jmeno).toBe('Nováček');
  });

  it('e-mail jiného odběratele se neuloží (žádná chyba 500)', async () => {
    const p = new Prohlizec(t.base);
    const f = await p.get('/infokanal');
    const ov = await p.post('/infokanal', {
      _csrf: csrfZ(f.text),
      jmeno: 'Kolize',
      telefon: '777800003',
      email: 'nova@example.cz',
      kanal: 'email',
      souhlas: 'ano',
    });
    const r = await p.post('/infokanal/overeni', {
      _csrf: csrfZ(ov.text),
      telefon: '+420777800003',
      kod: devKodZ(ov.text),
    });
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('jiný odběr');
    const o = await t.app.infokanal.odberatelPodleTelefonu('+420777800003');
    expect(o?.email).toBeNull();
    expect(o?.kanal).toBe('sms');
  });
});

describe('správa odběru kódem', () => {
  it('po vyčerpání limitu na číslo je odpověď stejná jako u neznámého čísla', async () => {
    const p = new Prohlizec(t.base);
    const zadost = async (telefon: string) => {
      const f = await p.get('/infokanal');
      return p.post('/infokanal/kod', { _csrf: csrfZ(f.text), telefon });
    };
    for (let i = 0; i < 3; i++) expect((await zadost('777800001')).text).toContain('Pokud číslo');
    const posVycerpani = await zadost('777800001');
    const nezname = await zadost('777800099');
    expect(posVycerpani.res.status).toBe(200);
    expect(posVycerpani.text).toContain('Pokud číslo');
    expect(posVycerpani.text).not.toContain('Příliš mnoho');
    const bezPromennych = (s: string) =>
      s
        .replace(/name="_csrf" value="[^"]+"/g, '')
        .replace(/\+?420[ ]?777[ ]?800[ ]?0\d\d/g, 'TEL')
        .replace(/777800\d\d\d/g, 'TEL');
    expect(bezPromennych(posVycerpani.text)).toBe(bezPromennych(nezname.text));
  });
});
