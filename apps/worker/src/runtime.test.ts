import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BoundedLog,
  JsonFileWorkerStore,
  StaticLocalAssetSourceRegistry,
  WorkerRuntime,
  detectMediaTools,
  getDeviceIdentity,
} from './runtime.js';
describe('Worker runtime', () => {
  it('persists device identity and advertises only detected capabilities', () => {
    let saved: ReturnType<typeof getDeviceIdentity> | undefined;
    const store = {
      load: () => saved,
      save: (value: ReturnType<typeof getDeviceIdentity>) => {
        saved = value;
      },
    };
    const first = getDeviceIdentity(store, new Date('2026-01-01'));
    expect(getDeviceIdentity(store)).toEqual(first);
    const runtime = new WorkerRuntime(
      first,
      detectMediaTools((tool) => tool === 'ffmpeg' || tool === 'ffprobe'),
    );
    expect(runtime.hello('win32', 'x64').capabilities).toEqual(['asset.thumbnail']);
  });
  it('bounds logs and cooperatively cancels jobs', async () => {
    const log = new BoundedLog(2);
    log.write('a');
    log.write('b');
    log.write('c');
    expect(log.lines()).toEqual(['b', 'c']);
    const runtime = new WorkerRuntime(
      { workerId: 'w', createdAt: 'now' },
      { ffmpeg: true, ffprobe: true },
    );
    expect(
      (
        await runtime.run(
          { id: 'j', type: 'asset.thumbnail', assetId: 'asset-1' },
          { cancelled: () => true, progress: async () => undefined },
        )
      ).state,
    ).toBe('canceled');
  });
  it('creates a real bounded JPEG thumbnail and retains only an opaque local reference', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-derivatives-'));
    const source = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true },
      {
        sources: new StaticLocalAssetSourceRegistry({ 'asset-intro': source }),
        derivativeDirectory,
      },
    );
    try {
      const updates: number[] = [];
      const result = await runtime.run(
        { id: 'job-real', type: 'asset.thumbnail', assetId: 'asset-intro' },
        {
          cancelled: () => false,
          progress: async (progress) => {
            updates.push(progress);
          },
        },
      );
      expect(result).toMatchObject({
        state: 'completed',
        result: {
          kind: 'asset.thumbnail',
          assetId: 'asset-intro',
          descriptor: { mimeType: 'image/jpeg', width: 640, height: 360 },
        },
      });
      if (result.state !== 'completed') throw new Error('real thumbnail was unexpectedly canceled');
      expect(result.result.bytes).toBeGreaterThan(100);
      expect(result.result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.result.localRef).toMatch(/^thumb-job-real-[a-f0-9]{16}$/);
      expect(existsSync(join(derivativeDirectory, `${result.result.localRef}.jpg`))).toBe(true);
      expect(JSON.stringify(result)).not.toContain(source);
      expect(updates).toEqual([5, 25, 75, 90, 100]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
  it('cancels an in-flight real thumbnail and leaves no derivative behind', async () => {
    const derivativeDirectory = mkdtempSync(join(tmpdir(), 'joy-media-canceled-'));
    const source = join(
      process.cwd(),
      'apps',
      'editor-web',
      'public',
      'media',
      'reference',
      'asset-intro.mp4',
    );
    const runtime = new WorkerRuntime(
      { workerId: 'worker-1', createdAt: '2026-07-22T00:00:00.000Z' },
      { ffmpeg: true, ffprobe: true },
      {
        sources: new StaticLocalAssetSourceRegistry({ 'asset-intro': source }),
        derivativeDirectory,
      },
    );
    let canceled = false;
    try {
      await expect(
        runtime.run(
          { id: 'job-canceled', type: 'asset.thumbnail', assetId: 'asset-intro' },
          {
            cancelled: () => canceled,
            progress: async (progress) => {
              if (progress === 25) canceled = true;
            },
          },
        ),
      ).resolves.toEqual({ state: 'canceled' });
      expect(existsSync(derivativeDirectory)).toBe(true);
      expect(readdirSync(derivativeDirectory)).toEqual([]);
    } finally {
      rmSync(derivativeDirectory, { recursive: true, force: true });
    }
  });
  it('persists identity, Worker session, and a pending pairing separately from project data', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'joy-media-worker-')), 'state.json');
    const store = new JsonFileWorkerStore(path);
    const identity = getDeviceIdentity(store, new Date('2026-07-22T00:00:00.000Z'));
    store.saveWorkerSession('worker-session');
    store.savePendingPairing('pairing-code', Date.now() + 60_000);

    const restarted = new JsonFileWorkerStore(path);
    expect(restarted.load()).toEqual(identity);
    expect(restarted.loadWorkerSession()).toBe('worker-session');
    expect(restarted.loadPendingPairing()?.code).toBe('pairing-code');
    restarted.clearWorkerSession();
    expect(restarted.load()).toEqual(identity);
    expect(restarted.loadWorkerSession()).toBeUndefined();
    restarted.clearPendingPairing();
    expect(restarted.loadPendingPairing()).toBeUndefined();
  });
});
