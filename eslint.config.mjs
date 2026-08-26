import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.agent/**',
      '**/.superpowers/**',
      '**/test-output/**',
      'debug-env.js',
      'fetch-patch.cjs',
      '**/.claude/worktrees/**',
      '**/web-releases/**',
      '**/releases/**',
      // TypeScript compiler outputs emitted alongside authored source files.
      '**/src/**/*.js',
      '**/src/**/*.d.ts',
      '**/src/**/*.js.map',
      '**/src/**/*.d.ts.map',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/bin/**/*.{mjs,cjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-redeclare': 'off',
    },
  },
);
