import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIpcHandlers, dispatchIpcRequest, type IpcHandlerDeps } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createMediaStage, type MediaStage } from './media-stage.js';
import { createWorkerSupervisor, type SupervisedChild } from './worker-supervisor.js';
import { LocalDatabase } from '../store/local-database.js';
import { createMemorySecretStore } from '@joy-media/provider-sdk';

const ORIGIN = 'joy-media-app://renderer';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('IPC media staging and audio presence', () => {
  let root: string;
  let stage: MediaStage;
  let probeAudio: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof createIpcHandlers>;
  let localDatabase: LocalDatabase;

  function buildHandlers({ withStage = true }: { readonly withStage?: boolean } = {}) {
    const registry = createFileRegistry(() => `ref-${Math.random().toString(36).slice(2)}`);
    const workerSupervisor = createWorkerSupervisor({
      spawn: (): SupervisedChild => ({ once: () => {}, kill: () => true }),
      command: 'node',
      workerId: () => 'w-1',
    });
    const deps: IpcHandlerDeps = {
      fileRegistry: registry,
      workerSupervisor,
      showOpenDialog: vi.fn(async () => ({ canceled: true, path: undefined })),
      localDatabase,
      probeMedia: vi.fn(async () => ({ checksum: 'x', byteSize: 1, kind: 'video' as const })),
      secretStore: createMemorySecretStore(),
      probeProvider: vi.fn(async () => ({ ok: true, modelId: 'm' })),
      checkForUpdate: vi.fn(async () => ({
        status: 'current' as const,
        reason: 'not-newer' as const,
        latestVersion: '1.0.3',
      })),
      now: () => 'T0',
      newId: () => 'id-1',
      ...(withStage
        ? {
            mediaStage: stage,
            probeAudio: probeAudio as unknown as NonNullable<IpcHandlerDeps['probeAudio']>,
          }
        : {}),
    };
    return createIpcHandlers(deps);
  }

  function call(channel: string, payload?: unknown) {
    return dispatchIpcRequest(handlers, { origin: ORIGIN, channel, payload });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'joy-ipc-stage-'));
    localDatabase = new LocalDatabase({
      filePath: ':memory:',
      idFactory: () => 'job-1',
      now: () => 'T0',
    });
    probeAudio = vi.fn(async () => ({ status: 'absent' as const }));
    stage = createMediaStage({
      directory: join(root, 'staged'),
      registry: createFileRegistry(() => 'unused'),
      localDatabase,
      now: () => 'T0',
    });
    handlers = buildHandlers();
  });

  afterEach(async () => {
    await stage.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('stages an upload through the IPC channels and returns a registered reference', async () => {
    const bytes = new TextEncoder().encode('imported original');
    const begun = await call('desktop.media-stage.begin', {
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      displayName: 'clip.mp4',
    });
    expect(begun.ok).toBe(true);
    const upload = begun.data as { status: string; uploadId: string };
    expect(upload.status).toBe('upload');

    const chunk = await call('desktop.media-stage.chunk', {
      uploadId: upload.uploadId,
      offset: 0,
      data: bytes,
    });
    expect(chunk).toEqual({ ok: true, data: { received: bytes.byteLength } });

    const finished = await call('desktop.media-stage.finish', { uploadId: upload.uploadId });
    expect(finished).toMatchObject({
      ok: true,
      data: { kind: 'local-file', displayName: 'clip.mp4' },
    });
  });

  it('refuses malformed stage requests before touching the disk', async () => {
    expect(await call('desktop.media-stage.begin', { sha256: 'nope' })).toEqual({
      ok: false,
      error: 'Invalid media stage request',
    });
    expect(
      await call('desktop.media-stage.chunk', {
        uploadId: 'not-a-uuid',
        offset: 0,
        data: new Uint8Array(1),
      }),
    ).toEqual({ ok: false, error: 'Invalid media chunk' });
    expect(await call('desktop.media-stage.finish', { uploadId: 42 })).toEqual({
      ok: false,
      error: 'Invalid media upload',
    });
  });

  it('reports staging as unavailable when the desktop has no staging root', async () => {
    handlers = buildHandlers({ withStage: false });
    expect(
      await call('desktop.media-stage.begin', {
        sha256: 'a'.repeat(64),
        bytes: 1,
        displayName: 'x.mp4',
      }),
    ).toEqual({
      ok: false,
      error: 'Media staging is unavailable',
    });
  });

  it('answers audio presence as unknown, never absent, when no verified copy is staged', async () => {
    const result = await call('desktop.media-audio-presence', {
      sha256: 'd'.repeat(64),
      bytes: 10,
    });
    expect(result).toEqual({ ok: true, data: { status: 'unknown', reason: 'not-staged' } });
    expect(probeAudio).not.toHaveBeenCalled();
  });

  it('probes the staged copy with ffprobe once a verified copy exists', async () => {
    const bytes = new TextEncoder().encode('probe me');
    const begun = (
      await call('desktop.media-stage.begin', {
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        displayName: 'clip.mp4',
      })
    ).data as { uploadId: string };
    await call('desktop.media-stage.chunk', { uploadId: begun.uploadId, offset: 0, data: bytes });
    await call('desktop.media-stage.finish', { uploadId: begun.uploadId });

    const result = await call('desktop.media-audio-presence', {
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
    expect(result).toEqual({ ok: true, data: { status: 'absent' } });
    expect(probeAudio).toHaveBeenCalledOnce();
    expect(String(probeAudio.mock.calls[0]?.[0])).toContain(`${sha256(bytes)}.bin`);
  });

  it('refuses to read a derivative for a missing job id, or a job with no derivative', async () => {
    expect(await call('desktop.job-derivative.read', {})).toEqual({
      ok: false,
      error: 'Invalid job id',
    });
    expect(await call('desktop.job-derivative.read', { jobId: 'job-404' })).toEqual({
      ok: false,
      error: 'This job has no derivative yet',
    });
  });
});
