import eslint from '@eslint/js';
import eslintPluginLit from 'eslint-plugin-lit';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      lit: eslintPluginLit,
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript handles these better than ESLint's JS versions:
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',

      // typescript-eslint rules — set 'off' so eslint-disable directives in
      // existing code are valid (TypeScript compiler enforces these natively)
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Validates HTML structure in lit-html templates — catches unclosed tags
      'lit/no-invalid-html': 'error',
      // Require quoted expressions in templates
      'lit/quoted-expressions': ['error', 'always'],
      // No native event listener in templates (use Lit's event syntax)
      'lit/no-native-attributes': 'warn',
      // No useless template literals
      'lit/no-useless-template-literals': 'warn',
    },
  },
];
