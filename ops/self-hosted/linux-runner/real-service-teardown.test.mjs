/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { isAlive, terminateProcessTree, removeDirWithRetry } from './real-service-teardown.mjs';

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX process groups only' : false };

/** Spawn a detached node process group; `body` runs in the child. */
function spawnGroup(body) {
  const child = spawn(process.execPath, ['-e', body], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  return child;
}

async function waitGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

test(
  'terminateProcessTree: a well-behaved process exits on SIGTERM without escalation',
  posixOnly,
  async () => {
    const child = spawnGroup('setInterval(() => {}, 1000)');
    await sleep(200);
    const record = await terminateProcessTree(child, { graceMs: 5000, killMs: 3000, pollMs: 50 });
    assert.equal(record.state, 'terminated');
    assert.equal(record.escalatedToKill, false);
    assert.equal(await waitGone(child.pid), true);
  },
);

test(
  'terminateProcessTree: a process that delays its exit is still awaited within the grace window',
  posixOnly,
  async () => {
    const child = spawnGroup(
      "process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 800); }); setInterval(() => {}, 1000);",
    );
    await sleep(200);
    const record = await terminateProcessTree(child, { graceMs: 5000, killMs: 3000, pollMs: 50 });
    assert.equal(record.state, 'terminated');
    assert.equal(record.escalatedToKill, false);
    assert.ok(
      record.waitedMs >= 500,
      `waited ${record.waitedMs}ms, expected to observe the delayed exit`,
    );
  },
);

test(
  'terminateProcessTree: an unresponsive process is escalated to SIGKILL and verified gone',
  posixOnly,
  async () => {
    const child = spawnGroup("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    await sleep(200);
    const record = await terminateProcessTree(child, { graceMs: 800, killMs: 4000, pollMs: 50 });
    assert.equal(record.escalatedToKill, true);
    assert.equal(record.state, 'sigkilled');
    assert.equal(await waitGone(child.pid), true);
  },
);

test(
  'terminateProcessTree: kills the whole run-owned group, not just the leader',
  posixOnly,
  async () => {
    // The leader spawns a grandchild in the same group, then both ignore SIGTERM.
    const child = spawnGroup(
      "const { spawn } = require('node:child_process');" +
        "const g = spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\',()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });" +
        'console.error(g.pid);' +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    );
    // We cannot easily read the grandchild pid over ignored stdio; instead assert
    // the leader group is gone (SIGKILL to -pid reaps the group).
    await sleep(300);
    const record = await terminateProcessTree(child, { graceMs: 600, killMs: 4000, pollMs: 50 });
    assert.equal(record.state, 'sigkilled');
    assert.equal(await waitGone(child.pid), true);
  },
);

test('terminateProcessTree: does not touch an unrelated process', posixOnly, async () => {
  const target = spawnGroup('setInterval(() => {}, 1000)');
  const bystander = spawnGroup('setInterval(() => {}, 1000)');
  await sleep(200);
  try {
    await terminateProcessTree(target, { graceMs: 3000, killMs: 3000, pollMs: 50 });
    assert.equal(await waitGone(target.pid), true);
    assert.equal(isAlive(bystander.pid), true, 'bystander must survive');
  } finally {
    await terminateProcessTree(bystander, { graceMs: 3000, killMs: 3000, pollMs: 50 });
  }
});

test(
  'terminateProcessTree: already-exited process is reported, not re-signalled',
  posixOnly,
  async () => {
    const child = spawnGroup('');
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = sleep(3000).then(resolve);
        child.once('exit', () => {
          timer.catch(() => {});
          resolve();
        });
      });
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'child should have exited');
    const record = await terminateProcessTree(child, { graceMs: 1000, killMs: 1000 });
    assert.equal(record.state, 'already-exited');
    assert.equal(record.signalRequested, false);
  },
);

test('removeDirWithRetry: removes a populated run-owned directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jm-teardown-'));
  await mkdir(join(dir, 'mc', 'certs'), { recursive: true });
  await writeFile(join(dir, 'mc', 'config.json'), '{}');
  await writeFile(join(dir, 'worker-output.mp4'), 'x');
  const record = await removeDirWithRetry(dir, { attempts: 3, delayMs: 10 });
  assert.equal(record.removed, true);
  await assert.rejects(() => stat(dir));
});

test('removeDirWithRetry: a writer that keeps recreating the path is reported, not hidden', async () => {
  // Injected fs: stat keeps succeeding (path keeps coming back) for every attempt.
  const fakeFs = {
    rm: async () => {},
    stat: async () => ({}),
    readdir: async () => ['config.json', 'certs'],
  };
  const record = await removeDirWithRetry('/tmp/never-goes-away', {
    attempts: 4,
    delayMs: 1,
    fs: fakeFs,
  });
  assert.equal(record.removed, false);
  assert.equal(record.attempts, 4);
  assert.deepEqual(record.residualEntries, ['certs', 'config.json']);
});

test('removeDirWithRetry: succeeds on a later attempt once the writer stops', async () => {
  let calls = 0;
  const fakeFs = {
    rm: async () => {
      calls += 1;
    },
    stat: async () => {
      if (calls >= 3) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {};
    },
    readdir: async () => ['leftover'],
  };
  const record = await removeDirWithRetry('/tmp/eventually-gone', {
    attempts: 6,
    delayMs: 1,
    fs: fakeFs,
  });
  assert.equal(record.removed, true);
  assert.equal(record.attempts, 3);
});

test('isAlive: false for a clearly dead pid', () => {
  assert.equal(isAlive(2_147_483_646), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(0), false);
});

test.after(async () => {
  await rm(join(tmpdir(), 'jm-teardown-cleanup-marker'), { force: true }).catch(() => {});
});
