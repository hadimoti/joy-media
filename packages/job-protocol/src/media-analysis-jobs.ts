import type {
  AssetAudioEvidenceV1,
  AssetCaptionEvidenceV1,
  AssetShotEvidenceV1,
  SemanticBrollAssetV1,
} from '@joy-media/project-schema';

export type ReferenceAnalysisEvidenceKind =
  | 'shot'
  | 'cut-rhythm'
  | 'palette'
  | 'composition'
  | 'text-safe-zone'
  | 'transcript'
  | 'audio-beat';

export interface ReferenceAnalysisBox {
  readonly leftPct: number;
  readonly topPct: number;
  readonly widthPct: number;
  readonly heightPct: number;
}

export interface ReferenceTranscriptSegment {
  readonly startUs: number;
  readonly endUs: number;
  readonly text: string;
}

export type ReferenceAnalysisEvidence =
  | {
      readonly id: string;
      readonly kind: 'shot';
      readonly label: string;
      readonly summary: string;
      readonly startUs: number;
      readonly durationUs: number;
    }
  | {
      readonly id: string;
      readonly kind: 'cut-rhythm';
      readonly label: string;
      readonly summary: string;
      readonly cutCount: number;
      readonly averageShotDurationUs: number;
      readonly fastestShotDurationUs: number;
    }
  | {
      readonly id: string;
      readonly kind: 'palette';
      readonly label: string;
      readonly summary: string;
      readonly startUs: number;
      readonly swatches: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: 'composition';
      readonly label: string;
      readonly summary: string;
      readonly startUs: number;
      readonly focalPoint: { readonly xPct: number; readonly yPct: number };
      readonly balance: 'left' | 'center' | 'right';
      readonly headroomPct: number;
    }
  | {
      readonly id: string;
      readonly kind: 'text-safe-zone';
      readonly label: string;
      readonly summary: string;
      readonly safe: boolean;
      readonly boxes: readonly ReferenceAnalysisBox[];
    }
  | {
      readonly id: string;
      readonly kind: 'transcript';
      readonly label: string;
      readonly summary: string;
      readonly segments: readonly ReferenceTranscriptSegment[];
    }
  | {
      readonly id: string;
      readonly kind: 'audio-beat';
      readonly label: string;
      readonly summary: string;
      readonly startUs: number;
      readonly durationUs: number;
      readonly strength: number;
    };

export interface ReferenceAnalysisFinding {
  readonly id: string;
  readonly source: 'deterministic' | 'model';
  readonly title: string;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface VideoReferenceAnalyzePayload {
  readonly assetId: string;
  readonly maxDurationUs: number;
  readonly maxBytes: number;
  readonly sampleCount?: number;
  readonly maxAudioBeats?: number;
  readonly includeModelAnalysis?: boolean;
  readonly model?: string;
}

export interface VideoReferenceAnalyzeJob {
  readonly protocolVersion: 1;
  readonly jobId: string;
  readonly type: 'video.reference-analyze';
  readonly payload: VideoReferenceAnalyzePayload;
  readonly requirements: {
    readonly capabilities: readonly string[];
    readonly privacy: 'local-only' | 'remote-api';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export interface VideoReferenceAnalyzeReceipt {
  /**
   * For deterministic reference analysis this hash/byte pair always refers to
   * the analyzed source asset, not to an output blob.
   */
  readonly kind: 'video.reference-analyze';
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly durationUs: number;
  };
  readonly summary: {
    readonly shotCount: number;
    readonly cutCount: number;
    readonly averageShotDurationUs: number;
    readonly fastestShotDurationUs: number;
    readonly sampleCount: number;
    readonly transcriptSegmentCount: number;
    readonly audioBeatCount: number;
  };
  readonly evidence: readonly ReferenceAnalysisEvidence[];
  readonly evidenceIds: readonly string[];
  readonly findings?: readonly ReferenceAnalysisFinding[];
  readonly model?: string;
}

export type MediaSemanticIndexEvidence =
  AssetShotEvidenceV1 | AssetCaptionEvidenceV1 | AssetAudioEvidenceV1;

export interface MediaSemanticIndexPayload {
  readonly projectId: string;
  readonly receipts: readonly VideoReferenceAnalyzeReceipt[];
  readonly usedAssetIds?: readonly string[];
  readonly maxAssets?: number;
  readonly includeEmbeddings?: boolean;
  readonly includeRemoteRerank?: boolean;
}

export interface MediaSemanticIndexJob {
  readonly protocolVersion: 1;
  readonly jobId: string;
  readonly type: 'media.semantic-index';
  readonly payload: MediaSemanticIndexPayload;
  readonly requirements: {
    readonly capabilities: readonly string[];
    readonly privacy: 'local-only' | 'remote-api';
  };
  readonly idempotencyKey: string;
  readonly maxAttempts: number;
}

export interface MediaSemanticIndexReceipt {
  readonly kind: 'media.semantic-index';
  readonly projectId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly summary: {
    readonly assetCount: number;
    readonly rangeCount: number;
    readonly evidenceCount: number;
    readonly embeddedRangeCount: number;
    readonly reranked: boolean;
  };
  readonly evidence: readonly MediaSemanticIndexEvidence[];
  readonly evidenceIds: readonly string[];
  readonly assets: readonly SemanticBrollAssetV1[];
  readonly model?: string;
}

export type MediaAnalysisJob = VideoReferenceAnalyzeJob | MediaSemanticIndexJob;

export function assertValidVideoReferenceAnalyzePayload(
  payload: unknown,
  label = 'payload',
): asserts payload is VideoReferenceAnalyzePayload {
  const value = requireRecord(payload, label);
  requireOpaqueId(value.assetId, `${label}.assetId`);
  requirePositiveInteger(value.maxDurationUs, `${label}.maxDurationUs`);
  requirePositiveInteger(value.maxBytes, `${label}.maxBytes`);
  if (value.sampleCount !== undefined)
    requireIntegerInRange(value.sampleCount, 1, 12, `${label}.sampleCount`);
  if (value.maxAudioBeats !== undefined)
    requireIntegerInRange(value.maxAudioBeats, 0, 32, `${label}.maxAudioBeats`);
  if (value.includeModelAnalysis !== undefined && typeof value.includeModelAnalysis !== 'boolean') {
    throw new Error(`${label}.includeModelAnalysis must be a boolean`);
  }
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new Error(`${label}.model must be a string`);
  }
}

export function assertValidVideoReferenceAnalyzeReceipt(
  receipt: unknown,
  label = 'receipt',
): asserts receipt is VideoReferenceAnalyzeReceipt {
  const value = requireRecord(receipt, label);
  requireOpaqueId(value.assetId, `${label}.assetId`);
  requireHash(value.sha256, `${label}.sha256`);
  requirePositiveInteger(value.bytes, `${label}.bytes`);
  const descriptor = requireRecord(value.descriptor, `${label}.descriptor`);
  if (typeof descriptor.mimeType !== 'string' || !descriptor.mimeType.startsWith('video/')) {
    throw new Error(`${label}.descriptor.mimeType must be a video MIME type`);
  }
  requirePositiveInteger(descriptor.width, `${label}.descriptor.width`);
  requirePositiveInteger(descriptor.height, `${label}.descriptor.height`);
  requirePositiveInteger(descriptor.durationUs, `${label}.descriptor.durationUs`);
  const summary = requireRecord(value.summary, `${label}.summary`);
  requireNonNegativeInteger(summary.shotCount, `${label}.summary.shotCount`);
  requireNonNegativeInteger(summary.cutCount, `${label}.summary.cutCount`);
  requirePositiveInteger(summary.averageShotDurationUs, `${label}.summary.averageShotDurationUs`);
  requirePositiveInteger(summary.fastestShotDurationUs, `${label}.summary.fastestShotDurationUs`);
  requirePositiveInteger(summary.sampleCount, `${label}.summary.sampleCount`);
  requireNonNegativeInteger(
    summary.transcriptSegmentCount,
    `${label}.summary.transcriptSegmentCount`,
  );
  requireNonNegativeInteger(summary.audioBeatCount, `${label}.summary.audioBeatCount`);
  const evidence = requireArray(value.evidence, `${label}.evidence`);
  if (evidence.length === 0 || evidence.length > 200) {
    throw new Error(`${label}.evidence must contain 1-200 entries`);
  }
  evidence.forEach((entry, index) =>
    assertValidReferenceAnalysisEvidence(entry, `${label}.evidence[${index}]`),
  );
  const evidenceIds = requireArray(value.evidenceIds, `${label}.evidenceIds`);
  const derivedEvidenceIds = evidence.map((entry) => (entry as ReferenceAnalysisEvidence).id);
  if (
    evidenceIds.length !== derivedEvidenceIds.length ||
    evidenceIds.some((entry, index) => entry !== derivedEvidenceIds[index])
  ) {
    throw new Error(`${label}.evidenceIds must match evidence order exactly`);
  }
  if (value.findings !== undefined) {
    const findings = requireArray(value.findings, `${label}.findings`);
    if (findings.length > 100)
      throw new Error(`${label}.findings must contain at most 100 entries`);
    findings.forEach((entry, index) =>
      assertValidReferenceAnalysisFinding(
        entry,
        new Set(derivedEvidenceIds),
        `${label}.findings[${index}]`,
      ),
    );
  }
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new Error(`${label}.model must be a string`);
  }
}

export function assertValidMediaSemanticIndexPayload(
  payload: unknown,
  label = 'payload',
): asserts payload is MediaSemanticIndexPayload {
  const value = requireRecord(payload, label);
  requireOpaqueId(value.projectId, `${label}.projectId`);
  const receipts = requireArray(value.receipts, `${label}.receipts`);
  if (receipts.length > 1_000)
    throw new Error(`${label}.receipts must contain at most 1000 entries`);
  receipts.forEach((receipt, index) =>
    assertValidVideoReferenceAnalyzeReceipt(receipt, `${label}.receipts[${index}]`),
  );
  if (value.usedAssetIds !== undefined) {
    requireArray(value.usedAssetIds, `${label}.usedAssetIds`).forEach((assetId, index) =>
      requireOpaqueId(assetId, `${label}.usedAssetIds[${index}]`),
    );
  }
  if (value.maxAssets !== undefined) {
    requireIntegerInRange(value.maxAssets, 1, 1_000, `${label}.maxAssets`);
  }
  if (value.includeEmbeddings !== undefined && typeof value.includeEmbeddings !== 'boolean') {
    throw new Error(`${label}.includeEmbeddings must be a boolean`);
  }
  if (value.includeRemoteRerank !== undefined && typeof value.includeRemoteRerank !== 'boolean') {
    throw new Error(`${label}.includeRemoteRerank must be a boolean`);
  }
}

export function assertValidMediaSemanticIndexReceipt(
  receipt: unknown,
  label = 'receipt',
): asserts receipt is MediaSemanticIndexReceipt {
  const value = requireRecord(receipt, label);
  if (value.kind !== 'media.semantic-index') throw new Error(`${label}.kind is invalid`);
  requireOpaqueId(value.projectId, `${label}.projectId`);
  requireHash(value.sha256, `${label}.sha256`);
  requirePositiveInteger(value.bytes, `${label}.bytes`);
  const summary = requireRecord(value.summary, `${label}.summary`);
  requireNonNegativeInteger(summary.assetCount, `${label}.summary.assetCount`);
  requireNonNegativeInteger(summary.rangeCount, `${label}.summary.rangeCount`);
  requireNonNegativeInteger(summary.evidenceCount, `${label}.summary.evidenceCount`);
  requireNonNegativeInteger(summary.embeddedRangeCount, `${label}.summary.embeddedRangeCount`);
  if (typeof summary.reranked !== 'boolean') {
    throw new Error(`${label}.summary.reranked must be a boolean`);
  }
  const evidence = requireArray(value.evidence, `${label}.evidence`);
  if (evidence.length > 5_000)
    throw new Error(`${label}.evidence must contain at most 5000 entries`);
  evidence.forEach((entry, index) =>
    assertValidSemanticIndexEvidence(entry, `${label}.evidence[${index}]`),
  );
  const evidenceIds = requireArray(value.evidenceIds, `${label}.evidenceIds`);
  const derivedEvidenceIds = evidence.map((entry) => (entry as MediaSemanticIndexEvidence).id);
  if (
    evidenceIds.length !== derivedEvidenceIds.length ||
    evidenceIds.some((entry, index) => entry !== derivedEvidenceIds[index])
  ) {
    throw new Error(`${label}.evidenceIds must match evidence order exactly`);
  }
  const knownEvidence = new Set(derivedEvidenceIds);
  requireArray(value.assets, `${label}.assets`).forEach((asset, assetIndex) => {
    const assetValue = requireRecord(asset, `${label}.assets[${assetIndex}]`);
    requireOpaqueId(assetValue.assetId, `${label}.assets[${assetIndex}].assetId`);
    if (typeof assetValue.displayName !== 'string' || assetValue.displayName.length === 0) {
      throw new Error(`${label}.assets[${assetIndex}].displayName must be a non-empty string`);
    }
    if (
      assetValue.assetType !== 'video' &&
      assetValue.assetType !== 'audio' &&
      assetValue.assetType !== 'image' &&
      assetValue.assetType !== 'other'
    ) {
      throw new Error(`${label}.assets[${assetIndex}].assetType is invalid`);
    }
    if (typeof assetValue.usedInTimeline !== 'boolean') {
      throw new Error(`${label}.assets[${assetIndex}].usedInTimeline must be a boolean`);
    }
    requireArray(assetValue.ranges, `${label}.assets[${assetIndex}].ranges`).forEach(
      (range, rangeIndex) => {
        const rangeValue = requireRecord(
          range,
          `${label}.assets[${assetIndex}].ranges[${rangeIndex}]`,
        );
        requireOpaqueId(
          rangeValue.rangeId,
          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].rangeId`,
        );
        if (rangeValue.assetId !== assetValue.assetId) {
          throw new Error(
            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].assetId must match assetId`,
          );
        }
        requirePositiveInteger(
          rangeValue.startUs,
          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].startUs`,
          true,
        );
        requirePositiveInteger(
          rangeValue.durationUs,
          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].durationUs`,
        );
        if (typeof rangeValue.label !== 'string' || rangeValue.label.length === 0) {
          throw new Error(
            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].label must be non-empty`,
          );
        }
        if (typeof rangeValue.text !== 'string') {
          throw new Error(
            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].text must be a string`,
          );
        }
        const ids = requireArray(
          rangeValue.evidenceIds,
          `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds`,
        );
        if (ids.length === 0)
          throw new Error(
            `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds must not be empty`,
          );
        ids.forEach((entry, index) => {
          if (typeof entry !== 'string' || !knownEvidence.has(entry)) {
            throw new Error(
              `${label}.assets[${assetIndex}].ranges[${rangeIndex}].evidenceIds[${index}] references unknown evidence`,
            );
          }
        });
      },
    );
  });
  if (value.model !== undefined && typeof value.model !== 'string') {
    throw new Error(`${label}.model must be a string`);
  }
}

function assertValidReferenceAnalysisEvidence(
  evidence: unknown,
  label: string,
): asserts evidence is ReferenceAnalysisEvidence {
  const value = requireRecord(evidence, label);
  requireOpaqueId(value.id, `${label}.id`);
  if (typeof value.label !== 'string' || value.label.length === 0) {
    throw new Error(`${label}.label must be a non-empty string`);
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    throw new Error(`${label}.summary must be a non-empty string`);
  }
  switch (value.kind) {
    case 'shot':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
      return;
    case 'cut-rhythm':
      requireNonNegativeInteger(value.cutCount, `${label}.cutCount`);
      requirePositiveInteger(value.averageShotDurationUs, `${label}.averageShotDurationUs`);
      requirePositiveInteger(value.fastestShotDurationUs, `${label}.fastestShotDurationUs`);
      return;
    case 'palette':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requireArrayOfHexColors(value.swatches, `${label}.swatches`);
      return;
    case 'composition': {
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      const focalPoint = requireRecord(value.focalPoint, `${label}.focalPoint`);
      requireUnitNumber(focalPoint.xPct, `${label}.focalPoint.xPct`);
      requireUnitNumber(focalPoint.yPct, `${label}.focalPoint.yPct`);
      if (value.balance !== 'left' && value.balance !== 'center' && value.balance !== 'right') {
        throw new Error(`${label}.balance must be left, center, or right`);
      }
      requireUnitNumber(value.headroomPct, `${label}.headroomPct`);
      return;
    }
    case 'text-safe-zone':
      if (typeof value.safe !== 'boolean') throw new Error(`${label}.safe must be a boolean`);
      requireArray(value.boxes, `${label}.boxes`).forEach((entry, index) => {
        const box = requireRecord(entry, `${label}.boxes[${index}]`);
        requireUnitNumber(box.leftPct, `${label}.boxes[${index}].leftPct`);
        requireUnitNumber(box.topPct, `${label}.boxes[${index}].topPct`);
        requireUnitNumber(box.widthPct, `${label}.boxes[${index}].widthPct`);
        requireUnitNumber(box.heightPct, `${label}.boxes[${index}].heightPct`);
      });
      return;
    case 'transcript':
      requireArray(value.segments, `${label}.segments`).forEach((entry, index) => {
        const segment = requireRecord(entry, `${label}.segments[${index}]`);
        requirePositiveInteger(segment.startUs, `${label}.segments[${index}].startUs`, true);
        requirePositiveInteger(segment.endUs, `${label}.segments[${index}].endUs`);
        if (typeof segment.text !== 'string') {
          throw new Error(`${label}.segments[${index}].text must be a string`);
        }
      });
      return;
    case 'audio-beat':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
      if (
        typeof value.strength !== 'number' ||
        !Number.isFinite(value.strength) ||
        value.strength < 0
      ) {
        throw new Error(`${label}.strength must be a non-negative finite number`);
      }
      return;
    default:
      throw new Error(`${label}.kind is invalid`);
  }
}

function assertValidSemanticIndexEvidence(
  evidence: unknown,
  label: string,
): asserts evidence is MediaSemanticIndexEvidence {
  const value = requireRecord(evidence, label);
  requireOpaqueId(value.id, `${label}.id`);
  requireOpaqueId(value.assetId, `${label}.assetId`);
  if (typeof value.label !== 'string' || value.label.length === 0) {
    throw new Error(`${label}.label must be a non-empty string`);
  }
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw new Error(`${label}.summary must be a string`);
  }
  requireOpaqueId(value.sourceEntityId, `${label}.sourceEntityId`);
  requireNonNegativeInteger(value.sourceEntityRevision, `${label}.sourceEntityRevision`);
  switch (value.kind) {
    case 'asset-shot':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
      if (value.tags !== undefined) requireArray(value.tags, `${label}.tags`);
      return;
    case 'asset-caption':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
      if (typeof value.text !== 'string') throw new Error(`${label}.text must be a string`);
      if (value.language !== undefined && typeof value.language !== 'string') {
        throw new Error(`${label}.language must be a string`);
      }
      return;
    case 'asset-audio':
      requirePositiveInteger(value.startUs, `${label}.startUs`, true);
      requirePositiveInteger(value.durationUs, `${label}.durationUs`);
      if (
        value.audioKind !== 'dialogue' &&
        value.audioKind !== 'music' &&
        value.audioKind !== 'sfx' &&
        value.audioKind !== 'ambient' &&
        value.audioKind !== 'unknown'
      ) {
        throw new Error(`${label}.audioKind is invalid`);
      }
      if (value.transcript !== undefined && typeof value.transcript !== 'string') {
        throw new Error(`${label}.transcript must be a string`);
      }
      return;
    default:
      throw new Error(`${label}.kind is invalid`);
  }
}

function assertValidReferenceAnalysisFinding(
  finding: unknown,
  evidenceIds: ReadonlySet<string>,
  label: string,
): asserts finding is ReferenceAnalysisFinding {
  const value = requireRecord(finding, label);
  requireOpaqueId(value.id, `${label}.id`);
  if (value.source !== 'deterministic' && value.source !== 'model') {
    throw new Error(`${label}.source must be deterministic or model`);
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error(`${label}.title must be a non-empty string`);
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    throw new Error(`${label}.summary must be a non-empty string`);
  }
  const ids = requireArray(value.evidenceIds, `${label}.evidenceIds`);
  if (ids.length === 0) throw new Error(`${label}.evidenceIds must not be empty`);
  ids.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${label}.evidenceIds[${index}] must be a non-empty string`);
    }
    if (!evidenceIds.has(entry)) {
      throw new Error(`${label}.evidenceIds[${index}] references unknown evidence ${entry}`);
    }
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireArrayOfHexColors(value: unknown, label: string): void {
  const items = requireArray(value, label);
  if (items.length === 0 || items.length > 8) throw new Error(`${label} must contain 1-8 swatches`);
  items.forEach((entry, index) => {
    if (typeof entry !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry)) {
      throw new Error(`${label}[${index}] must be a hex color`);
    }
  });
}

function requireOpaqueId(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier`);
  }
}

function requireHash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
}

function requirePositiveInteger(value: unknown, label: string, zeroAllowed = false): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zeroAllowed ? 0 : 1)) {
    throw new Error(`${label} must be a ${zeroAllowed ? 'non-negative' : 'positive'} integer`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  requirePositiveInteger(value, label, true);
}

function requireIntegerInRange(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function requireUnitNumber(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
}
