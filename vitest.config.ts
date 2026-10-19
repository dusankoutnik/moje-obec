import { defineConfig } from 'vitest/config';

// Testy proti Postgresu běží sériově (sdílená testovací databáze); čistě jednotkové testy to nezpomalí.
// Pokrytí (npm run test:pokryti): prahy jsou pár bodů pod naměřeným stavem — jak je zvedat, viz docs/VYVOJ.md.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/scripts/**', 'src/index.ts', 'src/db/migrate.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 84, statements: 80, functions: 82, branches: 68 },
    },
  },
});
