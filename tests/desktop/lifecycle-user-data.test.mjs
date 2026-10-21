import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const requireDesktop = createRequire(resolve(repoRoot, 'apps/desktop/package.json'));
const electronPath = requireDesktop('electron');
const lifecycleFixture = resolve(repoRoot, 'tests/desktop/lifecycle-user-data.mjs');
const syntheticSecret = 'joy-media-lifecycle-synthetic-key-v1';

function runFixture(mode, userDataDirectory) {
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|JOY_MEDIA_)/iu.test(name),
    ),
  );
  const result = spawnSync(
    electronPath,
    [lifecycleFixture, `--user-data-dir=${userDataDirectory}`, mode],
    {
      cwd: repoRoot,
      env: {
        ...inheritedEnvironment,
        TEMP: tmpdir(),
        TMP: tmpdir(),
        NODE_ENV: 'production',
        JOY_MEDIA_EDGE_URL: 'off',
      },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `Electron lifecycle fixture could not start: ${result.error?.message ?? ''}`,
  );
  assert.equal(
    result.status,
    0,
    `Electron lifecycle ${mode} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout.trim());
}

test(
  'preserves desktop settings, asset library and DPAPI-backed synthetic secrets across processes',
  { skip: process.platform !== 'win32' },
  () => {
    assert.equal(
      existsSync(lifecycleFixture),
      true,
      'The real Electron lifecycle user-data fixture must be present.',
    );
    const root = mkdtempSync(join(tmpdir(), 'joy-media-lifecycle-user-data-'));
    const userDataDirectory = join(root, 'profile', 'Roaming', 'joy-media');
    try {
      const seeded = runFixture('seed', userDataDirectory);
      assert.equal(seeded.result, 'seeded');
      assert.equal(seeded.encryptionAvailable, true);
      assert.equal(seeded.appName, 'JOY Media Lifecycle Fixture');

      const reopened = runFixture('verify', userDataDirectory);
      assert.equal(reopened.result, 'verified');
      assert.equal(reopened.appName, seeded.appName);
      assert.equal(reopened.ciphertextSha256, seeded.ciphertextSha256);
      assert.equal(reopened.directCiphertextSha256, seeded.directCiphertextSha256);
      assert.equal(reopened.settingValue, 'preserve-through-update');
      assert.equal(reopened.libraryExists, true);
      assert.equal(reopened.libraryCatalogPresent, true);
      assert.equal(
        reopened.syntheticSecretSha256,
        createHash('sha256').update(syntheticSecret).digest('hex'),
      );
      assert.equal(JSON.stringify(reopened).includes(syntheticSecret), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
