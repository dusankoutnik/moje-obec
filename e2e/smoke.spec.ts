// Smoke test v prohlížeči: redaktor webu se přihlásí SMS kódem (vývojový režim ukazuje kód na stránce), napíše
// aktualitu, editor ji sám uloží jako koncept, redaktor ji zveřejní a aktualita je na titulce.
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import sharp from 'sharp';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://platforma:platforma@localhost:5432/platforma_e2e';
const TELEFON = '+420777990001';

test.beforeAll(async () => {
  // e2e databáze musí být oddělená (název končí na _e2e nebo _test) — test do ní zapisuje
  if (!/_(e2e|test)$/.test(new URL(DB).pathname))
    throw new Error('E2E_DATABASE_URL musí končit na _e2e nebo _test');
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  // aplikace už běží (webServer) → schéma je zmigrované
  await c.query(
    `INSERT INTO uzivatele (telefon, role, gdpr_souhlas_at, jmeno, prijmeni, prezdivka)
     VALUES ($1, ARRAY['web'], now(), 'Eva', 'Testovací', 'Eva')
     ON CONFLICT (telefon) DO UPDATE SET role = ARRAY['web'], blokovan_at = NULL, jmeno = 'Eva', prijmeni = 'Testovací'`,
    [TELEFON],
  );
  // opakované běhy nad stejnou databází: limit kódů na kontakt (3 za hodinu) nesmí test zablokovat
  await c.query('DELETE FROM otp_kody WHERE kontakt = $1', [TELEFON]);
  await c.end();
});

async function prihlas(page: Page) {
  await page.goto('/prihlaseni');
  await page.locator('#telefon').fill('777 990 001');
  await page.locator('form:has(#telefon) button[type=submit]').click();
  await expect(page.locator('#kod')).toBeVisible();
  const kod = /kód z SMS je (\d{6})/.exec(await page.locator('body').innerText())?.[1];
  expect(kod, 'vývojový kód na stránce').toBeTruthy();
  await page.locator('#kod').fill(kod!);
  await page.locator('form:has(#kod) button[type=submit]').click();
  // po kódu proběhne řetěz přesměrování (OIDC) — počkat, až skončí mimo přihlašovací stránky
  await page.waitForURL((u) => !/^\/(oidc|prihlaseni)/.test(u.pathname), { timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText('Přihlašovací sezení vypršelo');
}

test('autosave a zveřejnění aktuality, aktualita na titulce', async ({ page }) => {
  const titulek = `Smoke test ${Date.now()}`;

  await prihlas(page);

  await page.goto('/sprava/web/novy?typ=aktualita');
  await page.locator('#titulek').fill(titulek);
  const editor = page.locator('.editor-obsah').first();
  await editor.click();
  await editor.pressSequentially('Text aktuality ze smoke testu.');
  // automatické uložení (à 20 s) založí koncept a přepne formulář na jeho adresu
  await expect(page.locator('#autosave-stav')).toContainText('Automaticky uloženo', { timeout: 45_000 });
  await expect(page).toHaveURL(/\/sprava\/web\/obsah\/[0-9a-f-]{36}$/);

  await page.locator('button[name=akce][value=zverejnit]').click();
  await expect(page.locator('.flash').first()).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('link', { name: titulek })).toBeVisible();
  await page.getByRole('link', { name: titulek }).click();
  await expect(page.locator('h1')).toContainText(titulek);
  await expect(page.locator('main')).toContainText('Text aktuality ze smoke testu.');
});

// fotka pro nahrání (dost velká, aby šla kliknout i s úchyty velikosti v rozích)
let PNG: Buffer;
test.beforeAll(async () => {
  PNG = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#5a8a6a' } })
    .png()
    .toBuffer();
});
test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => console.log('CHYBA STRÁNKY:', e.message));
});

test('editor: obrázek na pozici kurzoru, titulek a velikost, tabulka', async ({ page }) => {
  await prihlas(page);
  await page.goto('/sprava/web/novy?typ=aktualita');
  await page.locator('#titulek').fill(`Editor ${Date.now()}`);
  const editor = page.locator('.editor-obsah').first();
  await editor.click();
  await editor.pressSequentially('První odstavec.');
  await page.keyboard.press('Enter');
  await editor.pressSequentially('Druhý odstavec.');
  // kurzor na konec prvního odstavce
  await editor.locator('p').first().click();
  await page.keyboard.press('End');

  const vyber = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Vložit fotku na místo kurzoru' }).click();
  await (await vyber).setFiles({ name: 'fotka.png', mimeType: 'image/png', buffer: PNG });
  const dialog = page.locator('dialog.alt-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill('Testovací fotka');
  await dialog.getByRole('button', { name: 'Vložit' }).click();

  // obrázek je mezi prvním a druhým odstavcem, ne na konci
  const html = () => page.locator('#obsah_html').inputValue();
  await expect
    .poll(html)
    .toMatch(/První odstavec\.<\/p><img[^>]+alt="Testovací fotka"[^>]*><p>Druhý odstavec\./);

  // titulek a velikost přes plovoucí lištičku u fotky
  await editor.locator('img').click();
  await page.getByRole('button', { name: 'Třetina šířky textu' }).click();
  await page.getByRole('button', { name: 'Titulek pod obrázkem' }).click();
  await dialog.locator('input').fill('Foto: obec');
  await dialog.getByRole('button', { name: 'Uložit' }).click();
  await expect
    .poll(html)
    .toMatch(/<figure class="obr-s33"><img[^>]+><figcaption>Foto: obec<\/figcaption><\/figure>/);

  // tabulka se záhlavím a přidaný řádek
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Vložit tabulku 3 × 3 se záhlavím' }).click();
  await page.getByRole('button', { name: 'Přidat řádek pod' }).click();
  await expect.poll(html).toMatch(/<table[^>]*>.*<th.*<\/table>/s);
  expect(((await html()).match(/<tr>/g) ?? []).length).toBe(4);

  // uložení: sanitizace na serveru obsah zachová
  await page.locator('button[name=akce][value=koncept]').click();
  await expect(page.locator('.flash').first()).toBeVisible();
  const ulozeny = await page.locator('#obsah_html').inputValue();
  expect(ulozeny).toContain('<figcaption>Foto: obec</figcaption>');
  expect(ulozeny).toContain('alt="Testovací fotka"');
  // pomocné styly editoru (šířky sloupců) server odstraní
  expect(ulozeny).toMatch(/<table><tbody><tr><th>/);
  expect(ulozeny).not.toContain('style=');
});

test('editor: lomítko, obtékání a tažení fotky, galerie z fotek, HTML, kontrola před zveřejněním', async ({
  page,
}) => {
  const titulek = `Galerie ${Date.now()}`;
  await prihlas(page);
  await page.goto('/sprava/web/novy?typ=aktualita');
  await page.locator('#titulek').fill(titulek);
  const editor = page.locator('.editor-obsah').first();
  const html = () => page.locator('#obsah_html').inputValue();
  await editor.click();
  await editor.pressSequentially('Úvod k pouti.');
  await page.keyboard.press('Enter');

  // „/fotka“ → výběr souboru → popis
  await editor.pressSequentially('/fot');
  await expect(page.locator('.editor-lomitko')).toBeVisible();
  const vyber = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await vyber).setFiles({ name: 'kostel.png', mimeType: 'image/png', buffer: PNG });
  const dialog = page.locator('dialog.alt-dialog');
  await dialog.locator('input').fill('Kostel');
  await dialog.getByRole('button', { name: 'Vložit' }).click();
  await expect.poll(html).not.toContain('/fot');

  // vlevo s obtékáním → rovnou polovina šířky; pak tažením za roh menší
  await editor.locator('img').click();
  await page.getByRole('button', { name: 'Vlevo, text obtéká zprava' }).click();
  await expect.poll(html).toContain('<figure class="obr-vlevo obr-s50">');
  const uchyt = editor.locator('.editor-obr-uchyt.vpravo');
  await expect(uchyt).toBeVisible();
  const b = (await uchyt.boundingBox())!;
  const sirka = (await editor.locator('.editor-obr').boundingBox())!.width;
  await page.mouse.move(b.x + 8, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + 8 - sirka / 2, b.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect.poll(html).toContain('<figure class="obr-vlevo obr-s25">');

  // nová galerie ze 4 fotek přes tlačítko Galerie → vloží se živá značka
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Vložit fotogalerii' }).click();
  const vyberGalerie = page.locator('dialog.editor-vyber-galerie');
  await expect(vyberGalerie).toBeVisible();
  const fotky = page.waitForEvent('filechooser');
  await vyberGalerie.getByRole('button', { name: '+ Nová galerie z fotek…' }).click();
  await (
    await fotky
  ).setFiles([1, 2, 3, 4].map((i) => ({ name: `pout-${i}.png`, mimeType: 'image/png', buffer: PNG })));
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill(`Pouť ${titulek}`);
  await dialog.getByRole('button', { name: 'Nahrát 4 fotek' }).click();
  await expect
    .poll(html, { timeout: 30_000 })
    .toMatch(/<figure class="galerie-obce" data-galerie="[0-9a-f-]{36}"/);
  await expect(editor.locator('.editor-galerie-obce img')).toHaveCount(4);
  await editor.locator('.editor-galerie-obce').click();
  await page.getByRole('button', { name: 'Rozložení galerie: Pás náhledů' }).click();
  await expect.poll(html).toContain('data-rozlozeni="pas"');

  // ruční HTML: nepovolené věci editor vynechá a řekne co
  await page.getByRole('button', { name: 'Upravit HTML ručně (pro pokročilé)' }).click();
  const zdroj = page.locator('textarea.editor-html');
  await expect(zdroj).toBeVisible();
  await zdroj.fill(
    (await zdroj.inputValue()) +
      '\n<p style="color:red">TOTO JE VELMI DŮLEŽITÉ OZNÁMENÍ PRO VŠECHNY OBČANY OBCE</p><script>alert(1)</script>',
  );
  await page.getByRole('button', { name: 'Upravit HTML ručně (pro pokročilé)' }).click();
  await expect(page.locator('.editor-html-zprava')).toContainText('atribut style');
  await expect(page.locator('.editor-html-zprava')).toContainText('<script>');
  await expect.poll(html).toContain('<p>TOTO JE VELMI');

  // kontrola před zveřejněním upozorní na verzálky, „Přesto zveřejnit“ projde
  await page.locator('button[name=akce][value=zverejnit]').click();
  const kontrola = page.locator('dialog.editor-kontrola');
  await expect(kontrola).toContainText('VELKÝMI PÍSMENY');
  await kontrola.getByRole('button', { name: 'Přesto zveřejnit' }).click();
  await expect(page.locator('.flash').first()).toContainText('na webu');

  // web: fotka vlevo, galerie jako pás s prohlížečem
  await page.goto('/aktuality');
  await page.getByRole('link', { name: titulek }).click();
  await expect(page.locator('.obsah-html figure.obr-vlevo.obr-s25 img')).toHaveAttribute('alt', 'Kostel');
  const galerie = page.locator('.galerie-v-textu.galerie-pas');
  await expect(galerie.locator('a[data-foto]')).toHaveCount(4);
  // galerie je součástí jedné řady všech obrázků příspěvku (fotka v textu + 4 z galerie)
  await galerie.locator('a[data-foto]').first().click();
  await expect(page.locator('dialog.prohlizec')).toBeVisible();
  await expect(page.locator('dialog.prohlizec .pocitadlo')).toHaveText('2 / 5');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('dialog.prohlizec .pocitadlo')).toHaveText('3 / 5');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.prohlizec')).toBeHidden();

  // klik na fotku v textu: prohlížeč se všemi obrázky příspěvku (1 v textu + 4 z galerie), pás náhledů, zoom
  await page.locator('.obsah-html figure.obr-vlevo.obr-s25 img').click();
  await expect(page.locator('dialog.prohlizec')).toBeVisible();
  await expect(page.locator('dialog.prohlizec .pocitadlo')).toHaveText('1 / 5');
  await expect(page.locator('dialog.prohlizec .prohlizec-pas button')).toHaveCount(5);
  await page.locator('dialog.prohlizec .prohlizec-pas button').nth(3).click();
  await expect(page.locator('dialog.prohlizec .pocitadlo')).toHaveText('4 / 5');
  await expect(page.locator('dialog.prohlizec .prohlizec-pas button').nth(3)).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.getByRole('button', { name: 'Přiblížit' }).click();
  await expect(page.locator('dialog.prohlizec .prohlizec-ram')).toHaveClass(/zoom/);
  await page.keyboard.press('0');
  await expect(page.locator('dialog.prohlizec .prohlizec-ram')).not.toHaveClass(/zoom/);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.prohlizec')).toBeHidden();
});
