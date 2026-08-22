import { createHash } from 'node:crypto';
import type {
  MediaSemanticIndexEvidence,
  MediaSemanticIndexReceipt,
  VideoReferenceAnalyzeReceipt,
} from '@joy-media/job-protocol';
import type {
  AssetAudioEvidenceV1,
  AssetCaptionEvidenceV1,
  AssetShotEvidenceV1,
  SemanticBrollAssetV1,
  SemanticBrollSearchIndexV1,
  SemanticBrollTimeRangeV1,
} from '@joy-media/project-schema';
import { validateSemanticBrollSearchIndexV1 } from '@joy-media/project-schema';

export class SemanticIndexError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SemanticIndexError';
    this.code = code;
  }
}

export interface BuildSemanticBrollIndexOptions {
  readonly projectId: string;
  readonly receipts: readonly VideoReferenceAnalyzeReceipt[];
  readonly assetLabels?: ReadonlyMap<string, string>;
  readonly usedAssetIds?: ReadonlySet<string>;
  readonly now?: Date;
}

export function buildSemanticBrollIndex(
  options: BuildSemanticBrollIndexOptions,
): SemanticBrollSearchIndexV1 {
  const evidenceIndex = new Map<string, MediaSemanticIndexEvidence>();
  const assets: SemanticBrollAssetV1[] = [];

  for (const receipt of options.receipts) {
    const converted = semanticAssetFromReceipt(receipt, {
      usedInTimeline: options.usedAssetIds?.has(receipt.assetId) ?? false,
      ...(options.assetLabels?.get(receipt.assetId) === undefined
        ? {}
        : { label: options.assetLabels.get(receipt.assetId)! }),
    });
    for (const evidence of converted.evidence) evidenceIndex.set(evidence.id, evidence);
    assets.push(converted.asset);
  }

  const index: SemanticBrollSearchIndexV1 = {
    schemaVersion: 1,
    projectId: options.projectId,
    createdAt: (options.now ?? new Date()).toISOString(),
    evidenceIndex,
    assets: assets.sort((left, right) => left.assetId.localeCompare(right.assetId)),
  };

  const errors = validateSemanticBrollSearchIndexV1(index);
  if (errors.length > 0) {
    throw new SemanticIndexError('SEMANTIC_INDEX_INVALID', errors.join('; '));
  }

  return index;
}

export function createMediaSemanticIndexReceipt(
  index: SemanticBrollSearchIndexV1,
): MediaSemanticIndexReceipt {
  const evidence = [...index.evidenceIndex.values()].filter(
    (entry): entry is MediaSemanticIndexEvidence =>
      entry.kind === 'asset-shot' || entry.kind === 'asset-caption' || entry.kind === 'asset-audio',
  );
  const rangeCount = index.assets.reduce((count, asset) => count + asset.ranges.length, 0);
  const content = {
    projectId: index.projectId,
    evidence,
    evidenceIds: evidence.map((entry) => entry.id),
    assets: index.assets,
  };
  const bytes = Buffer.from(JSON.stringify(content), 'utf8');
  return {
    kind: 'media.semantic-index',
    projectId: index.projectId,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    summary: {
      assetCount: index.assets.length,
      rangeCount,
      evidenceCount: evidence.length,
      embeddedRangeCount: 0,
      reranked: false,
    },
    evidence: content.evidence,
    evidenceIds: content.evidenceIds,
    assets: content.assets,
  };
}

function semanticAssetFromReceipt(
  receipt: VideoReferenceAnalyzeReceipt,
  options: { readonly label?: string; readonly usedInTimeline: boolean },
): {
  readonly asset: SemanticBrollAssetV1;
  readonly evidence: readonly MediaSemanticIndexEvidence[];
} {
  const shotEvidence: AssetShotEvidenceV1[] = [];
  const captionEvidence: AssetCaptionEvidenceV1[] = [];
  const audioEvidence: AssetAudioEvidenceV1[] = [];

  for (const entry of receipt.evidence) {
    if (entry.kind === 'shot') {
      shotEvidence.push({
        id: semanticEvidenceId(receipt.assetId, entry.id),
        kind: 'asset-shot',
        label: entry.label,
        summary: entry.summary,
        sourceEntityId: receipt.assetId,
        sourceEntityRevision: 1,
        assetId: receipt.assetId,
        startUs: entry.startUs,
        durationUs: entry.durationUs,
        tags: tagsFromText(`${entry.label} ${entry.summary}`),
      });
      continue;
    }
    if (entry.kind === 'transcript') {
      for (const segment of entry.segments) {
        captionEvidence.push({
          id: semanticEvidenceId(
            receipt.assetId,
            `caption-${String(segment.startUs).padStart(8, '0')}`,
          ),
          kind: 'asset-caption',
          label: `${entry.label} ${(segment.startUs / 1_000_000).toFixed(1)}s`,
          summary: segment.text,
          sourceEntityId: receipt.assetId,
          sourceEntityRevision: 1,
          assetId: receipt.assetId,
          startUs: segment.startUs,
          durationUs: Math.max(1, segment.endUs - segment.startUs),
          text: segment.text,
          language: 'und',
        });
      }
      continue;
    }
    if (entry.kind === 'audio-beat') {
      audioEvidence.push({
        id: semanticEvidenceId(receipt.assetId, entry.id),
        kind: 'asset-audio',
        label: entry.label,
        summary: entry.summary,
        sourceEntityId: receipt.assetId,
        sourceEntityRevision: 1,
        assetId: receipt.assetId,
        startUs: entry.startUs,
        durationUs: entry.durationUs,
        audioKind: 'music',
      });
    }
  }

  const evidence = [...shotEvidence, ...captionEvidence, ...audioEvidence];
  if (evidence.length === 0) {
    throw new SemanticIndexError(
      'SEMANTIC_INDEX_MISSING_EVIDENCE',
      `asset ${receipt.assetId} produced no searchable evidence`,
    );
  }

  const ranges = buildRanges(receipt.assetId, shotEvidence, captionEvidence, audioEvidence);
  if (ranges.length === 0) {
    throw new SemanticIndexError(
      'SEMANTIC_INDEX_MISSING_RANGE',
      `asset ${receipt.assetId} produced no evidence-linked ranges`,
    );
  }

  return {
    evidence,
    asset: {
      assetId: receipt.assetId,
      displayName: options.label ?? receipt.assetId,
      assetType: receipt.descriptor.mimeType.startsWith('video/')
        ? 'video'
        : receipt.descriptor.mimeType.startsWith('audio/')
          ? 'audio'
          : 'other',
      durationUs: receipt.descriptor.durationUs,
      usedInTimeline: options.usedInTimeline,
      tags: [
        ...new Set(
          evidence.flatMap((entry) => tagsFromText(`${entry.label} ${entry.summary ?? ''}`)),
        ),
      ],
      ranges,
    },
  };
}

function buildRanges(
  assetId: string,
  shots: readonly AssetShotEvidenceV1[],
  captions: readonly AssetCaptionEvidenceV1[],
  audio: readonly AssetAudioEvidenceV1[],
): readonly SemanticBrollTimeRangeV1[] {
  const sourceRanges =
    shots.length > 0
      ? shots
      : [...captions, ...audio].sort((left, right) => left.startUs - right.startUs);

  return sourceRanges.map((source, index) => {
    const startUs = source.startUs;
    const durationUs = source.durationUs;
    const overlapping = [source, ...captions, ...audio]
      .filter(
        (entry, entryIndex, entries) =>
          entries.findIndex((candidate) => candidate.id === entry.id) === entryIndex,
      )
      .filter((entry) => rangesOverlap(startUs, durationUs, entry.startUs, entry.durationUs));
    const evidenceIds = overlapping.map((entry) => entry.id);
    if (evidenceIds.length === 0) {
      throw new SemanticIndexError(
        'SEMANTIC_INDEX_MISSING_EVIDENCE',
        `range ${assetId}.${index} has no evidence`,
      );
    }
    const text = overlapping
      .map((entry) =>
        entry.kind === 'asset-caption' ? entry.text : `${entry.label} ${entry.summary ?? ''}`,
      )
      .join(' ')
      .trim();
    return {
      rangeId: `${assetId}.range-${String(index + 1).padStart(4, '0')}`,
      assetId,
      startUs,
      durationUs,
      label: source.label,
      text,
      evidenceIds,
    };
  });
}

function semanticEvidenceId(assetId: string, sourceEvidenceId: string): string {
  return `${assetId}.${sourceEvidenceId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
}

function rangesOverlap(
  leftStartUs: number,
  leftDurationUs: number,
  rightStartUs: number,
  rightDurationUs: number,
): boolean {
  const leftEndUs = leftStartUs + leftDurationUs;
  const rightEndUs = rightStartUs + rightDurationUs;
  return leftStartUs < rightEndUs && rightStartUs < leftEndUs;
}

function tagsFromText(text: string): readonly string[] {
  const stop = new Set(['the', 'and', 'with', 'from', 'into', 'shot', 'audio']);
  return [...new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => token.length > 2 && !stop.has(token))
    .slice(0, 12);
}
