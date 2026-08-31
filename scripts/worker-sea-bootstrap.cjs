'use strict';

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync } = require('node:fs');
const { createServer } = require('node:net');
const { dirname, join, resolve } = require('node:path');

if (process.argv.includes('--joy-worker-self-test')) {
  process.stdout.write(JSON.stringify({ ok: true, executable: 'joy-worker.exe' }) + '\n');
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

  const stop = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', (error) => {
    log.write(`${error.stack || error.message}\n`);
    log.end();
    singleton.close(() => process.exit(1));
  });
  child.on('close', (code) => {
    log.end();
    singleton.close(() => process.exit(code === null ? 1 : code));
  });
});
