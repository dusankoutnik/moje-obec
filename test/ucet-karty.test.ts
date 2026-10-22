// Stránka Můj účet: karty podle modulů, nedostupná aplikace, vypnutý modul, eKlíč, změna telefonu se schválením, odběr.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prohlizec } from './pomocnici.js';
import { csrfZ, prihlasSRoli, spustTestApp, testovaciObec, volnyPort, type TestApp } from './pomocnici.js';

const TAJNE = 'x'.repeat(32);
let t: TestApp;
let falesna: http.Server;
let dostupna = true;
const prijate: { url: string; metoda: string; klic: string | undefined; telo: string }[] = [];

beforeAll(async () => {
  falesna = http.createServer((req, res) => {
    const kusy: Buffer[] = [];
    req.on('data', (k: Buffer) => kusy.push(k));
    req.on('end', () => {
      prijate.push({
        url: req.url!,
        metoda: req.method!,
        klic: req.headers['x-api-secret'] as string | undefined,
        telo: Buffer.concat(kusy).toString(),
      });
      if (!dostupna) {
        res.writeHead(500);
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-secret'] !== TAJNE) {
        res.writeHead(403);
        return res.end('{}');
      }
      if (req.url!.startsWith('/api/sso/summary/'))
        return res.end(
          JSON.stringify({
            reservations: 2,
            unpaidInvoices: 1,
            trips: 3,
            ridesGiven: 4,
            accesses: ['Posilovna: eKlíč'],
            ekeyEmail: 'ttlock@example.invalid',
            ekeyWait: null,
            gymStatus: 'active',
            upcoming: [
              {
                datum: 'po 26. 10.',
                iso: '2026-10-26',
                cas: '18:00–19:00',
                co: 'Sál',
                ucel: 'Jóga',
                ceka: false,
              },
            ],
          }),
        );
      if (req.url!.startsWith('/api/sso/platby/'))
        return res.end(
          JSON.stringify({
            mesic: {
              obdobi: 'říjen 2026',
              polozky: [
                {
                  datum: '1. 10.',
                  cas: 'celý den',
                  co: 'Sál',
                  ucel: '',
                  cena: 0,
                  ceka: false,
                  probehla: true,
                },
              ],
              soucet: 0,
              cekajici: 0,
            },
            vyuctovani: [
              {
                cislo: 'V2026-9',
                obdobi: 'září 2026',
                castka: 300,
                vystaveno: '1. 10. 2026',
                splatnost: '15. 10. 2026',
                zaplaceno: null,
                poSplatnosti: true,
                pdf: 'http://x/rezervace/ucet/faktura/9.pdf',
                potvrzeni: null,
                platba: 'http://x/rezervace/platba/abc',
              },
            ],
            predprodej: [],
          }),
        );
      if (req.url!.startsWith('/api/sso/ekey/'))
        return res.end(
          JSON.stringify({
            ok: true,
            ekey: { status: 'hotovo', noAccount: false, message: 'eKlíč odeslán.' },
          }),
        );
      res.end('{"ok":true}');
    });
  });
  const port = await volnyPort();
  await new Promise<void>((r) => falesna.listen(port, '127.0.0.1', () => r()));
  t = await spustTestApp({
    env: {
      APLIKACE_REZERVACE_URL: `http://127.0.0.1:${port}`,
      INTERNI_API_SECRET: TAJNE,
      APLIKACE_EKNIHY_URL: 'http://127.0.0.1:9',
    },
    obec: { ...testovaciObec, moduly: { ...testovaciObec.moduly, rezervace: true, eknihy: true } },
  });
});

afterAll(async () => {
  await t?.zavri();
  await new Promise<void>((r) => falesna.close(() => r()));
});

describe('Můj účet', () => {
  let p: Prohlizec;

  it('ukáže karty zapnutých modulů s daty z rezervací (x-api-secret = INTERNI_API_SECRET)', async () => {
    p = await prihlasSRoli(t, '+420601000001', []);
    const r = await p.get('/ucet');
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('id="odber"');
    expect(r.text).toContain('id="rezervace"');
    expect(r.text).toContain('Jóga');
    expect(r.text).toContain('Nezaplacené výzvy k úhradě: 1');
    expect(r.text).toContain('Posilovna: eKlíč');
    expect(r.text).toContain('id="spolujizda"');
    expect(r.text).toContain('Letos jste svezli sousedů: 4');
    expect(r.text).toContain('id="eknihy"');
    // nabídka použít e-mail TTLock (účet e-mail nemá)
    expect(r.text).toContain('ttlock@example.invalid');
    const s = prijate.find((x) => x.url.startsWith('/api/sso/summary/'));
    expect(s?.klic).toBe(TAJNE);
  });

  it('platby: vyúčtování s PDF a QR platbou', async () => {
    const r = await p.get('/ucet/platby');
    expect(r.text).toContain('V2026-9');
    expect(r.text).toContain('http://x/rezervace/platba/abc');
    expect(r.text).toContain('po splatnosti');
  });

  it('eKlíč se pošle do rezervací a e-mail z TTLock se použije jen se souhlasem', async () => {
    const r = await p.get('/ucet');
    await p.post('/ucet/eklic', { _csrf: csrfZ(r.text), email: 'TTlock@Example.invalid' });
    const e = prijate.filter((x) => x.url.startsWith('/api/sso/ekey/')).at(-1)!;
    expect(e.metoda).toBe('POST');
    expect(JSON.parse(e.telo)).toEqual({ email: 'ttlock@example.invalid' });
    let u = await t.db
      .selectFrom('uzivatele')
      .select('email')
      .where('telefon', '=', '+420601000001')
      .executeTakeFirstOrThrow();
    expect(u.email).toBeNull();
    const r2 = await p.get('/ucet');
    await p.post('/ucet/eklic-email', { _csrf: csrfZ(r2.text), akce: 'ano' });
    u = await t.db
      .selectFrom('uzivatele')
      .select('email')
      .where('telefon', '=', '+420601000001')
      .executeTakeFirstOrThrow();
    expect(u.email).toBe('ttlock@example.invalid');
  });

  it('odběr: přihlášení jedním klikem a změna kanálu a kategorií', async () => {
    let r = await p.get('/ucet');
    r = await p.post('/ucet/odber', { _csrf: csrfZ(r.text), akce: 'prihlasit', kanal: 'smisene' });
    const o = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('telefon', '=', '+420601000001')
      .executeTakeFirstOrThrow();
    expect(o.overen_at).not.toBeNull();
    expect(o.uzivatel_id).not.toBeNull();
    expect(o.kanal).toBe('smisene');
    const kat = await t.db.selectFrom('ik_kategorie').selectAll().where('povinna', '=', false).execute();
    expect(kat.length).toBeGreaterThan(0);
    r = await p.get('/ucet');
    expect(r.text).toContain('Uložit odběr');
    await p.post('/ucet/odber', { _csrf: csrfZ(r.text), akce: 'ulozit', kanal: 'sms' });
    const o2 = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('id', '=', o.id)
      .executeTakeFirstOrThrow();
    expect(o2.kanal).toBe('sms');
    const opt = await t.db
      .selectFrom('ik_optouty')
      .select('kategorie_id')
      .where('odberatel_id', '=', o.id)
      .execute();
    expect(opt.length).toBe(kat.length); // nic nezaškrtnuto → všechny nepovinné odhlášené
  });

  it('eKnihy: SMS o nových knihách se uloží do navic', async () => {
    const r = await p.get('/ucet');
    await p.post('/ucet/eknihy', { _csrf: csrfZ(r.text), eknihy_sms: 'ano' });
    const u = await t.db
      .selectFrom('uzivatele')
      .select('navic')
      .where('telefon', '=', '+420601000001')
      .executeTakeFirstOrThrow();
    expect(u.navic.eknihy_sms).toBe(true);
  });

  it('změna telefonu: žádost po ověření → schválení úřadem → nové číslo + SMS', async () => {
    // bez čerstvého ověření → na ověření
    let r = await p.get('/ucet/telefon');
    expect(r.url).toContain('/ucet/overeni');
    r = await p.post('/ucet/overeni/sms', { _csrf: csrfZ(r.text), dalsi: '/ucet/telefon' });
    const kod = /kód z SMS je (\d{6})/.exec(r.text)![1]!;
    r = await p.post('/ucet/overeni/kod', { _csrf: csrfZ(r.text), kod, dalsi: '/ucet/telefon' });
    expect(r.url).toContain('/ucet/telefon');
    r = await p.post('/ucet/telefon', {
      _csrf: csrfZ(r.text),
      telefon: '601 000 009',
      duvod: 'nový operátor',
    });
    expect(r.text).toContain('Čeká na schválení');
    const spravce = await prihlasSRoli(t, '+420601000002', ['spravce']);
    let s = await spravce.get('/sprava/ucty/zmeny-telefonu');
    expect(s.text).toContain('601 000 009');
    const id = /zmeny-telefonu\/(\d+)/.exec(s.text)![1]!;
    s = await spravce.post(`/sprava/ucty/zmeny-telefonu/${id}`, { _csrf: csrfZ(s.text), akce: 'schvalit' });
    expect(s.text).toContain('schválená');
    const u = await t.db
      .selectFrom('uzivatele')
      .select('telefon')
      .where('email', '=', 'ttlock@example.invalid')
      .executeTakeFirstOrThrow();
    expect(u.telefon).toBe('+420601000009');
    const o = await t.db
      .selectFrom('ik_odberatele')
      .select('telefon')
      .where('telefon', '=', '+420601000009')
      .executeTakeFirst();
    expect(o).toBeTruthy();
    const sms = await t.db.selectFrom('ik_odchozi').selectAll().execute();
    expect(sms.some((x) => JSON.stringify(x).includes('601000009'))).toBe(true);
  });

  it('běžný občan na správu změn telefonu nesmí', async () => {
    const r = await p.get('/sprava/ucty/zmeny-telefonu');
    expect(r.res.status).toBe(403);
  });

  it('aplikace neodpoví → karty „teď nedostupné“, zbytek funguje', async () => {
    dostupna = false;
    const r = await p.get('/ucet');
    dostupna = true;
    expect(r.res.status).toBe(200);
    expect(r.text).toContain('Tato služba teď neodpovídá');
    expect(r.text).toContain('id="udaje"');
  });

  it('vypnutý modul → karta zmizí', async () => {
    await t.app.moduly.uloz({ rezervace: false, eknihy: false }, { uzivatelId: null });
    const r = await p.get('/ucet');
    await t.app.moduly.uloz({ rezervace: true, eknihy: true }, { uzivatelId: null });
    expect(r.text).not.toContain('id="rezervace"');
    expect(r.text).not.toContain('id="spolujizda"');
    expect(r.text).not.toContain('id="eknihy"');
    expect(r.text).toContain('id="odber"');
  });

  it('GDPR: stažení vlastních údajů bez hesla a tokenu', async () => {
    const r = await p.get('/ucet/moje-udaje.json');
    const d = JSON.parse(r.text) as Record<string, Record<string, unknown>>;
    expect(d.ucet!.telefon).toBe('+420601000009');
    expect(d.ucet!.heslo_hash).toBeUndefined();
    expect(d.odber_hlaseni!.token).toBeUndefined();
  });
});
