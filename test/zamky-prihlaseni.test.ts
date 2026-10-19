// Zámek přihlášení heslem po opakovaných chybách (code review S5).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashujHeslo } from '../src/lib/krypto.js';
import { delkaZamkuMin, klicEmail, ZAMEK_PO_CHYBACH } from '../src/lib/zamky.js';
import { csrfZ, prihlasSRoli, prihlasTelefonem, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

async function strankaHesla(p: Prohlizec) {
  const inter = await p.get('/prihlaseni');
  const uid = inter.url.split('/oidc/interaction/')[1]!.split('/')[0]!;
  const s = await p.get(`/oidc/interaction/${uid}/heslo`);
  return { uid, text: s.text };
}

async function zkus(p: Prohlizec, email: string, heslo: string) {
  const { uid, text } = await strankaHesla(p);
  return p.post(`/oidc/interaction/${uid}/heslo`, { _csrf: csrfZ(text), email, heslo });
}

describe('zámek přihlášení heslem', () => {
  it('backoff roste a má strop', () => {
    expect(delkaZamkuMin(ZAMEK_PO_CHYBACH - 1)).toBe(0);
    expect(delkaZamkuMin(ZAMEK_PO_CHYBACH)).toBe(15);
    expect(delkaZamkuMin(ZAMEK_PO_CHYBACH + 1)).toBe(30);
    expect(delkaZamkuMin(ZAMEK_PO_CHYBACH + 2)).toBe(60);
    expect(delkaZamkuMin(100)).toBe(24 * 60);
  });

  it('po 5 chybách zamkne i správné heslo; neexistující e-mail se chová stejně; SMS kód funguje dál', async () => {
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: '+420777650001',
        email: 'zamek@example.cz',
        heslo_hash: await hashujHeslo('spravne-heslo-1'),
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const p = new Prohlizec(t.base);
    for (let i = 0; i < ZAMEK_PO_CHYBACH - 1; i++) {
      const r = await zkus(p, 'zamek@example.cz', 'spatne');
      expect(r.text).toContain('E-mail nebo heslo nesouhlasí');
    }
    const paty = await zkus(p, 'Zamek@Example.cz', 'spatne');
    expect(paty.text).toContain('Příliš mnoho neúspěšných pokusů');
    // i správné heslo je teď odmítnuté
    const spravne = await zkus(p, 'zamek@example.cz', 'spravne-heslo-1');
    expect(spravne.text).toContain('Příliš mnoho neúspěšných pokusů');
    expect(spravne.url).not.toContain('/ucet');

    // neexistující účet: stejné hlášky ve stejném pořadí
    const q = new Prohlizec(t.base);
    for (let i = 0; i < ZAMEK_PO_CHYBACH - 1; i++)
      expect((await zkus(q, 'nikdo@example.cz', 'spatne')).text).toContain('E-mail nebo heslo nesouhlasí');
    expect((await zkus(q, 'nikdo@example.cz', 'spatne')).text).toContain('Příliš mnoho neúspěšných pokusů');

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['akce', 'uzivatel_id'])
      .where('akce', '=', 'prihlaseni.zamceno')
      .execute();
    expect(audit).toHaveLength(2);
    expect(audit.filter((a) => a.uzivatel_id)).toHaveLength(1);

    // SMS kód zámek neblokuje
    const sms = new Prohlizec(t.base);
    await prihlasTelefonem(sms, '777650001');
    expect((await sms.get('/ucet')).url).toContain('/ucet');
  });

  it('úspěch nuluje čítač; správce vidí zámek a zruší ho', async () => {
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: '+420777650002',
        email: 'odemknout@example.cz',
        heslo_hash: await hashujHeslo('spravne-heslo-2'),
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const p = new Prohlizec(t.base);
    await zkus(p, 'odemknout@example.cz', 'spatne');
    await zkus(p, 'odemknout@example.cz', 'spatne');
    const ok = await zkus(p, 'odemknout@example.cz', 'spravne-heslo-2');
    expect(ok.url).toContain('/ucet');
    const radek = await t.db
      .selectFrom('prihlaseni_zamky')
      .selectAll()
      .where('klic', '=', klicEmail('odemknout@example.cz'))
      .executeTakeFirst();
    expect(radek).toBeUndefined();

    const r = new Prohlizec(t.base);
    for (let i = 0; i < ZAMEK_PO_CHYBACH; i++) await zkus(r, 'odemknout@example.cz', 'spatne');

    const admin = await prihlasSRoli(t, '777650099', ['spravce']);
    const cil = await t.db
      .selectFrom('uzivatele')
      .select('id')
      .where('telefon', '=', '+420777650002')
      .executeTakeFirstOrThrow();
    const detail = await admin.get(`/sprava/uzivatele/${cil.id}`);
    expect(detail.text).toContain('Přihlášení heslem je zamčené');
    const po = await admin.post(`/sprava/uzivatele/${cil.id}`, {
      _csrf: csrfZ(detail.text),
      akce: 'odemknout',
    });
    expect(po.text).toContain('Zámek přihlášení zrušen');
    expect(po.text).not.toContain('Přihlášení heslem je zamčené');
    const znovu = await zkus(new Prohlizec(t.base), 'odemknout@example.cz', 'spravne-heslo-2');
    expect(znovu.url).toContain('/ucet');
    const audit = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', '=', 'sprava.odemceni_prihlaseni')
      .execute();
    expect(audit).toHaveLength(1);
  });

  it('ověření heslem před citlivou změnou má vlastní zámek', async () => {
    await t.db
      .insertInto('uzivatele')
      .values({
        telefon: '+420777650003',
        email: 'overeni@example.cz',
        heslo_hash: await hashujHeslo('spravne-heslo-3'),
        gdpr_souhlas_at: new Date(),
      })
      .execute();
    const p = new Prohlizec(t.base);
    await prihlasTelefonem(p, '777650003');
    let s = await p.get('/ucet/overeni');
    for (let i = 0; i < ZAMEK_PO_CHYBACH; i++) {
      s = await p.post('/ucet/overeni/heslo', { _csrf: csrfZ(s.text), heslo: 'spatne' });
    }
    expect(s.text).toContain('Ověřte se prosím SMS kódem');
    const spravne = await p.post('/ucet/overeni/heslo', { _csrf: csrfZ(s.text), heslo: 'spravne-heslo-3' });
    expect(spravne.text).toContain('Ověřte se prosím SMS kódem');
  });
});
