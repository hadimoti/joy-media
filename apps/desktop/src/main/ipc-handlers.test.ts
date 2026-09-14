import { describe, expect, it, vi } from 'vitest';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';

function deps() {
  const fileRegistry = createFileRegistry(() => 'ref-1');
  const workerSupervisor = createWorkerSupervisor({
    spawn: (): SupervisedChild => ({ once: () => {}, kill: () => true }),
    command: 'node',
    workerId: () => 'w-1',
  });
  const showOpenDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\Media\\clip.mp4' }));
  const localDatabase = new LocalDatabase({
    filePath: ':memory:',
    idFactory: () => 'job-1',
    now: () => 'T0',
  });
  const probeMedia = vi.fn(async () => ({
    checksum: 'sha-abc',
    byteSize: 123,
    kind: 'video' as const,
  }));
  return {
    fileRegistry,
    workerSupervisor,
    showOpenDialog,
    localDatabase,
    probeMedia,
    now: () => 'T0',
  };
}

describe('IPC dispatch', () => {
  it('rejects requests from an origin outside the allow-list before any handler runs', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://evil.example',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(false);
    expect(d.showOpenDialog).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel even from an allowed origin', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.execute',
    });
    expect(result.ok).toBe(false);
  });

  it('select-file registers the chosen path and returns only the opaque ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'local-file', id: 'ref-1', displayName: 'clip.mp4' },
    });
  });

  it('select-file records the probed media into the manifest, keyed by the new ref', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    expect(d.probeMedia).toHaveBeenCalledWith('C:\\Media\\clip.mp4');
    expect(d.localDatabase.getMedia('ref-1')).toEqual({
      refId: 'ref-1',
      checksum: 'sha-abc',
      kind: 'video',
      byteSize: 123,
      lastVerifiedAt: 'T0',
    });
  });

  it('revoke-file also forgets the media manifest entry', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const selected = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.revoke-file',
      payload: selected.data,
    });
    expect(d.localDatabase.getMedia('ref-1')).toBeUndefined();
  });

  it('request-derivative rejects a forged ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.request-derivative',
      payload: { ref: { kind: 'local-file', id: 'forged', displayName: 'x' }, kind: 'thumbnail' },
    });
    expect(result.ok).toBe(false);
  });

  it('request-derivative enqueues a queued job and returns its id alongside the approval', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const selected = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.request-derivative',
      payload: { ref: selected.data, kind: 'thumbnail' },
    });
    expect(result).toEqual({
      ok: true,
      data: { refId: 'ref-1', kind: 'thumbnail', jobId: 'job-1' },
    });
    expect(d.localDatabase.getJob('job-1')).toMatchObject({
      kind: 'derivative:thumbnail',
      refId: 'ref-1',
      status: 'queued',
    });
  });

  it('worker-status reflects the supervisor state', async () => {
    const d = deps();
    d.workerSupervisor.start();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connection: 'online', workerId: 'w-1', capabilities: [] });
  });

  it('startup-preference fails closed on garbage input and starts nothing', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.startup-preference',
      payload: 'not-a-real-preference',
    });
    expect(result).toEqual({ ok: true, data: 'leave-worker-alone' });
  });

  it('job-status reports an unknown job id as an error, not a thrown exception', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.job-status',
      payload: { jobId: 'missing' },
    });
    expect(result.ok).toBe(false);
  });

  it('job-status round-trips a real queued job', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.job-status',
      payload: { jobId: 'job-1' },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        id: 'job-1',
        kind: 'export',
        refId: 'ref-9',
        status: 'queued',
        createdAt: 'T0',
        updatedAt: 'T0',
      },
    });
  });

  it('cancel-job moves a queued job to cancelled', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.cancel-job',
      payload: { jobId: 'job-1' },
    });
    expect(result.ok).toBe(true);
    expect(d.localDatabase.getJob('job-1')).toMatchObject({
      status: 'cancelled',
      error: 'cancelled by user',
    });
  });

  it('cancel-job refuses to cancel an already-finished job', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    d.localDatabase.enqueueJob('export', 'ref-9');
    d.localDatabase.updateJobStatus('job-1', 'done');
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.cancel-job',
      payload: { jobId: 'job-1' },
    });
    expect(result.ok).toBe(false);
    expect(d.localDatabase.getJob('job-1')?.status).toBe('done');
  });
});
