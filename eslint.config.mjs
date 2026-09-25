import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.agent/**',
      '**/.superpowers/**',
      '**/playwright-report/**',
      '**/test-results*/**',
      '**/test-output/**',
      '**/.claude/worktrees/**',
      '**/.kilo/**',
      '**/.scratchpad/**',
      '**/web-releases/**',
      '**/releases/**',
      'apps/desktop/renderer/**',
      'debug-env.js',
      'fetch-patch.cjs',
      '.tmp-p3-debug.mts',
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
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'URL',
          property: 'revokeObjectURL',
          message: 'Use media-object-url lifecycle helpers for object URL release.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Fixtures intentionally exercise malformed envelopes and use compact
    // casts; keep production source strict without making test scaffolding a
    // release blocker.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-properties': 'off',
    },
  },
  {
    files: [
      'apps/editor-web/src/media-object-url.ts',
      'packages/renderer-pixi/src/browser-export.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    // Electron preload scripts must be CommonJS (see the comment in preload.cjs for why)
    // and run in a browser-like renderer-adjacent context, so they get both CJS and
    // `window` globals rather than the tooling-script set below.
    files: ['apps/desktop/src/preload/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'writable',
        window: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },
  {
    files: [
      '**/bin/**/*.{mjs,cjs,js}',
      'ops/**/*.mjs',
      'tooling/**/*.mjs',
      'scripts/*.cjs',
      'apps/*/scripts/*.mjs',
      'tests/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        performance: 'readonly',
      },
    },
    rules: {
      'no-redeclare': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
