import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildLaunchEnvironment,
  createLiveDriver,
  EXPECTED_JOY_HASH,
  verifyAfterRun,
} from './driver.mjs';
import * as liveDriver from './driver.mjs';

test('the expected joy protocol hash is the owner baseline', () => {
  assert.equal(
    EXPECTED_JOY_HASH,
    'AF05BE55222C86FECE27E738B7E8A931CB4261C9797261C67DDE3C71A4E5CAC0',
  );
});

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
        ownerHome: run.root,
        installedDir: join(run.root, 'installed'),
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

test('defines a drop target for the timeline, monitor, and media panel', () => {
  assert.deepEqual(liveDriver.OS_FILE_DROP_SELECTORS, {
    timeline: '.timeline-lane, .timeline-empty-state, .timeline-file-new-track-drop',
    monitor: '.monitor-canvas-wrap',
    media: '.asset-library-main',
  });
});

const REAL_LOCAL_APP_DATA = join('C:', 'Users', 'Tester', 'AppData', 'Local');
const SCRATCH_ROOT = join('C:', 'jgp', 'v111', 'codex', 'profiles', 'env-run', 'environment');
const ELECTRON_DIR = join('C:', 'jgp', 'electron-44.3.0');
const SCRATCH_KEYS = ['USERPROFILE', 'HOME', 'APPDATA', 'TEMP', 'TMP'];

function baseEnvironment() {
  return {
    PATH: 'C:\\Windows\\System32',
    USERPROFILE: join('C:', 'Users', 'Tester'),
    APPDATA: join('C:', 'Users', 'Tester', 'AppData', 'Roaming'),
    TEMP: join('C:', 'Users', 'Tester', 'AppData', 'Local', 'Temp'),
    LOCALAPPDATA: REAL_LOCAL_APP_DATA,
  };
}

test('scratch mode: every folder, LOCALAPPDATA included, is under the run environment', () => {
  const base = baseEnvironment();
  const launch = buildLaunchEnvironment({
    baseEnv: base,
    envRoot: SCRATCH_ROOT,
    needsSignIn: false,
    electronDir: ELECTRON_DIR,
  });

  assert.equal(launch.mode, 'scratch');
  assert.match(launch.modeLine, /^mode: scratch/u);
  for (const key of [...SCRATCH_KEYS, 'LOCALAPPDATA']) {
    assert.ok(launch.env[key].startsWith(SCRATCH_ROOT), `${key} must be scratch`);
    assert.notEqual(launch.env[key], base.LOCALAPPDATA);
  }
  assert.equal(launch.env.LOCALAPPDATA, join(SCRATCH_ROOT, 'Local'));
  assert.ok(launch.scratchDirs.includes(join(SCRATCH_ROOT, 'Local')));
  assert.equal(launch.env.ELECTRON_OVERRIDE_DIST_PATH, ELECTRON_DIR);
  assert.equal(launch.env.PATH, base.PATH);
});

test('sign-in mode: LOCALAPPDATA is the real one and every other folder is scratch', () => {
  const base = baseEnvironment();
  const launch = buildLaunchEnvironment({
    baseEnv: base,
    envRoot: SCRATCH_ROOT,
    needsSignIn: true,
    electronDir: ELECTRON_DIR,
  });

  assert.equal(launch.mode, 'sign-in');
  assert.match(launch.modeLine, /^mode: sign-in/u);
  assert.match(launch.modeLine, /LOCALAPPDATA is the real one/u);
  assert.equal(launch.env.LOCALAPPDATA, REAL_LOCAL_APP_DATA);
  for (const key of SCRATCH_KEYS) {
    assert.ok(launch.env[key].startsWith(SCRATCH_ROOT), `${key} must stay scratch`);
  }
  assert.equal(launch.env.ELECTRON_OVERRIDE_DIST_PATH, ELECTRON_DIR);
  assert.equal(launch.env.PATH, base.PATH);
});

test('sign-in mode creates only scratch folders, never the real LOCALAPPDATA', () => {
  const launch = buildLaunchEnvironment({
    baseEnv: baseEnvironment(),
    envRoot: SCRATCH_ROOT,
    needsSignIn: true,
    electronDir: ELECTRON_DIR,
  });

  assert.deepEqual(launch.scratchDirs, [
    join(SCRATCH_ROOT, 'User'),
    join(SCRATCH_ROOT, 'Roaming'),
    join(SCRATCH_ROOT, 'Temp'),
  ]);
  assert.ok(!launch.scratchDirs.includes(REAL_LOCAL_APP_DATA));
});

test('scratch mode creates the scratch LOCALAPPDATA folder with the others', () => {
  const launch = buildLaunchEnvironment({
    baseEnv: baseEnvironment(),
    envRoot: SCRATCH_ROOT,
    needsSignIn: false,
    electronDir: ELECTRON_DIR,
  });

  assert.equal(launch.scratchDirs.length, 4);
  assert.ok(launch.scratchDirs.includes(join(SCRATCH_ROOT, 'Local')));
});

test('sign-in mode refuses when no real LOCALAPPDATA is set', () => {
  const base = baseEnvironment();
  delete base.LOCALAPPDATA;

  assert.throws(
    () =>
      buildLaunchEnvironment({
        baseEnv: base,
        envRoot: SCRATCH_ROOT,
        needsSignIn: true,
        electronDir: ELECTRON_DIR,
      }),
    /--needs-sign-in needs the real LOCALAPPDATA/u,
  );
});

test('building the environment does not change the base environment', () => {
  const base = baseEnvironment();
  const before = { ...base };
  buildLaunchEnvironment({
    baseEnv: base,
    envRoot: SCRATCH_ROOT,
    needsSignIn: true,
    electronDir: ELECTRON_DIR,
  });

  assert.deepEqual(base, before);
});

test('dispatches trusted CDP file-drop events with real scratch file paths', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'live-drop-driver-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'fixture.png');
  writeFileSync(file, 'image fixture');
  const calls = [];
  const session = {
    async send(method, params) {
      calls.push({ method, params });
    },
    async detach() {
      calls.push({ method: 'detach' });
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, liveDriver.OS_FILE_DROP_SELECTORS.monitor);
      const locator = { boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 80 }) };
      return { ...locator, first: () => locator };
    },
    context() {
      return { newCDPSession: async () => session };
    },
  };

  await liveDriver.dispatchOSFileDrop?.(page, 'monitor', [file], { allowedRoot: root });

  assert.deepEqual(
    calls
      .filter((call) => call.method === 'Input.dispatchDragEvent')
      .map((call) => call.params.type),
    ['dragEnter', 'dragOver', 'drop'],
  );
  assert.deepEqual(calls.find((call) => call.params?.type === 'drop')?.params.data.files, [file]);
  assert.equal(calls.at(-1)?.method, 'detach');
});
