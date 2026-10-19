// Úřední deska — nálezy code review 19. 10. 2026: zpětné datování, vratné nahrazení rozpočtové dokumentace,
// předčasné sejmutí jen u visícího dokumentu a uložení formuláře, které nevrátí sejmutý dokument na desku.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { datumPraha, pridejDny } from '../src/lib/datum.js';
import { DeskaSluzba } from '../src/moduly/deska/sluzba.js';
import { csrfZ, postSoubory, prihlasSRoli, Prohlizec, spustTestApp, type TestApp } from './pomocnici.js';

let t: TestApp;
let redaktor: Prohlizec;
let spravce: Prohlizec;
beforeAll(async () => {
  t = await spustTestApp();
  redaktor = await prihlasSRoli(t, '777410001', ['deska']);
  spravce = await prihlasSRoli(t, '777410002', ['spravce']);
});
afterAll(async () => t.zavri());
beforeEach(() => {
  for (const l of Object.values(t.app.limity)) l.reset();
});

const dnes = () => datumPraha(new Date());
async function katId(slug: string) {
  return String(
    (await t.db.selectFrom('ud_kategorie').select('id').where('slug', '=', slug).executeTakeFirstOrThrow())
      .id,
  );
}
async function vyvesit(p: Prohlizec, pole: Record<string, string>) {
  const form = await p.get('/sprava/deska/novy');
  return postSoubory(p, '/sprava/deska/novy', { _csrf: csrfZ(form.text), ...pole }, []);
}
async function upravit(p: Prohlizec, id: string, pole: Record<string, string>) {
  const form = await p.get(`/sprava/deska/${id}`);
  return postSoubory(p, `/sprava/deska/${id}`, { _csrf: csrfZ(form.text), ...pole }, []);
}
const dokument = (nazev: string) =>
  t.db.selectFrom('ud_dokumenty').selectAll().where('nazev', '=', nazev).executeTakeFirstOrThrow();

describe('datum vyvěšení', () => {
  it('redaktor nevyvěsí se zpětným datem (lhůta by byla jen naoko)', async () => {
    const r = await vyvesit(redaktor, {
      nazev: 'Vyhláška zpětně',
      kategorie_id: await katId('vyhlasky'),
      od: pridejDny(dnes(), -30),
      do: pridejDny(dnes(), 1),
    });
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('nemůže být v minulosti');
    expect(
      await t.db.selectFrom('ud_dokumenty').select('id').where('nazev', '=', 'Vyhláška zpětně').execute(),
    ).toHaveLength(0);
  });

  it('správce smí zpětně jen s důvodem (auditováno)', async () => {
    const pole = {
      nazev: 'Vyhláška z papírové desky',
      kategorie_id: await katId('vyhlasky'),
      od: pridejDny(dnes(), -3),
      do: pridejDny(dnes(), 20),
    };
    const bez = await vyvesit(spravce, pole);
    expect(bez.res.status).toBe(400);
    expect(bez.text).toContain('Napište důvod');
    await vyvesit(spravce, { ...pole, duvod_data: 'visela na papírové desce od pondělí' });
    const d = await dokument('Vyhláška z papírové desky');
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('akce', '=', 'deska.zpetne_datum')
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ id: d.id, duvod: 'visela na papírové desce od pondělí' });
  });

  it('u vyvěšeného dokumentu mění „od“ jen správce s důvodem; ostatní úpravy redaktor smí', async () => {
    await vyvesit(redaktor, { nazev: 'Oznámení A', kategorie_id: await katId('ostatni'), od: dnes() });
    const d = await dokument('Oznámení A');
    const zitra = pridejDny(dnes(), 1);
    const r = await upravit(redaktor, d.id, {
      nazev: 'Oznámení A',
      kategorie_id: await katId('ostatni'),
      od: zitra,
    });
    expect(r.res.status).toBe(400);
    expect(r.text).toContain('smí změnit jen správce');
    const ok = await upravit(redaktor, d.id, {
      nazev: 'Oznámení A',
      kategorie_id: await katId('ostatni'),
      od: dnes(),
      popis: 'doplněný popis',
    });
    expect(ok.res.status).toBe(200);
    expect((await dokument('Oznámení A')).popis).toBe('doplněný popis');
  });
});

describe('sejmutí', () => {
  it('předčasně sejmout jde jen visící dokument; uložení formuláře ho na desku nevrátí', async () => {
    await vyvesit(redaktor, {
      nazev: 'Budoucí B',
      kategorie_id: await katId('ostatni'),
      od: pridejDny(dnes(), 5),
    });
    const b = await dokument('Budoucí B');
    expect(
      await t.app.deska.sejmiHned(
        b.id,
        'omyl',
        (await t.db.selectFrom('uzivatele').select('id').executeTakeFirstOrThrow()).id,
      ),
    ).toBe(false);
    expect((await dokument('Budoucí B')).sejmuto_do).not.toBeNull(); // výchozí lhůta zůstala, nic se nepřepsalo
    expect((await dokument('Budoucí B')).sejmuti_duvod).toBe('');

    await vyvesit(redaktor, { nazev: 'Visící C', kategorie_id: await katId('ostatni'), od: dnes() });
    const c = await dokument('Visící C');
    const f = await spravce.get(`/sprava/deska/${c.id}`);
    await spravce.post(`/sprava/deska/${c.id}/sejmout`, { _csrf: csrfZ(f.text), duvod: 'vyvěšeno omylem' });
    const sejmuty = await dokument('Visící C');
    expect(sejmuty.sejmuto_do!.getTime()).toBeLessThanOrEqual(Date.now());
    // uložení formuláře beze změny data (pole „do“ = dnešek) dokument nevrací na desku do půlnoci
    await upravit(spravce, c.id, {
      nazev: 'Visící C',
      kategorie_id: await katId('ostatni'),
      od: dnes(),
      do: dnes(),
      popis: 'oprava překlepu',
    });
    const po = await dokument('Visící C');
    expect(po.sejmuto_do!.getTime()).toBe(sejmuty.sejmuto_do!.getTime());
    expect((await new Prohlizec(t.base).get('/uredni-deska')).text).not.toContain('Visící C');
  });
});

describe('nahrazení rozpočtové dokumentace', () => {
  it('překlep v roce sejme starší rozpočty, ale oprava i koš je vrátí; koš nic nenahrazuje', async () => {
    const kat = await katId('rozpocet');
    await vyvesit(spravce, {
      nazev: 'Rozpočet 2026',
      kategorie_id: kat,
      od: pridejDny(dnes(), -10),
      duvod_data: 'převzato z papírové desky',
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2026',
    });
    const r2026 = await dokument('Rozpočet 2026');
    expect(r2026.sejmuto_do).toBeNull();
    // nový rozpočet s překlepem v roce (2099) sejme ten platný
    await vyvesit(spravce, {
      nazev: 'Rozpočet 2027',
      kategorie_id: kat,
      od: dnes(),
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2099',
    });
    const novy = await dokument('Rozpočet 2027');
    let stary = await dokument('Rozpočet 2026');
    expect(stary.sejmuto_do).not.toBeNull();
    expect(stary.nahrazeno_id).toBe(novy.id);

    // oprava roku na 2025 (starší než 2026) → rozpočet 2026 se vrací na desku
    await upravit(spravce, novy.id, {
      nazev: 'Rozpočet 2027',
      kategorie_id: kat,
      od: dnes(),
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2025',
    });
    stary = await dokument('Rozpočet 2026');
    expect(stary.sejmuto_do).toBeNull();
    expect(stary.nahrazeno_id).toBeNull();
    expect(stary.sejmuti_duvod).toBe('');

    // správný rok 2027 → zase nahrazeno; koš nahrazující dokument vrátí původní stav
    await upravit(spravce, novy.id, {
      nazev: 'Rozpočet 2027',
      kategorie_id: kat,
      od: dnes(),
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2027',
    });
    expect((await dokument('Rozpočet 2026')).nahrazeno_id).toBe(novy.id);
    const f = await spravce.get(`/sprava/deska/${novy.id}`);
    await spravce.post(`/sprava/deska/${novy.id}/kos`, { _csrf: csrfZ(f.text), akce: 'smazat' });
    stary = await dokument('Rozpočet 2026');
    expect(stary.sejmuto_do).toBeNull();
    expect((await new Prohlizec(t.base).get('/rozpocet')).text).toContain('Rozpočet 2026');

    // uložení dokumentu v koši nic nesejme; obnovení z koše pravidla použije znovu
    await upravit(spravce, novy.id, {
      nazev: 'Rozpočet 2027',
      kategorie_id: kat,
      od: dnes(),
      do_odvolani: 'ano',
      typ_rozpoctu: 'rozpocet',
      rok: '2027',
    });
    expect((await dokument('Rozpočet 2026')).sejmuto_do).toBeNull();
    const f2 = await spravce.get(`/sprava/deska/${novy.id}`);
    await spravce.post(`/sprava/deska/${novy.id}/kos`, { _csrf: csrfZ(f2.text), akce: 'obnovit' });
    expect((await dokument('Rozpočet 2026')).nahrazeno_id).toBe(novy.id);
  });

  it('uložení uvnitř transakce volajícího (import) funguje a s ní se i vrátí', async () => {
    const kat = Number(await katId('rozpocet'));
    const data = {
      nazev: 'Návrh rozpočtu 2030 (import)',
      kategorieId: kat,
      cisloJednaci: '',
      puvodce: '',
      popis: '',
      od: dnes(),
      do: null,
      typRozpoctu: 'navrh_rozpoctu' as const,
      rok: 2030,
    };
    await t.db
      .transaction()
      .execute(async (trx) => {
        await new DeskaSluzba(trx).uloz(null, data, null);
        throw new Error('zrušit');
      })
      .catch(() => undefined);
    expect(
      await t.db.selectFrom('ud_dokumenty').select('id').where('nazev', '=', data.nazev).execute(),
    ).toHaveLength(0);
    await t.db.transaction().execute((trx) => new DeskaSluzba(trx).uloz(null, data, null));
    expect((await dokument(data.nazev)).rok).toBe(2030);
  });
});
