// Smoke test v prohlížeči: redaktor webu se přihlásí SMS kódem (vývojový režim ukazuje kód na stránce), napíše
// aktualitu, editor ji sám uloží jako koncept, redaktor ji zveřejní a aktualita je na titulce.
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

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
    `INSERT INTO uzivatele (telefon, role, gdpr_souhlas_at) VALUES ($1, ARRAY['web'], now())
     ON CONFLICT (telefon) DO UPDATE SET role = ARRAY['web'], blokovan_at = NULL`,
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

// 1×1 PNG pro nahrání obrázku
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64',
);

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
  await page.getByRole('button', { name: 'Vložit obrázek na místo kurzoru' }).click();
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

  // titulek a velikost přes kontextovou lištu (obrázek je po vložení vybraný)
  await editor.locator('img').click();
  await page.getByRole('button', { name: 'Šířka 300 px' }).click();
  await page.getByRole('button', { name: 'Titulek pod obrázkem' }).click();
  await dialog.locator('input').fill('Foto: obec');
  await dialog.getByRole('button', { name: 'Uložit' }).click();
  await expect
    .poll(html)
    .toMatch(/<figure><img[^>]+width="300"[^>]*><figcaption>Foto: obec<\/figcaption><\/figure>/);

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
