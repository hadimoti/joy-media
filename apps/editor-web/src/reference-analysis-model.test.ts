import { describe, expect, it } from 'vitest';
import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type { CreativeArtifactV2 } from '@joy-media/project-schema';
import type { BrowserAsset } from './control-plane-client.js';
import {
  buildPersistReferenceAnalysisTransaction,
  buildReferenceMarkerTransaction,
  parseReferenceAnalysisArtifact,
  referenceAnalysisArtifactId,
  referenceMarkerArtifactId,
  referenceStatusForAsset,
} from './reference-analysis-model.js';
import type { VideoReferenceAnalyzeReceipt } from '@joy-media/job-protocol';

const VIDEO_ASSET: BrowserAsset = {
  id: 'asset-intro',
  projectId: 'project-1',
  kind: 'video',
  displayName: 'Intro reference',
  sha256: 'b'.repeat(64),
  bytes: 1_054_138,
  descriptor: { mimeType: 'video/mp4', width: 320, height: 180, durationUs: 30_000_000 },
  createdAt: 1,
};

const RECEIPT: VideoReferenceAnalyzeReceipt = {
  kind: 'video.reference-analyze',
  assetId: 'asset-intro',
  sha256: VIDEO_ASSET.sha256,
  bytes: VIDEO_ASSET.bytes,
  descriptor: {
    mimeType: 'video/mp4',
    width: 320,
    height: 180,
    durationUs: 30_000_000,
  },
  summary: {
    shotCount: 1,
    cutCount: 0,
    averageShotDurationUs: 30_000_000,
    fastestShotDurationUs: 30_000_000,
    sampleCount: 3,
    transcriptSegmentCount: 0,
    audioBeatCount: 2,
  },
  evidence: [
    {
      id: 'shot-00000000',
      kind: 'shot',
      label: 'Shot 1',
      summary: 'Whole clip',
      startUs: 0,
      durationUs: 30_000_000,
    },
    {
      id: 'text-safe-zone-00000000',
      kind: 'text-safe-zone',
      label: 'Text box',
      summary: 'Burned-in timecode is tight to the edge',
      safe: false,
      boxes: [{ leftPct: 0, topPct: 0, widthPct: 0.25, heightPct: 0.16 }],
    },
  ],
  evidenceIds: ['shot-00000000', 'text-safe-zone-00000000'],
  findings: [
    {
      id: 'finding-1',
      source: 'model',
      title: 'Technical reference',
      summary: 'Use for pacing only.',
      evidenceIds: ['text-safe-zone-00000000'],
    },
  ],
};

describe('reference analysis model', () => {
  it('builds a durable marker transaction for videos that are marked as references', () => {
    const transaction = buildReferenceMarkerTransaction(VIDEO_ASSET, '2026-08-21T00:00:00.000Z');
    expect(transaction).toMatchObject<ArtifactTransaction>({
      label: 'Mark Intro reference as reference',
      commands: [
        {
          type: 'artifact.create',
          payload: {
            artifact: expect.objectContaining({
              id: referenceMarkerArtifactId(VIDEO_ASSET.id),
              kind: 'metadata',
            }),
          },
        },
      ],
    });
  });

  it('persists source hash, provenance, and evidence ids into a CreativeArtifactV2 payload', () => {
    const transaction = buildPersistReferenceAnalysisTransaction({
      asset: VIDEO_ASSET,
      receipt: RECEIPT,
      jobId: 'job-reference-1',
      now: '2026-08-21T00:00:00.000Z',
      store: { artifacts: {}, versions: {} },
    });
    const artifact = (
      transaction.commands[0] as Extract<
        ArtifactTransaction['commands'][number],
        { readonly type: 'artifact.create' }
      >
    ).payload.artifact;

    expect(artifact).toMatchObject({
      id: referenceAnalysisArtifactId(VIDEO_ASSET.id),
      kind: 'analysis',
      label: 'Reference analysis · Intro reference',
      provenance: {
        sourceArtifactIds: [referenceMarkerArtifactId(VIDEO_ASSET.id)],
        inputHashes: [VIDEO_ASSET.sha256],
        createdBy: { type: 'agent', id: 'reference-analysis' },
        jobId: 'job-reference-1',
      },
    });

    expect(parseReferenceAnalysisArtifact(artifact)).toMatchObject({
      assetId: VIDEO_ASSET.id,
      sourceSha256: VIDEO_ASSET.sha256,
      evidenceIds: RECEIPT.evidenceIds,
      receipt: {
        kind: 'video.reference-analyze',
        findings: [
          expect.objectContaining({
            id: 'finding-1',
            evidenceIds: ['text-safe-zone-00000000'],
          }),
        ],
      },
    });
  });

  it('updates an existing reference analysis artifact instead of duplicating it', () => {
    const existing = buildExistingAnalysisArtifact();
    const transaction = buildPersistReferenceAnalysisTransaction({
      asset: VIDEO_ASSET,
      receipt: RECEIPT,
      jobId: 'job-reference-2',
      now: '2026-08-21T00:01:00.000Z',
      store: {
        artifacts: { [existing.id]: existing },
        versions: {},
      },
    });

    expect(transaction.commands[0]).toMatchObject({
      type: 'artifact.update',
      payload: {
        artifactId: existing.id,
        updatedAt: '2026-08-21T00:01:00.000Z',
      },
    });
  });

  it('derives mark, run, and view affordances from assets, jobs, and artifacts', () => {
    const store: ArtifactStore = {
      artifacts: {
        [referenceMarkerArtifactId(VIDEO_ASSET.id)]: buildMarkerArtifact(),
        [referenceAnalysisArtifactId(VIDEO_ASSET.id)]: buildExistingAnalysisArtifact(),
      },
      versions: {},
    };

    expect(
      referenceStatusForAsset({
        asset: VIDEO_ASSET,
        store,
        jobs: [
          {
            id: 'job-reference-1',
            type: 'video.reference-analyze',
            assetId: VIDEO_ASSET.id,
            state: 'queued',
          },
        ],
      }),
    ).toMatchObject({
      marked: true,
      canRun: false,
      running: true,
      canView: true,
      analysisArtifactId: referenceAnalysisArtifactId(VIDEO_ASSET.id),
    });
  });

  it('rejects model findings that are not backed by deterministic evidence', () => {
    const invalidReceipt: VideoReferenceAnalyzeReceipt = {
      ...RECEIPT,
      findings: [
        {
          id: 'finding-bad',
          source: 'model',
          title: 'Invalid',
          summary: 'Missing evidence',
          evidenceIds: ['missing'],
        },
      ],
    };

    expect(() =>
      buildPersistReferenceAnalysisTransaction({
        asset: VIDEO_ASSET,
        receipt: invalidReceipt,
        jobId: 'job-reference-bad',
        now: '2026-08-21T00:00:00.000Z',
        store: { artifacts: {}, versions: {} },
      }),
    ).toThrow(/missing/i);
  });
});

function buildMarkerArtifact(): CreativeArtifactV2 {
  return {
    id: referenceMarkerArtifactId(VIDEO_ASSET.id),
    kind: 'metadata',
    schemaVersion: 1,
    revision: 0,
    label: `Reference source · ${VIDEO_ASSET.displayName}`,
    contentRef: {
      type: 'inline',
      value: JSON.stringify({
        schemaVersion: 1,
        type: 'reference-source',
        assetId: VIDEO_ASSET.id,
        sourceSha256: VIDEO_ASSET.sha256,
      }),
    },
    binding: { type: 'none' },
    provenance: {
      sourceArtifactIds: [],
      inputHashes: [VIDEO_ASSET.sha256],
      createdBy: { type: 'human', id: 'editor' },
    },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function buildExistingAnalysisArtifact(): CreativeArtifactV2 {
  return {
    id: referenceAnalysisArtifactId(VIDEO_ASSET.id),
    kind: 'analysis',
    schemaVersion: 1,
    revision: 1,
    label: `Reference analysis · ${VIDEO_ASSET.displayName}`,
    contentRef: {
      type: 'inline',
      value: JSON.stringify({
        schemaVersion: 1,
        type: 'reference-analysis',
        assetId: VIDEO_ASSET.id,
        sourceSha256: VIDEO_ASSET.sha256,
        sourceBytes: VIDEO_ASSET.bytes,
        evidenceIds: RECEIPT.evidenceIds,
        jobId: 'job-reference-1',
        receipt: RECEIPT,
      }),
    },
    binding: { type: 'none' },
    provenance: {
      sourceArtifactIds: [referenceMarkerArtifactId(VIDEO_ASSET.id)],
      inputHashes: [VIDEO_ASSET.sha256],
      createdBy: { type: 'agent', id: 'reference-analysis' },
      jobId: 'job-reference-1',
    },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}
