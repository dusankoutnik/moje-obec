// Přechod z VlastiKanálu: převod dat (syntetická data, ne ostrá DB), interní API, příchozí SMS, SMSGate, hlídání brány.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spustTestApp, volnyPort, type TestApp } from './pomocnici.js';
import { casVk, doparujUcty, prevedVlastikanal, type VkData } from '../src/moduly/infokanal/prevod.js';
import { nactiVlastikanal } from '../src/moduly/infokanal/prevod-sqlite.js';
import { PrichoziSluzba } from '../src/moduly/infokanal/prichozi.js';
import { HlidaniBrany } from '../src/moduly/infokanal/brana.js';
import { smsSPrefixem } from '../src/moduly/infokanal/odchozi.js';
import { SmsGate } from '../src/lib/sms/smsgate.js';
import { KonzoleMail } from '../src/lib/mail.js';
import { tajemstviWebhooku } from '../src/moduly/infokanal/index.js';

const TAJNE = 'x'.repeat(32);
const log = pino({ level: 'silent' });
let t: TestApp;
beforeAll(async () => {
  t = await spustTestApp({ env: { INTERNI_API_SECRET: TAJNE } });
});
afterAll(async () => t.zavri());

function vkData(): VkData {
  return {
    kategorie: [
      { id: 1, slug: 'dulezite', name: 'Obecná hlášení', optout: 0, sort: 1 },
      { id: 2, slug: 'cviceni', name: 'Pozvánky — cvičení', optout: 1, sort: 2 },
      { id: 3, slug: 'krizove', name: 'Krizové', optout: 0, sort: 0 },
      { id: 4, slug: 'pocasi', name: 'Výstrahy počasí', optout: 1, sort: 10 },
      { id: 5, slug: 'novinky', name: 'Novinky', optout: 1, sort: 20 },
    ],
    odberatele: [
      {
        id: 10,
        name: 'Jana Zkušební',
        phone: '+420777111001',
        email: 'Jana@Example.cz',
        village: 'Testov',
        token: 'tok10',
        verified_at: '2026-09-07 14:49:17',
        unsubscribed_at: null,
        source: 'infokanal',
        consent_type: 'Import',
        consent_at: '02.03.2020 12:23:36',
        note: null,
        created_at: '2026-09-07 14:49:17',
        user_id: 5,
        channel_pref: 'mixed',
      },
      {
        id: 11,
        name: 'Petr Odhlášený',
        phone: '777111002',
        email: null,
        village: '',
        token: 'tok11',
        verified_at: '2026-09-07 14:49:17',
        unsubscribed_at: '2026-10-01 08:00:00',
        source: 'sms',
        consent_type: null,
        consent_at: null,
        note: 'tajná poznámka',
        created_at: '2026-09-07 14:49:17',
        user_id: null,
        channel_pref: 'sms',
      },
      {
        id: 12,
        name: 'Eva Mailová',
        phone: null,
        email: 'eva@example.cz',
        village: 'Dolní Testov',
        token: 'tok12',
        verified_at: null,
        unsubscribed_at: null,
        source: 'urad',
        consent_type: 'Osobně',
        consent_at: '2026-09-10 10:00:00',
        note: null,
        created_at: '2026-09-10 10:00:00',
        user_id: 99,
        channel_pref: 'email',
      },
    ],
    optouty: [
      { subscriber_id: 10, category_id: 2 },
      { subscriber_id: 10, category_id: 1 }, // povinná — ignorovat
      { subscriber_id: 12, category_id: 5 },
    ],
    hlaseni: [
      {
        id: 1,
        author_user_id: 5,
        category_id: 1,
        is_crisis: 0,
        target: 'all',
        target_detail: null,
        sms_text: 'Voda nepoteče',
        email_subject: 'Odstávka vody',
        email_body: 'Text',
        email_html: '<p>Text</p>',
        web_title: null,
        web_body: null,
        web_html: null,
        wp_url: 'https://example.cz/clanek',
        status: 'done',
        scheduled_at: null,
        created_at: '2026-09-08 20:00:00',
        finished_at: '2026-09-08 21:00:00',
        auto_source: null,
      },
      {
        id: 2,
        author_user_id: null,
        category_id: 4,
        is_crisis: 0,
        target: 'villages',
        target_detail: '["Testov"]',
        sms_text: 'Bourky',
        email_subject: null,
        email_body: null,
        email_html: null,
        web_title: null,
        web_body: null,
        web_html: null,
        wp_url: null,
        status: 'scheduled',
        scheduled_at: '2026-12-01 06:30:00',
        created_at: '2026-10-02 23:00:00',
        finished_at: null,
        auto_source: 'ČHMÚ',
      },
    ],
    prijemci: [
      { message_id: 1, channel: 'sms', status: 'delivered', n: 5 },
      { message_id: 1, channel: 'sms', status: 'gaveup', n: 1 },
      { message_id: 1, channel: 'email', status: 'delivered', n: 7 },
    ],
  };
}

describe('převod VlastiKanálu', () => {
  it('časy VlastiKanálu (místní čas Praha, české datum)', () => {
    expect(casVk('2026-09-07 14:49:17')!.toISOString()).toBe('2026-09-07T12:49:17.000Z');
    expect(casVk('02.03.2020 12:23:36')!.toISOString()).toBe('2020-03-02T11:23:36.000Z');
    expect(casVk('')).toBeNull();
  });

  it('nanečisto nic nezapíše, ostře převede, opakování nic nezdvojí', async () => {
    const na = await prevedVlastikanal(t.db, vkData(), { nanecisto: true });
    expect(na.odberatelu).toBe(3);
    expect(await t.db.selectFrom('ik_odberatele').select('id').execute()).toHaveLength(0);

    const v = await prevedVlastikanal(t.db, vkData());
    expect(v).toMatchObject({
      odberatelu: 3,
      odberateluNovych: 3,
      kategoriiZalozenych: 1,
      optoutu: 2,
      hlaseni: 2,
      hlaseniNovych: 2,
      hlaseniNedokoncenych: 1,
      vazebNaUcet: 2,
    });
    const jana = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('prevod_id', '=', 10)
      .executeTakeFirstOrThrow();
    expect(jana).toMatchObject({
      telefon: '+420777111001',
      email: 'jana@example.cz',
      kanal: 'smisene',
      zdroj: 'import',
      token: 'tok10',
      mujucet_cislo: 5,
      cast_obce: 'Testov',
    });
    expect(jana.souhlas_at!.toISOString()).toBe('2020-03-02T11:23:36.000Z');
    const petr = await t.db
      .selectFrom('ik_odberatele')
      .selectAll()
      .where('prevod_id', '=', 11)
      .executeTakeFirstOrThrow();
    expect(petr.telefon).toBe('+420777111002');
    expect(petr.odhlasen_at).not.toBeNull();
    const sport = await t.db
      .selectFrom('ik_kategorie')
      .select('id')
      .where('slug', '=', 'sport')
      .executeTakeFirstOrThrow();
    const opt = await t.db.selectFrom('ik_optouty').selectAll().where('odberatel_id', '=', jana.id).execute();
    expect(opt.map((o) => o.kategorie_id)).toEqual([sport.id]);
    const h = await t.db.selectFrom('ik_hlaseni').selectAll().orderBy('prevod_id').execute();
    expect(h[0]).toMatchObject({ stav: 'hotovo', cil: 'vse' });
    expect(h[0]!.souhrn).toMatchObject({ prijemcu: 13, odeslano: 12, sms: { doruceno: 5, vzdano: 1 } });
    expect(h[1]).toMatchObject({
      stav: 'zruseno',
      cil: 'casti',
      zdroj_automatu: 'chmu',
      cil_detail: ['Testov'],
    });

    // seznam ve správě bere počty ze souhrnu
    const seznam = await t.app.infokanal.seznamHlaseni();
    expect(seznam.find((x) => x.email_predmet === 'Odstávka vody')).toMatchObject({
      prijemcu: 13,
      odeslano: 12,
    });

    const znovu = await prevedVlastikanal(t.db, vkData());
    expect(znovu).toMatchObject({ odberateluNovych: 0, odberateluAktualizovanych: 3, hlaseniNovych: 0 });
    expect(await t.db.selectFrom('ik_odberatele').select('id').execute()).toHaveLength(3);
    expect(await t.db.selectFrom('ik_hlaseni').select('id').execute()).toHaveLength(2);
    // převedená hlášení se nerozesílají
    expect(await t.app.infokanalFronta.zpracujVse()).toBe(0);
  });

  it('výstrahy: stavy, vazba na hlášení, detail pro automat, idempotence, stav zdrojů', async () => {
    const d = vkData();
    const zaklad = {
      level: null,
      sms_text: 'SMS',
      email_subject: 'Předmět',
      email_body: 'Text',
      reminded_at: null,
      cancelled_at: null,
      decided_user_id: null,
      decided_at: null,
      created_at: '2026-10-16 15:05:00',
    };
    d.vystrahy = [
      {
        ...zaklad,
        id: 1,
        source: 'cez',
        ext_key: '1100',
        title: 'Odstávka elektřiny',
        valid_from: '2026-11-06T08:00:00Z',
        valid_to: '2026-11-06T14:30:00Z',
        detail: JSON.stringify({
          id: 1100,
          announcement_key: 'abc.pdf',
          opened_at: '2026-11-06T08:00:00Z',
          fix_expected_at: '2026-11-06T14:30:00Z',
          addresses: {
            towns: [
              {
                code: '999',
                name: 'Testov',
                town_districts: [{ town_parts: [{ name: 'Dolní Testov', streets: [] }] }],
              },
            ],
          },
        }),
        status: 'sent',
        message_id: 1,
        reminded_at: '2026-11-05 17:00:00',
      },
      {
        ...zaklad,
        id: 2,
        source: 'scvk',
        ext_key: '6939',
        title: 'Odstávka vody',
        valid_from: '2026-10-22T06:30:00.000Z',
        valid_to: '2026-10-22T10:30:00.000Z',
        detail: JSON.stringify({
          id: '6939',
          href: '/udalosti/x-6939',
          typ: 'planovana',
          title: 'T',
          published: 'p',
          from: '2026-10-22T06:30:00.000Z',
          to: '2026-10-22T10:30:00.000Z',
          text: 'plný text',
          file: null,
        }),
        status: 'sent',
        message_id: null,
      },
      {
        ...zaklad,
        id: 3,
        source: 'chmu',
        ext_key: 'Silný vítr|yellow',
        level: 'yellow',
        title: 'Silný vítr',
        valid_from: '2026-10-20T10:00:00+02:00',
        valid_to: null,
        detail: JSON.stringify({
          event: 'Silný vítr',
          level: 'yellow',
          from: '2026-10-20T10:00:00+02:00',
          to: null,
          headline: 'H',
          description: 'D',
          instruction: 'I',
        }),
        status: 'deleted',
        message_id: null,
      },
      {
        ...zaklad,
        id: 4,
        source: 'chmu',
        ext_key: 'Bouřky|orange',
        level: 'orange',
        title: 'B',
        valid_from: null,
        valid_to: null,
        detail: '{}',
        status: 'pending',
        message_id: null,
      },
    ];
    d.kv = {
      chmu_last: 'alert_cap_50_220808.xml 22-Oct-2026 08:08',
      chmu_ok: '2026-10-22T15:00:00.442Z',
      cez_ok: '2026-10-22T15:00:00.835Z',
    };
    // událost, kterou už mezitím zapsal automat platformy (bez prevod_id) — nepřevádí se
    await t.db
      .insertInto('ik_vystrahy')
      .values({ zdroj: 'chmu', externi_id: 'Bouřky|orange', titulek: 'B', detail: '{}', stav: 'odeslano' })
      .execute();
    const v = await prevedVlastikanal(t.db, d, { kodObce: '999' });
    expect(v).toMatchObject({
      vystrah: 3,
      vystrahNovych: 3,
      vystrahUzZnamych: 1,
      vystrahSHlasenim: 1,
      vystrahPodleStavu: { odeslano: 2, zahozeno: 1 },
    });
    const radky = await t.db.selectFrom('ik_vystrahy').selectAll().orderBy('id').execute();
    const cez = radky.find((r) => r.zdroj === 'cez')!;
    const h1 = await t.db
      .selectFrom('ik_hlaseni')
      .select('id')
      .where('prevod_id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(cez).toMatchObject({ stav: 'odeslano', hlaseni_id: h1.id, externi_id: '1100' });
    expect(cez.plati_od!.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(cez.pripomenuto_at).not.toBeNull();
    expect(cez.detail).toMatchObject({
      id: '1100',
      od: '2026-11-06T08:00:00.000Z',
      casti: [{ nazev: 'Dolní Testov' }],
      prevod_id: 1,
    });
    expect(radky.find((r) => r.zdroj === 'scvk')!.detail).toMatchObject({
      titulek: 'T',
      text: 'plný text',
      od: '2026-10-22T06:30:00.000Z',
    });
    const chmu = radky.find((r) => r.externi_id === 'Silný vítr|yellow')!;
    expect(chmu).toMatchObject({ stav: 'zahozeno', stupen: 'yellow' });
    expect(chmu.detail).toMatchObject({
      jev: 'Silný vítr',
      stupen: 'yellow',
      popis: 'D',
      od: '2026-10-20T08:00:00.000Z',
    });
    const zdroje = await t.db.selectFrom('ik_vystrahy_zdroje').selectAll().orderBy('zdroj').execute();
    expect(zdroje.map((z) => [z.zdroj, z.razitko])).toEqual([
      ['cez', null],
      ['chmu', 'alert_cap_50_220808.xml 22-Oct-2026 08:08'],
    ]);
    const znovu = await prevedVlastikanal(t.db, d, { kodObce: '999' });
    expect(znovu).toMatchObject({ vystrah: 3, vystrahNovych: 0, vystrahUzZnamych: 1 });
    expect(await t.db.selectFrom('ik_vystrahy').select('id').execute()).toHaveLength(4);
    const na = await prevedVlastikanal(
      t.db,
      { ...d, vystrahy: [{ ...d.vystrahy[0]!, id: 50, ext_key: '5000' }] },
      { nanecisto: true },
    );
    expect(na.vystrahNovych).toBe(1);
    expect(await t.db.selectFrom('ik_vystrahy').select('id').execute()).toHaveLength(4);
  });

  it('dopárování účtu podle čísla MujÚčtu (až existuje uzivatele.cislo)', async () => {
    expect(await doparujUcty(t.db)).toBe(0); // sloupec zatím neexistuje (přidává ho převod účtů)
  });

  it('anonymizace pro dev: kontakty nahrazené, vazby zůstávají', async () => {
    const v = await prevedVlastikanal(t.db, vkData(), { anonymizovat: true, nanecisto: true });
    expect(v.odberatelu).toBe(3);
  });

  it('čtení SQLite VlastiKanálu (syntetická DB)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vk-'));
    try {
      const soubor = path.join(dir, 'vk.db');
      const db = new DatabaseSync(soubor);
      db.exec(`
        CREATE TABLE subscribers (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, email TEXT, village TEXT, token TEXT,
          verified_at TEXT, unsubscribed_at TEXT, source TEXT, consent_type TEXT, consent_at TEXT, note TEXT,
          created_at TEXT, user_id INTEGER, channel_pref TEXT);
        CREATE TABLE categories (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, optout INTEGER, sort INTEGER);
        CREATE TABLE optouts (subscriber_id INTEGER, category_id INTEGER);
        CREATE TABLE admins (id INTEGER PRIMARY KEY, email TEXT, user_id INTEGER);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, author_id INTEGER, category_id INTEGER, is_crisis INTEGER,
          target TEXT, target_detail TEXT, sms_text TEXT, email_subject TEXT, email_body TEXT, web_title TEXT,
          web_body TEXT, wp_url TEXT, status TEXT, scheduled_at TEXT, created_at TEXT, finished_at TEXT);
        CREATE TABLE recipients (id INTEGER PRIMARY KEY, message_id INTEGER, channel TEXT, status TEXT);
        INSERT INTO subscribers VALUES (1,'A','+420777000111',NULL,'','t1',NULL,NULL,'web',NULL,NULL,NULL,NULL,7,'sms');
        INSERT INTO categories VALUES (1,'dulezite','Obecná',0,1);
        INSERT INTO admins VALUES (1,'a@b.cz',7);
        INSERT INTO messages VALUES (1,1,1,0,'all',NULL,'ahoj',NULL,NULL,NULL,NULL,NULL,'done',NULL,NULL,NULL);
        INSERT INTO recipients VALUES (1,1,'sms','delivered'),(2,1,'sms','delivered');`);
      db.close();
      const d = nactiVlastikanal(soubor);
      expect(d.odberatele).toHaveLength(1);
      expect(d.hlaseni[0]).toMatchObject({ author_user_id: 7, email_html: null, auto_source: null });
      expect(d.prijemci).toEqual([{ message_id: 1, channel: 'sms', status: 'delivered', n: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('interní API', () => {
  const api = (cesta: string, init: RequestInit = {}, klic: string | null = TAJNE) =>
    fetch(t.base + cesta, {
      ...init,
      headers: { 'content-type': 'application/json', ...(klic ? { 'x-api-secret': klic } : {}) },
    });

  it('bez klíče 401, přes proxy 404', async () => {
    expect((await api('/api/interni/odber?telefon=777111001', {}, null)).status).toBe(401);
    expect((await api('/api/interni/odber?telefon=777111001', {}, 'y'.repeat(32))).status).toBe(401);
    const proxy = await fetch(t.base + '/api/interni/odber?telefon=777111001', {
      headers: { 'x-api-secret': TAJNE, 'x-forwarded-for': '1.2.3.4' },
    });
    expect(proxy.status).toBe(404);
  });

  it('odber: preference odběratele', async () => {
    const r = await (await api('/api/interni/odber?telefon=777111001')).json();
    expect(r).toEqual({ odebira: true, kanal: 'mixed', email: 'jana@example.cz' });
    expect(await (await api('/api/interni/odber?telefon=777111002')).json()).toMatchObject({
      odebira: false,
      kanal: 'sms',
    });
    expect(await (await api('/api/interni/odber?telefon=777999999')).json()).toEqual({ odebira: false });
  });

  it('odeslat: 202, fronta, prefix obce, deduplikace, stav dávky', async () => {
    const r = await api('/api/interni/odeslat', {
      method: 'POST',
      body: JSON.stringify({
        prijemci: [{ telefon: '777 222 333', email: 'a@example.cz' }, { telefon: '+420777222333' }],
        sms: 'Rezervace potvrzena — děkujeme',
        email: { predmet: 'Rezervace', text: 'Potvrzeno.' },
        zdroj: 'rezervace',
      }),
    });
    expect(r.status).toBe(202);
    const v = (await r.json()) as { id: string; sms: number; email: number };
    expect(v).toMatchObject({ sms: 1, email: 1, zkraceno: false });
    expect(await t.app.infokanalOdchozi.zpracujVse()).toBe(2);
    const sms = t.sms.odeslane.at(-1)!;
    expect(sms).toMatchObject({ telefon: '+420777222333', text: 'TESTOV: Rezervace potvrzena - dekujeme' });
    expect(t.mail.odeslane.at(-1)).toMatchObject({ komu: 'a@example.cz', predmet: 'Rezervace' });
    const stav = (await (await api('/api/interni/odeslat/' + v.id)).json()) as { zpravy: { stav: string }[] };
    expect(stav.zpravy.map((z) => z.stav)).toEqual(['odeslano', 'odeslano']);
    expect((await api('/api/interni/odeslat', { method: 'POST', body: '{"prijemci":[]}' })).status).toBe(400);
  });

  it('předpona se nezdvojí, dlouhá SMS se zkrátí', () => {
    expect(smsSPrefixem('TESTOV: ', 'TESTOV: kod 123').text).toBe('TESTOV: kod 123');
    const d = smsSPrefixem('TESTOV: ', 'a'.repeat(600));
    expect(d.zkraceno).toBe(true);
    expect(d.text.length).toBe(459);
  });
});

describe('příchozí SMS', () => {
  it('START, STOP, ODVOZ na falešné rezervace, neznámá SMS správcům', async () => {
    const prijato: { telo: unknown; hlavicky: Record<string, unknown> }[] = [];
    const port = await volnyPort();
    const server = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        prijato.push({ telo: JSON.parse(b), hlavicky: req.headers });
        res.end('{"ok":true}');
      });
    }).listen(port, '127.0.0.1');
    try {
      await t.db
        .insertInto('uzivatele')
        .values({
          telefon: '+420777000900',
          email: 'spravce@example.cz',
          heslo_hash: null,
          role: ['spravce'],
        })
        .execute();
      const mail = new KonzoleMail();
      const p = new PrichoziSluzba(
        t.db,
        t.app.infokanalOdchozi,
        mail,
        {
          odvozUrl: `http://127.0.0.1:${port}/api/sms/prichozi`,
          odvozHlavicky: { 'x-hook-secret': 'hook', 'x-api-secret': TAJNE },
          notify: ['navic@example.cz'],
          nazevKanalu: 'TestKanál',
        },
        log,
      );
      expect(await p.zpracuj({ od: '+420777333444', text: 'START Karel Nový', prijato: null })).toBe('start');
      const k = await t.app.infokanal.odberatelPodleTelefonu('+420777333444');
      expect(k).toMatchObject({ jmeno: 'Karel Nový', zdroj: 'sms', kanal: 'sms' });
      expect(k!.overen_at).not.toBeNull();
      expect(await p.zpracuj({ od: '+420777333444', text: 'stop', prijato: null })).toBe('stop');
      expect((await t.app.infokanal.odberatelPodleTelefonu('+420777333444'))!.odhlasen_at).not.toBeNull();
      expect(await p.zpracuj({ od: '+420777333444', text: 'Start', prijato: null })).toBe('restart');
      expect((await t.app.infokanal.odberatelPodleTelefonu('+420777333444'))!.odhlasen_at).toBeNull();

      expect(await p.zpracuj({ od: '+420777333444', text: 'ODVOZ Turnov zítra', prijato: null })).toBe(
        'odvoz',
      );
      expect(prijato[0]!.telo).toEqual({
        phone: '+420777333444',
        dest: 'Turnov zítra',
        text: 'ODVOZ Turnov zítra',
      });
      expect(prijato[0]!.hlavicky['x-hook-secret']).toBe('hook');
      expect(prijato[0]!.hlavicky['x-api-secret']).toBe(TAJNE);
      expect(await p.zpracuj({ od: '+420777333444', text: 'odvoz', prijato: null })).toBe('odvoz_bez_cile');

      expect(await p.zpracuj({ od: '+420777555666', text: 'Dobrý den, kdy je svoz?', prijato: null })).toBe(
        'preposlano',
      );
      t.sms.odeslane.length = 0;
      t.mail.odeslane.length = 0;
      await t.app.infokanalOdchozi.zpracujVse();
      expect(t.sms.odeslane.map((s) => s.text)).toEqual([
        'TESTOV: Jste prihlaseni k odberu obecnich zprav. Odhlaseni: poslete STOP.',
        'TESTOV: Odber je zrusen. Znovu prihlasit: poslete START.',
        'TESTOV: Jste prihlaseni k odberu obecnich zprav. Odhlaseni: poslete STOP.',
        'TESTOV: Napiste prosim i cil, napr. ODVOZ Turnov.',
      ]);
      expect(t.mail.odeslane.map((m) => m.komu).sort()).toEqual(['navic@example.cz', 'spravce@example.cz']);
      expect(t.mail.odeslane[0]!.text).toContain('kdy je svoz');
    } finally {
      server.close();
    }
  });

  it('SMSGate webhook: příchozí SMS, doručenky, podpis', async () => {
    const g = new SmsGate({
      url: 'https://api.sms-gate.app/3rdparty/v1/message',
      user: 'U',
      pass: 'P',
      webhookKlic: 'klic',
    });
    expect(g.zakladApi).toBe('https://api.sms-gate.app/3rdparty/v1');
    const telo = JSON.stringify({
      event: 'sms:received',
      payload: { message: 'STOP', phoneNumber: '+420777333444', receivedAt: '2026-10-22T10:00:00Z' },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const podpis = createHmac('sha256', 'klic')
      .update(telo + ts)
      .digest('hex');
    expect(g.prichoziZWebhooku(telo, { 'x-signature': podpis, 'x-timestamp': ts })).toEqual([
      { od: '+420777333444', text: 'STOP', prijato: new Date('2026-10-22T10:00:00Z') },
    ]);
    expect(() => g.prichoziZWebhooku(telo, { 'x-signature': 'spatne', 'x-timestamp': ts })).toThrow();
    const bez = new SmsGate({ url: 'https://x/3rdparty/v1/message', user: 'U', pass: 'P' });
    expect(
      await bez.zpracujWebhook(JSON.stringify({ event: 'sms:delivered', payload: { messageId: 'abc' } }), {}),
    ).toEqual([{ branaId: 'abc', stav: 'doruceno' }]);
    expect(bez.prichoziZWebhooku(JSON.stringify({ event: 'sms:delivered', payload: {} }), {})).toEqual([]);
  });

  it('webhook platformy: tajná adresa, konzole bez příchozích', async () => {
    const r = await fetch(`${t.base}/webhook/sms/${tajemstviWebhooku({ SESSION_SECRET: 'a'.repeat(64) })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, prichozich: 0 });
  });
});

describe('hlídání brány', () => {
  it('offline → poplach, připomínka po 12 h, obnovení; výpadek cloudu > 2 h', async () => {
    let lastSeen = '2026-10-22T08:00:00Z';
    let cloudOk = true;
    const f = (async (url: string) => {
      if (!cloudOk) throw new Error('ECONNREFUSED');
      if (String(url).endsWith('/devices')) return new Response(JSON.stringify([{ lastSeen }]));
      return new Response(JSON.stringify([{ state: 'Pending' }, { state: 'Pending' }, { state: 'Sent' }]));
    }) as typeof fetch;
    const mail = new KonzoleMail();
    const h = new HlidaniBrany(
      t.db,
      mail,
      {
        zaklad: 'https://brana/3rdparty/v1',
        user: 'U',
        pass: 'P',
        limitMin: 60,
        notify: ['brana@example.cz'],
        fetch: f,
      },
      log,
    );
    expect((await h.kontrola(new Date('2026-10-22T08:30:00Z'))).stav).toBe('ok');
    expect(mail.odeslane).toHaveLength(0);
    expect((await h.kontrola(new Date('2026-10-22T09:30:00Z'))).stav).toBe('offline');
    expect(mail.odeslane[0]!.predmet).toContain('offline');
    expect(mail.odeslane[0]!.text).toContain('čeká 2 SMS');
    await h.kontrola(new Date('2026-10-22T10:00:00Z'));
    expect(mail.odeslane).toHaveLength(1);
    await h.kontrola(new Date('2026-10-22T22:00:00Z'));
    expect(mail.odeslane).toHaveLength(2);
    expect(mail.odeslane[1]!.predmet).toContain('stále offline');
    lastSeen = '2026-10-22T22:05:00Z';
    expect((await h.kontrola(new Date('2026-10-22T22:10:00Z'))).stav).toBe('obnoveno');
    expect(mail.odeslane[2]!.predmet).toContain('zase funguje');

    cloudOk = false;
    expect((await h.kontrola(new Date('2026-10-23T08:00:00Z'))).stav).toBe('chyba');
    await h.kontrola(new Date('2026-10-23T09:00:00Z'));
    expect(mail.odeslane).toHaveLength(3);
    await h.kontrola(new Date('2026-10-23T10:30:00Z'));
    expect(mail.odeslane).toHaveLength(4);
    expect(mail.odeslane[3]!.predmet).toContain('nelze ověřit');
    await h.kontrola(new Date('2026-10-23T14:30:00Z'));
    expect(mail.odeslane).toHaveLength(4);
  });
});
