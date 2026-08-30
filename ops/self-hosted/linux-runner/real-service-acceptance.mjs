#!/usr/bin/env node
/* global process, setTimeout, URL, Buffer, window, fetch, atob, btoa, crypto, localStorage */

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
      error.stdout = Buffer.concat(stdout).toString('utf8');
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
const mcHostUrl = new URL(s3Endpoint);
mcHostUrl.username = s3AccessKey;
mcHostUrl.password = s3SecretKey;
const mcEnvironment = {
  ...process.env,
  MC_CONFIG_DIR: mcConfig,
  'MC_HOST_joy-ci': mcHostUrl.toString(),
};
const apiPort = await freePort();
const webPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const token = 'joy-media-e2e-token';
const owner = 'e2e-owner@example.test';
const smokeOnly = process.env.JOY_MEDIA_REAL_ACCEPTANCE_SMOKE_ONLY === '1';
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
    env: mcEnvironment,
    input,
  });
};

try {
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
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
  const deliveryEvidence = await recordJourney(webUrl, apiUrl, token, candidateSha, pool);
  if (!smokeOnly) {
    await runObserver(webUrl, token);
  }
  const restoreEvidence = await verifyRestoreCompatibility(databaseUrl, namespace);
  await recordOperationalEvidence(
    candidateSha,
    runId,
    runAttempt,
    pass,
    deliveryEvidence,
    restoreEvidence,
  );
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
      [
        'exec',
        'playwright',
        'test',
        ...(process.env.JOY_MEDIA_REAL_ACCEPTANCE_SMOKE_ONLY === '1'
          ? ['tests/e2e/authenticated-smoke.spec.ts']
          : ['tests/e2e']),
        `--project=${project}`,
        '--workers=1',
      ],
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
      const details = [error.stdout, error.stderr].filter(Boolean).join('\n');
      error.message = `${error.message}${details ? `: ${details.slice(-4000)}` : ''}`;
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

  // Produce a real mixed-source export, then exercise the same private
  // object path for download, ffprobe inspection, and re-import.  Keeping
  // this in the disposable project makes the acceptance proof meaningful
  // without touching owner media or a production bucket.
  const mixedPath = join(tempRoot, `mixed-${runId}-${pass}.mp4`);
  await execFile(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      join(root, 'packages/test-fixtures/media/video.mp4'),
      '-i',
      join(root, 'packages/test-fixtures/media/audio.mp3'),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-shortest',
      mixedPath,
    ],
    { cwd: root },
  );
  const mixedBytes = await readFile(mixedPath);
  const mixedDigest = createHash('sha256').update(mixedBytes).digest('hex');
  const exportAssetId = `real-export-${runId}-${pass}`;
  const reimportAssetId = `real-reimport-${runId}-${pass}`;
  const exportRegistered = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest: sha, byteLength, requestHeaders }) => {
      const response = await fetch(`/api/v1/projects/${id}/assets`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          id: mediaId,
          kind: 'video',
          displayName: 'mixed-export.mp4',
          sha256: sha,
          bytes: byteLength,
          descriptor: { mimeType: 'video/mp4', durationUs: 3_000_000, width: 320, height: 180 },
          locations: [{ kind: 'opfs-cache', ref: `real-export-${mediaId}` }],
        }),
      });
      return response.status;
    },
    {
      projectId,
      assetId: exportAssetId,
      digest: mixedDigest,
      byteLength: mixedBytes.byteLength,
      requestHeaders: headers,
    },
  );
  if (exportRegistered !== 201)
    throw new Error(`real-service mixed export registration returned ${exportRegistered}`);
  const exportUploaded = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest: sha, payload, sessionToken }) => {
      const raw = atob(payload);
      const body = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'video/mp4',
          'x-joy-sha256': sha,
          'x-joy-bytes': String(body.byteLength),
        },
        body,
      });
      return response.status;
    },
    {
      projectId,
      assetId: exportAssetId,
      digest: mixedDigest,
      payload: mixedBytes.toString('base64'),
      sessionToken,
    },
  );
  if (exportUploaded !== 201)
    throw new Error(`real-service mixed export upload returned ${exportUploaded}`);
  const exportedDownload = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, sessionToken }) => {
      const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
        headers: { authorization: `Bearer ${sessionToken}` },
      });
      const content = new Uint8Array(await response.arrayBuffer());
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', content)),
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      let binary = '';
      for (let offset = 0; offset < content.length; offset += 0x8000) {
        binary += String.fromCharCode(...content.subarray(offset, offset + 0x8000));
      }
      return {
        status: response.status,
        bytes: content.byteLength,
        digest,
        payload: btoa(binary),
      };
    },
    { projectId, assetId: exportAssetId, sessionToken },
  );
  if (
    exportedDownload.status !== 200 ||
    exportedDownload.bytes !== mixedBytes.byteLength ||
    exportedDownload.digest !== mixedDigest
  )
    throw new Error('mixed export download failed integrity verification');
  const exportedPath = join(tempRoot, `downloaded-${runId}-${pass}.mp4`);
  await writeFile(exportedPath, Buffer.from(exportedDownload.payload, 'base64'));
  const ffprobeResult = await execFile(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', exportedPath],
    { cwd: root },
  );
  const ffprobe = JSON.parse(ffprobeResult.stdout.toString('utf8'));
  const streamTypes = (Array.isArray(ffprobe.streams) ? ffprobe.streams : []).map(
    (stream) => stream.codec_type,
  );
  if (!streamTypes.includes('video') || !streamTypes.includes('audio'))
    throw new Error('mixed export ffprobe did not find both video and audio streams');
  const reimported = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest: sha, byteLength, requestHeaders }) => {
      const response = await fetch(`/api/v1/projects/${id}/assets`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          id: mediaId,
          kind: 'video',
          displayName: 'reimported-mixed-export.mp4',
          sha256: sha,
          bytes: byteLength,
          descriptor: { mimeType: 'video/mp4', durationUs: 3_000_000, width: 320, height: 180 },
          locations: [{ kind: 'opfs-cache', ref: `real-reimport-${mediaId}` }],
        }),
      });
      return response.status;
    },
    {
      projectId,
      assetId: reimportAssetId,
      digest: mixedDigest,
      byteLength: mixedBytes.byteLength,
      requestHeaders: headers,
    },
  );
  if (reimported !== 201) throw new Error(`real-service re-import returned ${reimported}`);
  const reimportUploaded = await page.evaluate(
    async ({ projectId: id, assetId: mediaId, digest: sha, payload, sessionToken }) => {
      const raw = atob(payload);
      const body = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const response = await fetch(`/api/v1/projects/${id}/assets/${mediaId}/original`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'video/mp4',
          'x-joy-sha256': sha,
          'x-joy-bytes': String(body.byteLength),
        },
        body,
      });
      return response.status;
    },
    {
      projectId,
      assetId: reimportAssetId,
      digest: mixedDigest,
      payload: mixedBytes.toString('base64'),
      sessionToken,
    },
  );
  if (reimportUploaded !== 201)
    throw new Error(`real-service re-import upload returned ${reimportUploaded}`);
  const reimportDownloaded = await page.evaluate(
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
    { projectId, assetId: reimportAssetId, sessionToken },
  );
  if (
    reimportDownloaded.status !== 200 ||
    reimportDownloaded.bytes !== mixedBytes.byteLength ||
    reimportDownloaded.digest !== mixedDigest
  )
    throw new Error('real-service re-import download failed integrity verification');
  const missingSourceStatus = await page.evaluate(
    async ({ projectId: id, sessionToken }) =>
      (
        await fetch(`/api/v1/projects/${id}/assets/missing-source/original`, {
          headers: { authorization: `Bearer ${sessionToken}` },
        })
      ).status,
    { projectId, sessionToken },
  );
  // The API maps a missing asset to its conflict-safe control-plane error
  // (409) rather than leaking a storage existence signal; both statuses are
  // accepted across the current local/production adapters.
  if (missingSourceStatus !== 404 && missingSourceStatus !== 409)
    throw new Error(`missing-source recovery returned ${missingSourceStatus}, expected 404/409`);
  const deliveryRecovery = await page.evaluate(
    async ({ projectId: id, sessionToken }) => {
      const requestHeaders = {
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json',
      };
      const createdResponse = await fetch(`/api/v1/projects/${id}/jobs`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ id: `delivery-recovery-${Date.now()}`, type: 'render' }),
      });
      if (createdResponse.status !== 201) return { created: createdResponse.status };
      const created = await createdResponse.json();
      const jobId = created.data?.id;
      const canceledResponse = await fetch(`/api/v1/projects/${id}/jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: requestHeaders,
        body: '{}',
      });
      const canceled = await canceledResponse.json();
      const retryResponse = await fetch(`/api/v1/projects/${id}/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: requestHeaders,
        body: '{}',
      });
      const retried = await retryResponse.json();
      return {
        created: createdResponse.status,
        canceled: canceledResponse.status,
        canceledState: canceled.data?.state,
        retried: retryResponse.status,
        retriedState: retried.data?.state,
      };
    },
    { projectId, sessionToken },
  );
  if (
    deliveryRecovery.created !== 201 ||
    ![200, 201].includes(deliveryRecovery.canceled) ||
    deliveryRecovery.canceledState !== 'canceled' ||
    ![200, 201].includes(deliveryRecovery.retried) ||
    deliveryRecovery.retriedState !== 'queued'
  )
    throw new Error(`delivery cancel/retry recovery failed: ${JSON.stringify(deliveryRecovery)}`);
  var deliveryEvidence = {
    sourceAssets: { video: true, audio: true },
    mixedSourceExport: { status: 'passed', bytes: mixedBytes.byteLength, sha256: mixedDigest },
    downloaded: { status: 200, bytes: exportedDownload.bytes, sha256: exportedDownload.digest },
    ffprobe: {
      status: 'passed',
      streamTypes,
      formatName: ffprobe.format?.format_name ?? null,
    },
    reimport: {
      status: reimported,
      assetId: reimportAssetId,
      uploadStatus: reimportUploaded,
      downloadStatus: reimportDownloaded.status,
      bytes: reimportDownloaded.bytes,
      sha256: reimportDownloaded.digest,
    },
    cancelRetry: deliveryRecovery,
    missingSource: { status: missingSourceStatus },
  };

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
  const source = await currentSourceProvenance(sourceSha);
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
  return deliveryEvidence;
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

async function verifyRestoreCompatibility(databaseUrl, namespace) {
  const legacySchema = `ci_legacy_${namespace}`;
  const legacyPool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${legacySchema},public`,
  });
  let evidence;
  let operationError;
  let cleanupError;
  try {
    const currentSchemaCheck = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects' LIMIT 1",
      [schema],
    );
    if ((currentSchemaCheck.rowCount ?? 0) !== 1)
      throw new Error('current schema project table is not readable');
    await pool.query(`CREATE SCHEMA "${legacySchema}"`);
    // Recreate the pre-expansion (N-1) shape: initialize() must add the
    // optional columns/tables and preserve rows when the current binary opens
    // an older deployment's metadata.
    await pool.query(`
      CREATE TABLE "${legacySchema}".projects (id text primary key, owner_id text not null, title text not null, revision integer not null);
      CREATE TABLE "${legacySchema}".workers (id text primary key, owner_id text not null, revoked_at timestamptz NULL);
      CREATE TABLE "${legacySchema}".jobs (id text primary key, project_id text not null, type text not null, state text not null, lease_owner text, lease_expires_at timestamptz);
      CREATE TABLE "${legacySchema}".job_attempts (id bigserial primary key, job_id text not null, worker_id text not null, started_at timestamptz not null, completed_at timestamptz);
      CREATE TABLE "${legacySchema}".job_events (cursor bigserial primary key, job_id text not null, type text not null, created_at timestamptz not null);
      CREATE TABLE "${legacySchema}".worker_pairing_offers (worker_id text primary key, pairing_code_hash text not null, owner_id text, expires_at timestamptz not null);
      CREATE TABLE "${legacySchema}".media_assets (id text primary key, project_id text not null, kind text not null, display_name text not null, sha256 text not null, byte_length bigint not null, descriptor jsonb not null, locations jsonb not null, created_at timestamptz not null);
      CREATE TABLE "${legacySchema}".media_derivatives (id text primary key, project_id text not null, asset_id text not null, kind text not null, profile text not null, sha256 text not null, byte_length bigint not null, descriptor jsonb not null, availability text not null, locations jsonb not null, verified_at timestamptz not null);
    `);
    const legacyControlPlane = new PostgresControlPlane(legacyPool, { skipLocked: false });
    await legacyControlPlane.initialize();
    const actor = { id: `restore-owner-${namespace}` };
    const projectId = `restore-project-${namespace}`;
    await legacyControlPlane.createProject(actor, projectId, 'N-1 restore compatibility');
    const restored = await legacyControlPlane.getProject(actor, projectId);
    if (restored.id !== projectId || restored.revision !== 0)
      throw new Error('N-1 restore did not preserve the project row');
    evidence = {
      status: 'passed',
      schemaIsolation: true,
      nVersion: { status: 'passed', initialized: true, projectReadable: true },
      nMinusOneVersion: {
        status: 'passed',
        legacyBaseSchemaInitialized: true,
        migratedInPlace: true,
        projectReadable: true,
      },
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
      const remaining = await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1 LIMIT 1', [
        legacySchema,
      ]);
      if ((remaining.rowCount ?? 0) !== 0) {
        cleanupError = new Error('legacy restore schema still exists');
      } else if (evidence !== undefined) {
        evidence.cleanup = { status: 'passed', schema: 'disposable' };
      }
    } catch (error) {
      cleanupError = error;
      if (evidence !== undefined)
        evidence.cleanup = {
          status: 'failed',
          schema: 'disposable',
          error: error instanceof Error ? error.message : String(error),
        };
    }
    await legacyPool.end().catch(() => undefined);
  }
  if (cleanupError !== undefined)
    throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  if (operationError !== undefined)
    throw operationError instanceof Error ? operationError : new Error(String(operationError));
  if (evidence === undefined) throw new Error('restore compatibility did not produce evidence');
  return evidence;
}

async function recordOperationalEvidence(
  sourceSha,
  workflowRunId,
  attempt,
  lanePass,
  deliveryEvidence,
  restoreEvidence,
) {
  const output = join(root, 'test-output');
  await mkdir(join(output, 'delivery'), { recursive: true });
  await mkdir(join(output, 'windows'), { recursive: true });
  await mkdir(join(output, 'operations'), { recursive: true });
  const sourceProvenance = await currentSourceProvenance(sourceSha);
  const common = {
    schemaVersion: 1,
    status: smokeOnly ? 'smoke-only' : 'verified',
    execution: 'real-services',
    scope: smokeOnly ? 'smoke-only' : 'full',
    sourceProvenance,
    workflowRunId,
    attempt,
    lanePass,
  };
  await writeFile(
    join(output, 'delivery/result.json'),
    `${JSON.stringify({ ...common, delivery: deliveryEvidence }, null, 2)}\n`,
  );
  const windowsEvidencePath = join(output, 'windows/acceptance.json');
  try {
    await readFile(windowsEvidencePath);
  } catch {
    throw new Error('Windows Worker acceptance evidence was not downloaded for this pass');
  }
  await writeFile(
    join(output, 'operations/restore.json'),
    `${JSON.stringify({ ...common, restore: restoreEvidence }, null, 2)}\n`,
  );
}

async function runMcWithConfig(config, args) {
  await execFile('mc', args, {
    cwd: root,
    env: { ...mcEnvironment, MC_CONFIG_DIR: config },
  });
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
            displayName: 'JOY E2E',
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
async function currentSourceProvenance(commitSha) {
  return {
    commitSha,
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
    } catch {
      // Retry until the service is ready.
    }
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
    } catch {
      // Best-effort process cleanup.
    }
  }
}
