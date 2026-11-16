import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import { eslintQualityRulesV1 } from '@chester-hill-solutions/ratchet-strap';
import { goldPlugin } from './scripts/lib/gold-rules.mjs';

const warnings = (rules) => Object.fromEntries(Object.entries(rules).map(([id, value]) => {
  const [level, ...options] = Array.isArray(value) ? value : [value];
  return [id, level === 0 || level === 'off' ? 'off' : ['warn', ...options]];
}));

export const RATCHET_RULES = {
  ...eslintQualityRulesV1,
  complexity: ['warn', { max: 10 }],
  'max-depth': ['warn', { max: 3 }],
  'max-params': ['warn', { max: 4 }],
  'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
  '@typescript-eslint/no-explicit-any': 'warn',
  eqeqeq: ['warn', 'always'],
};

export default [
  {
    // Built assets, qualification bundles, external snapshots and upstream UI
    // primitives have their own source of truth. Local UI code remains in scope.
    ignores: ['**/node_modules/**', '**/.git/**', '.wrangler/**', 'public/**',
      'vendor/**', 'tools/vendor/**', 'coverage/**', 'hillclimb/**',
      'bench/comparison/baseline/**', '**/dist/**', '**/build/**',
      'packages/ui/src/components/ui/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, Bun: 'readonly' } },
    rules: { ...warnings(js.configs.recommended.rules), 'no-debugger': 'error' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
    plugins: { '@typescript-eslint': tsPlugin, gold: goldPlugin },
    rules: {
      ...RATCHET_RULES,
      // TypeScript resolves Worker, DOM, JSX and imported type names.
      'no-undef': 'off', 'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description',
        minimumDescriptionLength: 10,
      }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'web/**/*.{ts,tsx}', 'runtime/opencode/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: { 'gold/async-sequencing': 'warn', 'gold/lifecycle-state': 'warn',
      'gold/effect-contract': 'warn', 'gold/type-escape': 'warn', 'gold/body-once': 'error' },
  },
  {
    files: ['**/*.tsx'],
    plugins: { react, 'react-hooks': hooks, 'jsx-a11y': a11y },
    settings: { react: { version: 'detect' } },
    rules: {
      ...warnings({ ...react.configs.recommended.rules, ...react.configs['jsx-runtime'].rules,
        ...a11y.configs.recommended.rules }),
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Console is the interface of scripts/benchmarks, and test callbacks are fixtures.
    files: ['scripts/**/*.{ts,mjs}', 'bench/**/*.ts', '**/*.test.ts', 'test/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-console': 'off', 'max-lines-per-function': 'off' },
  },
  { files: ['**/*.test.ts', 'test/**/*.ts', 'tests/**/*.ts'], rules: { 'gold/mock-passthrough': 'error' } },
  {
    // The comparison benchmark deliberately replaces the entire Worker DO class;
    // importing it would require the Workers runtime inside a Bun-only harness.
    files: ['bench/comparison/aboiteau.test.ts'], rules: { 'gold/mock-passthrough': 'off' },
  },
];
