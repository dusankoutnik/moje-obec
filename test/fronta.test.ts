// Rozesílací fronta infokanálu (nálezy code review 19. 10. 2026): atomické zabrání řádku, odeslaná zpráva se
// neposílá znovu ani při výpadku DB, odhlášení před odesláním, odklad po dočasné chybě, zaseknuté řádky,
// délka SMS a čas naplánování v pražském čase.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { sql } from 'kysely';
import { spustTestApp, type TestApp } from './pomocnici.js';
import { RozesilaciFronta, type FrontaKonfigurace } from '../src/moduly/infokanal/fronta.js';
import { KonzoleSms } from '../src/lib/sms/konzole.js';
import { KonzoleMail } from '../src/lib/mail.js';
import { SmsChyba, type SmsPoskytovatel } from '../src/lib/sms/typy.js';
import { naplanovanoZFormulare } from '../src/moduly/infokanal/sprava.js';
import { MAX_SMS_ZNAKU } from '../src/moduly/infokanal/sluzba.js';
import type { Logger } from '../src/lib/logger.js';

let t: TestApp;
const log = pino({ level: 'silent' }) as unknown as Logger;
const CFG: FrontaKonfigurace = {
  smsIntervalMinMs: 0,
  smsIntervalMaxMs: 0,
  emailIntervalMs: 0,
  baseUrl: 'http://test',
  smsPrefix: 'TESTOV: ',
  nazevKanalu: 'TestKanál',
  nazevObce: 'Testov',
};

beforeAll(async () => {
  t = await spustTestApp();
});
afterAll(async () => t.zavri());
beforeEach(async () => {
  // každý test má vlastní odběratele a frontu (testovací DB)
  await sql`DELETE FROM ik_prijemci; DELETE FROM ik_odberatele;`.execute(t.db);
});

function fronta(sms: SmsPoskytovatel, mail = new KonzoleMail()) {
  const f = new RozesilaciFronta(t.db, sms, mail, CFG, log);
  f.vypniPlanovac();
  return f;
}

async function odberatele(predpona: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { o } = await t.app.infokanal.zalozNeboObnov({
      jmeno: `Odběratel ${predpona}${i}`,
      telefon: `+420${predpona}${String(i).padStart(3, '0')}`,
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
  return ids;
}

async function hlaseni(text: string, krizove = false) {
  const kat = await t.db
    .selectFrom('ik_kategorie')
    .select('id')
    .where('slug', '=', krizove ? 'krizove' : 'hlaseni')
    .executeTakeFirstOrThrow();
  const v = await t.app.infokanal.zalozHlaseni(null, {
    kategorieId: kat.id,
    krizove,
    cil: 'vse',
    cilDetail: [],
    smsText: text,
    emailPredmet: null,
    emailText: null,
  });
  if ('chyba' in v) throw new Error(v.chyba);
  return v.id;
}

async function stavy(hlaseniId: string) {
  return t.db
    .selectFrom('ik_prijemci')
    .select(['kontakt', 'stav', 'posledni_chyba', 'dalsi_pokus_at', 'pokusy'])
    .where('hlaseni_id', '=', hlaseniId)
    .orderBy('id')
    .execute();
}

async function dokud(f: RozesilaciFronta) {
  while (await f.krok('sms'));
}

describe('fronta: souběh a výpadky', () => {
  it('dva workery najednou pošlou každou SMS právě jednou', async () => {
    await odberatele('601100', 12);
    const id = await hlaseni('Dva workery');
    // pomalá brána, aby se workery opravdu překrývaly
    class Pomala extends KonzoleSms {
      override async posli(telefon: string, text: string) {
        await new Promise((r) => setTimeout(r, 5));
        return super.posli(telefon, text);
      }
    }
    const a = new Pomala();
    const b = new Pomala();
    await Promise.all([dokud(fronta(a)), dokud(fronta(b)), dokud(fronta(a))]);
    const radky = await stavy(id);
    const odeslane = [...a.odeslane, ...b.odeslane].filter((s) => s.text.includes('Dva workery'));
    expect(odeslane).toHaveLength(radky.length);
    expect(new Set(odeslane.map((s) => s.telefon)).size).toBe(radky.length);
    expect(radky.every((r) => r.stav === 'odeslano' && r.pokusy === 1)).toBe(true);
  });

  it('zpráva odešla, ale zápis do DB selhal → neposílá se znovu a stav se dopíše', async () => {
    await odberatele('601200', 3);
    const id = await hlaseni('Vypadek DB');
    class Padajici extends RozesilaciFronta {
      pady = 1;
      protected override async zapisOdeslano(i: number, b: string | null) {
        if (this.pady-- > 0) throw new Error('spojení s DB spadlo');
        return super.zapisOdeslano(i, b);
      }
    }
    const sms = new KonzoleSms();
    const f = new Padajici(t.db, sms, new KonzoleMail(), CFG, log);
    f.vypniPlanovac();
    await dokud(f);
    await f.krok('sms'); // dopíše nezapsaný stav
    const radky = await stavy(id);
    expect(sms.odeslane.filter((s) => s.text.includes('Vypadek DB'))).toHaveLength(3);
    expect(radky.map((r) => r.stav)).toEqual(['odeslano', 'odeslano', 'odeslano']);
  });

  it('zaseknutý řádek (proces spadl během odesílání) se uzavře jako odeslaný, ne znovu poslaný', async () => {
    await odberatele('601300', 1);
    const id = await hlaseni('Zaseknuto');
    await sql`UPDATE ik_prijemci SET stav = 'odesila_se', zabrano_at = now() - interval '10 minutes'
              WHERE hlaseni_id = ${id}`.execute(t.db);
    const sms = new KonzoleSms();
    const f = fronta(sms);
    expect(await f.uklidZaseknute()).toBe(1);
    await dokud(f);
    expect(sms.odeslane).toHaveLength(0);
    const [r] = await stavy(id);
    expect(r!.stav).toBe('odeslano');
    expect(r!.posledni_chyba).toContain('přerušeno');
  });

  it('kdo se odhlásí mezi naplánováním a odesláním, už nic nedostane — krizové ano', async () => {
    const [x, y] = await odberatele('601400', 2);
    const bezne = await hlaseni('Bezne po odhlaseni');
    const krizove = await hlaseni('Krizove po odhlaseni', true);
    await t.app.infokanal.odhlas(x!, 'test');
    const sms = new KonzoleSms();
    await dokud(fronta(sms));
    const telX = (await t.app.infokanal.odberatelPodleId(x!))!.telefon;
    const telY = (await t.app.infokanal.odberatelPodleId(y!))!.telefon;
    const bezneOdeslano = sms.odeslane.filter((s) => s.text.includes('Bezne')).map((s) => s.telefon);
    expect(bezneOdeslano).toEqual([telY]);
    expect((await stavy(bezne)).find((r) => r.kontakt === telX)!.stav).toBe('vzdano');
    const krizoveOdeslano = sms.odeslane.filter((s) => s.text.includes('Krizove')).map((s) => s.telefon);
    expect(krizoveOdeslano.sort()).toEqual([telX, telY].sort());
    expect((await stavy(krizove)).every((r) => r.stav === 'odeslano')).toBe(true);
  });

  it('dočasná chyba brány: řádek čeká s odkladem (Retry-After), ostatní jdou dál; trvalá = vzdáno', async () => {
    await odberatele('601500', 3);
    const id = await hlaseni('Docasna chyba');
    const ok = new KonzoleSms();
    const brana: SmsPoskytovatel = {
      nazev: 'test',
      async posli(telefon, text) {
        if (telefon.endsWith('500000')) throw new SmsChyba('brána přetížena', true, 120_000);
        if (telefon.endsWith('500001')) throw new SmsChyba('neplatné číslo', false);
        return ok.posli(telefon, text);
      },
      async stavDoruceni() {
        return 'nezjisteno';
      },
    };
    await dokud(fronta(brana));
    const r = await stavy(id);
    const prvni = r.find((x) => x.kontakt.endsWith('500000'))!;
    expect(prvni.stav).toBe('ceka');
    expect(new Date(prvni.dalsi_pokus_at!).getTime()).toBeGreaterThan(Date.now() + 100_000);
    expect(r.find((x) => x.kontakt.endsWith('500001'))!.stav).toBe('vzdano');
    expect(r.find((x) => x.kontakt.endsWith('500002'))!.stav).toBe('odeslano');
  });
});

describe('doručenky', () => {
  it('hromadné doručenky brány (inbox) se zapíšou, polling jde po dávkách', async () => {
    await odberatele('601600', 5);
    const id = await hlaseni('Dorucenky');
    const sms = new KonzoleSms();
    await dokud(fronta(sms));
    const ids = sms.odeslane.filter((s) => s.text.includes('Dorucenky')).map((s) => s.id);
    let dotazu = 0;
    const brana: SmsPoskytovatel = {
      nazev: 'inbox',
      posli: sms.posli.bind(sms),
      async stavDoruceni() {
        dotazu++;
        return 'nezjisteno';
      },
      async stahniDorucenky() {
        return [
          { branaId: ids[0]!, stav: 'doruceno' as const },
          { branaId: ids[1]!, stav: 'selhalo' as const },
        ];
      },
    };
    const zmen = await fronta(brana).aktualizujDorucenky(2);
    expect(zmen).toBe(2);
    // zbylé 3 odeslané se dotazovaly po dávkách po 2 (a nic dalšího v okně 48 h nezůstalo neprošlé)
    expect(dotazu).toBeGreaterThanOrEqual(3);
    const r = await stavy(id);
    expect(r.filter((x) => x.stav === 'doruceno')).toHaveLength(1);
    expect(r.filter((x) => x.stav === 'selhalo')).toHaveLength(1);
  });
});

describe('zakládání hlášení', () => {
  it('příliš dlouhá SMS se odmítne na serveru (ne tiché oříznutí v bráně)', async () => {
    await odberatele('601700', 1);
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
      smsText: 'á'.repeat(MAX_SMS_ZNAKU),
      emailPredmet: null,
      emailText: null,
    });
    expect(v).toMatchObject({ chyba: 'sms_dlouha', max: MAX_SMS_ZNAKU });
  });

  it('čas naplánování z formuláře je pražský čas (léto i zima), neplatný se pozná', () => {
    expect(naplanovanoZFormulare('2026-07-01T08:30')!.toString()).toBe(
      new Date('2026-07-01T06:30:00Z').toString(),
    );
    expect(naplanovanoZFormulare('2026-12-01T08:30')!.toString()).toBe(
      new Date('2026-12-01T07:30:00Z').toString(),
    );
    expect(naplanovanoZFormulare('')).toBeNull();
    expect(naplanovanoZFormulare('zítra')).toBe('neplatne');
    expect(naplanovanoZFormulare('2026-07-01T25:00')).toBe('neplatne');
  });
});
