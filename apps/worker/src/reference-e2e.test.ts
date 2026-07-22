import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import { freezeManifest, verifyExport } from '@joy-media/export-core';
import { PlaybackScheduler } from '@joy-media/playback-engine';
import { InMemoryProjectStore, LocalProjectPersistence } from '@joy-media/project-persistence';
import type { PersistenceAdapter } from '@joy-media/project-persistence';
import { validateSpikeProject } from '@joy-media/project-schema';
import type { SpikeProject } from '@joy-media/project-schema';
import { buildReferenceSpikeProject, REFERENCE_PROJECT } from '@joy-media/test-fixtures';
import { executeLeasedExport } from './export-job.js';

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
  it('reopens a reversible 30-second edit, plays through proxies, and exports both formats after lease recovery', () => {
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
    const outputDirectory = mkdtempSync(join(tmpdir(), 'joy-media-reference-e2e-'));
    const now = Date.now();

    api.enqueue(owner, 'landscape', REFERENCE_PROJECT.id, 'render.export', now);
    expect(api.lease('interrupted-worker', now + 1, 5)?.id).toBe('landscape');
    expect(api.lease('recovery-worker', now + 6, 30_000)?.id).toBe('landscape');
    const landscapeManifest = freezeManifest({
      projectId: REFERENCE_PROJECT.id,
      revision: REFERENCE_PROJECT.revision,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'social-h264-aac',
    });
    const landscapePath = join(outputDirectory, 'reference-landscape.mp4');
    expect(
      executeLeasedExport(api, 'recovery-worker', 'landscape', landscapeManifest, landscapePath),
    ).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(verifyExport(landscapePath)).toMatchObject({ width: 64, height: 36 });

    api.enqueue(owner, 'vertical', REFERENCE_PROJECT.id, 'render.export', now + 10);
    expect(api.lease('recovery-worker', now + 11)?.id).toBe('vertical');
    const verticalManifest = freezeManifest({
      ...landscapeManifest,
      width: 36,
      height: 64,
    });
    const verticalPath = join(outputDirectory, 'reference-vertical.mp4');
    expect(
      executeLeasedExport(api, 'recovery-worker', 'vertical', verticalManifest, verticalPath),
    ).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(verifyExport(verticalPath)).toMatchObject({ width: 36, height: 64 });
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
