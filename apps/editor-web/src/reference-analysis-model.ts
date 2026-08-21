import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type { CreativeArtifactV2 } from '@joy-media/project-schema';
import type {
  ReferenceAnalysisFinding,
  VideoReferenceAnalyzeReceipt,
} from '@joy-media/job-protocol';
import type { BrowserAsset, BrowserJob } from './control-plane-client.js';

interface ReferenceMarkerDocument {
  readonly schemaVersion: 1;
  readonly type: 'reference-source';
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly displayName: string;
}

export interface ReferenceAnalysisDocument {
  readonly schemaVersion: 1;
  readonly type: 'reference-analysis';
  readonly assetId: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly evidenceIds: readonly string[];
  readonly jobId: string;
  readonly receipt: VideoReferenceAnalyzeReceipt;
}

export interface ReferenceAssetStatus {
  readonly marked: boolean;
  readonly running: boolean;
  readonly canRun: boolean;
  readonly canView: boolean;
  readonly markerArtifactId?: string;
  readonly analysisArtifactId?: string;
}

export function referenceMarkerArtifactId(assetId: string): string {
  return `reference-source-${assetId}`;
}

export function referenceAnalysisArtifactId(assetId: string): string {
  return `reference-analysis-${assetId}`;
}

export function buildReferenceMarkerTransaction(
  asset: BrowserAsset,
  now: string,
): ArtifactTransaction {
  return {
    label: `Mark ${asset.displayName} as reference`,
    commands: [
      {
        type: 'artifact.create',
        payload: {
          artifact: {
            id: referenceMarkerArtifactId(asset.id),
            kind: 'metadata',
            schemaVersion: 1,
            revision: 0,
            label: `Reference source · ${asset.displayName}`,
            contentRef: {
              type: 'inline',
              value: JSON.stringify({
                schemaVersion: 1,
                type: 'reference-source',
                assetId: asset.id,
                sourceSha256: asset.sha256,
                sourceBytes: asset.bytes,
                displayName: asset.displayName,
              } satisfies ReferenceMarkerDocument),
            },
            binding: { type: 'none' },
            provenance: {
              sourceArtifactIds: [],
              inputHashes: [asset.sha256],
              createdBy: { type: 'human', id: 'editor' },
            },
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    ],
  };
}

export function buildPersistReferenceAnalysisTransaction(input: {
  readonly asset: BrowserAsset;
  readonly receipt: VideoReferenceAnalyzeReceipt;
  readonly jobId: string;
  readonly now: string;
  readonly store: ArtifactStore;
}): ArtifactTransaction {
  validateModelEvidence(input.receipt.findings, new Set(input.receipt.evidenceIds));
  const artifactId = referenceAnalysisArtifactId(input.asset.id);
  const markerId = referenceMarkerArtifactId(input.asset.id);
  const contentRef = {
    type: 'inline' as const,
    value: JSON.stringify({
      schemaVersion: 1,
      type: 'reference-analysis',
      assetId: input.asset.id,
      sourceSha256: input.asset.sha256,
      sourceBytes: input.asset.bytes,
      evidenceIds: [...input.receipt.evidenceIds],
      jobId: input.jobId,
      receipt: input.receipt,
    } satisfies ReferenceAnalysisDocument),
  };
  const existing = input.store.artifacts[artifactId];
  if (existing !== undefined) {
    return {
      label: `Update reference analysis for ${input.asset.displayName}`,
      commands: [
        {
          type: 'artifact.update',
          payload: {
            artifactId,
            label: `Reference analysis · ${input.asset.displayName}`,
            contentRef,
            updatedAt: input.now,
            versionId: `${artifactId}-v${input.now}`,
          },
        },
      ],
    };
  }
  return {
    label: `Persist reference analysis for ${input.asset.displayName}`,
    commands: [
      {
        type: 'artifact.create',
        payload: {
          artifact: {
            id: artifactId,
            kind: 'analysis',
            schemaVersion: 1,
            revision: 0,
            label: `Reference analysis · ${input.asset.displayName}`,
            contentRef,
            binding: { type: 'none' },
            provenance: {
              sourceArtifactIds:
                input.store.artifacts[markerId] === undefined ? [markerId] : [markerId],
              inputHashes: [input.asset.sha256],
              createdBy: { type: 'agent', id: 'reference-analysis' },
              jobId: input.jobId,
              ...(input.receipt.model === undefined ? {} : { modelId: input.receipt.model }),
            },
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
      },
    ],
  };
}

export function parseReferenceAnalysisArtifact(
  artifact: CreativeArtifactV2 | undefined,
): ReferenceAnalysisDocument | undefined {
  if (artifact?.kind !== 'analysis' || artifact.contentRef.type !== 'inline') return undefined;
  try {
    const parsed = JSON.parse(artifact.contentRef.value) as ReferenceAnalysisDocument;
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.type !== 'reference-analysis' ||
      typeof parsed.assetId !== 'string' ||
      typeof parsed.sourceSha256 !== 'string' ||
      !Array.isArray(parsed.evidenceIds) ||
      typeof parsed.jobId !== 'string' ||
      parsed.receipt?.kind !== 'video.reference-analyze'
    ) {
      return undefined;
    }
    validateModelEvidence(parsed.receipt.findings, new Set(parsed.receipt.evidenceIds));
    return parsed;
  } catch {
    return undefined;
  }
}

export function referenceAnalysisReceiptFromDerivative(
  derivative: BrowserJob['derivative'] | undefined,
): VideoReferenceAnalyzeReceipt | undefined {
  if (
    derivative?.kind !== 'video.reference-analyze' ||
    derivative.assetId === undefined ||
    derivative.sha256 === undefined ||
    derivative.bytes === undefined ||
    derivative.descriptor === undefined ||
    derivative.summary === undefined ||
    derivative.evidence === undefined ||
    derivative.evidenceIds === undefined
  ) {
    return undefined;
  }
  const findings = Array.isArray(derivative.findings)
    ? (derivative.findings as VideoReferenceAnalyzeReceipt['findings'])
    : undefined;
  const receipt: VideoReferenceAnalyzeReceipt = {
    kind: 'video.reference-analyze',
    assetId: derivative.assetId,
    sha256: derivative.sha256,
    bytes: derivative.bytes,
    descriptor: derivative.descriptor as VideoReferenceAnalyzeReceipt['descriptor'],
    summary: derivative.summary,
    evidence: derivative.evidence as VideoReferenceAnalyzeReceipt['evidence'],
    evidenceIds: derivative.evidenceIds,
    ...(findings === undefined ? {} : { findings }),
    ...(derivative.model === undefined ? {} : { model: derivative.model }),
  };
  validateModelEvidence(receipt.findings, new Set(receipt.evidenceIds));
  return receipt;
}

export function referenceStatusForAsset(input: {
  readonly asset: BrowserAsset;
  readonly store: ArtifactStore;
  readonly jobs: readonly Pick<BrowserJob, 'id' | 'type' | 'assetId' | 'state'>[];
}): ReferenceAssetStatus {
  const markerArtifactId = referenceMarkerArtifactId(input.asset.id);
  const analysisArtifactId = referenceAnalysisArtifactId(input.asset.id);
  const marked =
    input.store.artifacts[markerArtifactId] !== undefined ||
    parseReferenceAnalysisArtifact(input.store.artifacts[analysisArtifactId]) !== undefined;
  const running = input.jobs.some(
    (job) =>
      job.type === 'video.reference-analyze' &&
      job.assetId === input.asset.id &&
      (job.state === 'queued' || job.state === 'leased'),
  );
  const canView =
    parseReferenceAnalysisArtifact(input.store.artifacts[analysisArtifactId]) !== undefined;
  return {
    marked,
    running,
    canRun: marked && !running,
    canView,
    ...(marked ? { markerArtifactId } : {}),
    ...(canView ? { analysisArtifactId } : {}),
  };
}

function validateModelEvidence(
  findings: readonly ReferenceAnalysisFinding[] | undefined,
  evidenceIds: ReadonlySet<string>,
): void {
  for (const finding of findings ?? []) {
    if ((finding.evidenceIds ?? []).length === 0) {
      throw new Error(`reference finding ${finding.id} must cite evidence`);
    }
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(
          `reference finding ${finding.id} references missing evidence ${evidenceId}`,
        );
      }
    }
  }
}
