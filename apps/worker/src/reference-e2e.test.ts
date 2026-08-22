import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import { PlaybackScheduler } from '@joy-media/playback-engine';
import { InMemoryProjectStore, LocalProjectPersistence } from '@joy-media/project-persistence';
import type { PersistenceAdapter } from '@joy-media/project-persistence';
import { validateSpikeProject } from '@joy-media/project-schema';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { createRenderBundle } from '@joy-media/render-planner';
import { buildReferenceSpikeProject, REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { executeLeasedExport } from './export-job.js';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';

const splitProduct: CommandTransaction = {
  label: 'Split product beat',
  commands: [
    {
      type: 'timeline.splitClip',
      payload: {
        compositionId: 'root',
        trackId: 'track-0',
        clipId: 'product',
        atUs: 15_000_000,
        newClipId: 'product-second-half',
      },
    },
  ],
};

const persistenceAdapter: PersistenceAdapter<SpikeProject, CommandTransaction> = {
  projectId: (project) => project.id,
  schemaVersion: (project) => project.schemaVersion,
  validate: validateSpikeProject,
  apply: (project, transaction) => new ProjectHistory(project).apply(transaction),
};

describe('P02 reference social-edit end-to-end workflow', () => {
  it('reopens a reversible 30-second edit, plays through proxies, and exports both formats after lease recovery', async () => {
    const initial = buildReferenceSpikeProject();
    const history = new ProjectHistory(initial);
    const edited = history.apply(splitProduct);
    expect(history.undo()).toEqual(initial);
    expect(history.redo()).toEqual(edited);

    const persistence = new LocalProjectPersistence(
      new InMemoryProjectStore<SpikeProject, CommandTransaction>(),
      persistenceAdapter,
    );
    persistence.initialize(initial);
    expect(persistence.saveTransaction(initial, splitProduct, false)).toEqual(edited);
    expect(persistence.recover(REFERENCE_PROJECT.id)).toMatchObject({
      project: edited,
      revision: 1,
      recoveredWithWarnings: false,
    });

    const scheduler = new PlaybackScheduler();
    const staleToken = scheduler.requestToken();
    scheduler.seek(15_000_000);
    expect(scheduler.acceptFrame(staleToken, true)).toBe(false);
    const currentToken = scheduler.requestToken();
    scheduler.acceptFrame(currentToken, false);
    scheduler.acceptFrame(currentToken, false);
    scheduler.acceptFrame(currentToken, false);
    expect(scheduler.metrics).toMatchObject({
      decodedFrames: 3,
      droppedFrames: 3,
      quality: 'proxy',
    });

    const api = new LocalControlPlane();
    const owner = { id: 'reference-owner' };
    api.createProject(owner, REFERENCE_PROJECT.id, REFERENCE_PROJECT.title);
    api.pairWorker(owner, 'interrupted-worker');
    api.pairWorker(owner, 'recovery-worker');
    api.helloWorker('interrupted-worker', ['render.export'], [], 100);
    api.helloWorker('recovery-worker', ['render.export'], [], 100);
    const outputDirectory = mkdtempSync(join(tmpdir(), 'joy-media-reference-e2e-'));
    const now = Date.now();

    api.enqueue(owner, 'landscape', REFERENCE_PROJECT.id, 'render.export', now);
    expect(api.lease('interrupted-worker', now + 1, 5)?.id).toBe('landscape');
    expect(api.lease('recovery-worker', now + 6, 30_000)?.id).toBe('landscape');
    const resolver = referenceResolver(outputDirectory);
    expect(
      await executeLeasedExport(
        {
          complete: (workerId, jobId, receipt) =>
            api.complete(workerId, jobId, Date.now(), receipt),
        },
        'recovery-worker',
        'landscape',
        createRenderBundle({
          timelineProject: edited,
          visualProject: referenceVisualProject(64, 36),
          outputPreset: 'social-h264-aac',
          seed: 'reference-landscape',
        }),
        { outputDirectory, mediaResolver: resolver, frameLimit: 3 },
      ),
    ).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });

    api.enqueue(owner, 'vertical', REFERENCE_PROJECT.id, 'render.export', now + 10);
    expect(api.lease('recovery-worker', now + 11)?.id).toBe('vertical');
    expect(
      await executeLeasedExport(
        {
          complete: (workerId, jobId, receipt) =>
            api.complete(workerId, jobId, Date.now(), receipt),
        },
        'recovery-worker',
        'vertical',
        createRenderBundle({
          timelineProject: edited,
          visualProject: referenceVisualProject(36, 64),
          outputPreset: 'social-h264-aac',
          seed: 'reference-vertical',
        }),
        { outputDirectory, mediaResolver: resolver, frameLimit: 3 },
      ),
    ).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(api.eventsAfter(owner, REFERENCE_PROJECT.id, 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'leased',
      'completed',
      'queued',
      'leased',
      'completed',
    ]);
  });
});

function referenceResolver(directory: string): StaticWorkerMediaResolver {
  const path = join(directory, 'reference-private.mp4');
  writeFileSync(path, 'worker-private-reference-media');
  return new StaticWorkerMediaResolver({
    'asset:asset-intro': path,
    'asset:asset-product': path,
    'asset:asset-outro': path,
    'asset:asset-b-roll-a': path,
    'asset:asset-b-roll-b': path,
  });
}

function referenceVisualProject(width: number, height: number): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: REFERENCE_PROJECT.id,
    title: REFERENCE_PROJECT.title,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width,
        height,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 100_000,
        background: '#000000',
        tracks: [],
      },
    },
    assets: {
      'asset-intro': { id: 'asset-intro', kind: 'video', displayName: 'Intro' },
      'asset-product': { id: 'asset-product', kind: 'video', displayName: 'Product' },
      'asset-outro': { id: 'asset-outro', kind: 'video', displayName: 'Outro' },
      'asset-b-roll-a': { id: 'asset-b-roll-a', kind: 'video', displayName: 'B-roll A' },
      'asset-b-roll-b': { id: 'asset-b-roll-b', kind: 'video', displayName: 'B-roll B' },
    },
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
    audio: {
      clips: {
        intro: { gain: 0.75, pan: 0, mute: false, solo: false },
        product: { gain: 0.75, pan: 0, mute: false, solo: false },
        outro: { gain: 0.75, pan: 0, mute: false, solo: false },
        'b-roll-a': { gain: 0.75, pan: 0, mute: false, solo: false },
        'b-roll-b': { gain: 0.75, pan: 0, mute: false, solo: false },
      },
      buses: [],
      effects: [],
    },
  };
}
