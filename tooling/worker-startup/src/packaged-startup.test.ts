import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * End-to-end checks of the packaged Worker (joy-worker.exe). A loopback server stands in for the desktop
 * app's local job API. It answers only requests that carry the per-run token, the same routes the
 * desktop serves. The tests need a built executable (`pnpm worker:exe`) and run only on Windows.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const executable =
  process.env.JOY_MEDIA_PACKAGED_WORKER ??
  join(repoRoot, 'apps', 'worker', 'bin', 'joy-worker.exe');
const TOKEN = 'packaged-test-token';
const available = process.platform === 'win32' && existsSync(executable);

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
}

interface FakeLocalJobApi {
  readonly server: Server;
  readonly url: string;
  readonly seen: SeenRequest[];
  readonly capabilities: string[][];
}

/** The environment a packaged run receives: nothing inherited from the JOY Media configuration. */
function baseEnvironment(stateDir: string, pipe: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('JOY_MEDIA_')) env[name] = value;
  }
  return {
    ...env,
    JOY_MEDIA_WORKER_STATE_PATH: join(stateDir, 'worker-state.json'),
    JOY_MEDIA_WORKER_PIPE: pipe,
    JOY_MEDIA_WORKER_ROOT: repoRoot,
    JOY_MEDIA_NODE_PATH: process.execPath,
    JOY_MEDIA_WORKER_CHILD_PID_PATH: join(stateDir, 'child.pid'),
  };
}

/** A loopback job API that accepts only the per-run token and answers with no job queued. */
function startLocalJobApi(): Promise<FakeLocalJobApi> {
  const seen: SeenRequest[] = [];
  const capabilities: string[][] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const path = request.url ?? '';
    const headers = { 'content-type': 'application/json' };
    seen.push({ method: request.method ?? '', path, authorization: request.headers.authorization });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      request.resume();
      response.writeHead(401, headers);
      response.end('{"error":{"code":"UNAUTHORIZED"}}');
      return;
    }
    if (request.method === 'POST' && /^\/v1\/workers\/[^/]+\/hello$/.test(path)) {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { capabilities?: string[] };
        capabilities.push(parsed.capabilities ?? []);
        response.writeHead(200, headers);
        response.end('{"data":null}');
      });
      return;
    }
    request.resume();
    if (request.method === 'POST' && /^\/v1\/workers\/[^/]+\/(leases|preview\/next)$/.test(path)) {
      response.writeHead(200, headers);
      response.end('{"data":null}');
      return;
    }
    response.writeHead(404, headers);
    response.end('{"error":{"code":"NOT_FOUND"}}');
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolveStart({ server, url: `http://127.0.0.1:${address.port}`, seen, capabilities });
    });
  });
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the packaged Worker');
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
}

/** Ends the launcher and its Worker child. On Windows the child is removed with its tree. */
function stopTree(child: ChildProcess): void {
  if (child.pid !== undefined) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
}

describe.skipIf(!available)('packaged Worker startup', () => {
  it('starts under a loopback job API, announces its capabilities, and polls with the per-run token only', async () => {
    const api = await startLocalJobApi();
    const stateDir = mkdtempSync(join(tmpdir(), 'joy-packaged-worker-'));
    const pipe = `\\\\.\\pipe\\joy-media-worker-test-${process.pid}-${Date.now()}`;
    const child = spawn(executable, [], {
      env: {
        ...baseEnvironment(stateDir, pipe),
        JOY_MEDIA_API_URL: api.url,
        JOY_MEDIA_WORKER_LOCAL_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    try {
      await waitUntil(
        () =>
          api.capabilities.length >= 1 &&
          api.seen.filter((request) => request.path.endsWith('/leases')).length >= 2,
        90_000,
      );

      const leases = api.seen.filter((request) => request.path.endsWith('/leases'));
      expect(leases.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(api.seen.some((request) => /pair|joyst/i.test(request.path))).toBe(false);

      const advertised = api.capabilities[0] ?? [];
      expect(advertised).toContain('text.lm-studio');
      expect(advertised.some((name) => name.startsWith('video.') || name.startsWith('edit.'))).toBe(
        false,
      );

      const log = readFileSync(join(stateDir, 'logs', 'worker.log'), 'utf8');
      expect(log).toContain('"workerId"');
      const state = JSON.parse(readFileSync(join(stateDir, 'worker-state.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(state.identity).toEqual(expect.objectContaining({ workerId: expect.any(String) }));
      expect(state).not.toHaveProperty('sessionToken');
      expect(state).not.toHaveProperty('pendingPairing');
    } finally {
      stopTree(child);
      api.server.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['https://joyst.ir/api', 'http://192.168.1.20:4174', 'http://localhost:4174'])(
    'refuses %s before the Worker starts, and creates no state',
    (remoteUrl) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'joy-packaged-worker-refuse-'));
      try {
        const result = spawnSync(executable, [], {
          env: {
            ...baseEnvironment(stateDir, `\\\\.\\pipe\\joy-media-worker-refuse-${process.pid}`),
            JOY_MEDIA_API_URL: remoteUrl,
            JOY_MEDIA_WORKER_LOCAL_TOKEN: TOKEN,
          },
          encoding: 'utf8',
          timeout: 60_000,
          windowsHide: true,
        });
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('remote addresses are refused');
        expect(readdirSync(stateDir)).toEqual([]);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it('names the missing loopback address instead of defaulting to a remote one', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'joy-packaged-worker-missing-'));
    try {
      const result = spawnSync(executable, [], {
        env: {
          ...baseEnvironment(stateDir, `\\\\.\\pipe\\joy-media-worker-missing-${process.pid}`),
        },
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('JOY_MEDIA_API_URL is required');
      expect(readdirSync(stateDir)).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
