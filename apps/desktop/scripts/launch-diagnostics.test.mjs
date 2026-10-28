// Launch test for the default packaged build (plan section 10d, G0 item 2). A default packaged launch with the diagnostics switch
// must write no diagnostic file under its user-data folder. The live check needs the default packaged joy-media.exe, so it runs
// only when JOY_MEDIA_DEFAULT_LAUNCH_EXE names that file, and only on a disposable host (Windows Sandbox, a Hyper-V guest or a CI
// container). A default launch registers the joy:// protocol and creates ~/joy-media-assets, which would change any other host.
// Without the variable, the live check is skipped; on any other host it fails. The checker and the launch plumbing always run,
// against a stand-in program. A crash reporter leaves no file to look for, so this test does not check for one. The static
// exclusion test checks that the default staged build contains no crashReporter string.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assertDisposableHost } from '../../../tests/desktop/disposable-host.mjs';

/** The switch that enables diagnostics in the instrumented build. The default build must ignore it. */
export const DIAGNOSTICS_SWITCH = '--joy-media-gpu-diagnostics';

/** File names only the instrumented build writes. The default build must write none of them. */
export const DIAGNOSTIC_FILE_NAMES = [
  'gpu-diagnostics.jsonl',
  'gpu-events.jsonl',
  'gpu-events.1.jsonl',
];

/** The diagnostic files under a user-data folder, as paths relative to it. */
export function findDiagnosticFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (DIAGNOSTIC_FILE_NAMES.includes(entry.name))
        found.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  walk(root);
  return found.sort();
}

// How long a stopped program may take to exit before the test fails, rather than waiting forever.
const STOP_TIMEOUT_MILLISECONDS = 15000;

/** Resolves to `value` after the given time. The timer does not keep the test process alive. */
function delay(milliseconds, value) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), milliseconds).unref();
  });
}

// The packaged app has child processes (GPU, renderer), so on Windows the whole tree is stopped with taskkill /T. Elsewhere only
// the direct child is stopped. The live check runs only on Windows (assertDisposableHost refuses elsewhere), and the stand-in has
// no children, so nothing else needs stopping there.
function stopTree(child) {
  if (process.platform === 'win32') {
    // Bounded, so a stuck taskkill cannot block the event loop and stop the timer that ends the wait.
    const { status } = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: STOP_TIMEOUT_MILLISECONDS,
    });
    if (status === 0) return;
  }
  child.kill('SIGKILL');
}

/**
 * Starts a program with the diagnostics switch and a private user-data folder, waits, stops it (on Windows, its whole process
 * tree), and reports whether it was still running and which diagnostic files it left behind.
 */
export async function launchAndCheck({
  exe,
  prefixArgs = [],
  userDataDir,
  waitMilliseconds,
  env = process.env,
}) {
  await mkdir(userDataDir, { recursive: true });
  const child = spawn(exe, [...prefixArgs, DIAGNOSTICS_SWITCH, `--user-data-dir=${userDataDir}`], {
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    // An error without a process id is a failed spawn. A failed kill also raises an error, but the process is still there,
    // so only the wait for its exit decides that case.
    child.on('error', (error) => {
      if (child.pid === undefined) resolve({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
  const early = await Promise.race([exited, delay(waitMilliseconds, null)]);
  const stillRunning = early === null;
  if (stillRunning) stopTree(child);
  const finished = await Promise.race([exited, delay(STOP_TIMEOUT_MILLISECONDS, null)]);
  if (finished === null) {
    // Stopped once more, so a program that survived the first stop is not left running before the test fails.
    stopTree(child);
    throw new Error(
      `the program did not exit within ${STOP_TIMEOUT_MILLISECONDS / 1000} seconds of being stopped`,
    );
  }
  return {
    stillRunning,
    exitCode: stillRunning ? null : (finished.code ?? finished.signal ?? finished.error?.message),
    diagnosticFiles: findDiagnosticFiles(userDataDir),
  };
}

// Windows can hold a file for a moment after its process is killed, so the scratch folder is removed with retries.
function removeScratch(root) {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function scratchFolder() {
  const root = await mkdtemp(join(tmpdir(), 'joy-launch-test-'));
  return { root, userDataDir: join(root, 'user-data') };
}

const standIn = fileURLToPath(new URL('./launch-diagnostics-stub.mjs', import.meta.url));

test('the checker reports nothing for an empty user-data folder', async () => {
  const { root } = await scratchFolder();
  try {
    assert.deepEqual(findDiagnosticFiles(root), []);
  } finally {
    await removeScratch(root);
  }
});

test('the checker names a diagnostic file wherever it sits under the folder', async () => {
  const { root } = await scratchFolder();
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'gpu-diagnostics.jsonl'), '{}\n', 'utf8');
    await writeFile(join(root, 'unrelated.json'), '{}\n', 'utf8');
    assert.deepEqual(findDiagnosticFiles(root), ['nested/gpu-diagnostics.jsonl']);
  } finally {
    await removeScratch(root);
  }
});

test('a stand-in program that writes nothing passes the launch check', async () => {
  const { root, userDataDir } = await scratchFolder();
  try {
    const result = await launchAndCheck({
      exe: process.execPath,
      prefixArgs: [standIn],
      userDataDir,
      waitMilliseconds: 1500,
    });
    assert.equal(result.stillRunning, true);
    assert.deepEqual(result.diagnosticFiles, []);
  } finally {
    await removeScratch(root);
  }
});

test('a stand-in program that writes a diagnostic file is reported by the check', async () => {
  const { root, userDataDir } = await scratchFolder();
  try {
    const result = await launchAndCheck({
      exe: process.execPath,
      prefixArgs: [standIn],
      userDataDir,
      waitMilliseconds: 1500,
      env: { ...process.env, STUB_WRITE_DIAGNOSTICS: '1' },
    });
    assert.deepEqual(result.diagnosticFiles, ['gpu-diagnostics.jsonl']);
  } finally {
    await removeScratch(root);
  }
});

test(
  'the default packaged build, launched with the diagnostics switch, writes no diagnostic file',
  {
    skip: process.env.JOY_MEDIA_DEFAULT_LAUNCH_EXE
      ? false
      : 'set JOY_MEDIA_DEFAULT_LAUNCH_EXE to the default packaged joy-media.exe, on a disposable host (Windows Sandbox, a Hyper-V guest or a CI container)',
  },
  async () => {
    try {
      assertDisposableHost();
    } catch (error) {
      throw new Error(
        `the live launch check changes the host, so it needs a disposable one. ${error.message}`,
      );
    }
    const { root, userDataDir } = await scratchFolder();
    try {
      const result = await launchAndCheck({
        exe: process.env.JOY_MEDIA_DEFAULT_LAUNCH_EXE,
        userDataDir,
        waitMilliseconds: 20000,
      });
      assert.equal(
        result.stillRunning,
        true,
        `the default build exited early (code ${result.exitCode})`,
      );
      assert.deepEqual(result.diagnosticFiles, [], 'the default build wrote diagnostic files');
    } finally {
      await removeScratch(root);
    }
  },
);
