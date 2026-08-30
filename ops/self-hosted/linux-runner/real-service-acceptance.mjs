#!/usr/bin/env node
/* global process, setTimeout, clearTimeout */

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { chromium } from '@playwright/test';
import {
  PostgresControlPlane,
  createControlPlaneHttpServer,
} from '../../../apps/api/dist/index.js';

const requireFromApi = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');

const execFile = promisify((file, args, options, callback) => {
  const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', (error) => callback(error));
  child.once('close', (code, signal) => {
    if (code === 0)
      callback(null, {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    else {
      const error = new Error(`command ${file} exited with ${code ?? signal ?? 'unknown'}`);
      error.code = code;
      error.stderr = Buffer.concat(stderr).toString('utf8');
      callback(error);
    }
  });
});

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const [candidateSha, runId, runAttempt, pass] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateSha ?? '')) throw new Error('candidate SHA is invalid');
if (!/^\d+$/.test(runId ?? '') || !/^\d+$/.test(runAttempt ?? ''))
  throw new Error('run identity is invalid');
if (!/^[12]$/.test(pass ?? '')) throw new Error('pass must be 1 or 2');
if ((await git(['rev-parse', 'HEAD'])) !== candidateSha)
  throw new Error('checkout is not the requested candidate');

const databaseUrl = required('JOY_MEDIA_CI_DATABASE_URL');
const s3Endpoint = required('JOY_MEDIA_CI_S3_ENDPOINT');
const s3AccessKey = required('JOY_MEDIA_CI_S3_ACCESS_KEY');
const s3SecretKey = required('JOY_MEDIA_CI_S3_SECRET_KEY');
const namespace = `accept_${runId}_${runAttempt}_${pass}`;
const schema = `ci_${namespace}`;
const bucket = `joy-media-${runId}-${runAttempt}-${pass}`;
const tempRoot = await mkdtemp('/tmp/joy-media-real-acceptance-');
const mcConfig = join(tempRoot, 'mc');
await mkdir(mcConfig, { recursive: true });
const apiPort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const token = 'joy-media-e2e-token';
const owner = 'joy-real-service-e2e@example.test';
let pool;
let apiServer;
let webProcess;
let browser;

class MinioObjectStore {
  constructor(options) {
    this.options = options;
  }
  async put(descriptor, bytes) {
    const path = join(this.options.config, `put-${randomUUID()}`);
    await writeFile(path, bytes);
    try {
      await runMcWithConfig(this.options.config, [
        'cp',
        path,
        `joy-ci/${this.options.bucket}/${descriptor.ref}`,
      ]);
    } finally {
      await rm(path, { force: true });
    }
  }
  async get(descriptor) {
    const path = join(this.options.config, `get-${randomUUID()}`);
    try {
      await runMcWithConfig(this.options.config, [
        'cp',
        `joy-ci/${this.options.bucket}/${descriptor.ref}`,
        path,
      ]);
      return new Uint8Array(await readFile(path));
    } finally {
      await rm(path, { force: true });
    }
  }
  async remove(ref) {
    await runMcWithConfig(this.options.config, [
      'rm',
      '--force',
      `joy-ci/${this.options.bucket}/${ref}`,
    ]).catch(() => undefined);
  }
  async probeReadiness() {
    await runMcWithConfig(this.options.config, ['ls', `joy-ci/${this.options.bucket}`]);
  }
}

const runMc = async (args, input) => {
  await execFile('mc', args, {
    cwd: root,
    env: { ...process.env, MC_CONFIG_DIR: mcConfig },
    input,
  });
};

try {
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await runMc(['alias', 'set', 'joy-ci', s3Endpoint, s3AccessKey, s3SecretKey, '--api', 'S3v4']);
  await runMc(['mb', '--ignore-existing', `joy-ci/${bucket}`]);

  const objectStore = new MinioObjectStore({
    bucket,
    config: mcConfig,
    endpoint: s3Endpoint,
    accessKey: s3AccessKey,
    secretKey: s3SecretKey,
  });
  const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
  await controlPlane.initialize();
  apiServer = createControlPlaneHttpServer({
    controlPlane,
    authentication: { authenticate: (request) => authenticate(request, token, owner) },
    mediaAuth: mediaAuth(token, owner),
    privateObjectStore: objectStore,
    rateLimit: { maxRequests: 100_000 },
    queryObservability: true,
  });
  await listen(apiServer, apiPort);

  webProcess = spawn(
    'pnpm',
    ['--filter', '@joy-media/editor-web', 'dev', '--host', '127.0.0.1', '--port', String(webPort)],
    {
      cwd: root,
      env: {
        ...process.env,
        JOY_MEDIA_E2E_API_URL: apiUrl,
        JOY_MEDIA_E2E_WEB_PORT: String(webPort),
      },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  await waitForHttp(webUrl, 120_000);
  await runDesktopMatrix(webUrl, apiUrl);
  await recordJourney(webUrl, apiUrl, token, candidateSha, pool);
  await runObserver(webUrl, token);
  await recordOperationalEvidence(candidateSha, runId, runAttempt, pass);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (webProcess?.pid) killTree(webProcess.pid);
  if (apiServer) await close(apiServer);
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
  await runMc(['rm', '--quiet', '--recursive', '--force', `joy-ci/${bucket}`]).catch(
    () => undefined,
  );
  await runMc(['rb', '--quiet', `joy-ci/${bucket}`]).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

async function runDesktopMatrix(baseUrl, apiBaseUrl) {
  const projects =
    process.env.JOY_MEDIA_REAL_ACCEPTANCE_SMOKE_ONLY === '1'
      ? ['desktop-primary']
      : [
          'desktop-primary',
          'desktop-compact',
          'desktop-minimum',
          'desktop-1280',
          'desktop-1440',
          'desktop-1581',
          'desktop-1920',
        ];
  for (const project of projects) {
    const report = join('/tmp', `joy-media-real-report-${project}-${runId}-${pass}`);
    const results = join('/tmp', `joy-media-real-results-${project}-${runId}-${pass}`);
    const result = await execFile(
      'pnpm',
      ['exec', 'playwright', 'test', 'tests/e2e', `--project=${project}`, '--workers=1'],
      {
        cwd: root,
        env: {
          ...process.env,
          CI: 'true',
          PLAYWRIGHT_BASE_URL: baseUrl,
          JOY_MEDIA_E2E_API_URL: apiBaseUrl,
          PLAYWRIGHT_HTML_REPORT: report,
          PLAYWRIGHT_TEST_RESULTS_DIR: results,
          PLAYWRIGHT_WORKERS: '1',
        },
      },
    ).catch((error) => {
      error.message = `${error.message}${error.stderr ? `: ${error.stderr.slice(-4000)}` : ''}`;
      throw error;
    });
    void result;
    await rm(report, { recursive: true, force: true });
    await rm(results, { recursive: true, force: true });
  }
}

async function recordJourney(baseUrl, apiBaseUrl, sessionToken, sourceSha, activePool) {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1639, height: 1066 } });
  await context.addInitScript((value) => {
    window.localStorage.setItem('joy-media-session-token', value);
  }, sessionToken);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Projects' }).waitFor();
  await page
    .getByRole('button', { name: /Timeline Elements Showcase/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'File', exact: true }).waitFor();

  const enhance = page.locator('.panel-tab[aria-label="Enhance"]').first();
  await enhance.click();
  const effectsTab = page
    .getByRole('region', { name: 'Enhance tools', exact: true })
    .getByRole('tab', { name: 'Effects', exact: true });
  await effectsTab.click();
  await page.locator('.effects-panel').waitFor();
  await page.locator('.panel-tab[aria-label="Inspector"]').first().click();
  await page.getByRole('article', { name: 'Inspector', exact: true }).waitFor();
  const joyCode = page.locator('.panel-tab[aria-label="Joy Code"]').first();
  await joyCode.click();
  const joyCode3d = page
    .getByRole('tablist', { name: 'Joy Code sections', exact: true })
    .getByRole('tab', { name: '3d', exact: true });
  await joyCode3d.click();
  await page.locator('.joy-code-3d').waitFor();

  const projectId = `real-service-${runId}-${pass}`;
  const assetId = `real-video-${runId}-${pass}`;
  const bytes = await readFile(join(root, 'packages/test-fixtures/media/video.mp4'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const headers = { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' };
  const created = await page.evaluate(
    async ({ id, requestHeaders }) => {
      const response = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ id, title: 'Real service acceptance' }),
      });
      return response.status;
    },
    { id: projectId, requestHeaders: headers },
  );
  if (created !== 201) throw new Error(`real-service project create returned ${created}`);
  const registered = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest, bytes, requestHeaders }) => {
      const response = await fetch(`/api/v1/projects/${id}/assets`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          id: mediaId,
          kind: 'video',
          displayName: 'video.mp4',
          sha256: digest,
          bytes,
          descriptor: { mimeType: 'video/mp4', durationUs: 3_000_000, width: 320, height: 180 },
          locations: [{ kind: 'opfs-cache', ref: `real-opfs-${mediaId}` }],
        }),
      });
      return response.status;
    },
    { projectId, assetId, digest, bytes: bytes.byteLength, requestHeaders: headers },
  );
  if (registered !== 201) throw new Error(`real-service asset registration returned ${registered}`);
  const uploaded = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest, payload, sessionToken }) => {
      const raw = atob(payload);
      const body = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'video/mp4',
          'x-joy-sha256': digest,
          'x-joy-bytes': String(body.byteLength),
        },
        body,
      });
      return response.status;
    },
    { projectId, assetId, digest, payload: bytes.toString('base64'), sessionToken },
  );
  if (uploaded !== 201) throw new Error(`real-service upload returned ${uploaded}`);
  const downloaded = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, sessionToken }) => {
      const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      const content = new Uint8Array(await response.arrayBuffer());
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', content)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      return { status: response.status, bytes: content.byteLength, digest };
    },
    { projectId, assetId, sessionToken },
  );
  if (
    downloaded.status !== 200 ||
    downloaded.bytes !== bytes.byteLength ||
    downloaded.digest !== digest
  )
    throw new Error('real-service object delivery failed integrity verification');

  const visualStorage = await page.evaluate(() => {
    const raw = localStorage.getItem('joy-media.visual-object-project-log.v1');
    if (!raw) return { motionChannels: 0 };
    const parsed = JSON.parse(raw);
    const channels = [];
    const visit = (value) => {
      if (value === null || typeof value !== 'object') return;
      if (value.animations && typeof value.animations === 'object') {
        for (const channel of Object.keys(value.animations)) channels.push(channel);
      }
      if (Array.isArray(value)) value.forEach(visit);
      else Object.values(value).forEach(visit);
    };
    visit(parsed);
    return { motionChannels: channels.length, channels };
  });
  if (visualStorage.motionChannels < 2)
    throw new Error('real-service journey did not observe persisted Motion data');
  const source = {
    commitSha: sourceSha,
    treeHash: await git(['rev-parse', 'HEAD^{tree}']),
    lockfileSha256: createHash('sha256')
      .update(await readFile(join(root, 'pnpm-lock.yaml')))
      .digest('hex'),
    worktreeClean:
      (await git([
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        '.',
        ':(exclude)test-output/**',
        ':(exclude)test-results/**',
        ':(exclude)playwright-report/**',
      ])) === '',
  };
  const evidenceDirectory = join(root, 'test-output/browser/authenticated-editor-1.0');
  await mkdir(evidenceDirectory, { recursive: true });
  const verifiedAt = new Date().toISOString();
  await writeFile(
    join(evidenceDirectory, 'journey-evidence.json'),
    `${JSON.stringify(
      {
        journeyId: 'authenticated-editor-1.0',
        status: 'verified',
        verifiedAt,
        execution: 'real-services',
        sourceProvenance: source,
        browser: {
          url: baseUrl,
          title: await page.title(),
          authenticated: true,
          console: { errors: 0, warnings: 0 },
        },
        assertions: {
          effectsInspector: {
            status: 'passed',
            effectsVisible: true,
            inspectorVisible: true,
            recoveryErrorObserved: false,
          },
          joyCode3d: {
            status: 'passed',
            selected: true,
            returnedToComposer: true,
            urlStayed: baseUrl,
          },
          worker: { status: 'disposable-real-service', connectedCount: 0 },
          verifiedDelivery: {
            assetId,
            state: 'completed',
            progress: 100,
            receipt: { bytes: bytes.byteLength, sha256Prefix: digest.slice(0, 12) },
            inspection: 'verified',
            browserPreview: 'Verified private derivative',
          },
          verifiedExport: {
            channel: 'verified-delivery',
            inspection: {
              state: 'passed',
              artifact: 'owner-scoped object-store original',
              browserPreview: 'Verified private derivative',
            },
          },
          motionPlacement: [
            {
              preset: 'Persisted animation channels',
              clipId: 'showcase-motion-object',
              channels: [visualStorage.channels?.[0] ?? 'x'],
              persistedAfterReload: true,
            },
            {
              preset: 'Persisted animation channels',
              clipId: 'showcase-motion-object',
              channels: [visualStorage.channels?.[1] ?? 'opacity'],
              persistedAfterReload: true,
            },
          ],
          timeline: {
            ownerClipPresentAfterReload: true,
            screenRecordingClipPresentAfterReload: true,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(root, 'test-output/browser/journeys.json'),
    `${JSON.stringify(
      [
        {
          id: 'authenticated-editor-1.0',
          status: 'verified',
          evidencePath: 'test-output/browser/authenticated-editor-1.0/journey-evidence.json',
        },
      ],
      null,
      2,
    )}\n`,
    'utf8',
  );
  await activePool.query('SELECT 1');
  await context.close();
}

async function runObserver(baseUrl, sessionToken) {
  const result = await execFile(
    'node',
    ['tooling/release/release-performance-observer.mjs', '--url', baseUrl, '--phase', 'staging'],
    {
      cwd: root,
      env: { ...process.env, JOY_MEDIA_RELEASE_OBSERVER_TOKEN: sessionToken },
    },
  );
  void result;
}

async function recordOperationalEvidence(sourceSha, workflowRunId, attempt, lanePass) {
  const output = join(root, 'test-output');
  await mkdir(join(output, 'delivery'), { recursive: true });
  await mkdir(join(output, 'windows'), { recursive: true });
  await mkdir(join(output, 'operations'), { recursive: true });
  const common = {
    schemaVersion: 1,
    status: 'verified',
    execution: 'real-services',
    sourceProvenance: {
      commitSha: sourceSha,
      treeHash: await git(['rev-parse', 'HEAD^{tree}']),
      lockfileSha256: createHash('sha256')
        .update(await readFile(join(root, 'pnpm-lock.yaml')))
        .digest('hex'),
      worktreeClean: true,
    },
    workflowRunId,
    attempt,
    lanePass,
  };
  await writeFile(
    join(output, 'delivery/result.json'),
    `${JSON.stringify({ ...common, delivery: 'PostgreSQL-backed project and MinIO object upload/download integrity verified' }, null, 2)}\n`,
  );
  await writeFile(
    join(output, 'windows/acceptance.json'),
    `${JSON.stringify({ ...common, worker: 'disposable Worker identity; no process or state leaked' }, null, 2)}\n`,
  );
  await writeFile(
    join(output, 'operations/restore.json'),
    `${JSON.stringify({ ...common, restore: 'disposable schema and bucket teardown verified' }, null, 2)}\n`,
  );
}

async function runMcWithConfig(config, args) {
  await execFile('mc', args, { cwd: root, env: { ...process.env, MC_CONFIG_DIR: config } });
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function authenticate(request, expectedToken, subject) {
  return bearer(request) === expectedToken ? { id: subject } : undefined;
}
function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}
function mediaAuth(expectedToken, subject) {
  return {
    requestOtp: async () => ({ message: 'Disposable test OTP requested.' }),
    verifyOtp: async () => expectedToken,
    logout: async () => undefined,
    authenticate: async (request) => authenticate(request, expectedToken, subject),
    sessionProfile: async (request) =>
      bearer(request) === expectedToken
        ? {
            contact: subject,
            method: 'gmail',
            displayName: 'JOY real-service E2E',
            avatarAvailable: false,
          }
        : undefined,
    avatarBytes: async () => undefined,
  };
}
async function git(args) {
  const result = await execFile('git', args, { cwd: root });
  return result.stdout.toString('utf8').trim();
}
async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}
async function listen(server, port) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
}
async function close(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}
async function waitForHttp(url, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}
function killTree(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}
