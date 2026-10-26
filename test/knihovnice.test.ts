// Role knihovnice: aktuality jen v rubrice knihovny (a podrubrikách); jinde 403, cizí rubriky příspěvku zůstanou.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfZ, postSoubory, prihlasSRoli, spustTestApp, type Prohlizec, type TestApp } from './pomocnici.js';

let t: TestApp;
let kn: Prohlizec;
const id = {} as Record<string, number>;

beforeAll(async () => {
  t = await spustTestApp();
  const k = async (slug: string, nazev: string, nadrazena_id: number | null = null) =>
    (id[slug] = (
      await t.db
        .insertInto('web_kategorie')
        .values({ slug, nazev, nadrazena_id })
        .onConflict((oc) => oc.column('slug').doUpdateSet({ nazev, nadrazena_id }))
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id);
  await k('knihovna', 'Knihovna');
  await k('knihovna-akce', 'Akce knihovny', id.knihovna!);
  await k('obecni-urad', 'Obecní úřad informuje');
  kn = await prihlasSRoli(t, '777 950 001', ['knihovnice']);
});
afterAll(async () => t.zavri());

async function aktualita(titulek: string, kategorie_id: number, kategorie_dalsi: number[] = []) {
  return (
    await t.db
      .insertInto('web_obsah')
      .values({
        typ: 'aktualita',
        titulek,
        slug: titulek.toLowerCase().replace(/\s+/g, '-'),
        kategorie_id,
        kategorie_dalsi,
        stav: 'zverejneno',
        datum: new Date(),
        obsah_html: '<p>text</p>',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

describe('knihovnice', () => {
  it('vidí jen příspěvky své rubriky, jinam 403', async () => {
    await aktualita('Noc s Andersenem', id['knihovna-akce']!);
    const urad = await aktualita('Svoz odpadu', id['obecni-urad']!);
    const seznam = await kn.get('/sprava/web/aktuality');
    expect(seznam.res.status).toBe(200);
    expect(seznam.text).toContain('Noc s Andersenem');
    expect(seznam.text).not.toContain('Svoz odpadu');
    expect((await kn.get(`/sprava/web/obsah/${urad}`)).res.status).toBe(403);
    expect((await kn.get('/sprava/web/stranky')).res.status).toBe(403);
    expect((await kn.get('/sprava/web/novy?typ=stranka')).res.status).toBe(403);
    expect((await kn.get('/sprava/web/vzhled')).res.status).toBe(403);
    // administrace: dlaždice knihovny; /sprava/web vede rovnou na příspěvky
    expect((await kn.get('/sprava')).text).toContain('Příspěvky knihovny');
    expect((await kn.get('/sprava/web', false)).res.headers.get('location')).toBe('/sprava/web/aktuality');
  });

  it('napíše příspěvek jen do své rubriky; cizí rubriky existujícího příspěvku zachová', async () => {
    const form = await kn.get('/sprava/web/novy?typ=aktualita');
    expect(form.text).toContain('Akce knihovny');
    expect(form.text).not.toContain('Obecní úřad informuje');
    const odp = await postSoubory(
      kn,
      '/sprava/web/novy',
      {
        _csrf: csrfZ(form.text),
        typ: 'aktualita',
        titulek: 'Nové knihy',
        obsah_html: '<p>Přišly nové knihy.</p>',
        kategorie_id: String(id['obecni-urad']), // podvržená cizí rubrika
        kategorie_dalsi_pole: '1',
        akce: 'zverejnit',
      },
      [],
    );
    expect(odp.res.status).toBe(200);
    const nove = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('titulek', '=', 'Nové knihy')
      .executeTakeFirstOrThrow();
    expect(nove.kategorie_id).toBe(id.knihovna);
    expect(nove.kategorie_dalsi).toEqual([]);
    // společný příspěvek (úřad hlavní, knihovna další): knihovnice upraví text, rubrika úřadu zůstane hlavní
    const spolecny = await aktualita('Týden knihoven', id['obecni-urad']!, [id.knihovna!]);
    const f2 = await kn.get(`/sprava/web/obsah/${spolecny}`);
    expect(f2.res.status).toBe(200);
    await postSoubory(
      kn,
      `/sprava/web/obsah/${spolecny}`,
      {
        _csrf: csrfZ(f2.text),
        titulek: 'Týden knihoven 2026',
        obsah_html: '<p>Program týdne.</p>',
        kategorie_id: String(id['knihovna-akce']),
        kategorie_dalsi_pole: '1',
        akce: 'zverejnit',
      },
      [],
    );
    const po = await t.db
      .selectFrom('web_obsah')
      .selectAll()
      .where('id', '=', spolecny)
      .executeTakeFirstOrThrow();
    expect(po.titulek).toBe('Týden knihoven 2026');
    expect(po.kategorie_id).toBe(id['obecni-urad']);
    expect(po.kategorie_dalsi).toEqual([id['knihovna-akce']]);
  });

  it('smaže svůj příspěvek do koše, cizí ne', async () => {
    const muj = await aktualita('Halloween', id.knihovna!);
    const cizi = await aktualita('Zastupitelstvo', id['obecni-urad']!);
    const f = await kn.get(`/sprava/web/obsah/${muj}/smazat`);
    await kn.post(`/sprava/web/obsah/${muj}/smazat`, { _csrf: csrfZ(f.text) });
    const smazany = await t.db
      .selectFrom('web_obsah')
      .select('smazano_at')
      .where('id', '=', muj)
      .executeTakeFirstOrThrow();
    expect(smazany.smazano_at).not.toBeNull();
    const r = await kn.post(`/sprava/web/obsah/${cizi}/smazat`, { _csrf: csrfZ(f.text) }, false);
    expect(r.res.status).toBe(403);
  });
});
