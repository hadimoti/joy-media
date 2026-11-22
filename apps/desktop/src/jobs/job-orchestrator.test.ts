import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpathSync as fsRealpathSync } from 'node:fs';
import type { realpathSync as RealpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../store/local-database.js';
import {
  CANCELLED_BY_USER,
  createJobOrchestrator,
  EXPIRED_LEASE_ERROR,
  JobProtocolError,
  type JobOrchestrator,
} from './job-orchestrator.js';

const WORKER = 'worker-a';
const THUMBNAIL_CAPABILITIES = ['asset.thumbnail'];

describe('job orchestrator', () => {
  let dir: string;
  let database: LocalDatabase;
  let clock: number;
  let ids: number;
  let tokens: number;

  const at = (ms: number) => new Date(Date.parse('2026-10-21T00:00:00.000Z') + ms).toISOString();

  function open(filePath: string): LocalDatabase {
    return new LocalDatabase({ filePath });
  }

  function orchestratorFor(
    db: LocalDatabase,
    maxLeaseMs = 3_000,
    removeDerivativeFile?: (path: string) => void,
  ): JobOrchestrator {
    const orchestrator = createJobOrchestrator({
      store: db.jobDispatch,
      now: () => at(clock),
      newId: () => `job-${++ids}`,
      newLeaseToken: () => `lease-${++tokens}`,
      maxLeaseMs,
      ...(removeDerivativeFile === undefined ? {} : { removeDerivativeFile }),
    });
    orchestrator.configureDerivativeCleanup(join(dir, 'derivatives'));
    return orchestrator;
  }

  /** HTTP status a protocol refusal maps onto, or undefined when the call succeeds. */
  function refusalStatus(call: () => unknown): number | undefined {
    try {
      call();
      return undefined;
    } catch (error) {
      return error instanceof JobProtocolError ? error.status : undefined;
    }
  }

  function submitThumbnail(orchestrator: JobOrchestrator, refId = 'ref-1'): string {
    const submitted = orchestrator.submit({
      jobType: 'asset.thumbnail',
      refId,
      kind: 'derivative:thumbnail',
    });
    if (!submitted.ok) throw new Error(`expected a queued job, got ${submitted.code}`);
    return submitted.jobId;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'joy-jobs-'));
    database = open(join(dir, 'jobs.sqlite'));
    clock = 0;
    ids = 0;
    tokens = 0;
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('submission', () => {
    it('queues a thumbnail before the Worker has said hello', () => {
      const orchestrator = orchestratorFor(database);
      const jobId = submitThumbnail(orchestrator);
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'queued',
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
      });
    });

    it('refuses a mask job with SETUP_REQUIRED before the Worker reports its capabilities', () => {
      const result = orchestratorFor(database).submit({
        jobType: 'mask.image',
        refId: 'ref-1',
        kind: 'derivative:mask',
      });
      expect(result).toMatchObject({ ok: false, code: 'SETUP_REQUIRED', jobType: 'mask.image' });
    });

    it('requires the speech capability and the exact engine flag before accepting a valid payload', () => {
      const orchestrator = orchestratorFor(database);
      const request = {
        jobType: 'speech.transcribe',
        refId: 'ref-audio',
        kind: 'speech.transcribe',
        payload: { schemaVersion: 1, language: 'fa-IR', modelId: 'faster-whisper-large-v3-turbo' },
      };
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      // A worker that only reports a synthesis engine cannot transcribe.
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      // The real worker advertises speech.transcribe once Whisper is verified; it has no Whisper model flag.
      orchestrator.hello(WORKER, ['speech.transcribe']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: true });
    });

    it('still requires the exact engine flag for synthesis', () => {
      const orchestrator = orchestratorFor(database);
      const request = {
        jobType: 'speech.synthesize',
        kind: 'speech.synthesize',
        refId: 'speech-output',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      };
      orchestrator.hello(WORKER, ['speech.synthesize']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.chatterbox-en']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: true });
    });

    it('requires a source for transcription and preserves optional synthesis references', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, [
        'speech.transcribe',
        'speech.model.faster-whisper-large-v3-turbo',
        'speech.synthesize',
        'speech.model.kokoro-82m',
        'speech.model.chatterbox-en',
      ]);
      expect(
        orchestrator.submit({
          jobType: 'speech.transcribe',
          refId: ' ',
          kind: 'speech.transcribe',
          payload: {
            schemaVersion: 1,
            language: 'en-US',
            modelId: 'faster-whisper-large-v3-turbo',
          },
        }),
      ).toMatchObject({ ok: false, code: 'PAYLOAD_INVALID' });
      const selectedSource = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'voice-reference-a',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'chatterbox-en', text: 'Hello' },
      });
      expect(selectedSource).toMatchObject({ ok: true });
      if (!selectedSource.ok) throw new Error('expected synthesis to be queued');
      expect(orchestrator.lease(WORKER)?.refId).toBe('voice-reference-a');
    });

    it('rejects malformed speech payloads and accepts a valid synthesis payload', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const base = {
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
      };
      expect(orchestrator.submit({ ...base, payload: { schemaVersion: 1 } })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      expect(
        orchestrator.submit({
          ...base,
          payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
        }),
      ).toMatchObject({ ok: true });
    });

    it('queues picture and video mask jobs with their payload once the Worker advertises the capability', () => {
      const orchestrator = orchestratorFor(database);
      const request = (jobType: string, payload?: Record<string, unknown>) => ({
        jobType,
        refId: 'ref-1',
        kind: 'derivative:mask',
        payload,
      });
      orchestrator.hello(WORKER, ['mask.image']);
      expect(orchestrator.submit(request('mask.video', { mode: 'subject' }))).toMatchObject({
        ok: false,
        code: 'SETUP_REQUIRED',
        jobType: 'mask.video',
      });
      expect(orchestrator.submit(request('mask.image'))).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      const image = orchestrator.submit(request('mask.image', { mode: 'subject' }));
      if (!image.ok) throw new Error(`expected a queued job, got ${image.code}`);
      orchestrator.hello(WORKER, ['mask.image', 'mask.video']);
      const video = orchestrator.submit(request('mask.video', { mode: 'subject' }));
      expect(video.ok).toBe(true);
      expect(orchestrator.lease(WORKER)).toMatchObject({
        id: image.jobId,
        jobType: 'mask.image',
        payload: { mode: 'subject' },
      });
    });

    it('refuses a thumbnail with SETUP_REQUIRED when the Worker lacks FFmpeg', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, []);
      const result = orchestrator.submit({
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        kind: 'derivative:thumbnail',
      });
      expect(result).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      if (result.ok) throw new Error('unreachable');
      expect(result.message).toContain('FFmpeg');
    });

    it('refuses a QC job until the Worker advertises media.qc, then leases it with its payload and keeps the report', () => {
      const orchestrator = orchestratorFor(database);
      const request = {
        jobType: 'media.qc',
        refId: 'asset-1',
        kind: 'media.qc',
        payload: { checks: ['black'] },
      };
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      orchestrator.hello(WORKER, ['asset.thumbnail']);
      expect(orchestrator.submit(request)).toMatchObject({ ok: false, code: 'SETUP_REQUIRED' });
      orchestrator.hello(WORKER, ['media.qc']);
      expect(orchestrator.submit({ ...request, payload: undefined })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      const submitted = orchestrator.submit(request);
      if (!submitted.ok) throw new Error(`expected a queued job, got ${submitted.code}`);
      const leased = orchestrator.lease(WORKER);
      expect(leased).toMatchObject({
        id: submitted.jobId,
        jobType: 'media.qc',
        refId: 'asset-1',
        payload: { checks: ['black'] },
      });
      const resultJson = JSON.stringify({ kind: 'media.qc', assetId: 'asset-1', report: {} });
      orchestrator.complete(WORKER, submitted.jobId, leased?.leaseToken ?? '', {
        kind: 'media.qc',
        resultJson,
      });
      expect(orchestrator.get(submitted.jobId)).toMatchObject({ status: 'done', resultJson });
    });

    it('refuses an upscale job without its payload, even when the Worker advertises the model', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['upscale.image']);
      const result = orchestrator.submit({
        jobType: 'upscale.image',
        refId: 'ref-1',
        kind: 'derivative:upscale',
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
        jobType: 'upscale.image',
      });
    });

    it('hands an upscale job and its payload to the Worker with the lease', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['upscale.image']);
      const payload = { mediaKind: 'image', modelSha256: 'a'.repeat(64), sourcePath: 'in.png' };
      expect(
        orchestrator.submit({
          jobType: 'upscale.image',
          refId: 'ref-1',
          kind: 'derivative:upscale',
          payload,
        }),
      ).toMatchObject({ ok: true });
      expect(orchestrator.lease(WORKER)).toMatchObject({
        jobType: 'upscale.image',
        refId: 'ref-1',
        payload,
      });
    });

    it('queues a render export only with a JSON object payload within the size cap', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['render.export']);
      const base = { jobType: 'render.export', refId: 'project-1', kind: 'render' };
      expect(orchestrator.submit({ ...base, payload: ['not', 'an', 'object'] })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      expect(orchestrator.submit({ ...base, payload: { blob: 'x'.repeat(70_000) } })).toMatchObject(
        {
          ok: false,
          code: 'PAYLOAD_INVALID',
        },
      );
      expect(orchestrator.submit({ ...base, payload: { schemaVersion: 1 } })).toMatchObject({
        ok: true,
      });
    });

    it('refuses a payload that is not a plain JSON object, without throwing', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['render.export']);
      const base = { jobType: 'render.export', refId: 'project-1', kind: 'render' };
      expect(orchestrator.submit({ ...base, payload: new Date() })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      expect(orchestrator.submit({ ...base, payload: { toJSON: () => undefined } })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
      expect(orchestrator.submit({ ...base, payload: { toJSON: () => 'text' } })).toMatchObject({
        ok: false,
        code: 'PAYLOAD_INVALID',
      });
    });

    it('refuses a payload on a job type that does not take one', () => {
      const result = orchestratorFor(database).submit({
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        kind: 'derivative:thumbnail',
        payload: { unexpected: true },
      });
      expect(result).toMatchObject({ ok: false, code: 'PAYLOAD_INVALID' });
    });
  });

  describe('leasing', () => {
    it('hands the queued job to the Worker once and marks it running with a lease', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);

      const leased = orchestrator.lease(WORKER);
      expect(leased).toEqual({
        id: jobId,
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        leaseToken: 'lease-1',
      });
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'running',
        workerId: WORKER,
        attempts: 1,
      });
      expect(orchestrator.lease(WORKER)).toBeUndefined();
    });

    it('refuses a lease from a Worker id that did not say hello', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      submitThumbnail(orchestrator);
      expect(() => orchestrator.lease('someone-else')).toThrow(JobProtocolError);
    });

    it('never leases a job the Worker did not advertise', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, []);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      submitThumbnail(orchestrator);
      orchestrator.hello(WORKER, []);
      expect(orchestrator.lease(WORKER)).toBeUndefined();
    });
  });

  describe('progress and the lease token', () => {
    it('renews the lease on heartbeat and reports a pending cancel', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a lease');

      clock = 2_000;
      expect(orchestrator.heartbeat(WORKER, jobId, leased.leaseToken, 40)).toEqual({
        cancelRequested: false,
      });
      expect(orchestrator.get(jobId)).toMatchObject({ progress: 40, status: 'running' });
    });

    it('rejects a heartbeat with the wrong lease token', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      orchestrator.lease(WORKER);
      expect(refusalStatus(() => orchestrator.heartbeat(WORKER, jobId, 'forged', 10))).toBe(409);
    });
  });

  describe('completion and failure', () => {
    it('completes only once the derivative bytes match the reported digest', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a lease');

      expect(
        refusalStatus(() =>
          orchestrator.complete(WORKER, jobId, leased.leaseToken, {
            kind: 'asset.thumbnail',
            sha256: 'abc',
            bytes: 3,
            resultJson: '{}',
          }),
        ),
      ).toBe(422);
      expect(orchestrator.get(jobId)?.status).toBe('running');

      orchestrator.recordDerivative(WORKER, jobId, leased.leaseToken, {
        sha256: 'abc',
        bytes: 3,
        mimeType: 'image/jpeg',
        path: join(dir, 'd.jpg'),
      });
      orchestrator.complete(WORKER, jobId, leased.leaseToken, {
        kind: 'asset.thumbnail',
        sha256: 'abc',
        bytes: 3,
        resultJson: '{"kind":"asset.thumbnail"}',
      });
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'done',
        progress: 100,
        leaseToken: undefined,
      });
    });

    it('records a worker failure with its message, capped in length', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a lease');
      orchestrator.fail(WORKER, jobId, leased.leaseToken, 'x'.repeat(500));
      const failed = orchestrator.get(jobId);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toHaveLength(240);
    });
  });

  describe('cancellation', () => {
    it('cancels a queued job immediately', () => {
      const orchestrator = orchestratorFor(database);
      const jobId = submitThumbnail(orchestrator);
      expect(orchestrator.requestCancel(jobId)).toMatchObject({
        ok: true,
        job: { status: 'cancelled' },
      });
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'cancelled',
        error: CANCELLED_BY_USER,
      });
    });

    it('flags a running job, which the Worker learns of on its next heartbeat and then reports as cancelled', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a lease');

      expect(orchestrator.requestCancel(jobId)).toMatchObject({
        ok: true,
        job: { status: 'running', cancelRequested: true },
      });
      expect(orchestrator.heartbeat(WORKER, jobId, leased.leaseToken, 10)).toEqual({
        cancelRequested: true,
      });
      orchestrator.fail(WORKER, jobId, leased.leaseToken, 'canceled');
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'cancelled',
        error: CANCELLED_BY_USER,
      });
    });

    it('honors a pending cancellation when the late Worker failure is not labeled canceled', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const derivativeDirectory = join(dir, 'derivatives');
      mkdirSync(derivativeDirectory, { recursive: true });
      const path = join(derivativeDirectory, `${submitted.jobId}-${'a'.repeat(16)}.wav`);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'a'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });

      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'completion rejected');

      expect(orchestrator.get(submitted.jobId)).toMatchObject({
        status: 'cancelled',
        error: CANCELLED_BY_USER,
        derivative: undefined,
      });
      expect(existsSync(path)).toBe(false);
    });

    it('refuses to cancel a finished job', () => {
      const orchestrator = orchestratorFor(database);
      const jobId = submitThumbnail(orchestrator);
      orchestrator.requestCancel(jobId);
      expect(orchestrator.requestCancel(jobId)).toEqual({
        ok: false,
        error: 'Cannot cancel a job in status "cancelled"',
      });
    });
  });

  describe('lease expiry and crash recovery', () => {
    it('fails a job whose Worker stopped renewing its lease, rather than leaving it running', () => {
      const orchestrator = orchestratorFor(database, 3_000);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      orchestrator.lease(WORKER);

      clock = 2_999;
      expect(orchestrator.expireLeases()).toBe(0);
      clock = 3_001;
      expect(orchestrator.expireLeases()).toBe(1);
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'failed',
        error: EXPIRED_LEASE_ERROR,
      });
    });

    it('cancels an expired lease that the user had asked to cancel', () => {
      const orchestrator = orchestratorFor(database, 3_000);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      orchestrator.lease(WORKER);
      orchestrator.requestCancel(jobId);
      clock = 5_000;
      orchestrator.expireLeases();
      expect(orchestrator.get(jobId)).toMatchObject({
        status: 'cancelled',
        error: CANCELLED_BY_USER,
      });
    });

    it('deletes an uploaded speech derivative when its lease expires', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const derivativeDirectory = join(dir, 'derivatives');
      mkdirSync(derivativeDirectory, { recursive: true });
      const path = join(derivativeDirectory, `${submitted.jobId}-${'a'.repeat(16)}.wav`);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'a'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });
      clock = 4_000;
      expect(orchestrator.expireLeases()).toBe(1);
      expect(orchestrator.get(submitted.jobId)?.status).toBe('failed');
      expect(existsSync(path)).toBe(false);
    });

    it('retries a failed speech derivative deletion on the next sweep', () => {
      let failFirstDelete = true;
      const orchestrator = orchestratorFor(database, 3_000, (path) => {
        if (failFirstDelete) {
          failFirstDelete = false;
          throw new Error('simulated transient delete failure');
        }
        rmSync(path);
      });
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const derivativeDirectory = join(dir, 'derivatives');
      const path = join(derivativeDirectory, `${submitted.jobId}-${'b'.repeat(16)}.wav`);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'b'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });

      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');
      expect(orchestrator.get(submitted.jobId)).toMatchObject({
        status: 'cancelled',
        derivative: undefined,
      });
      expect(existsSync(path)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(derivativeDirectory, 'pending-cleanup.json'), 'utf8')),
      ).toEqual([{ jobId: submitted.jobId, fileName: `${submitted.jobId}-${'b'.repeat(16)}.wav` }]);
      orchestrator.expireLeases();
      expect(existsSync(path)).toBe(false);
    });

    it('retains an in-memory cleanup when persistence fails and writes it on the next sweep', () => {
      let failDelete = true;
      const orchestrator = orchestratorFor(database, 3_000, (file) => {
        if (failDelete) throw new Error('temporary delete failure');
        rmSync(file);
      });
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const directory = join(dir, 'derivatives');
      const fileName = `${submitted.jobId}-${'9'.repeat(16)}.wav`;
      const path = join(directory, fileName);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: '9'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });
      mkdirSync(join(directory, 'pending-cleanup.json'));
      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');
      expect(existsSync(path)).toBe(true);
      rmSync(join(directory, 'pending-cleanup.json'), { recursive: true });
      orchestrator.expireLeases();
      expect(JSON.parse(readFileSync(join(directory, 'pending-cleanup.json'), 'utf8'))).toEqual([
        { jobId: submitted.jobId, fileName },
      ]);
      failDelete = false;
      orchestrator.expireLeases();
      expect(existsSync(path)).toBe(false);
    });

    it('retains and retries cleanup after a transient realpath error', () => {
      const orchestrator = orchestratorFor(database);
      const directory = join(dir, 'derivatives');
      const fileName = `job-retry-${'8'.repeat(16)}.wav`;
      const path = join(directory, fileName);
      writeFileSync(path, 'wav');
      writeFileSync(
        join(directory, 'pending-cleanup.json'),
        JSON.stringify([{ jobId: 'job-retry', fileName }]),
      );
      let failRealpath = true;
      const restarted = createJobOrchestrator({
        store: database.jobDispatch,
        realpathSync: ((target) => {
          if (failRealpath) {
            failRealpath = false;
            throw Object.assign(new Error('temporary I/O'), { code: 'EIO' });
          }
          return fsRealpathSync(target);
        }) as typeof RealpathSync,
      });
      restarted.configureDerivativeCleanup(directory);
      expect(existsSync(path)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(directory, 'pending-cleanup.json'), 'utf8')),
      ).toHaveLength(1);
      failRealpath = false;
      restarted.expireLeases();
      expect(existsSync(path)).toBe(false);
    });

    it('never deletes a speech derivative outside the derivative directory', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const path = join(dir, `${submitted.jobId}-${'c'.repeat(16)}.wav`);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'c'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });

      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');

      expect(existsSync(path)).toBe(true);
    });

    it('refuses a traversal path even when its normalized target is inside the configured directory', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const directory = join(dir, 'derivatives');
      const path = `${directory}\\..\\derivatives\\${submitted.jobId}-${'d'.repeat(16)}.wav`;
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'd'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });
      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');
      expect(existsSync(path)).toBe(true);
    });

    it('refuses a derivative symlink that resolves outside the configured directory', ({
      skip,
    }) => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const outside = join(dir, `${submitted.jobId}-${'e'.repeat(16)}.wav`);
      const link = join(dir, 'derivatives', `${submitted.jobId}-${'e'.repeat(16)}.wav`);
      writeFileSync(outside, 'wav');
      try {
        symlinkSync(outside, link, 'file');
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (!['EACCES', 'EPERM', 'ENOTSUP', 'UNKNOWN'].includes(code)) throw error;
        skip('the operating system refused to create a file symlink');
      }
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'e'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path: link,
      });
      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');
      expect(readFileSync(outside, 'utf8')).toBe('wav');
    });

    it('refuses a matching file in a sibling derivatives directory', () => {
      const orchestrator = orchestratorFor(database);
      orchestrator.hello(WORKER, ['speech.synthesize', 'speech.model.kokoro-82m']);
      const submitted = orchestrator.submit({
        jobType: 'speech.synthesize',
        refId: 'speech-output',
        kind: 'speech.synthesize',
        payload: { schemaVersion: 1, language: 'en-US', modelId: 'kokoro-82m', text: 'Hello' },
      });
      if (!submitted.ok) throw new Error('expected synthesis job');
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a speech lease');
      const sibling = join(dir, 'sibling', 'derivatives');
      mkdirSync(sibling, { recursive: true });
      const path = join(sibling, `${submitted.jobId}-${'f'.repeat(16)}.wav`);
      writeFileSync(path, 'wav');
      orchestrator.recordDerivative(WORKER, submitted.jobId, leased.leaseToken, {
        sha256: 'f'.repeat(64),
        bytes: 3,
        mimeType: 'audio/wav',
        path,
      });
      orchestrator.requestCancel(submitted.jobId);
      orchestrator.fail(WORKER, submitted.jobId, leased.leaseToken, 'canceled');
      expect(existsSync(path)).toBe(true);
    });

    it('loads persisted cleanup records in a new orchestrator instance', () => {
      const orchestrator = orchestratorFor(database);
      const directory = join(dir, 'derivatives');
      const jobId = 'job-restart';
      const fileName = `${jobId}-${'1'.repeat(16)}.wav`;
      const file = join(directory, fileName);
      writeFileSync(file, 'wav');
      writeFileSync(join(directory, 'pending-cleanup.json'), JSON.stringify([{ jobId, fileName }]));
      const restarted = createJobOrchestrator({ store: database.jobDispatch });
      restarted.configureDerivativeCleanup(directory);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(directory, 'pending-cleanup.json'))).toBe(false);
      void orchestrator;
    });

    it('discards a persisted record naming an outside file without deleting it', () => {
      const orchestrator = orchestratorFor(database);
      const directory = join(dir, 'derivatives');
      const outside = join(dir, 'outside.wav');
      writeFileSync(outside, 'keep');
      writeFileSync(
        join(directory, 'pending-cleanup.json'),
        JSON.stringify([{ jobId: 'job-outside', fileName: `..\\outside.wav` }]),
      );
      const warnings: string[] = [];
      const restarted = createJobOrchestrator({ store: database.jobDispatch });
      restarted.configureDerivativeCleanup(directory, (message) => warnings.push(message));
      expect(readFileSync(outside, 'utf8')).toBe('keep');
      expect(existsSync(join(directory, 'pending-cleanup.json'))).toBe(false);
      expect(warnings.every((message) => !message.includes(dir))).toBe(true);
      void orchestrator;
    });

    it('keeps a dispatched job, its lease and its progress across a desktop restart', () => {
      const filePath = join(dir, 'restart.sqlite');
      const first = open(filePath);
      const orchestrator = orchestratorFor(first, 60_000);
      orchestrator.hello(WORKER, THUMBNAIL_CAPABILITIES);
      const jobId = submitThumbnail(orchestrator);
      const leased = orchestrator.lease(WORKER);
      if (leased === undefined) throw new Error('expected a lease');
      orchestrator.heartbeat(WORKER, jobId, leased.leaseToken, 55);
      first.close();

      const second = open(filePath);
      try {
        const restarted = orchestratorFor(second, 60_000);
        expect(restarted.get(jobId)).toMatchObject({
          status: 'running',
          progress: 55,
          workerId: WORKER,
          leaseToken: leased.leaseToken,
        });
        expect(restarted.heartbeat(WORKER, jobId, leased.leaseToken, 60)).toEqual({
          cancelRequested: false,
        });
      } finally {
        second.close();
      }
    });
  });
});
