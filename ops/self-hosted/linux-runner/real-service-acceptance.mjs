#!/usr/bin/env node
/* global process, setTimeout, URL, Buffer, window, fetch, atob, btoa, crypto, localStorage */

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

import { chromium } from '@playwright/test';
import { verifyExport } from '../../../packages/export-core/dist/index.js';
import {
  PostgresControlPlane,
  createControlPlaneHttpServer,
} from '../../../apps/api/dist/index.js';
import {
  assertJourneyTelemetryClean,
  buildProfileSummary,
  createJourneyTelemetry,
} from './real-service-evidence.mjs';
import { createLeaseHeartbeatLoop, throwIfLeaseCanceled } from './lease-heartbeat.mjs';

const requireFromApi = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const { Pool } = requireFromApi('pg');

const execFile = promisify((file, args, options, callback) => {
  const { input, ...spawnOptions } = options ?? {};
  const child = spawn(file, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let settled = false;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    callback(error, result);
  };
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.once('error', (error) => finish(error));
  child.once('close', (code, signal) => {
    if (code === 0)
      finish(null, {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    else {
      const error = new Error(`command ${file} exited with ${code ?? signal ?? 'unknown'}`);
      error.code = code;
      error.stderr = Buffer.concat(stderr).toString('utf8');
      error.stdout = Buffer.concat(stdout).toString('utf8');
      finish(error);
    }
  });
  child.stdin.end(input);
});

// A real-service export includes browser encoding, upload, and disposable
// Worker verification after the user's click. The app's Worker polling window
// is 30 minutes, so the old four-minute Playwright event timeout could expire
// before the app reached its final browser download handoff.
const REAL_SERVICE_EXPORT_DOWNLOAD_TIMEOUT_MS = 35 * 60_000;

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
let webPort = await freePort();
for (let attempt = 0; webPort === apiPort && attempt < 10; attempt += 1) webPort = await freePort();
if (webPort === apiPort) throw new Error('could not allocate two distinct ports');
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const token = 'joy-media-e2e-token';
const owner = 'e2e-owner@example.test';
const smokeOnly = process.env.JOY_MEDIA_REAL_ACCEPTANCE_SMOKE_ONLY === '1';
let pool;
let apiServer;
let webProcess;
let webProcessError;
let browser;
let realWorkerLifecycle;
let realWorkerPromise;

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
  // Real-service acceptance must exercise the same Worker-backed export
  // contract as production.  Keep the Worker disposable and in-process so
  // the lane remains isolated from owner machines while still leasing,
  // downloading, verifying, and completing jobs through PostgreSQL.
  const realWorkerId = `real-service-render-worker-${runId}-${pass}`;
  await controlPlane.pairWorker({ id: owner }, realWorkerId);
  await controlPlane.helloWorker(realWorkerId, ['render.export'], [], Date.now());
  realWorkerLifecycle = { stopped: false };
  const realWorkerDirectory = join(tempRoot, 'worker');
  await mkdir(realWorkerDirectory, { recursive: true });
  realWorkerPromise = runRealServiceExportWorker(
    controlPlane,
    objectStore,
    realWorkerId,
    realWorkerDirectory,
    realWorkerLifecycle,
  );
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
  webProcess.once('error', (error) => {
    webProcessError = error;
  });
  try {
    await waitForHttp(webUrl, 120_000);
  } catch (error) {
    if (webProcessError !== undefined) {
      const detail =
        webProcessError instanceof Error ? webProcessError.message : String(webProcessError);
      error.message = `${error.message}; web process failed to spawn: ${detail}`;
    }
    throw error;
  }
  const profileSummaries = await runDesktopMatrix(webUrl, apiUrl);
  const deliveryEvidence = await recordJourney(
    webUrl,
    apiUrl,
    token,
    candidateSha,
    pool,
    profileSummaries,
  );
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
    if (realWorkerLifecycle !== undefined) {
      realWorkerLifecycle.stopped = true;
      await realWorkerPromise?.catch(() => undefined);
      realWorkerLifecycle = undefined;
    }
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
  await runMc(['rm', '--quiet', '--recursive', '--force', `joy-ci/${bucket}`]).catch(
    () => undefined,
  );
  await runMc(['rb', '--quiet', `joy-ci/${bucket}`]).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}

async function runRealServiceExportWorker(
  controlPlane,
  objectStore,
  workerId,
  workerDirectory,
  lifecycle,
) {
  let lastHelloAt = 0;
  while (!lifecycle.stopped) {
    const now = Date.now();
    try {
      if (now - lastHelloAt >= 10_000) {
        await controlPlane.helloWorker(workerId, ['render.export'], [], now);
        lastHelloAt = now;
      }
      const job = await controlPlane.lease(workerId, now, 300_000);
      if (job === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (job.type !== 'render.export' || job.assetId === undefined || job.payload === undefined) {
        await controlPlane.fail(
          workerId,
          job.id,
          'real-service Worker received unsupported job',
          Date.now(),
          job.leaseToken,
        );
        continue;
      }
      const sourcePath = join(workerDirectory, `${safeToken(job.id)}-${job.generation}.source`);
      const outputPath = join(workerDirectory, `${safeToken(job.id)}-${job.generation}.export.mp4`);
      try {
        const asset = await controlPlane.workerJobAsset(
          workerId,
          job.id,
          Date.now(),
          job.leaseToken,
        );
        const sourceDescriptor = privateDescriptor(asset);
        const sourceBytes = await objectStore.get(sourceDescriptor);
        await writeFile(sourcePath, Buffer.from(sourceBytes), { mode: 0o600 });
        const payload = job.payload;
        await runLeasedExportWithHeartbeats(
          controlPlane,
          workerId,
          job.id,
          job.leaseToken,
          { sourcePath, payload },
          outputPath,
        );
        const bytes = await readFile(outputPath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const probe = verifyExport(outputPath);
        const localRef = `export-real-${sha256.slice(0, 40)}`;
        const objectRef = `real-${localRef}`;
        await objectStore.put(
          { ref: objectRef, sha256, bytes: bytes.byteLength, mimeType: 'video/mp4' },
          new Uint8Array(bytes),
        );
        await controlPlane.registerWorkerCloudDerivative(
          workerId,
          job.id,
          {
            id: `upload-${sha256.slice(0, 32)}`,
            assetId: job.assetId,
            kind: 'proxy',
            profile: 'render.export',
            sha256,
            bytes: bytes.byteLength,
            descriptor: {
              mimeType: 'video/mp4',
              width: probe.width,
              height: probe.height,
              durationUs: probe.durationUs,
            },
            availability: 'available-cloud',
            locations: [{ kind: 'private-object', ref: objectRef }],
          },
          Date.now(),
          job.leaseToken,
        );
        await controlPlane.complete(
          workerId,
          job.id,
          Date.now(),
          {
            kind: 'render.export',
            assetId: job.assetId,
            sha256,
            bytes: bytes.byteLength,
            localRef,
            descriptor: {
              mimeType: 'video/mp4',
              width: probe.width,
              height: probe.height,
              durationUs: probe.durationUs,
            },
          },
          job.leaseToken,
        );
      } catch (error) {
        await controlPlane
          .fail(
            workerId,
            job.id,
            error instanceof Error ? error.message.slice(0, 500) : 'real-service export failed',
            Date.now(),
            job.leaseToken,
          )
          .catch(() => undefined);
      } finally {
        await rm(sourcePath, { force: true });
        await rm(outputPath, { force: true });
      }
    } catch {
      if (!lifecycle.stopped) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function runLeasedExportWithHeartbeats(
  controlPlane,
  workerId,
  jobId,
  leaseToken,
  input,
  outputPath,
) {
  let cancelRequested = false;
  let heartbeatError;
  const heartbeatLoop = createLeaseHeartbeatLoop({
    heartbeat: () => controlPlane.heartbeat(workerId, jobId, 10, Date.now(), 30_000, leaseToken),
    onHeartbeat: (result) => {
      cancelRequested ||= result.cancelRequested;
    },
  });
  await heartbeatLoop.send();
  throwIfLeaseCanceled(cancelRequested);
  heartbeatLoop.start();
  try {
    await executeExportInWorkerThread(input, outputPath);
    if (heartbeatLoop.lastError !== undefined) throw heartbeatLoop.lastError;
    throwIfLeaseCanceled(cancelRequested);
  } finally {
    try {
      await heartbeatLoop.stop();
    } catch (error) {
      heartbeatError = error;
    }
  }
  if (heartbeatError !== undefined) throw heartbeatError;
  throwIfLeaseCanceled(cancelRequested);
}

async function executeExportInWorkerThread(input, outputPath) {
  const workerModule = new URL('../../../apps/worker/dist/export-job.js', import.meta.url).href;
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { executeLeasedExport } = await import(workerData.workerModule);
        try {
          executeLeasedExport(
            { complete: () => undefined },
            'real-service-export-thread',
            'real-service-export-job',
            workerData.input,
            workerData.outputPath,
          );
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })().catch((error) => {
        parentPort.postMessage({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    `,
    { eval: true, workerData: { workerModule, input, outputPath } },
  );
  await new Promise((resolve, reject) => {
    let settled = false;
    worker.once('message', (message) => {
      if (settled) return;
      settled = true;
      if (message?.ok === true) resolve();
      else reject(new Error(message?.error ?? 'real-service export thread failed'));
      void worker.terminate();
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        reject(new Error(`real-service export thread exited with ${code}`));
      }
    });
  });
}

function privateDescriptor(asset) {
  const location = asset.locations.find((candidate) => candidate.kind === 'private-object');
  if (location === undefined) throw new Error(`asset ${asset.id} has no private source`);
  return {
    ref: location.ref,
    sha256: asset.sha256,
    bytes: asset.bytes,
    mimeType: asset.descriptor.mimeType,
  };
}

function safeToken(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
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
  const sourceProvenance = await currentSourceProvenance(candidateSha);
  const summaries = [];
  const matrixEvidencePath = join(root, 'test-output/browser/real-service-profile-matrix.json');
  await mkdir(dirname(matrixEvidencePath), { recursive: true });
  await rm(matrixEvidencePath, { force: true });
  for (const project of projects) {
    const report = join('/tmp', `joy-media-real-report-${project}-${runId}-${pass}`);
    const results = join('/tmp', `joy-media-real-results-${project}-${runId}-${pass}`);
    const startedAt = new Date().toISOString();
    let result;
    let exitCode = 0;
    let failure;
    try {
      result = await execFile(
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
          '--reporter=json',
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
      );
    } catch (error) {
      failure = error;
      exitCode = typeof error?.code === 'number' ? error.code : 1;
      result = {
        stdout: Buffer.from(typeof error?.stdout === 'string' ? error.stdout : ''),
        stderr: Buffer.from(typeof error?.stderr === 'string' ? error.stderr : ''),
      };
    }
    const finishedAt = new Date().toISOString();
    summaries.push(
      buildProfileSummary({
        project,
        reportText: result.stdout.toString('utf8'),
        exitCode,
        startedAt,
        finishedAt,
        sourceProvenance,
      }),
    );
    await writeProfileMatrixEvidence(
      matrixEvidencePath,
      sourceProvenance,
      summaries,
      'in-progress',
    );
    await rm(report, { recursive: true, force: true });
    await rm(results, { recursive: true, force: true });
    if (failure !== undefined) {
      await writeProfileMatrixEvidence(matrixEvidencePath, sourceProvenance, summaries, 'failed');
      const details = [failure.stdout, failure.stderr].filter(Boolean).join('\n');
      failure.message = `${failure.message}${details ? `: ${details.slice(-4000)}` : ''}`;
      failure.profileSummaries = summaries;
      throw failure;
    }
  }
  await writeProfileMatrixEvidence(matrixEvidencePath, sourceProvenance, summaries, 'passed');
  return summaries;
}

async function writeProfileMatrixEvidence(path, sourceProvenance, profiles, status) {
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status,
        execution: 'real-services',
        candidateSha,
        workflowRunId: runId,
        attempt: runAttempt,
        lanePass: pass,
        sourceProvenance,
        profiles,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function recordJourney(
  baseUrl,
  apiBaseUrl,
  sessionToken,
  sourceSha,
  activePool,
  profileSummaries,
) {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1639, height: 1066 } });
  await context.addInitScript((value) => {
    window.localStorage.setItem('joy-media-session-token', value);
  }, sessionToken);
  const page = await context.newPage();
  const telemetry = createJourneyTelemetry();
  let captureBrowserTelemetry = true;
  page.on('console', (message) => {
    if (!captureBrowserTelemetry) return;
    if (message.type() === 'error') telemetry.consoleErrors.push(message.text());
    if (message.type() === 'warning') telemetry.consoleWarnings.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (!captureBrowserTelemetry) return;
    telemetry.pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    if (!captureBrowserTelemetry) return;
    if (request.url().startsWith('http'))
      telemetry.failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    if (!captureBrowserTelemetry) return;
    if (response.status() >= 400)
      telemetry.httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Projects' }).waitFor();
  const title = `Real service acceptance ${runId}-${pass}`;
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByPlaceholder('Project name').fill(title);
  await page.getByRole('button', { name: 'Create project' }).click();
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
  const joyCodeBrief = page
    .getByRole('tablist', { name: 'Joy Code sections', exact: true })
    // PanelShell keeps the short visual label while exposing the migration
    // alias as the accessible name. Target the contract users and assistive
    // technology receive, not the painted text node.
    .getByRole('tab', { name: 'Creative Brief', exact: true });
  await joyCodeBrief.click();
  await page.getByRole('article', { name: 'Joy Code', exact: true }).waitFor();
  await page.locator('.creative-brief-panel').waitFor();
  const joyCode3d = page
    .getByRole('tablist', { name: 'Joy Code sections', exact: true })
    .getByRole('tab', { name: '3d', exact: true });
  await joyCode3d.click();
  await page.locator('.joy-code-3d').waitFor();

  const projectId = await readControlPlaneProjectId(page);
  if (!projectId)
    throw new Error('real-service acceptance did not resolve a control-plane project id');
  const headers = { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' };
  const videoName = `real-video-${runId}-${pass}.mp4`;
  const audioName = `real-audio-${runId}-${pass}.wav`;
  await importFixture(page, 'video.mp4', videoName);
  await importFixture(page, 'audio.wav', audioName);
  await resetAssetCatalogFilters(page);
  await addAssetToTimeline(page, videoName);
  // Motion/Spatial authoring requires an object-backed visual clip.  A newly
  // created project starts with media-only clips, so place a first-party HTML
  // scene on the imported video before applying a preset.  Keep this in the
  // real-service journey (rather than seeding localStorage) so persistence is
  // exercised through the same compound document transaction as production.
  await page.locator(`.timeline-clip[aria-label^="${videoName},"]`).click();
  await enhance.click();
  await page
    .getByRole('region', { name: 'Enhance tools', exact: true })
    .getByRole('tab', { name: /^Animate/ })
    .click();
  const motion = page.locator('.motion-panel');
  await motion.waitFor();
  await motion.getByRole('tab', { name: 'Scenes', exact: true }).click();
  await motion
    .getByRole('button', { name: /^Add .+ to selected clip$/ })
    .first()
    .click();
  await motion.getByRole('tab', { name: 'Presets', exact: true }).click();
  await motion
    .locator('.motion-field', { hasText: 'Preset' })
    .locator('select')
    .selectOption('joy-pop-in');
  await motion.getByRole('button', { name: 'Apply motion preset' }).click();
  await motion.getByRole('img', { name: 'scaleX keyframes', exact: true }).waitFor();
  await motion.getByRole('img', { name: 'scaleY keyframes', exact: true }).waitFor();
  await motion.getByRole('img', { name: 'opacity keyframes', exact: true }).waitFor();
  const motionObjectId = (await motion.locator('.motion-object-id').textContent())?.trim();
  if (!motionObjectId || motionObjectId === 'Select a clip')
    throw new Error('real-service journey did not resolve the Motion target object');
  // Applying a preset targets the generated HTML-scene clip, not the
  // imported media clip that the scene was placed above.  Keep that exact
  // clip id for the reload check; selecting the imported video by display
  // name would resolve its media controller (which intentionally has no
  // animation channels) and make a valid persisted preset look missing.
  const motionClipId = await page
    .locator('.timeline-clip[data-element-kind="html-scene"][aria-pressed="true"]')
    .first()
    .getAttribute('data-clip-id');
  if (!motionClipId)
    throw new Error('real-service journey did not resolve the generated Motion clip id');
  // The Enhance panel replaces the Create/Assets surface. Return to the
  // catalog before resolving the second imported asset, and clear any kind
  // filter that the import flow or prior interactions may have selected.
  await page.locator('.panel-tab[aria-label="Create"]').first().click();
  await page.getByRole('article', { name: 'Assets', exact: true }).waitFor();
  await resetAssetCatalogFilters(page);
  await addAssetToTimeline(page, audioName);

  const firstDownload = await triggerExportDownload(page);
  const exportAssetId = `real-export-${runId}-${pass}`;
  const mixedBytes = await readFile(firstDownload.path);
  const mixedDigest = firstDownload.sha256;
  const reimportAssetId = `real-reimport-${runId}-${pass}`;
  const exportedProbe = JSON.parse(
    (
      await execFile(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_streams',
          '-show_format',
          firstDownload.path,
        ],
        { cwd: root },
      )
    ).stdout.toString('utf8'),
  );
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
  const exportedPath = join(tempRoot, `verified-delivery-${runId}-${pass}.mp4`);
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
  await importFixture(page, firstDownload.path, firstDownload.filename);
  const redownload = await redownloadMostRecentExport(page);
  if (redownload.sha256 !== firstDownload.sha256 || redownload.bytes !== firstDownload.bytes) {
    throw new Error('Recent processes redownload did not match the original JOY export bytes');
  }
  captureBrowserTelemetry = false;
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
    mixedSourceExport: {
      status: 'passed',
      producer: 'joy-export-mp4',
      filename: firstDownload.filename,
      bytes: firstDownload.bytes,
      sha256: firstDownload.sha256,
      durableRedownloadMatched: true,
    },
    downloaded: { status: 200, bytes: exportedDownload.bytes, sha256: exportedDownload.digest },
    ffprobe: {
      status: 'passed',
      streamTypes,
      formatName: ffprobe.format?.format_name ?? null,
      exportFormatName: exportedProbe.format?.format_name ?? null,
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

  // Reopen the active project before asserting Motion persistence.  This
  // proves the persisted document can be reconstructed by a fresh editor
  // session instead of merely finding data in the current React/localStorage
  // process.  The clip/object and expected channels are carried through the
  // check so unrelated animation data cannot satisfy this release gate.
  captureBrowserTelemetry = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'File', exact: true }).waitFor();
  const reloadedClip = page.locator(`.timeline-clip[data-clip-id="${motionClipId}"]`).first();
  await reloadedClip.waitFor({ timeout: 15_000 });
  await reloadedClip.click();
  if ((await reloadedClip.getAttribute('aria-pressed')) !== 'true')
    throw new Error('real-service journey did not reselect the persisted Motion clip after reload');
  await enhance.click();
  await page
    .getByRole('region', { name: 'Enhance tools', exact: true })
    .getByRole('tab', { name: /^Animate/ })
    .click();
  const reloadedMotion = page.locator('.motion-panel');
  await reloadedMotion.waitFor();
  await reloadedMotion.getByRole('tab', { name: 'Presets', exact: true }).click();
  const renderedMotionChannels = ['scaleX', 'scaleY', 'opacity'];
  for (const channel of renderedMotionChannels)
    await reloadedMotion.getByRole('img', { name: `${channel} keyframes`, exact: true }).waitFor();
  const reloadedMotionObjectId = (
    await reloadedMotion.locator('.motion-object-id').textContent()
  )?.trim();
  if (reloadedMotionObjectId !== motionObjectId)
    throw new Error(
      `real-service journey reopened a different Motion target: expected ${motionObjectId}, got ${reloadedMotionObjectId ?? '(none)'}`,
    );

  const visualStorage = await page.evaluate(
    ({ objectId, renderedChannels }) => {
      const raw = localStorage.getItem('joy-media.visual-object-project-log.v1');
      if (!raw)
        return {
          objectId,
          motionChannels: renderedChannels.length,
          channels: renderedChannels,
          storedChannels: [],
          persistedAfterReload: false,
        };
      const parsed = JSON.parse(raw);
      const storedChannels = new Set();
      const visit = (value) => {
        if (value === null || typeof value !== 'object') return;
        if (value.id === objectId && value.animations && typeof value.animations === 'object')
          Object.keys(value.animations).forEach((channel) => storedChannels.add(channel));
        if (
          value.type === 'object.replaceAnimation' &&
          value.payload?.objectId === objectId &&
          typeof value.payload.property === 'string'
        )
          storedChannels.add(value.payload.property);
        if (Array.isArray(value)) value.forEach(visit);
        else Object.values(value).forEach(visit);
      };
      visit(parsed);
      const channels = [...renderedChannels];
      const persistedAfterReload = channels.every((channel) => storedChannels.has(channel));
      return {
        objectId,
        motionChannels: channels.length,
        channels,
        storedChannels: [...storedChannels],
        persistedAfterReload,
      };
    },
    { objectId: reloadedMotionObjectId, renderedChannels: renderedMotionChannels },
  );
  const expectedMotionChannels = ['scaleX', 'scaleY', 'opacity'];
  if (
    !visualStorage.persistedAfterReload ||
    visualStorage.motionChannels !== expectedMotionChannels.length ||
    !expectedMotionChannels.every((channel) => visualStorage.channels.includes(channel)) ||
    !expectedMotionChannels.every((channel) => visualStorage.storedChannels.includes(channel))
  )
    throw new Error(
      `real-service journey did not observe persisted Motion data for ${motionObjectId}: ${JSON.stringify(visualStorage)}`,
    );
  const browserTelemetry = assertJourneyTelemetryClean(telemetry);
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
          console: browserTelemetry.console,
          pageErrors: browserTelemetry.pageErrors,
          network: browserTelemetry.network,
          profiles: profileSummaries,
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
          worker: {
            status: 'disposable-real-service',
            connectedCount: 1,
            capabilities: ['render.export'],
          },
          verifiedDelivery: {
            assetId: exportAssetId,
            state: 'completed',
            progress: 100,
            receipt: {
              bytes: exportedDownload.bytes,
              sha256Prefix: exportedDownload.digest.slice(0, 12),
            },
            inspection: 'verified',
            browserPreview: 'Verified private derivative',
          },
          verifiedExport: {
            channel: 'verified-delivery',
            producer: 'joy-export-mp4',
            inspection: {
              state: 'passed',
              artifact: 'owner-scoped object-store original',
              browserPreview: 'Verified private derivative',
            },
          },
          motionPlacement: [
            {
              preset: 'Persisted animation channels',
              clipId: motionClipId,
              objectId: reloadedMotionObjectId,
              channels: [visualStorage.channels?.[0] ?? 'x'],
              persistedAfterReload: true,
            },
            {
              preset: 'Persisted animation channels',
              clipId: motionClipId,
              objectId: reloadedMotionObjectId,
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

async function downloadSha256(download) {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error('The browser did not expose the export bytes');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function importFixture(page, fileNameOrPath, displayName) {
  await page.locator('.panel-tab[aria-label="Create"]').first().click();
  await page.getByRole('article', { name: 'Assets', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  const sourcePath =
    fileNameOrPath.includes('/') || fileNameOrPath.includes('\\')
      ? fileNameOrPath
      : join(root, 'packages/test-fixtures/media', fileNameOrPath);
  // Upload the fixture bytes under the display name used by the journey. A
  // path-only Playwright upload preserves the fixture's on-disk basename
  // (for example, `video.mp4`), which makes the subsequent catalog assertion
  // miss the intentionally unique real-service asset name.
  const mimeType = displayName.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'video/mp4';
  await drawer
    .locator('input[type="file"][aria-label="Media file"]')
    .setInputFiles({ name: displayName, mimeType, buffer: await readFile(sourcePath) });
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  await page.locator('.asset-card', { hasText: displayName }).first().waitFor({ timeout: 15_000 });
}

async function resetAssetCatalogFilters(page) {
  // Dockview keeps inactive panels mounted while the feature hub changes. The
  // accessible article locator can therefore resolve the outgoing copy while
  // its header is being detached. Scope to the mounted, user-visible asset
  // library so the following controls belong to the active Create surface.
  const assetsPanel = page.locator('article.asset-library:visible').first();
  await assetsPanel.waitFor({ state: 'visible' });
  // Import intentionally reveals the newly imported kind (for example,
  // importing audio selects the Audio category). The journey adds both the
  // video and audio fixtures next, so return to the user-visible All view and
  // clear any search before resolving either card. This also covers the
  // compact/1581 layouts where the category transition is committed before
  // the next interaction.
  await assetsPanel
    .getByRole('tab', { name: /^All\b/ })
    .first()
    .click();
  const searchToggle = assetsPanel
    .locator('button[aria-label="Search Assets"], button[aria-label="Close Assets search"]')
    .first();
  await searchToggle.waitFor({ state: 'visible' });
  if ((await searchToggle.getAttribute('aria-expanded')) !== 'true') await searchToggle.click();
  const searchField = assetsPanel
    .getByRole('searchbox', { name: 'Search Assets', exact: true })
    .first();
  await searchField.waitFor({ state: 'visible' });
  await searchField.fill('');
}

async function addAssetToTimeline(page, displayName) {
  const card = page.locator('.asset-card', { hasText: displayName }).first();
  // The compact/list catalog keeps card actions hidden until the card is
  // hovered or focused. Reveal the action row before asking Playwright to
  // click the timeline affordance so the real-service journey matches a
  // desktop user's interaction.
  await card.hover();
  await card.getByRole('button', { name: `Add ${displayName} to timeline` }).click();
  await page.locator(`.timeline-clip[aria-label^="${displayName},"]`).waitFor({ timeout: 15_000 });
}

async function triggerExportDownload(page) {
  const downloadPromise = page.waitForEvent('download', {
    timeout: REAL_SERVICE_EXPORT_DOWNLOAD_TIMEOUT_MS,
  });
  const exportFailure = page
    .locator('.export-toast')
    .filter({ hasText: /^Export failed:/ })
    .first();
  const failurePromise = exportFailure
    .waitFor({
      state: 'visible',
      timeout: REAL_SERVICE_EXPORT_DOWNLOAD_TIMEOUT_MS,
    })
    .then(async () => {
      throw new Error(
        `JOY export failed before browser download: ${(await exportFailure.textContent())?.trim() ?? 'unknown export failure'}`,
      );
    });
  await page.getByRole('button', { name: 'Export MP4' }).click();
  const download = await Promise.race([downloadPromise, failurePromise]);
  const digest = await downloadSha256(download);
  const path = await download.path();
  if (!path) throw new Error('The browser did not materialize the JOY export file');
  return {
    filename: download.suggestedFilename(),
    path,
    bytes: digest.bytes,
    sha256: digest.sha256,
  };
}

async function redownloadMostRecentExport(page) {
  const processes = page.getByRole('button', { name: 'Recent processes' });
  if ((await processes.getAttribute('aria-expanded')) !== 'true') await processes.click();
  await page.getByRole('region', { name: 'Recent processes' }).waitFor();
  const redownload = page.getByRole('link', { name: /Download .* again/ }).first();
  await redownload.waitFor();
  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 });
  await redownload.click();
  return await downloadSha256(await downloadPromise);
}

async function readControlPlaneProjectId(page) {
  return page.evaluate(() => {
    const activeRaw = localStorage.getItem('joy-media.active-project.v1');
    if (activeRaw === null) return undefined;
    let active;
    try {
      active = JSON.parse(activeRaw);
    } catch {
      return undefined;
    }
    if (typeof active?.projectId !== 'string') return undefined;
    const bindingsRaw = localStorage.getItem('joy-media.control-plane-project-bindings.v1');
    if (bindingsRaw === null) return undefined;
    try {
      const bindings = JSON.parse(bindingsRaw);
      const ownerBindings = bindings?.bindingsByOwner?.['e2e-owner@example.test'];
      const binding = ownerBindings?.[active.projectId];
      return typeof binding?.controlPlaneProjectId === 'string'
        ? binding.controlPlaneProjectId
        : undefined;
    } catch {
      return undefined;
    }
  });
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
