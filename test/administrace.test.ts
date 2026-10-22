// Správa → dlaždice aplikací, Schvalování a Statistiky (náhrada centrální Administrace MujÚčtu).
// Rezervace a eKnihy jsou falešné HTTP servery; ověřuje se klíč, tvar volání a degradace při výpadku.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  csrfZ,
  prihlasSRoli,
  spustTestApp,
  testovaciObec,
  volnyPort,
  type Prohlizec,
  type TestApp,
} from './pomocnici.js';

const KLIC = 'k'.repeat(32);
let t: TestApp;
let rez: http.Server;
let ekn: http.Server;
let rezVypadek = false;
const posty: { url: string; telo: Record<string, unknown>; klic: string | undefined }[] = [];
let admin: Prohlizec;

const SOUHRN = {
  users: 291,
  pending: 3,
  gymRequested: 1,
  unpaid: { c: 4, s: 1850 },
  future: 42,
  trips: 2,
  tickets: { paid: 17, held: 5, onsite: 1 },
};

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

beforeAll(async () => {
  rez = http.createServer((req, res) => {
    const kusy: Buffer[] = [];
    req.on('data', (k: Buffer) => kusy.push(k));
    req.on('end', () => {
      if (req.headers['x-api-secret'] !== KLIC) return json(res, 403, { error: 'forbidden' });
      if (rezVypadek) return json(res, 500, {});
      const u = req.url!;
      if (u === '/api/admin/summary') return json(res, 200, SOUHRN);
      if (u === '/api/admin/approvals')
        return json(res, 200, {
          reservations: [
            { id: 11, series: false, heading: 'Sál — 1. 11. 2026', detail: 'Žadatel A · účel: oslava' },
            { id: 12, series: true, heading: 'Posilovna — 3. 11. 2026, 18:00–19:00', detail: 'Žadatel B' },
          ],
          gym: [{ id: 77, heading: 'Žadatel C', detail: 'způsob otevírání: 📱 eKlíč' }],
        });
      if (req.method === 'POST' && u.startsWith('/api/admin/approvals/')) {
        const telo = JSON.parse(Buffer.concat(kusy).toString() || '{}') as Record<string, unknown>;
        posty.push({ url: u, telo, klic: req.headers['x-api-secret'] as string });
        if (u.endsWith('/reservation/99'))
          return json(res, 409, { ok: false, error: 'Žádost už není čekající.' });
        return json(res, 200, { ok: true });
      }
      json(res, 404, {});
    });
  });
  ekn = http.createServer((req, res) => {
    if (req.headers['x-api-secret'] !== KLIC) return json(res, 403, {});
    if (req.url === '/api/statistiky')
      return json(res, 200, {
        knih: 4468,
        knih_cs: 792,
        stazeni_celkem: 900,
        stazeni_30d: 55,
        stahujicich_30d: 20,
        top_30d: [{ id: 1673, title: 'Osudy dobrého vojáka Švejka', author: 'Hašek', n: 9 }],
      });
    json(res, 404, {});
  });
  const p1 = await volnyPort();
  await new Promise<void>((r) => rez.listen(p1, '127.0.0.1', () => r()));
  const p2 = await volnyPort();
  await new Promise<void>((r) => ekn.listen(p2, '127.0.0.1', () => r()));
  t = await spustTestApp({
    env: {
      APLIKACE_REZERVACE_URL: `http://127.0.0.1:${p1}`,
      APLIKACE_EKNIHY_URL: `http://127.0.0.1:${p2}`,
      INTERNI_API_SECRET: KLIC,
    },
    obec: { ...testovaciObec, moduly: { ...testovaciObec.moduly, rezervace: true, eknihy: true } },
  });
  admin = await prihlasSRoli(t, '777200001', ['admin']);
  await t.db
    .updateTable('uzivatele')
    .set({ email: 'admin@example.cz', jmeno: 'Ada', prijmeni: 'Správcová', rezident_posouzen_at: new Date() })
    .where('telefon', '=', '+420777200001')
    .execute();
});

afterAll(async () => {
  await t.zavri();
  await new Promise((r) => rez.close(r));
  await new Promise((r) => ekn.close(r));
});

describe('dashboard Správy', () => {
  it('správce vidí dlaždice s živými počty z rezervací', async () => {
    const { text } = await admin.get('/sprava');
    expect(text).toContain('/sprava/schvalovani');
    expect(text).toContain('3 rezervací');
    expect(text).toContain('42 nadcházejících');
    expect(text).toContain('4 nezaplaceno (1');
    expect(text).toContain('17 prodáno · 5 čeká na platbu');
    expect(text).toContain('/rezervace/admin/spolujizda');
  });

  it('účetní vidí jen finanční dlaždice', async () => {
    const u = await prihlasSRoli(t, '777200002', ['ucetni']);
    const { res, text } = await u.get('/sprava');
    expect(res.status).toBe(200);
    expect(text).toContain('/rezervace/admin/vyuctovani');
    expect(text).toContain('/rezervace/admin/predprodej');
    expect(text).not.toContain('/sprava/schvalovani');
    expect(text).not.toContain('/rezervace/admin/rezervace');
    const s = await u.get('/sprava/schvalovani');
    expect(s.res.status).toBe(403);
  });

  it('redaktor dlaždice rezervací nevidí', async () => {
    const u = await prihlasSRoli(t, '777200003', ['redaktor']);
    const { text } = await u.get('/sprava');
    expect(text).not.toContain('/rezervace/admin/');
  });

  it('nedostupné rezervace = dlaždice bez čísel', async () => {
    rezVypadek = true;
    try {
      const { res, text } = await admin.get('/sprava');
      expect(res.status).toBe(200);
      expect(text).toContain('/rezervace/admin/vyuctovani');
      expect(text).not.toContain('nadcházejících');
      expect(text).toContain('Rezervace teď neodpovídají');
    } finally {
      rezVypadek = false;
    }
  });
});

describe('Schvalování', () => {
  it('ukáže žádosti a potvrzení pošle do rezervací s číslem účtu', async () => {
    const { text } = await admin.get('/sprava/schvalovani');
    expect(text).toContain('Sál — 1. 11. 2026');
    expect(text).toContain('opakovaná');
    expect(text).toContain('Žadatel C');
    const ja = await t.db
      .selectFrom('uzivatele')
      .select('cislo')
      .where('telefon', '=', '+420777200001')
      .executeTakeFirstOrThrow();
    const r = await admin.post('/sprava/schvalovani/rezervace/12', {
      _csrf: csrfZ(text),
      akce: 'potvrdit',
      pozn: 'Klíče u starostky',
      cela_serie: '1',
    });
    expect(r.text).toContain('Rezervace potvrzena');
    const p = posty.at(-1)!;
    expect(p.url).toBe('/api/admin/approvals/reservation/12');
    expect(p.klic).toBe(KLIC);
    expect(p.telo).toEqual({
      action: 'potvrdit',
      pozn: 'Klíče u starostky',
      celaSerie: true,
      actorId: ja.cislo,
    });
  });

  it('chyba z rezervací se ukáže správci', async () => {
    const { text } = await admin.get('/sprava/schvalovani');
    const r = await admin.post('/sprava/schvalovani/rezervace/99', { _csrf: csrfZ(text), akce: 'zamitnout' });
    expect(r.text).toContain('Žádost už není čekající.');
  });

  it('aktivace posilovny (admin)', async () => {
    const { text } = await admin.get('/sprava/schvalovani');
    const r = await admin.post('/sprava/schvalovani/posilovna/77', { _csrf: csrfZ(text) });
    expect(r.text).toContain('Posilovna aktivována');
    expect(posty.at(-1)!.url).toBe('/api/admin/approvals/gym/77');
  });

  it('posouzení rezidenta a doplnění jména u účtu bez jména', async () => {
    const [novy, bez] = await t.db
      .insertInto('uzivatele')
      .values([
        { telefon: '+420777200010', jmeno: 'Nová', prijmeni: 'Sousedka', email: null, heslo_hash: null },
        { telefon: '+420777200011', email: null, heslo_hash: null },
      ])
      .returningAll()
      .execute();
    let { text } = await admin.get('/sprava/schvalovani');
    expect(text).toContain('Nová Sousedka');
    expect(text).toContain('777 200 011');
    await admin.post(`/sprava/schvalovani/rezident/${novy!.id}`, { _csrf: csrfZ(text), rezident: '1' });
    const u1 = await t.app.ucty.podleId(novy!.id);
    expect(u1!.rezident).toBe(true);
    expect(u1!.rezident_posouzen_at).not.toBeNull();
    ({ text } = await admin.get('/sprava/schvalovani'));
    expect(text).not.toContain('Nová Sousedka');
    const a = await t.db
      .selectFrom('audit_log')
      .select('akce')
      .where('akce', '=', 'sprava.rezident')
      .execute();
    expect(a.length).toBeGreaterThan(0);

    const r = await admin.post(`/sprava/schvalovani/jmeno/${bez!.id}`, {
      _csrf: csrfZ(text),
      jmeno: 'Karel',
      prijmeni: 'Opožděný',
    });
    expect(r.text).not.toContain('Vyplňte jméno');
    const u2 = await t.app.ucty.podleId(bez!.id);
    expect([u2!.jmeno, u2!.prijmeni, u2!.prezdivka]).toEqual(['Karel', 'Opožděný', 'Karel']);
  });

  it('avízo správcům o novém účtu jde jednou a po posouzení přijde „Vyřízeno“', async () => {
    const s = t.app.administrace.sluzba;
    // účet Karel Opožděný z předchozího testu je bez posouzení → avízo
    const n1 = await s.avizoNovychUctu();
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(await s.avizoNovychUctu()).toBe(0);
    const zpravy = await t.db.selectFrom('ik_odchozi').selectAll().where('zdroj', '=', 'sprava').execute();
    expect(
      zpravy.some((z) => z.kontakt === 'admin@example.cz' && z.email_predmet!.includes('Karel Opožděný')),
    ).toBe(true);
    const karel = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('telefon', '=', '+420777200011')
      .executeTakeFirstOrThrow();
    const ja = await t.db
      .selectFrom('uzivatele')
      .selectAll()
      .where('telefon', '=', '+420777200001')
      .executeTakeFirstOrThrow();
    await s.posoudit(karel, false, ja);
    const po = await t.db.selectFrom('ik_odchozi').selectAll().where('zdroj', '=', 'sprava').execute();
    expect(po.some((z) => z.email_predmet!.startsWith('✓ Vyřízeno: Karel Opožděný — rezident NE'))).toBe(
      true,
    );
  });
});

describe('Statistiky', () => {
  it('agregáty účtů, rezervací a eKnih', async () => {
    const { res, text } = await admin.get('/sprava/statistiky');
    expect(res.status).toBe(200);
    expect(text).toContain('Účty občanů');
    expect(text).toContain('<strong>42</strong> nadcházejících rezervací');
    expect(text).toContain('<strong>4468</strong> knih v katalogu');
    expect(text).toContain('Osudy dobrého vojáka Švejka');
  });

  it('jen pro správce', async () => {
    const u = await prihlasSRoli(t, '777200004', ['web']);
    const { res } = await u.get('/sprava/statistiky');
    expect(res.status).toBe(403);
  });
});
