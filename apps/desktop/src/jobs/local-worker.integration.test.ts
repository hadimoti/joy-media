import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFileRegistry } from '../main/file-registry.js';
import { LocalDatabase } from '../store/local-database.js';
import type { DispatchJob } from './job-dispatch.js';
import {
  CANCELLED_BY_USER,
  createJobOrchestrator,
  EXPIRED_LEASE_ERROR,
} from './job-orchestrator.js';
import { startLocalJobApi, type LocalJobApi } from './local-job-api.js';
import { localWorkerEnv } from './worker-env.js';

/**
 * Runs the compiled Worker (`apps/worker/dist`) as a child process against the real loopback job
 * API, with real FFmpeg. Nothing here is mocked: the Worker decodes real video and the desktop
 * stores the JPEG the Worker uploads.
 */

// The Worker build sits beside this package, so it is located from this file, not from the cwd.
const workerDir = fileURLToPath(new URL('../../../worker/', import.meta.url));
const workerEntry = join(workerDir, 'dist', 'index.js');
const tscEntry = fileURLToPath(
  new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url),
);
const readObserverPath = fileURLToPath(new URL('./read-observer.cjs', import.meta.url));

/** The provider key files a Worker process has read, as the read observer logged them. */
function providerFileReads(logPath: string): string[] {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
}
// Above the Worker's 10 s heartbeat interval (apps/worker/src/worker-daemon.ts). At 3 s, a job that is slow under load can
// expire before its first heartbeat. That is the lease rule working as designed, and it was the survives flake (2026-10-28).
const LEASE_CAP_MS = 20_000;
const FIRST_JOB_TIMEOUT_MS = 60_000;

describe('local Worker route (real worker process, real FFmpeg)', () => {
  let dir: string;
  let database: LocalDatabase;
  let api: LocalJobApi;
  let registry: ReturnType<typeof createFileRegistry>;
  let workers: ChildProcess[];
  let videoPath: string;
  let sourceDelayMs = 0;
  let stopApiReads: () => void;

  // The Worker runs from its build, so the build is brought up to date from its source before any test starts.
  // An old build would otherwise pass or fail for reasons the current source does not have.
  beforeAll(() => {
    execFileSync(process.execPath, [tscEntry, '-b', '--force', workerDir], {
      stdio: 'pipe',
      timeout: 120_000,
    });
  }, 150_000);

  beforeEach(async () => {
    if (!existsSync(workerEntry))
      throw new Error(`Worker build missing at ${workerEntry}; run tsc -b apps/worker first`);
    dir = mkdtempSync(join(tmpdir(), 'joy-local-worker-'));
    mkdirSync(join(dir, 'worker'), { recursive: true });
    videoPath = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      videoPath,
    ]);
    database = new LocalDatabase({ filePath: join(dir, 'jobs.sqlite') });
    // Each API gets its own registry, so a source read that outlives its test cannot resolve
    // against the next test's registry.
    const apiRegistry = createFileRegistry();
    registry = apiRegistry;
    let apiStopped = false;
    stopApiReads = () => {
      apiStopped = true;
    };
    api = await startLocalJobApi({
      orchestrator: createJobOrchestrator({
        store: database.jobDispatch,
        maxLeaseMs: LEASE_CAP_MS,
      }),
      derivativeDirectory: join(dir, 'derivatives'),
      sourceSize: async (refId) =>
        (await stat(apiRegistry.resolvePath({ kind: 'local-file', id: refId, displayName: refId })))
          .size,
      readSource: async (refId) => {
        // Holds the source read open for a while so a test can cancel a job that is genuinely running.
        if (sourceDelayMs > 0) await new Promise((done) => setTimeout(done, sourceDelayMs));
        // A read held past the end of its test belongs to a closed API and its removed files.
        if (apiStopped) return new Uint8Array();
        return readFile(
          apiRegistry.resolvePath({ kind: 'local-file', id: refId, displayName: refId }),
        );
      },
      onWarning: (message) => console.warn(message),
    });
    sourceDelayMs = 0;
    workers = [];
  });

  afterEach(async () => {
    for (const worker of workers) if (worker.exitCode === null) worker.kill('SIGKILL');
    stopApiReads();
    await api.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function orchestrator() {
    return createJobOrchestrator({ store: database.jobDispatch, maxLeaseMs: LEASE_CAP_MS });
  }

  // The last output of each Worker, so a timeout can say what the Worker printed before it went quiet.
  const workerTails = new Map<ChildProcess, { text: string }>();

  /** Every Worker process loads the read observer, so a test sees each provider-file read the process makes. */
  function observedEnv(): NodeJS.ProcessEnv {
    return { NODE_OPTIONS: `--require=${readObserverPath.replaceAll('\\', '/')}` };
  }

  function startWorker(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
    const child = spawn(process.execPath, [workerEntry], {
      cwd: workerDir,
      env: {
        ...localWorkerEnv(process.env, { apiEnv: api.workerEnv, workerRoot: join(dir, 'worker') }),
        ...observedEnv(),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = { text: '' };
    const keep = (chunk: Buffer): void => {
      tail.text = `${tail.text}${chunk}`.slice(-1_500);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      keep(chunk);
      process.stdout.write(`[worker] ${chunk}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      keep(chunk);
      process.stderr.write(`[worker] ${chunk}`);
    });
    workerTails.set(child, tail);
    workers.push(child);
    return child;
  }

  // attempts >= 1 means a Worker leased the job; a job still queued with attempts 0 was never leased.
  function workerDiagnostics(child: ChildProcess, jobId: string): string {
    const output = workerTails.get(child)?.text.trim() ?? '';
    const presence = database.jobDispatch.presence();
    const job = database.jobDispatch.get(jobId);
    const state =
      job === undefined
        ? 'missing'
        : `${job.status} attempts=${job.attempts} error=${job.error ?? 'none'}`;
    return (
      `Worker exit=${child.exitCode ?? 'running'} signal=${child.signalCode ?? 'none'}; ` +
      `presence=${presence === undefined ? 'none' : presence.workerId}; ` +
      `job=${state}; ` +
      `last output: ${output.length === 0 ? '(none)' : output}`
    );
  }

  async function waitFor<T>(
    read: () => T | undefined,
    timeoutMs: number,
    label: string,
    context?: () => string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(
      `timed out waiting for ${label}${context === undefined ? '' : `; ${context()}`}`,
    );
  }

  const terminal = (job: DispatchJob | undefined): DispatchJob | undefined =>
    job !== undefined && ['done', 'failed', 'cancelled'].includes(job.status) ? job : undefined;

  function refFor(path: string): string {
    return registry.registerSelection(path, 'clip').id;
  }

  async function waitForWorker(): Promise<void> {
    await waitFor(
      () =>
        database.jobDispatch.presence()?.capabilities.includes('asset.thumbnail')
          ? true
          : undefined,
      FIRST_JOB_TIMEOUT_MS,
      'the Worker to say hello with asset.thumbnail',
    );
  }

  /** Stops a Worker process and waits until it has exited, so the reads it made are all in its log. */
  async function stopWorker(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  }

  it('renders a real thumbnail through the Worker and stores the verified JPEG', async () => {
    const job = orchestrator();
    startWorker();
    await waitForWorker();

    const submitted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`);

    const finished = await waitFor(
      () => terminal(database.jobDispatch.get(submitted.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the thumbnail job to finish',
    );
    expect(finished).toMatchObject({ status: 'done', progress: 100 });
    const derivative = finished.derivative;
    if (derivative === undefined) throw new Error('expected a stored derivative');
    const bytes = readFileSync(derivative.path);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(derivative.sha256);
    expect(derivative).toMatchObject({ mimeType: 'image/jpeg', bytes: bytes.length });
    expect(JSON.parse(finished.resultJson ?? '{}')).toMatchObject({ kind: 'asset.thumbnail' });
  }, 90_000);

  it('keeps a provider key file out of a local Worker, which advertises no AI provider and reads no key file', async () => {
    // A key file in the Worker PC's home directory, the file a standalone Worker would read at startup.
    const home = join(dir, 'home');
    mkdirSync(join(home, '.joy-media'), { recursive: true });
    writeFileSync(
      join(home, '.joy-media', 'ai-providers.json'),
      JSON.stringify({
        'lm-studio': {
          baseUrl: 'http://127.0.0.1:1234/v1',
          apiKey: 'sk-local-boundary-test',
          defaultModel: 'local-model',
        },
      }),
    );
    const localLog = join(dir, 'provider-reads-local.log');
    const local = startWorker({ HOME: home, USERPROFILE: home, JOY_TEST_READ_LOG: localLog });
    await waitForWorker();
    expect(database.jobDispatch.presence()?.capabilities).not.toContain('text.lm-studio');

    // A job the Worker really runs, so the reads it makes on the way to a result are observed too.
    const job = orchestrator();
    const submitted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`);
    await waitFor(
      () => terminal(database.jobDispatch.get(submitted.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the thumbnail job to finish',
    );

    // Checked after the Worker has stopped: the log then holds every read the process made in its life.
    await stopWorker(local);
    expect(providerFileReads(localLog)).toEqual([]);

    // Control: a Worker with no local token reads the same file. Its own log, so the local run cannot satisfy it.
    const standaloneLog = join(dir, 'provider-reads-standalone.log');
    const standalone = spawn(process.execPath, [workerEntry], {
      cwd: workerDir,
      env: {
        ...localWorkerEnv(process.env, { apiEnv: {}, workerRoot: join(dir, 'standalone') }),
        ...observedEnv(),
        HOME: home,
        USERPROFILE: home,
        JOY_TEST_READ_LOG: standaloneLog,
      },
      stdio: 'ignore',
    });
    try {
      await waitFor(
        () => (providerFileReads(standaloneLog).length > 0 ? true : undefined),
        FIRST_JOB_TIMEOUT_MS,
        'the standalone Worker to read its provider file',
      );
    } finally {
      await stopWorker(standalone);
    }
  }, 150_000);

  it('reports a real failure, with no derivative, when the source is not a video', async () => {
    const job = orchestrator();
    const notVideo = join(dir, 'not-a-video.bin');
    writeFileSync(notVideo, 'this is plain text, not media');
    startWorker();
    await waitForWorker();

    const submitted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(notVideo),
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`);

    const failed = await waitFor(
      () => terminal(database.jobDispatch.get(submitted.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the failing thumbnail job to finish',
    );
    expect(failed.status).toBe('failed');
    expect(failed.error ?? '').not.toBe('');
    expect(failed.derivative).toBeUndefined();
  }, 90_000);

  it('cancels a queued job before any Worker runs it, and never renders it', async () => {
    const job = orchestrator();
    const submitted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`);
    expect(job.requestCancel(submitted.jobId)).toMatchObject({
      ok: true,
      job: { status: 'cancelled' },
    });

    startWorker();
    await waitForWorker();
    await new Promise((done) => setTimeout(done, 1_500));
    expect(database.jobDispatch.get(submitted.jobId)).toMatchObject({ status: 'cancelled' });
    expect(database.jobDispatch.get(submitted.jobId)?.derivative).toBeUndefined();
  }, 90_000);

  it('cancels a job that is already running on the real Worker, and the Worker stops before it renders', async () => {
    sourceDelayMs = 4_000;
    const job = orchestrator();
    startWorker();
    await waitForWorker();

    const submitted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`submit refused: ${submitted.message}`);
    await waitFor(
      () => (database.jobDispatch.get(submitted.jobId)?.status === 'running' ? true : undefined),
      FIRST_JOB_TIMEOUT_MS,
      'the Worker to lease the job',
    );
    expect(job.requestCancel(submitted.jobId)).toMatchObject({
      ok: true,
      job: { status: 'running', cancelRequested: true },
    });

    const cancelled = await waitFor(
      () => terminal(database.jobDispatch.get(submitted.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the cancelled job to reach a terminal state',
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', error: CANCELLED_BY_USER });
    expect(cancelled.derivative).toBeUndefined();
  }, 90_000);

  it('refuses masking with SETUP_REQUIRED when the real Worker has no masking models', async () => {
    const job = orchestrator();
    startWorker();
    await waitForWorker();
    expect(
      job.submit({ jobType: 'mask.image', refId: refFor(videoPath), kind: 'derivative:mask' }),
    ).toMatchObject({
      ok: false,
      code: 'SETUP_REQUIRED',
      jobType: 'mask.image',
    });
  }, 90_000);

  it('survives a Worker killed mid-job: the lease expires instead of hanging, and a restarted Worker completes new work', async () => {
    const job = orchestrator();
    const first = startWorker();
    await waitForWorker();

    // Hold the source read open so the Worker is still mid-job when it is killed. Without the
    // hold, a fast job can finish between two 100 ms polls and never be seen as running.
    sourceDelayMs = 4_000;
    const interrupted = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!interrupted.ok) throw new Error(`submit refused: ${interrupted.message}`);

    await waitFor(
      () => (database.jobDispatch.get(interrupted.jobId)?.status === 'running' ? true : undefined),
      FIRST_JOB_TIMEOUT_MS,
      'the Worker to lease the job',
      () => workerDiagnostics(first, interrupted.jobId),
    );
    expect(database.jobDispatch.get(interrupted.jobId)).toMatchObject({ status: 'running' });
    first.kill('SIGKILL');

    const afterCrash = await waitFor(
      () => terminal(database.jobDispatch.get(interrupted.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the orphaned job to reach a terminal state',
    );
    // The Worker died while its source read was held, so the job can only end by lease expiry.
    expect(afterCrash).toMatchObject({ status: 'failed', error: EXPIRED_LEASE_ERROR });

    sourceDelayMs = 0;
    startWorker();
    await waitForWorker();
    const next = job.submit({
      jobType: 'asset.thumbnail',
      refId: refFor(videoPath),
      kind: 'derivative:thumbnail',
    });
    if (!next.ok) throw new Error(`submit refused: ${next.message}`);
    const recovered = await waitFor(
      () => terminal(database.jobDispatch.get(next.jobId)),
      FIRST_JOB_TIMEOUT_MS,
      'the post-restart thumbnail job to finish',
    );
    // Same condition as before. A failure now says which error the job recorded.
    expect(recovered.status, `post-restart job: ${recovered.error ?? 'no error recorded'}`).toBe(
      'done',
    );
  }, 180_000);
});
