import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLEANUP_BUDGET_MS,
  SMOKE_MARKER_FILE,
  SMOKE_NONCE_ENVIRONMENT,
  SMOKE_PROFILE_PREFIX,
  SMOKE_SUPERVISED_ENVIRONMENT,
  checkOwnedProfile,
  isStillRunning,
  ownedProcesses,
  parsePosixProcessTable,
  parseSupervisorArguments,
  parseWindowsProcessTable,
  removeWithRetries,
  superviseSmoke,
} from './smoke-supervisor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nonce = '0123456789abcdef0123456789abcdef';
const tempRoot = resolve('joy-smoke-test-temp');
const root = join(tempRoot, `${SMOKE_PROFILE_PREFIX}${nonce}`);
const marker = JSON.stringify({ nonce });

/** A clock that only moves when something sleeps, so retry budgets are exact and the tests take no real time. */
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

test('a folder whose files are released late is removed once the lock clears', async () => {
  const clock = fakeClock();
  const present = new Set([root]);
  let failures = 3;
  const result = await removeWithRetries({
    root,
    remove: () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('EPERM, Permission denied');
      }
      present.delete(root);
    },
    exists: (path) => present.has(path),
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.removed, true);
  assert.equal(result.attempts, 4, 'three failed attempts, then the one that succeeds');
});

test('a folder that stays locked past the budget fails the cleanup and names the last error', async () => {
  const clock = fakeClock();
  const result = await removeWithRetries({
    root,
    remove: () => {
      throw new Error('EPERM, Permission denied');
    },
    exists: () => true,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(result.removed, false);
  assert.ok(result.attempts > 1, 'the cleanup retries before it gives up');
  assert.ok(result.elapsedMs >= CLEANUP_BUDGET_MS, 'the budget is spent before it gives up');
  assert.match(result.reason, /EPERM/u);
});

test('a folder that can be removed at once is removed on the first attempt', async () => {
  const clock = fakeClock();
  const present = new Set([root]);
  const result = await removeWithRetries({
    root,
    remove: () => present.delete(root),
    exists: (path) => present.has(path),
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.deepEqual(result, { removed: true, attempts: 1, elapsedMs: 0 });
});

test("refuses to delete anything that is not this run's profile", () => {
  assert.deepEqual(checkOwnedProfile({ root, tempRoot, nonce, markerText: marker }), { ok: true });
  assert.equal(
    checkOwnedProfile({ root: join(tempRoot, 'other-folder'), tempRoot, nonce, markerText: marker })
      .ok,
    false,
    'the wrong name',
  );
  assert.equal(
    checkOwnedProfile({
      root: join(tempRoot, 'nested', `${SMOKE_PROFILE_PREFIX}${nonce}`),
      tempRoot,
      nonce,
      markerText: marker,
    }).ok,
    false,
    'not directly under the temp folder',
  );
  assert.equal(
    checkOwnedProfile({ root, tempRoot, nonce, markerText: null }).ok,
    false,
    'no marker',
  );
  assert.equal(
    checkOwnedProfile({
      root,
      tempRoot,
      nonce,
      markerText: JSON.stringify({ nonce: 'f'.repeat(32) }),
    }).ok,
    false,
    'a marker from another run',
  );
  assert.equal(
    checkOwnedProfile({ root, tempRoot, nonce: 'not-a-nonce', markerText: marker }).ok,
    false,
    'a malformed nonce',
  );
});

test("owned processes are the app's children and their children, not unrelated system processes", () => {
  const table = [
    { pid: 100, parentPid: 1, startedAt: 'a', name: 'explorer.exe', commandLine: '' },
    { pid: 200, parentPid: 300, startedAt: 'b', name: 'joy-media.exe', commandLine: '' },
    {
      pid: 201,
      parentPid: 200,
      startedAt: 'c',
      name: 'joy-media.exe',
      commandLine: '--type=gpu-process',
    },
    { pid: 202, parentPid: 201, startedAt: 'd', name: 'helper.exe', commandLine: '' },
    { pid: 500, parentPid: 1, startedAt: 'e', name: 'TiWorker.exe', commandLine: '-Embedding' },
  ];
  assert.deepEqual(
    ownedProcesses(table, 200).map((row) => row.pid),
    [201, 202],
  );
});

test('a reused process id is not taken for the process that held it before', () => {
  const record = { pid: 201, startedAt: 'c' };
  assert.equal(isStillRunning([{ pid: 201, startedAt: 'c' }], record), true);
  assert.equal(isStillRunning([{ pid: 201, startedAt: 'reused' }], record), false);
  assert.equal(isStillRunning([], record), false);
});

test('parses the Windows and POSIX process tables', () => {
  assert.deepEqual(
    parseWindowsProcessTable(
      '{"ProcessId":5,"ParentProcessId":4,"Name":"a.exe","CreationDate":"/Date(1)/","CommandLine":null}',
    ),
    [{ pid: 5, parentPid: 4, startedAt: '/Date(1)/', name: 'a.exe', commandLine: '' }],
  );
  assert.deepEqual(parseWindowsProcessTable(''), []);
  assert.deepEqual(
    parsePosixProcessTable('  101   1 Mon Oct 26 01:02:03 2026 /usr/bin/joy --type=gpu\n'),
    [
      {
        pid: 101,
        parentPid: 1,
        startedAt: 'Mon Oct 26 01:02:03 2026',
        name: '/usr/bin/joy',
        commandLine: '/usr/bin/joy --type=gpu',
      },
    ],
  );
});

test('reads the supervisor arguments, with the app arguments after the separator', () => {
  assert.deepEqual(parseSupervisorArguments(['--exe', 'app.exe', '--', '--smoke', '--x=1']), {
    executable: resolve('app.exe'),
    cwd: resolve('.'),
    args: ['--smoke', '--x=1'],
  });
  assert.throws(() => parseSupervisorArguments(['--smoke']), /usage/u);
});

/**
 * A host for superviseSmoke: the app exits with `exitCode`, the listed children end after the given number of process
 * table reads (Infinity for never), an unrelated system process is always listed, and deletion fails `removeFailures`
 * times before it succeeds.
 */
function fakeHost({ exitCode = 0, children = [], removeFailures = 0, unkillable = [] } = {}) {
  const clock = fakeClock();
  const state = {
    reads: 0,
    killed: [],
    removeCalls: 0,
    present: true,
    failuresLeft: removeFailures,
  };
  const ended = new Set();
  const unrelated = {
    pid: 500,
    parentPid: 1,
    startedAt: 'u',
    name: 'TiWorker.exe',
    commandLine: '-Embedding',
  };
  const io = {
    runApp: async () => ({ pid: 200, exitCode, stdout: 'app output\n', stderr: '' }),
    readTable: () => {
      state.reads += 1;
      const live = children
        .filter((child) => !ended.has(child.pid) && state.reads <= child.endsAfterReads)
        .map(({ pid, parentPid, startedAt, name, commandLine }) => ({
          pid,
          parentPid,
          startedAt,
          name,
          commandLine,
        }));
      return [unrelated, ...live];
    },
    kill: (pid) => {
      if (unkillable.includes(pid)) throw new Error('Access is denied');
      state.killed.push(pid);
      ended.add(pid);
    },
    remove: () => {
      state.removeCalls += 1;
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1;
        throw new Error('EPERM, Permission denied');
      }
      state.present = false;
    },
    exists: () => state.present,
    readText: () => marker,
    sleep: clock.sleep,
    now: clock.now,
  };
  return { io, state };
}

const gpuChild = (endsAfterReads) => ({
  pid: 201,
  parentPid: 200,
  startedAt: 'c',
  name: 'joy-media.exe',
  commandLine: '--type=gpu-process',
  endsAfterReads,
});

const run = (io) =>
  superviseSmoke({ executable: 'app.exe', args: ['--smoke'], tempRoot, nonce, io });

test('a clean run removes its profile and passes', async () => {
  const { io, state } = fakeHost();
  const result = await run(io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.profile.removed, true);
  assert.deepEqual(result.summary.ownedProcesses, []);
  assert.deepEqual(state.killed, []);
  assert.equal(result.stdout, 'app output\n');
});

test('a child that ends on its own is waited for, not stopped', async () => {
  const { io, state } = fakeHost({ children: [gpuChild(3)] });
  const result = await run(io);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(state.killed, [], 'the child ended by itself');
  assert.deepEqual(result.summary.stoppedProcesses, []);
});

test('a child that never ends is stopped by its id, and the unrelated system process is left alone', async () => {
  const { io, state } = fakeHost({ children: [gpuChild(Infinity)] });
  const result = await run(io);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(state.killed, [201]);
  assert.deepEqual(result.summary.survivingProcesses, []);
  assert.ok(!state.killed.includes(500), 'a process that is not the app child is never stopped');
});

test('a child that cannot be stopped is reported as surviving', async () => {
  const { io } = fakeHost({ children: [gpuChild(Infinity)], unkillable: [201] });
  const result = await run(io);
  assert.equal(result.summary.survivingProcesses.length, 1);
  assert.equal(result.summary.survivingProcesses[0].pid, 201);
});

test('a folder that stays locked fails the run with exit code 2 and names the error', async () => {
  const { io } = fakeHost({ removeFailures: Infinity });
  const result = await run(io);
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary.profile.removed, false);
  assert.match(result.summary.profile.reason, /EPERM/u);
});

test('a folder released after a delay passes the run', async () => {
  const { io, state } = fakeHost({ removeFailures: 5, children: [gpuChild(2)] });
  const result = await run(io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.profile.removed, true);
  assert.equal(state.removeCalls, 6);
});

test('an app that fails keeps its own exit code, and its profile is still removed', async () => {
  const { io } = fakeHost({ exitCode: 1 });
  const result = await run(io);
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.profile.removed, true);
});

test('the app receives the chosen nonce and the supervised flag', async () => {
  let seen;
  const { io } = fakeHost();
  const capture = {
    ...io,
    runApp: async (options) => {
      seen = options.env;
      return { pid: 200, exitCode: 0, stdout: '', stderr: '' };
    },
  };
  await run(capture);
  assert.equal(seen[SMOKE_NONCE_ENVIRONMENT], nonce);
  assert.equal(seen[SMOKE_SUPERVISED_ENVIRONMENT], '1');
});

test('the names the supervisor relies on match the app smoke isolation module', () => {
  const source = readFileSync(join(here, '..', 'src', 'main', 'smoke-isolation.ts'), 'utf8');
  for (const literal of [
    `'${SMOKE_PROFILE_PREFIX}'`,
    `'${SMOKE_MARKER_FILE}'`,
    `'${SMOKE_NONCE_ENVIRONMENT}'`,
    `'${SMOKE_SUPERVISED_ENVIRONMENT}'`,
    '/^[0-9a-f]{32}$/',
  ]) {
    assert.ok(source.includes(literal), `smoke-isolation.ts must contain ${literal}`);
  }
});
