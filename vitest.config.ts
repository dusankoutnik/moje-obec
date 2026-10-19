import { defineConfig } from 'vitest/config';

// Testy proti Postgresu běží sériově (sdílená testovací databáze); čistě jednotkové testy to nezpomalí.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
