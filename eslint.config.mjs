import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The desktop source reaches the project-folder store only through its package front door. So a relative or absolute
 * import may not leave apps/desktop/src, because a path into a package's files would skip the front door. A module may
 * be loaded with import() only from a literal name. Package names are not read here: each package exports only what its
 * front door lists, and the build checks the packaged app.
 */
const desktopSourceRoot = `${path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps', 'desktop', 'src')}${path.sep}`;

function leavesDesktopSource(filename, specifier) {
  // A built-in module (node:fs) and a bare package name are not paths into another folder.
  if (typeof specifier !== 'string' || specifier.startsWith('node:')) return false;
  let target;
  try {
    if (specifier.startsWith('file:')) {
      target = fileURLToPath(specifier);
    } else if (
      specifier.startsWith('.') ||
      path.isAbsolute(specifier) ||
      /^[A-Za-z]:[\\/]/.test(specifier) ||
      specifier.startsWith('\\')
    ) {
      target = path.resolve(path.dirname(filename), specifier);
    } else {
      return false; // a bare name is a package, and a package exports only its front door
    }
  } catch {
    return true; // a URL that does not name a file cannot be checked, so it is reported
  }
  return !(target + path.sep).startsWith(desktopSourceRoot);
}

const desktopBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      leaves:
        'Import from inside apps/desktop/src, or by package name. A relative or absolute path into another folder skips the package front door.',
      dynamic:
        'Load a module with import() or require() only from a literal name, so the module it loads can be read.',
      loader:
        'Do not create a require function, or call require as a property. Each one loads a path the boundary check cannot read.',
    },
  },
  create(context) {
    const filename = context.filename;
    function check(node, specifier) {
      if (leavesDesktopSource(filename, specifier)) context.report({ node, messageId: 'leaves' });
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type !== 'Literal') {
          context.report({ node, messageId: 'dynamic' });
          return;
        }
        check(node, node.source.value);
      },
      // A CommonJS file (the preload and the read observer) loads a module with require(path).
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const argument = node.arguments[0];
        if (argument?.type !== 'Literal') {
          context.report({ node, messageId: 'dynamic' });
          return;
        }
        check(node, argument.value);
      },
      // A require function made at run time (createRequire) loads a path the check cannot read.
      Identifier(node) {
        if (node.name === 'createRequire') context.report({ node, messageId: 'loader' });
      },
      // Module.require(path) and module.require(path) load a path the check cannot read.
      MemberExpression(node) {
        const name = node.computed
          ? node.property.type === 'Literal'
            ? node.property.value
            : undefined
          : node.property.type === 'Identifier'
            ? node.property.name
            : undefined;
        if (name === 'require') {
          context.report({ node, messageId: 'loader' });
        }
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference?.type === 'TSExternalModuleReference') {
          check(node, node.moduleReference.expression.value);
        }
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.agent/**',
      '**/.superpowers/**',
      '**/playwright-report/**',
      '**/.wrangler/**',
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
      // The desktop source is linted in full, so its .js files are not ignored as compiled output.
      '!apps/desktop/src/**/*.js',
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
    // The desktop source reaches the project-folder store only through its package front door, so it may not import from
    // another folder by a relative or absolute path, and it may load a module with import() only from a literal name.
    // Tests are not checked.
    files: ['apps/desktop/src/**/*.{js,jsx,ts,tsx,mts,cts,mjs,cjs}'],
    ignores: ['**/*.test.*'],
    plugins: {
      'joy-desktop': { rules: { boundary: desktopBoundary } },
    },
    rules: {
      'joy-desktop/boundary': 'error',
      // Code run from a string loads modules the rule cannot see, so the desktop source does not run code from strings.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // The read observer is a CommonJS preload that the local worker test loads with NODE_OPTIONS --require, so it is
    // plain Node code: require and process are its only globals.
    files: ['apps/desktop/src/jobs/read-observer.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        process: 'readonly',
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
