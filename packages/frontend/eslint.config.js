// Minimal ESLint, kept ONLY for the eslint-plugin-expo rules Biome has no
// equivalent for. Formatting and every other lint rule is Biome (root
// biome.json, `bun run lint`); do not add rules here that Biome can enforce.
//
// - no-env-var-destructuring / no-dynamic-env-var: Metro inlines
//   `process.env.EXPO_PUBLIC_*` only when read as a static member expression;
//   a destructured or computed read is silently `undefined` in the bundle.
// - use-dom-exports: a `'use dom'` component file must default-export the
//   component and export nothing else, or Expo cannot mount it.
const expo = require('eslint-plugin-expo');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['dist/**', 'web-build/**', '.expo/**', 'android/**', 'ios/**'],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      'expo/use-dom-exports': 'error',
    },
  },
];
