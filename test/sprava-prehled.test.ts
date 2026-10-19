// Dashboard správy: rozpočet SMS s kódy a stav fronty infokanálu (jen agregáty, jen správcům).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { prehledSms } from '../src/lib/provoz.js';
import { prihlasSRoli, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());

async function pripravFrontu() {
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const { o } = await t.app.infokanal.zalozNeboObnov({
      jmeno: `Odběratel ${i}`,
      telefon: `+42077766000${i}`,
      email: null,
      castObce: '',
      kanal: 'sms',
      optouty: [],
      zdroj: 'urad',
      overeno: true,
      souhlas: true,
    });
    ids.push(o.id);
  }
  const kat = await t.db
    .selectFrom('ik_kategorie')
    .select('id')
    .where('slug', '=', 'hlaseni')
    .executeTakeFirstOrThrow();
  const v = await t.app.infokanal.zalozHlaseni(null, {
    kategorieId: kat.id,
    krizove: false,
    cil: 'vse',
    cilDetail: [],
    smsText: 'Přehled fronty',
    emailPredmet: null,
    emailText: null,
  });
  if ('chyba' in v) throw new Error(v.chyba);
  const radky = await t.db
    .selectFrom('ik_prijemci')
    .select('id')
    .where('hlaseni_id', '=', v.id)
    .orderBy('id')
    .execute();
  expect(radky).toHaveLength(4);
  // 1 čeká, 1 se odesílá, 1 odeslán, 1 vzdán
  await sql`UPDATE ik_prijemci SET stav = 'odesila_se', zabrano_at = now() WHERE id = ${radky[1]!.id}`.execute(
    t.db,
  );
  await sql`UPDATE ik_prijemci SET stav = 'odeslano', odeslano_at = now() WHERE id = ${radky[2]!.id}`.execute(
    t.db,
  );
  await sql`UPDATE ik_prijemci SET stav = 'vzdano', zabrano_at = now() WHERE id = ${radky[3]!.id}`.execute(
    t.db,
  );
}

describe('přehled SMS na dashboardu správy', () => {
  it('počítá kódy za 24 h, příznak vyčerpání a stav fronty', async () => {
    await t.db
      .insertInto('otp_kody')
      .values([
        { kontakt: '+420777660101', ucel: 'prihlaseni', kod_hash: 'x', expires_at: new Date() },
        { kontakt: '+420777660102', ucel: 'odber', kod_hash: 'x', expires_at: new Date() },
        // e-mailový kód se do rozpočtu SMS nepočítá
        { kontakt: 'nekdo@example.cz', ucel: 'email', kod_hash: 'x', expires_at: new Date() },
        // starší než 24 h
        {
          kontakt: '+420777660103',
          ucel: 'prihlaseni',
          kod_hash: 'x',
          expires_at: new Date(),
          vytvoren_at: new Date(Date.now() - 25 * 3600_000),
        },
      ])
      .execute();
    await pripravFrontu();
    let p = await prehledSms(t.db, 300, true);
    expect(p).toEqual({
      kodu24h: 2,
      limit: 300,
      vycerpano: null,
      fronta: { ceka: 1, odesilaSe: 1, odeslano24h: 1, vzdano24h: 1 },
    });

    await t.db
      .insertInto('nastaveni')
      .values({
        klic: 'sms_rozpocet_vycerpan',
        hodnota: JSON.stringify({ at: new Date().toISOString(), pocet: 300, limit: 300 }) as never,
      })
      .execute();
    p = await prehledSms(t.db, 300, false);
    expect(p.vycerpano?.pocet).toBe(300);
    expect(p.fronta).toBeNull();
  });

  it('správce vidí dlaždici, redaktor ne', async () => {
    const spravce = await prihlasSRoli(t, '777660201', ['spravce']);
    const s = await spravce.get('/sprava');
    expect(s.text).toContain('id="sms-prehled"');
    expect(s.text).toMatch(/SMS s kódy za 24 hodin: \d+ z \d+/);
    expect(s.text).toContain('Denní limit SMS s kódy byl vyčerpán');
    expect(s.text).toMatch(/čeká <strong>1<\/strong>/);
    // žádné kontakty, jen počty
    expect(s.text).not.toContain('777 660 00');
    expect(s.text).not.toContain('+42077766000');

    const redaktor = await prihlasSRoli(t, '777660202', ['redaktor']);
    const r = await redaktor.get('/sprava');
    expect(r.res.status).toBe(200);
    expect(r.text).not.toContain('id="sms-prehled"');
  });
});
