import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  missingEntryPoints,
  packageEntryPoints,
  readWorkspacePackages,
  unresolvedWorkspaceImports,
  workspaceDependencyNames,
  workspaceImportSpecifiers,
  workspaceRuntimeClosure,
  type WorkspaceManifest,
  type WorkspacePackage,
} from '../../scripts/workspace-staging.mjs';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function workspacePackage(manifest: WorkspaceManifest): WorkspacePackage {
  return { name: manifest.name ?? '', dir: `/repo/${manifest.name ?? ''}`, manifest };
}

function packagesOf(...manifests: WorkspaceManifest[]): Map<string, WorkspacePackage> {
  return new Map(manifests.map((manifest) => [manifest.name ?? '', workspacePackage(manifest)]));
}

describe('workspaceDependencyNames', () => {
  it('lists workspace dependencies only, and ignores devDependencies and registry packages', () => {
    expect(
      workspaceDependencyNames({
        name: '@joy-media/app',
        dependencies: {
          '@joy-media/a': 'workspace:*',
          zod: '^4.0.0',
          '@joy-media/b': 'workspace:^',
        },
        devDependencies: { '@joy-media/dev-only': 'workspace:*' },
      }),
    ).toEqual(['@joy-media/a', '@joy-media/b']);
  });
});

describe('workspaceRuntimeClosure', () => {
  const leaf: WorkspaceManifest = { name: '@joy-media/leaf' };
  const middle: WorkspaceManifest = {
    name: '@joy-media/middle',
    dependencies: { '@joy-media/leaf': 'workspace:*' },
  };
  const devOnly: WorkspaceManifest = { name: '@joy-media/dev-only' };

  it('includes the packages a dependency pulls in, sorted by name', () => {
    const closure = workspaceRuntimeClosure(
      [
        {
          name: '@joy-media/app',
          dependencies: { '@joy-media/middle': 'workspace:*' },
          devDependencies: { '@joy-media/dev-only': 'workspace:*' },
        },
      ],
      packagesOf(leaf, middle, devOnly),
    );
    expect(closure.map((entry) => entry.name)).toEqual(['@joy-media/leaf', '@joy-media/middle']);
  });

  it('stages a package once when two apps, or a cycle, reach it more than once', () => {
    const left: WorkspaceManifest = {
      name: '@joy-media/left',
      dependencies: { '@joy-media/right': 'workspace:*' },
    };
    const right: WorkspaceManifest = {
      name: '@joy-media/right',
      dependencies: { '@joy-media/left': 'workspace:*' },
    };
    const closure = workspaceRuntimeClosure(
      [
        { name: '@joy-media/one', dependencies: { '@joy-media/left': 'workspace:*' } },
        { name: '@joy-media/two', dependencies: { '@joy-media/left': 'workspace:*' } },
      ],
      packagesOf(left, right),
    );
    expect(closure.map((entry) => entry.name)).toEqual(['@joy-media/left', '@joy-media/right']);
  });

  it('fails when a workspace dependency has no package, instead of skipping it', () => {
    expect(() =>
      workspaceRuntimeClosure(
        [{ name: '@joy-media/app', dependencies: { '@joy-media/ghost': 'workspace:*' } }],
        packagesOf(leaf),
      ),
    ).toThrow('@joy-media/app depends on @joy-media/ghost');
  });
});

describe('staged imports', () => {
  it('finds static, dynamic and CommonJS imports of workspace packages, with their subpaths', () => {
    expect(
      workspaceImportSpecifiers(
        [
          "import { a } from '@joy-media/provider-sdk';",
          "export { b } from '@joy-media/provider-oauth/chatgpt.js';",
          "const c = await import('@joy-media/export-core');",
          "const d = require('@joy-media/job-protocol');",
          "import '@joy-media/render-ir';",
          "import { e } from 'zod'; // not a workspace package",
        ].join('\n'),
      ),
    ).toEqual([
      '@joy-media/export-core',
      '@joy-media/job-protocol',
      '@joy-media/provider-oauth/chatgpt.js',
      '@joy-media/provider-sdk',
      '@joy-media/render-ir',
    ]);
  });

  it('flags the package the old fixed list forgot', () => {
    const stagedBeforeTheFix = packagesOf(
      { name: '@joy-media/provider-sdk', exports: { '.': './dist/index.js' } },
      { name: '@joy-media/project-schema', exports: { '.': './dist/index.js' } },
    );
    expect(
      unresolvedWorkspaceImports(
        ['@joy-media/provider-oauth', '@joy-media/provider-sdk'],
        [...stagedBeforeTheFix.values()],
      ),
    ).toEqual(['@joy-media/provider-oauth']);
  });

  it('flags a subpath that the staged package does not export, and accepts one it does', () => {
    const staged = [
      workspacePackage({
        name: '@joy-media/provider-oauth',
        exports: { '.': './dist/index.js', './chatgpt.js': './dist/chatgpt.js' },
      }),
    ];
    expect(
      unresolvedWorkspaceImports(
        [
          '@joy-media/provider-oauth',
          '@joy-media/provider-oauth/chatgpt.js',
          '@joy-media/provider-oauth/secret.js',
        ],
        staged,
      ),
    ).toEqual(['@joy-media/provider-oauth/secret.js']);
  });

  it('accepts a subpath that an exports pattern covers', () => {
    const staged = [
      workspacePackage({
        name: '@joy-media/ui',
        exports: { './features/*': './dist/features/*.js' },
      }),
    ];
    expect(unresolvedWorkspaceImports(['@joy-media/ui/features/a'], staged)).toEqual([]);
  });
});

describe('package entry points', () => {
  it('collects main and every file target of exports, and skips patterns', () => {
    expect(
      packageEntryPoints({
        main: './dist/index.js',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './chatgpt.js': { types: './dist/chatgpt.d.ts', default: './dist/chatgpt.js' },
          './features/*': './dist/features/*.js',
        },
      }),
    ).toEqual(['dist/chatgpt.d.ts', 'dist/chatgpt.js', 'dist/index.d.ts', 'dist/index.js']);
  });

  it('reports the entry points that the staged folder does not have', () => {
    // `resolve` is what the helper uses, so the fake file set matches on Windows and POSIX alike.
    const present = new Set([
      resolve('/staged', 'dist/index.js'),
      resolve('/staged', 'dist/index.d.ts'),
    ]);
    expect(
      missingEntryPoints(
        {
          main: './dist/index.js',
          exports: {
            '.': { types: './dist/index.d.ts', default: './dist/index.js' },
            './x.js': './dist/x.js',
          },
        },
        '/staged',
        (path) => present.has(path),
      ),
    ).toEqual(['dist/x.js']);
  });
});

function nonTestSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return nonTestSourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function importedWorkspacePackages(appDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of nonTestSourceFiles(join(repoRoot, appDir, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /from '(@joy-media\/[a-z0-9-]+)(?:\/[^']*)?'/g,
    )) {
      names.add(match[1] ?? '');
    }
  }
  return names;
}

describe('the staged workspace packages of this repository', () => {
  it('cover every workspace package that the desktop and Worker source imports at runtime', async () => {
    const packages = await readWorkspacePackages(repoRoot);
    const roots = ['@joy-media/desktop', '@joy-media/worker'].map((name) => {
      const found = packages.get(name);
      if (found === undefined) throw new Error(`${name} is not a workspace package`);
      return found.manifest;
    });
    const staged = new Set(workspaceRuntimeClosure(roots, packages).map((entry) => entry.name));

    const imported = new Set([
      ...importedWorkspacePackages('apps/desktop'),
      ...importedWorkspacePackages('apps/worker'),
    ]);
    // Guards the drift that broke the packaged app: an import that is not a declared dependency.
    expect([...imported].filter((name) => !staged.has(name))).toEqual([]);
    // The two packages the old fixed list named, and the one it had forgotten.
    for (const name of [
      '@joy-media/provider-sdk',
      '@joy-media/project-schema',
      '@joy-media/provider-oauth',
    ]) {
      expect(staged.has(name)).toBe(true);
    }
  });
});
