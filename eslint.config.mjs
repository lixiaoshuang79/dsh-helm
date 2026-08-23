// dsh-helm ESLint flat config — strict type-aware lint for packages/*/src + tests
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/lib/**', '**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // dynamic import() type annotations (node:sqlite lazy load) are intentional
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off', // tests use ! deliberately
      '@typescript-eslint/no-require-imports': 'off', // node:sqlite lazy require is intentional
      'no-console': 'off', // CLI package is a console app
    },
  },
)
