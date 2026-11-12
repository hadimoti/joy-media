import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLiveDriver, EXPECTED_JOY_HASH, verifyAfterRun } from './driver.mjs';

function fakeRun() {
  const root = mkdtempSync(join(tmpdir(), 'live-driver-test-'));
  const app = join(root, 'app');
  const playwright = join(app, 'resources', 'app', 'node_modules', 'playwright-core');
  mkdirSync(playwright, { recursive: true });
  writeFileSync(join(playwright, 'package.json'), '{"name":"playwright-core"}');
  writeFileSync(join(app, 'joy-media.exe'), 'fake app');
  writeFileSync(join(root, 'electron.exe'), 'fake Electron');
  writeFileSync(join(root, 'version'), '44.3.0');
  return { root, app, out: join(root, 'out') };
}

function configFor(run) {
  return {
    appDir: run.app,
    outDir: run.out,
    profileDir: join(run.root, 'profile'),
    libraryDir: join(run.root, 'library'),
    electronDir: run.root,
  };
}

function driverFor(run, overrides = {}) {
  let launches = 0;
  const { lock, ...preflightOverrides } = overrides;
  const driver = createLiveDriver(
    {
      ...configFor(run),
      runId: 'fake-run',
      lockPath: join(run.root, 'app-lock.txt'),
    },
    {
      preflightDeps: {
        platform: 'win32',
        joyHash: EXPECTED_JOY_HASH,
        ownerLibraryFiles: 3221,
        electronVersion: '44.3.0',
        portAvailable: true,
        runningProcesses: 0,
        ...preflightOverrides,
      },
      inspectLock: () => lock ?? { status: 'available' },
      spawn() {
        launches += 1;
        throw new Error('fake app must not launch');
      },
    },
  );
  return { driver, launches: () => launches };
}

test('refuses a recent app lock before launch', async (t) => {
  const run = fakeRun();
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  const fake = driverFor(run, { lock: { status: 'busy' } });

  await assert.rejects(fake.driver.launch(), /lock is younger than 30 minutes/u);
  assert.equal(fake.launches(), 0);
  await fake.driver.close();
});

test('refuses a wrong joy protocol hash before launch', async (t) => {
  const run = fakeRun();
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  const fake = driverFor(run, { joyHash: 'wrong-hash' });

  await assert.rejects(fake.driver.launch(), /joy:\/\/ registry hash does not match/u);
  assert.equal(fake.launches(), 0);
  await fake.driver.close();
});

test('refuses a missing playwright runtime in a fake unpacked app', async (t) => {
  const run = fakeRun();
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  rmSync(join(run.app, 'resources', 'app', 'node_modules', 'playwright-core'), {
    recursive: true,
    force: true,
  });
  const fake = driverFor(run);

  await assert.rejects(fake.driver.launch(), /playwright-core is missing/u);
  assert.equal(fake.launches(), 0);
  await fake.driver.close();
});

test('refuses a changed owner-library count after a fake run', () => {
  assert.throws(
    () =>
      verifyAfterRun(
        { joyHash: EXPECTED_JOY_HASH, ownerLibraryFiles: 3221 },
        {
          joyHash: EXPECTED_JOY_HASH,
          ownerLibraryFiles: 3220,
          runningProcesses: 0,
        },
      ),
    /owner library file count changed/u,
  );
});

test('refuses Electron versions other than 44.3.0', async (t) => {
  const run = fakeRun();
  t.after(() => rmSync(run.root, { recursive: true, force: true }));
  const fake = driverFor(run, { electronVersion: '45.0.0' });

  await assert.rejects(fake.driver.launch(), /Electron 44\.3\.0 is required/u);
  assert.equal(fake.launches(), 0);
  await fake.driver.close();
});
