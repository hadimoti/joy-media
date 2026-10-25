import { mkdtempSync, rmSync } from 'node:fs';
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

  function orchestratorFor(db: LocalDatabase, maxLeaseMs = 3_000): JobOrchestrator {
    return createJobOrchestrator({
      store: db.jobDispatch,
      now: () => at(clock),
      newId: () => `job-${++ids}`,
      newLeaseToken: () => `lease-${++tokens}`,
      maxLeaseMs,
    });
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
