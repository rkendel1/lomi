import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

const sharedRules = {
  ...js.configs.recommended.rules,
  'no-undef': 'off',
  'no-unused-vars': 'off',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-console': 'off',
  'prefer-const': 'warn',
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
};

/**
 * Shared flat ESLint config.
 *
 * `react: true` adds the browser globals and the React Hooks rules. Library
 * packages stay on the Node/browser-neutral preset so accidental DOM usage is
 * easier to spot.
 */
export function createConfig({ react = false } = {}) {
  const config = [
    {
      ignores: [
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/node_modules/**',
        '**/.turbo/**',
        '**/public/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.{ts,tsx,js,mjs,cjs}'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: react
          ? { ...globals.browser, ...globals.es2022 }
          : { ...globals.node, ...globals.es2022 },
      },
      rules: sharedRules,
    },
  ];

  if (react) {
    config.push({
      files: ['**/*.{ts,tsx}'],
      plugins: { 'react-hooks': reactHooks },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    });
  }

  return config;
}

export const baseConfig = createConfig();
export const reactConfig = createConfig({ react: true });
