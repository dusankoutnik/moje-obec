// ESLint 9 (flat config): TypeScript + Prettier (Prettier řeší formát, ESLint jen logiku).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'public/js/vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      globals: Object.fromEntries(
        [
          'document',
          'window',
          'navigator',
          'console',
          'fetch',
          'FormData',
          'URL',
          'URLSearchParams',
          'HTMLFormElement',
          'HTMLInputElement',
          'HTMLElement',
          'Element',
          'Event',
          'CustomEvent',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Quill',
          'Image',
          'Blob',
          'FileReader',
          'DataTransfer',
          'location',
          'history',
          'localStorage',
          'requestAnimationFrame',
          'IntersectionObserver',
          'isFinite',
        ].map((g) => [g, 'readonly']),
      ),
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: Object.fromEntries(
        ['process', 'fetch', 'WebSocket', 'Buffer', 'console', 'setTimeout', 'URL'].map((g) => [
          g,
          'readonly',
        ]),
      ),
    },
  },
);
