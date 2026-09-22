'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { createServer } = require('node:net');
const { dirname, join, resolve } = require('node:path');

// build-worker-exe.ps1 replaces this literal with its -BuildMarker before the
// SEA blob is prepared, so two builds of the same source produce distinguishable
// packages. Keep the literal spelling: the substitution is textual.
const BUILD_MARKER = '__JOY_MEDIA_BUILD_MARKER__';

// The self-test answers before any environment check so that CI can verify a
// freshly built package that is not yet sitting next to a Worker runtime.
if (process.argv.includes('--joy-worker-self-test')) {
  process.stdout.write(
    JSON.stringify({ ok: true, executable: 'joy-worker.exe', buildMarker: BUILD_MARKER }) + '\n',
  );
  process.exit(0);
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate))
      return candidate;
  }
  return undefined;
}

const executableDirectory = dirname(process.execPath);
const workerRoot =
  process.env.JOY_MEDIA_WORKER_ROOT?.trim() || resolve(executableDirectory, '..', '..', '..');
const entryPoint =
  process.env.JOY_MEDIA_WORKER_ENTRYPOINT?.trim() ||
  join(workerRoot, 'apps', 'worker', 'dist', 'index.js');
const statePath =
  process.env.JOY_MEDIA_WORKER_STATE_PATH?.trim() ||
  join(
    process.env.USERPROFILE || process.env.HOME || workerRoot,
    '.joy-media',
    'worker-state.json',
  );
const apiUrl = process.env.JOY_MEDIA_API_URL?.trim() || 'https://joyst.ir/api';
const parsedApiUrl = new URL(apiUrl);
const localTestApi =
  process.env.JOY_MEDIA_WORKER_TEST_MODE === '1' &&
  parsedApiUrl.protocol === 'http:' &&
  ['127.0.0.1', 'localhost', '::1'].includes(parsedApiUrl.hostname);
if (parsedApiUrl.protocol !== 'https:' && !localTestApi)
  throw new Error('JOY_MEDIA_API_URL must use HTTPS');
if (!existsSync(entryPoint)) throw new Error(`Worker entrypoint not found: ${entryPoint}`);

const stateDirectory = dirname(statePath);
const pipeHash = createHash('sha256').update(workerRoot).digest('hex').slice(0, 16);
const singletonPipe =
  process.env.JOY_MEDIA_WORKER_PIPE?.trim() || `\\\\.\\pipe\\joy-media-worker-${pipeHash}`;
const singleton = createServer();

singleton.once('error', (error) => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    // A prior supervisor may still own the Worker after Task Scheduler stops
    // its wrapper. Treat that process as authoritative instead of spawning a
    // second lease/heartbeat loop.
    process.exit(0);
  }
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

singleton.listen(singletonPipe, () => {
  const logPath = join(stateDirectory, 'logs', 'worker.log');
  mkdirSync(dirname(logPath), { recursive: true });
  const nodePath =
    firstExisting([
      process.env.JOY_MEDIA_NODE_PATH?.trim(),
      join(process.env.LOCALAPPDATA || '', 'hermes', 'node', 'node.exe'),
      join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    ]) || 'node.exe';

  const child = spawn(nodePath, [entryPoint], {
    cwd: workerRoot,
    env: {
      ...process.env,
      JOY_MEDIA_API_URL: apiUrl,
      JOY_MEDIA_WORKER_STATE_PATH: statePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  // Windows does not reap this child when the launcher is force-terminated, so
  // publish the pair of PIDs. A supervisor (and the acceptance harness) can then
  // prove the whole Worker tree started and later stopped instead of leaving an
  // orphaned lease/heartbeat loop behind. Like the pairing hand-off this file
  // records only PIDs and the build marker, never the child environment or
  // argv, which is where the pairing secret lives.
  const childPidPath = process.env.JOY_MEDIA_WORKER_CHILD_PID_PATH?.trim();
  const childPidTemporaryPath = childPidPath ? `${childPidPath}.tmp` : undefined;

  const publishChildPid = () => {
    if (!childPidPath || !Number.isInteger(child.pid) || child.pid <= 0) return;
    try {
      mkdirSync(dirname(childPidPath), { recursive: true });
      // Write then rename so a reader polling this path never parses a
      // half-written record.
      const record = { launcherPid: process.pid, childPid: child.pid, buildMarker: BUILD_MARKER };
      writeFileSync(childPidTemporaryPath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      rmSync(childPidPath, { force: true });
      renameSync(childPidTemporaryPath, childPidPath);
    } catch (error) {
      // Missing evidence must not orphan the Worker: keep supervising the child
      // and record why the hand-off file is absent.
      const message = error instanceof Error ? error.message : String(error);
      log.write(`worker child pid hand-off failed: ${message}\n`);
      try {
        rmSync(childPidTemporaryPath, { force: true });
      } catch {
        // A stale temporary file is inert; the next start replaces it.
      }
    }
  };

  const clearChildPid = () => {
    if (!childPidPath) return;
    try {
      rmSync(childPidPath, { force: true });
      rmSync(childPidTemporaryPath, { force: true });
    } catch {
      // The child has already exited; a leftover file is corrected by the next
      // start rather than by failing shutdown here.
    }
  };

  publishChildPid();

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    clearChildPid();
    log.write(`${error.stack || error.message}\n`);
    log.end();
    singleton.close(() => process.exit(1));
  });
  child.on('close', (code) => {
    clearChildPid();
    log.end();
    singleton.close(() => process.exit(code === null ? 1 : code));
  });
});
