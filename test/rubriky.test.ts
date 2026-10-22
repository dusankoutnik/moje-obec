// Prázdné rubriky (bez zveřejněného příspěvku / dokumentu) se návštěvníkům nenabízejí: ve filtru aktualit,
// v hlavním menu (odkazy na rubriku) ani ve filtru úřední desky. V editoru zůstávají (redaktor do nich píše).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prohlizec, prihlasSRoli, spustTestApp, type TestApp } from './pomocnici.js';

describe('prázdné rubriky se skrývají', () => {
  let t: TestApp;
  let plnaId: number;
  let prazdnaId: number;
  beforeAll(async () => {
    t = await spustTestApp();
    plnaId = (
      await t.db
        .insertInto('web_kategorie')
        .values({ slug: 'plna', nazev: 'Plná rubrika', poradi: 10 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    prazdnaId = (
      await t.db
        .insertInto('web_kategorie')
        .values({ slug: 'prazdna', nazev: 'Prázdná rubrika', poradi: 20 })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await t.db
      .insertInto('web_obsah')
      .values({
        typ: 'aktualita',
        titulek: 'Zpráva v plné rubrice',
        slug: 'zprava-v-plne',
        kategorie_id: plnaId,
        stav: 'zverejneno',
        datum: new Date('2026-10-01T10:00:00Z'),
        obsah_html: '<p>x</p>',
      })
      .execute();
    // položky menu: pod „Aktuálně“ odkazy na obě rubriky a na dvě kategorie desky (jedna bez dokumentů)
    const rodic = await t.db
      .insertInto('web_obsah')
      .values({
        typ: 'stranka',
        titulek: 'Aktuálně',
        slug: 'aktualne',
        stav: 'zverejneno',
        v_menu: true,
        poradi: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const odkazy: [string, string][] = [
      ['Plná', '/aktuality?kategorie=plna'],
      ['Prázdná', '/aktuality?kategorie=prazdna'],
      ['Deska – bez dokumentů', '/uredni-deska/archiv?kategorie=bez-dokumentu'],
    ];
    for (const [titulek, url] of odkazy)
      await t.db
        .insertInto('web_obsah')
        .values({
          typ: 'odkaz',
          titulek,
          slug: titulek.toLowerCase().replace(/[^a-z]+/g, '-'),
          odkaz_url: url,
          nadrazena_id: rodic.id,
          stav: 'zverejneno',
          v_menu: true,
          poradi: 1,
        })
        .execute();
    await t.db
      .insertInto('ud_kategorie')
      .values({ slug: 'bez-dokumentu', nazev: 'Bez dokumentů', poradi: 99 })
      .execute();
  });
  afterAll(() => t.zavri());

  it('filtr aktualit nabízí jen rubriky s obsahem', async () => {
    const b = new Prohlizec(t.base);
    const r = await b.get('/aktuality');
    expect(r.text).toContain('kategorie=plna');
    expect(r.text).not.toContain('kategorie=prazdna');
  });

  it('hlavní menu skryje odkaz na prázdnou rubriku i na kategorii desky bez dokumentů', async () => {
    const b = new Prohlizec(t.base);
    const r = await b.get('/');
    expect(r.text).toContain('href="/aktuality?kategorie=plna"');
    expect(r.text).not.toContain('kategorie=prazdna');
    expect(r.text).not.toContain('kategorie=bez-dokumentu');
  });

  it('filtr úřední desky nenabízí kategorii bez dokumentů', async () => {
    const b = new Prohlizec(t.base);
    const r = await b.get('/uredni-deska');
    expect(r.text).not.toContain('bez-dokumentu');
    const a = await b.get('/uredni-deska/archiv');
    expect(a.text).not.toContain('bez-dokumentu');
  });

  it('po zveřejnění příspěvku se rubrika objeví; v editoru je vždy', async () => {
    const red = await prihlasSRoli(t, '777 620 001', ['web']);
    const e = await red.get('/sprava/web/novy?typ=aktualita');
    expect(e.text).toContain('Prázdná rubrika');
    await t.db
      .insertInto('web_obsah')
      .values({
        typ: 'aktualita',
        titulek: 'První zpráva',
        slug: 'prvni-zprava',
        kategorie_id: prazdnaId,
        stav: 'zverejneno',
        datum: new Date('2026-10-02T10:00:00Z'),
        obsah_html: '<p>y</p>',
      })
      .execute();
    t.app.web.obsah.zmena(); // keš menu
    const b = new Prohlizec(t.base);
    expect((await b.get('/aktuality')).text).toContain('kategorie=prazdna');
    expect((await b.get('/')).text).toContain('href="/aktuality?kategorie=prazdna"');
  });
});
