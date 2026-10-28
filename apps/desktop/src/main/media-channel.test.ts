import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../store/local-database.js';
import { createJobOrchestrator } from '../jobs/job-orchestrator.js';
import type { DispatchJob } from '../jobs/job-dispatch.js';
import { createMediaChannelHandlers, MEDIA_CHANNELS } from './media-channel.js';

function setup() {
  const db = new LocalDatabase({ filePath: ':memory:', now: () => 'T0' });
  let ids = 0;
  const orchestrator = createJobOrchestrator({
    store: db.jobDispatch,
    now: () => 'T0',
    newId: () => `job-${++ids}`,
    newLeaseToken: () => 'lease-token',
  });
  const handlers = createMediaChannelHandlers({
    orchestrator,
    jobStore: db.jobDispatch,
  });
  return { db, orchestrator, handlers };
}

describe('desktop.media channels', () => {
  it('declares every media channel once', () => {
    expect(new Set(MEDIA_CHANNELS).size).toBe(MEDIA_CHANNELS.length);
    expect(MEDIA_CHANNELS).toHaveLength(11);
  });

  it('refuses a render before the Worker has reported the capability', () => {
    const { handlers } = setup();
    const result = handlers['desktop.media.render.enqueue']({
      refId: 'ref-1',
      payload: { timeline: [] },
    });
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('Worker has not reported its capabilities'),
    });
  });

  it('queues a render once the Worker has reported it, and reports its status', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    const queued = handlers['desktop.media.render.enqueue']({
      refId: 'ref-1',
      payload: { timeline: [] },
    });
    expect(queued).toEqual({ ok: true, data: { jobId: 'job-1' } });
    const status = handlers['desktop.media.job.status']({ jobId: 'job-1' });
    expect(status).toMatchObject({ ok: true, data: { id: 'job-1', status: 'queued' } });
  });

  it('never returns a lease token, a worker id or a path in job status', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: {} });
    const serialized = JSON.stringify(handlers['desktop.media.job.status']({ jobId: 'job-1' }));
    expect(serialized).not.toContain('lease-token');
    expect(serialized).not.toContain('w-1');
    expect(serialized).not.toContain('path');
  });

  it('cancels a queued job, and reports the result', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: {} });
    const cancelled = handlers['desktop.media.job.cancel']({ jobId: 'job-1' });
    expect(cancelled).toMatchObject({ ok: true, data: { id: 'job-1', status: 'cancelled' } });
  });

  it('refuses an unknown job and an invalid job id', () => {
    const { handlers } = setup();
    expect(handlers['desktop.media.job.status']({ jobId: 'missing' })).toEqual({
      ok: false,
      error: 'Unknown job',
    });
    expect(handlers['desktop.media.job.status']({ jobId: '../escape' })).toEqual({
      ok: false,
      error: 'Invalid job id',
    });
  });

  it('refuses a render request with no reference or with a non-object payload', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['render.export']);
    expect(handlers['desktop.media.render.enqueue']({ payload: {} })).toEqual({
      ok: false,
      error: 'Invalid media request',
    });
    expect(handlers['desktop.media.render.enqueue']({ refId: 'ref-1', payload: [] })).toEqual({
      ok: false,
      error: 'Invalid media request',
    });
  });

  it('lists workers: none before a hello, then the reporting Worker', () => {
    const { orchestrator, handlers } = setup();
    expect(handlers['desktop.media.workers.list']({})).toEqual({ ok: true, data: [] });
    orchestrator.hello('w-1', ['render.export', 'audio.ml-denoise']);
    const listed = handlers['desktop.media.workers.list']({}) as {
      data: { workerId: string; capabilities: string[]; lastHelloAt: string }[];
    };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ workerId: 'w-1', lastHelloAt: 'T0' });
    expect([...listed.data[0]!.capabilities].sort()).toEqual(['audio.ml-denoise', 'render.export']);
  });

  it('refuses denoise, because the orchestrator does not dispatch audio.ml-denoise yet', () => {
    const { orchestrator, handlers } = setup();
    orchestrator.hello('w-1', ['audio.ml-denoise']);
    expect(handlers['desktop.media.audio.denoise']({ refId: 'ref-1', payload: {} })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not available'),
    });
  });

  it('returns a finished derivative as bytes, after checking its checksum, and never its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-media-channel-'));
    try {
      const bytes = Buffer.from('thumbnail-bytes');
      const path = join(dir, 'job-d-thumb.jpg');
      writeFileSync(path, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const { db, handlers } = setup();
      const job: DispatchJob = {
        id: 'job-d',
        kind: 'derivative:thumbnail',
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        status: 'done',
        createdAt: 'T0',
        updatedAt: 'T0',
        error: undefined,
        progress: 1,
        attempts: 1,
        workerId: 'w-1',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        cancelRequested: false,
        derivative: { sha256, bytes: bytes.length, mimeType: 'image/jpeg', path },
        resultJson: undefined,
      };
      db.jobDispatch.insert(job);

      const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-d' });
      expect(result).toMatchObject({
        ok: true,
        data: { mimeType: 'image/jpeg', sha256 },
      });
      expect(JSON.stringify(result)).not.toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a derivative whose bytes no longer match the recorded checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-media-channel-'));
    try {
      const path = join(dir, 'job-bad-thumb.jpg');
      writeFileSync(path, Buffer.from('tampered'));
      const { db, handlers } = setup();
      const job: DispatchJob = {
        id: 'job-bad',
        kind: 'derivative:thumbnail',
        jobType: 'asset.thumbnail',
        refId: 'ref-1',
        status: 'done',
        createdAt: 'T0',
        updatedAt: 'T0',
        error: undefined,
        progress: 1,
        attempts: 1,
        workerId: 'w-1',
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        cancelRequested: false,
        derivative: { sha256: 'a'.repeat(64), bytes: 8, mimeType: 'image/jpeg', path },
        resultJson: undefined,
      };
      db.jobDispatch.insert(job);
      const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-bad' });
      expect(result).toEqual({ ok: false, error: 'Derivative failed its checksum' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a derivative file that is missing, without throwing', async () => {
    const { db, handlers } = setup();
    const job: DispatchJob = {
      id: 'job-missing',
      kind: 'derivative:thumbnail',
      jobType: 'asset.thumbnail',
      refId: 'ref-1',
      status: 'done',
      createdAt: 'T0',
      updatedAt: 'T0',
      error: undefined,
      progress: 1,
      attempts: 1,
      workerId: 'w-1',
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      cancelRequested: false,
      derivative: {
        sha256: 'a'.repeat(64),
        bytes: 3,
        mimeType: 'image/jpeg',
        path: join(tmpdir(), 'joy-media-channel-no-such-file.jpg'),
      },
      resultJson: undefined,
    };
    db.jobDispatch.insert(job);
    const result = await handlers['desktop.media.derivative.bytes']({ jobId: 'job-missing' });
    expect(result).toEqual({ ok: false, error: 'Derivative file is not available' });
  });

  it('reports not-yet-available for the channels whose local stores are not built', () => {
    const { handlers } = setup();
    for (const channel of [
      'desktop.media.asset.register',
      'desktop.media.asset.upload-original',
      'desktop.media.project.document.get',
      'desktop.media.project.document.put',
      'desktop.media.preview.frame',
    ] as const) {
      const result = handlers[channel]({});
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('not available') });
    }
  });
});
