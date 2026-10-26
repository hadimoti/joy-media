import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { internalPackageDirectories, WORKER_RUNTIME_PACKAGES } from './workspace-packages.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const desktopManifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));

test('every internal dependency of the desktop app is staged, including release-trust', () => {
  const staged = internalPackageDirectories(desktopManifest);
  const declared = Object.keys(desktopManifest.dependencies ?? {}).filter((name) =>
    name.startsWith('@joy-media/'),
  );
  assert.ok(declared.length > 0, 'the desktop manifest declares internal dependencies');
  for (const name of declared) {
    assert.ok(
      staged.includes(name.slice('@joy-media/'.length)),
      `${name} is not staged into the packaged node_modules`,
    );
  }
  assert.ok(staged.includes('release-trust'), 'release-trust is staged');
});

test('the Worker runtime closure is staged even when the desktop manifest does not list it', () => {
  const staged = internalPackageDirectories({ dependencies: {} });
  for (const name of WORKER_RUNTIME_PACKAGES) {
    assert.ok(staged.includes(name), `${name} is staged`);
  }
});

test('every staged name is a workspace package with a manifest', () => {
  for (const name of internalPackageDirectories(desktopManifest)) {
    assert.ok(
      existsSync(join(repoRoot, 'packages', name, 'package.json')),
      `packages/${name}/package.json exists`,
    );
  }
});

test('the packager stages from the manifest-derived list, not a fixed list', () => {
  const source = readFileSync(join(desktopRoot, 'scripts', 'package-release.mjs'), 'utf8');
  assert.match(source, /internalPackageDirectories\(desktopManifest\)/u);
});

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name) ? [path] : [];
  });
}

test('every internal package the desktop main process imports is a declared dependency', () => {
  const declared = new Set(Object.keys(desktopManifest.dependencies ?? {}));
  const imported = new Set();
  for (const file of listSourceFiles(join(desktopRoot, 'src', 'main'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /from\s+['"](@joy-media\/[^'"]+)['"]/gu,
    )) {
      imported.add(match[1].split('/').slice(0, 2).join('/'));
    }
  }
  assert.ok(imported.size > 0, 'the main process imports internal packages');
  for (const name of imported) {
    assert.ok(
      declared.has(name),
      `${name} is imported by the desktop main process but is not a declared dependency`,
    );
  }
});
