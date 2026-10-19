// Smoke test v prohlížeči: redaktor webu se přihlásí SMS kódem (vývojový režim ukazuje kód na stránce), napíše
// aktualitu, editor ji sám uloží jako koncept, redaktor ji zveřejní a aktualita je na titulce.
import { expect, test } from '@playwright/test';
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

test('autosave a zveřejnění aktuality, aktualita na titulce', async ({ page }) => {
  const titulek = `Smoke test ${Date.now()}`;

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

  await page.goto('/sprava/web/novy?typ=aktualita');
  await page.locator('#titulek').fill(titulek);
  const editor = page.locator('.ql-editor').first();
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
