import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../..');
const workerManifest = JSON.parse(
  readFileSync(resolve(repoRoot, 'apps/worker/package.json'), 'utf8'),
);
const acceptanceHarness = readFileSync(
  resolve(repoRoot, 'ops/self-hosted/windows-runner/worker-acceptance-container.ps1'),
  'utf8',
);

function workspaceManifest(packageName) {
  const packageDirectory =
    packageName === '@joy-media/worker'
      ? 'apps/worker'
      : resolve(repoRoot, 'packages', packageName.slice('@joy-media/'.length));
  return JSON.parse(readFileSync(resolve(repoRoot, packageDirectory, 'package.json'), 'utf8'));
}

function runtimeWorkspaceDependencies() {
  const pending = Object.entries(workerManifest.dependencies ?? {})
    .filter(([name, version]) => name.startsWith('@joy-media/') && version.startsWith('workspace:'))
    .map(([name]) => name);
  const seen = new Set();

  while (pending.length > 0) {
    const name = pending.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    for (const [dependency, version] of Object.entries(
      workspaceManifest(name).dependencies ?? {},
    )) {
      if (
        dependency.startsWith('@joy-media/') &&
        version.startsWith('workspace:') &&
        !seen.has(dependency)
      ) {
        pending.push(dependency);
      }
    }
  }

  return seen;
}

test('the Windows Worker acceptance runtime stages its full transitive workspace dependency closure', () => {
  const packageList = acceptanceHarness.match(/foreach\s*\(\$packageName\s+in\s+@\(([^)]*)\)/s);
  assert.ok(
    packageList,
    'the Worker acceptance harness must declare its staged workspace packages',
  );

  const staged = new Set([...packageList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const required = runtimeWorkspaceDependencies();
  const missing = [...required]
    .map((name) => name.slice('@joy-media/'.length))
    .filter((name) => !staged.has(name))
    .sort();

  assert.deepEqual(
    missing,
    [],
    'the Worker harness must stage every production workspace dependency required at runtime',
  );
});
