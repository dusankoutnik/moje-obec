// Playwright smoke test (e2e/): spustí aplikaci proti vlastní databázi a projde hlavní cestu redaktora v prohlížeči.
// Lokálně: viz docs/VYVOJ.md (docker image mcr.microsoft.com/playwright). V CI samostatný job jen na push do main.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://platforma:platforma@localhost:5432/platforma_e2e';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: BASE, locale: 'cs-CZ', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx src/index.ts',
    url: `${BASE}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    env: {
      // místní .env (vývojová instance) se nenačítá — e2e běží jen s hodnotami níže
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      BASE_URL: BASE,
      INTERNAL_BASE_URL: BASE,
      TRUST_PROXY_HOPS: '0',
      LOG_LEVEL: 'warn',
      DATABASE_URL: DB,
      SESSION_SECRET: 'e2e-'.repeat(10),
      OIDC_COOKIE_SECRET: 'e2e-oidc-'.repeat(5),
      OIDC_PLATFORMA_SECRET: 'e2e-platforma-secret',
      OBEC_YML: './obec.example.yml',
      DATA_DIR: '/tmp/platforma-e2e-data',
      SMS_PROVIDER: 'konzole',
      MAIL_PROVIDER: 'konzole',
      OTP_DEV_ZOBRAZIT: '1',
      OTP_COOLDOWN_S: '0',
    },
  },
});
