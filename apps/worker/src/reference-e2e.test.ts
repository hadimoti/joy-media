import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { ProjectHistory } from '@joy-media/commands';
import type { CommandTransaction } from '@joy-media/commands';
import { freezeManifest, renderFixture, verifyExport } from '@joy-media/export-core';
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
    api.registerAsset(owner, REFERENCE_PROJECT.id, {
      id: 'reference-source',
      kind: 'video',
      displayName: 'reference-source.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1,
      descriptor: { mimeType: 'video/mp4', durationUs: 100_000, width: 64, height: 36 },
      locations: [{ kind: 'private-object', ref: 'reference-source-1' }],
    });
    api.pairWorker(owner, 'interrupted-worker');
    api.pairWorker(owner, 'recovery-worker');
    api.helloWorker('interrupted-worker', ['render.export']);
    api.helloWorker('recovery-worker', ['render.export']);
    const outputDirectory = mkdtempSync(join(tmpdir(), 'joy-media-reference-e2e-'));
    const now = Date.now();

    api.enqueue(
      owner,
      'landscape',
      REFERENCE_PROJECT.id,
      'render.export',
      now,
      'reference-source',
      {
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 3,
        manifest: landscapeManifestLike(),
      },
    );
    expect(api.lease('interrupted-worker', now + 1, 5)?.id).toBe('landscape');
    const landscapeLease = api.lease('recovery-worker', now + 6, 30_000);
    expect(landscapeLease?.id).toBe('landscape');
    const landscapeManifest = freezeManifest({
      projectId: REFERENCE_PROJECT.id,
      revision: REFERENCE_PROJECT.revision,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'social-h264-aac',
    });
    const landscapeSource = join(outputDirectory, 'reference-source-landscape.mp4');
    renderFixture(landscapeManifest, landscapeSource);
    const landscapePath = join(outputDirectory, 'reference-landscape.mp4');
    const landscapeResult = executeLeasedExport(
      { complete: () => undefined },
      'recovery-worker',
      'landscape',
      {
        sourcePath: landscapeSource,
        payload: {
          schemaVersion: 1,
          producer: 'browser-staged-preview-export',
          frameCount: 3,
          manifest: landscapeManifest,
        },
      },
      landscapePath,
      landscapeLease?.leaseToken,
    );
    expect(landscapeResult).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    const landscapeProbe = verifyExport(landscapePath);
    expect(landscapeProbe).toMatchObject({ width: 64, height: 36 });
    completeExport(
      api,
      'recovery-worker',
      'landscape',
      'reference-source',
      landscapePath,
      landscapeProbe,
      now + 7,
      landscapeLease?.leaseToken,
    );

    api.enqueue(
      owner,
      'vertical',
      REFERENCE_PROJECT.id,
      'render.export',
      now + 10,
      'reference-source',
      {
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 3,
        manifest: {
          projectId: REFERENCE_PROJECT.id,
          revision: REFERENCE_PROJECT.revision,
          width: 36,
          height: 64,
          frameRate: 30,
          durationUs: 100_000,
          preset: 'social-h264-aac',
        },
      },
    );
    const verticalLease = api.lease('recovery-worker', now + 11);
    expect(verticalLease?.id).toBe('vertical');
    const verticalManifest = freezeManifest({
      ...landscapeManifest,
      width: 36,
      height: 64,
    });
    const verticalSource = join(outputDirectory, 'reference-source-vertical.mp4');
    renderFixture(verticalManifest, verticalSource);
    const verticalPath = join(outputDirectory, 'reference-vertical.mp4');
    const verticalResult = executeLeasedExport(
      { complete: () => undefined },
      'recovery-worker',
      'vertical',
      {
        sourcePath: verticalSource,
        payload: {
          schemaVersion: 1,
          producer: 'browser-staged-preview-export',
          frameCount: 3,
          manifest: verticalManifest,
        },
      },
      verticalPath,
      verticalLease?.leaseToken,
    );
    expect(verticalResult).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    const verticalProbe = verifyExport(verticalPath);
    expect(verticalProbe).toMatchObject({ width: 36, height: 64 });
    completeExport(
      api,
      'recovery-worker',
      'vertical',
      'reference-source',
      verticalPath,
      verticalProbe,
      now + 12,
      verticalLease?.leaseToken,
    );
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

function landscapeManifestLike() {
  return {
    projectId: REFERENCE_PROJECT.id,
    revision: REFERENCE_PROJECT.revision,
    width: 64,
    height: 36,
    frameRate: 30,
    durationUs: 100_000,
    preset: 'social-h264-aac' as const,
  };
}

function completeExport(
  api: LocalControlPlane,
  workerId: string,
  jobId: string,
  assetId: string,
  outputPath: string,
  probe: ReturnType<typeof verifyExport>,
  at: number,
  leaseToken: string | undefined,
): void {
  const bytes = readFileSync(outputPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const descriptor = {
    mimeType: 'video/mp4' as const,
    width: probe.width,
    height: probe.height,
    durationUs: probe.durationUs,
  };
  api.registerWorkerCloudDerivative(
    workerId,
    jobId,
    {
      id: `derivative-${jobId}`,
      assetId,
      kind: 'proxy',
      profile: 'joy-export-h264-aac',
      sha256,
      bytes: bytes.length,
      descriptor,
      availability: 'available-cloud',
      locations: [{ kind: 'private-object', ref: `derivative-${jobId}` }],
    },
    at,
    leaseToken,
  );
  api.complete(
    workerId,
    jobId,
    at + 1,
    {
      kind: 'render.export',
      assetId,
      sha256,
      bytes: bytes.length,
      localRef: `export-${jobId}`,
      descriptor,
    },
    leaseToken,
  );
}
