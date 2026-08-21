/**
 * S1: Semantic Snapshot Types
 * 
 * Bounded, versioned project state capture for AI Creative OS foundation.
 * These types provide a stable, bounded view of project state suitable for
 * semantic analysis without exposing the full project structure.
 * 
 * Dependency: none (innermost package)
 */

// ============================================================================
// Core Types
// ============================================================================

/** Unique identifier for a semantic snapshot */
export type SnapshotId = string;

/** Revision number for snapshot versioning - monotonically increasing */
export type SnapshotRevision = number;

/** Canonical ID that can be referenced as evidence in S3 recommendations */
export type EvidenceId = string;

/** Timestamp in ISO 8601 format */
export type ISO8601 = string;

// ============================================================================
// Bounded String Types
// ============================================================================

/** Maximum length for snapshot-level identifiers */
const MAX_ID_LENGTH = 256;

/** Maximum length for labels and titles */
const MAX_LABEL_LENGTH = 500;

/** Maximum length for descriptions */
const MAX_DESCRIPTION_LENGTH = 2000;

/** Maximum length for content summaries */
const MAX_SUMMARY_LENGTH = 5000;

/** Maximum number of items in any snapshot array */
const MAX_ARRAY_LENGTH = 1000;

/** Maximum supported temporal range in microseconds (24 hours) */
const MAX_TIME_US = 24 * 60 * 60 * 1_000_000;

// ============================================================================
// Validation Helpers
// ============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringMaxLength(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isReadonlyArray<T>(value: unknown, guard: (v: unknown) => v is T): value is readonly T[] {
  return Array.isArray(value) && value.length <= MAX_ARRAY_LENGTH && value.every(guard);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedTimeUs(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_TIME_US;
}

function hasSameDerivedEvidence(
  expected: SnapshotEvidenceV1,
  actual: unknown,
): actual is SnapshotEvidenceV1 {
  if (!isSnapshotEvidenceV1(actual)) {
    return false;
  }

  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

// ============================================================================
// Snapshot Metadata
// ============================================================================

/** Metadata about the snapshot capture */
export interface SnapshotMetadataV1 {
  readonly id: SnapshotId;
  readonly revision: SnapshotRevision;
  readonly projectId: string;
  readonly createdAt: ISO8601;
  /** The schema version of the project at capture time */
  readonly schemaVersion: number;
  /** Hash of the snapshot content for integrity verification */
  readonly contentHash: string;
  /** User or agent who created the snapshot */
  readonly createdBy: string;
}

// ============================================================================
// Evidence Types
// ============================================================================

/** 
 * EvidenceKind categorizes the type of evidence available in the snapshot.
 * These are the canonical evidence types that S3 recommendations can reference.
 */
export type EvidenceKindV1 =
  | 'clip'
  | 'asset'
  | 'caption-document'
  | 'marker'
  | 'composition'
  | 'track'
  | 'visual-object'
  | 'effect'
  | 'transition'
  | 'audio-region'
  | 'workflow-artifact'
  | 'export-preset';

/** All valid evidence kinds */
export const EVIDENCE_KINDS_V1: readonly EvidenceKindV1[] = [
  'clip',
  'asset',
  'caption-document',
  'marker',
  'composition',
  'track',
  'visual-object',
  'effect',
  'transition',
  'audio-region',
  'workflow-artifact',
  'export-preset',
];

/**
 * Base evidence entry - the canonical referenceable unit in S1.
 * All recommendations in S3 must reference valid EvidenceId entries.
 */
export interface SnapshotEvidenceV1 {
  readonly id: EvidenceId;
  readonly kind: EvidenceKindV1;
  readonly label: string;
  readonly summary?: string;
  /** Temporal position in microseconds (for time-based evidence) */
  readonly startUs?: number;
  readonly durationUs?: number;
  /** Reference to the source entity ID in the project */
  readonly sourceEntityId: string;
  /** Revision of the source entity at capture time */
  readonly sourceEntityRevision: number;
}

/** Validation for evidence entries */
export function validateSnapshotEvidence(value: unknown): string[] {
  const errors: string[] = [];
  
  if (value === null || typeof value !== 'object') {
    return ['Evidence must be an object'];
  }
  
  const evidence = value as Record<string, unknown>;
  
  if (!isNonEmptyString(evidence.id) || evidence.id.length > MAX_ID_LENGTH) {
    errors.push(`Evidence id must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
  }
  
  if (!isNonEmptyString(evidence.kind) || !EVIDENCE_KINDS_V1.includes(evidence.kind as EvidenceKindV1)) {
    errors.push(`Evidence kind must be one of: ${EVIDENCE_KINDS_V1.join(', ')}`);
  }
  
  if (!isNonEmptyString(evidence.label) || evidence.label.length > MAX_LABEL_LENGTH) {
    errors.push(`Evidence label must be a non-empty string <= ${MAX_LABEL_LENGTH} chars`);
  }
  
  if (evidence.summary !== undefined && !isStringMaxLength(evidence.summary, MAX_SUMMARY_LENGTH)) {
    errors.push(`Evidence summary must be <= ${MAX_SUMMARY_LENGTH} chars`);
  }
  
  if (evidence.startUs !== undefined && !isBoundedTimeUs(evidence.startUs)) {
    errors.push(`Evidence startUs must be a non-negative integer <= ${MAX_TIME_US}`);
  }
  
  if (evidence.durationUs !== undefined && !isBoundedTimeUs(evidence.durationUs)) {
    errors.push(`Evidence durationUs must be a non-negative integer <= ${MAX_TIME_US}`);
  }
  
  if (!isNonEmptyString(evidence.sourceEntityId) || evidence.sourceEntityId.length > MAX_ID_LENGTH) {
    errors.push(`Evidence sourceEntityId must be a non-empty string <= ${MAX_ID_LENGTH} chars`);
  }
  
  if (!isNonNegativeInteger(evidence.sourceEntityRevision)) {
    errors.push('Evidence sourceEntityRevision must be a non-negative integer');
  }
  
  return errors;
}

// ============================================================================
// Media Evidence Subtypes
// ============================================================================

/** Evidence for video/audio/image assets */
export interface AssetEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'asset';
  readonly assetType: 'video' | 'audio' | 'image' | 'other';
  readonly fileSizeBytes: number;
  readonly mimeType: string;
  readonly durationUs?: number;
}

/** Evidence for timeline clips */
export interface ClipEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'clip';
  readonly trackId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly assetId?: string;
}

/** Evidence for caption documents */
export interface CaptionDocumentEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'caption-document';
  readonly language: string;
  readonly textLength: number;
  readonly wordCount: number;
}

/** Evidence for timeline markers */
export interface MarkerEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'marker';
  readonly timeUs: number;
  readonly color?: string;
}

/** Evidence for compositions */
export interface CompositionEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'composition';
  readonly width: number;
  readonly height: number;
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
  readonly durationUs: number;
}

/** Evidence for tracks */
export interface TrackEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'track';
  readonly trackType: 'video' | 'audio' | 'image' | 'text' | 'effect';
  readonly itemCount: number;
}

/** Evidence for visual objects */
export interface VisualObjectEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'visual-object';
  readonly objectType: 'image' | 'video' | 'shape' | 'text' | 'group' | 'html';
  readonly zIndex: number;
}

/** Evidence for effects */
export interface EffectEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'effect';
  readonly effectId: string;
  readonly enabled: boolean;
}

/** Evidence for transitions */
export interface TransitionEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'transition';
  readonly transitionId: string;
  readonly fromClipId: string;
  readonly toClipId: string;
}

/** Evidence for audio regions */
export interface AudioRegionEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'audio-region';
  readonly startUs: number;
  readonly durationUs: number;
  readonly peakDb?: number;
  readonly loudnessLufs?: number;
}

/** Evidence for workflow artifacts */
export interface WorkflowArtifactEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'workflow-artifact';
  readonly artifactKind: string;
  readonly workflowNodeId?: string;
}

/** Evidence for export presets */
export interface ExportPresetEvidenceV1 extends SnapshotEvidenceV1 {
  readonly kind: 'export-preset';
  readonly presetName: string;
  readonly outputFormat: string;
  readonly resolution: { readonly width: number; readonly height: number };
}

// ============================================================================
// Discriminated Union for Evidence
// ============================================================================

/** All possible evidence types as a discriminated union */
export type SnapshotEvidenceUnionV1 =
  | AssetEvidenceV1
  | ClipEvidenceV1
  | CaptionDocumentEvidenceV1
  | MarkerEvidenceV1
  | CompositionEvidenceV1
  | TrackEvidenceV1
  | VisualObjectEvidenceV1
  | EffectEvidenceV1
  | TransitionEvidenceV1
  | AudioRegionEvidenceV1
  | WorkflowArtifactEvidenceV1
  | ExportPresetEvidenceV1;

// ============================================================================
// Snapshot Sections
// ============================================================================

/** 
 * A named section of evidence within the snapshot.
 * Sections help organize evidence by domain (timeline, assets, captions, etc.)
 */
export interface SnapshotSectionV1 {
  readonly id: string;
  readonly label: string;
  readonly domain: 'timeline' | 'assets' | 'captions' | 'audio' | 'composition' | 'workflow' | 'export' | 'metadata';
  readonly evidence: readonly SnapshotEvidenceV1[];
}

// ============================================================================
// Statistical Summary
// ============================================================================

/** Statistical summary of the snapshot for quick analysis */
export interface SnapshotStatisticsV1 {
  readonly totalClips: number;
  readonly totalTracks: number;
  readonly totalAssets: number;
  readonly totalDurationUs: number;
  readonly totalCaptionDocuments: number;
  readonly totalMarkers: number;
  readonly totalVisualObjects: number;
  readonly totalEffects: number;
  readonly totalTransitions: number;
  /** Count of clips with missing assets */
  readonly missingAssetCount: number;
  /** Count of caption documents without text */
  readonly emptyCaptionCount: number;
  /** Count of timeline gaps */
  readonly gapCount: number;
}

// ============================================================================
// S1 Semantic Snapshot
// ============================================================================

/**
 * S1: Semantic Snapshot Version 1
 * 
 * A bounded, revisioned capture of project state suitable for semantic analysis.
 * This is the canonical source of evidence that S3 recommendations must reference.
 * 
 * Key invariants:
 * - All arrays are readonly and bounded
 * - All strings are bounded
 * - All IDs are non-empty
 * - Evidence can be referenced by ID from S3
 * - No raw project objects exposed
 * - No executable content
 */
export interface SemanticSnapshotV1 {
  readonly schemaVersion: 1;
  readonly metadata: SnapshotMetadataV1;
  
  /** Statistics for quick analysis without deep inspection */
  readonly statistics: SnapshotStatisticsV1;
  
  /** 
   * All evidence in the snapshot, organized by section.
   * S3 recommendations must reference evidence IDs from this collection.
   */
  readonly sections: readonly SnapshotSectionV1[];
  
  /** 
   * Flat index of all evidence by ID for O(1) lookup.
   * Derived from sections for convenience, not user-provided.
   */
  readonly evidenceIndex: ReadonlyMap<EvidenceId, SnapshotEvidenceV1>;
  
  /** 
   * Flat list of all evidence IDs for iteration.
   */
  readonly evidenceIds: readonly EvidenceId[];
}

// ============================================================================
// Builder and Validation
// ============================================================================

/** Validation result for a snapshot */
export interface SnapshotValidationResultV1 {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Build options for creating a semantic snapshot
 */
export interface BuildSnapshotOptionsV1 {
  projectId: string;
  revision: SnapshotRevision;
  createdBy: string;
  schemaVersion: number;
  contentHash: string;
}

/**
 * Create a semantic snapshot from sections
 */
export function createSemanticSnapshotV1(
  sections: readonly SnapshotSectionV1[],
  options: BuildSnapshotOptionsV1,
): SemanticSnapshotV1 {
  const now = new Date().toISOString();
  const metadata: SnapshotMetadataV1 = {
    id: `snapshot-${options.projectId}-${options.revision}`,
    revision: options.revision,
    projectId: options.projectId,
    createdAt: now,
    schemaVersion: options.schemaVersion,
    contentHash: options.contentHash,
    createdBy: options.createdBy,
  };

  // Build statistics from sections
  const statistics = {
    totalClips: 0,
    totalTracks: 0,
    totalAssets: 0,
    totalDurationUs: 0,
    totalCaptionDocuments: 0,
    totalMarkers: 0,
    totalVisualObjects: 0,
    totalEffects: 0,
    totalTransitions: 0,
    missingAssetCount: 0,
    emptyCaptionCount: 0,
    gapCount: 0,
  };

  const evidenceIndex = new Map<EvidenceId, SnapshotEvidenceV1>();
  const evidenceIds: EvidenceId[] = [];
  
  for (const section of sections) {
    for (const evidence of section.evidence) {
      evidenceIndex.set(evidence.id, evidence);
      evidenceIds.push(evidence.id);
      
      // Update statistics based on evidence kind
      switch (evidence.kind) {
        case 'clip':
          statistics.totalClips++;
          if (evidence.durationUs) {
            statistics.totalDurationUs += evidence.durationUs;
          }
          break;
        case 'asset':
          statistics.totalAssets++;
          break;
        case 'caption-document':
          statistics.totalCaptionDocuments++;
          break;
        case 'marker':
          statistics.totalMarkers++;
          break;
        case 'composition':
          // Composition duration is the project duration
          if (evidence.durationUs) {
            statistics.totalDurationUs = evidence.durationUs;
          }
          break;
        case 'track':
          statistics.totalTracks++;
          break;
        case 'visual-object':
          statistics.totalVisualObjects++;
          break;
        case 'effect':
          statistics.totalEffects++;
          break;
        case 'transition':
          statistics.totalTransitions++;
          break;
      }
    }
  }

  return {
    schemaVersion: 1,
    metadata,
    statistics,
    sections,
    evidenceIndex,
    evidenceIds,
  };
}

/**
 * Validate a semantic snapshot
 */
export function validateSemanticSnapshotV1(
  snapshot: unknown,
): SnapshotValidationResultV1 {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (snapshot === null || typeof snapshot !== 'object') {
    return { valid: false, errors: ['Snapshot must be an object'], warnings: [] };
  }

  const s = snapshot as Record<string, unknown>;

  // Check schema version
  if (s.schemaVersion !== 1) {
    errors.push(`Unsupported schema version: ${s.schemaVersion}`);
  }

  // Validate metadata
  const metadata = s.metadata as Record<string, unknown>;
  if (!metadata || typeof metadata !== 'object') {
    errors.push('Snapshot metadata is required');
  } else {
    if (!isNonEmptyString(metadata.id)) {
      errors.push('Metadata id is required');
    }
    if (!isNonNegativeInteger(metadata.revision)) {
      errors.push('Metadata revision must be a non-negative integer');
    }
    if (!isNonEmptyString(metadata.projectId)) {
      errors.push('Metadata projectId is required');
    }
    if (!isNonEmptyString(metadata.createdAt)) {
      errors.push('Metadata createdAt is required');
    }
    if (!isNonNegativeInteger(metadata.schemaVersion)) {
      errors.push('Metadata schemaVersion is required');
    }
  }

  // Validate sections
  const sections = s.sections as unknown[];
  if (!Array.isArray(sections)) {
    errors.push('Sections must be an array');
  } else {
    for (const section of sections) {
      if (section === null || typeof section !== 'object') {
        errors.push('Each section must be an object');
        continue;
      }
      
      const sec = section as Record<string, unknown>;
      if (!isNonEmptyString(sec.id)) {
        errors.push('Section id is required');
      }
      if (!isNonEmptyString(sec.label)) {
        errors.push('Section label is required');
      }
      
      const domain = sec.domain as string;
      const validDomains = ['timeline', 'assets', 'captions', 'audio', 'composition', 'workflow', 'export', 'metadata'];
      if (!validDomains.includes(domain)) {
        errors.push(`Invalid section domain: ${domain}`);
      }
      
      const evidence = sec.evidence as unknown[];
      if (!Array.isArray(evidence)) {
        errors.push(`Section ${sec.id} evidence must be an array`);
      } else {
        for (const ev of evidence) {
          const evErrors = validateSnapshotEvidence(ev);
          errors.push(...evErrors);
        }
      }
    }
  }

  const expectedEvidenceEntries = Array.isArray(sections)
    ? sections.flatMap((section) =>
        section !== null &&
        typeof section === 'object' &&
        Array.isArray((section as Record<string, unknown>).evidence)
          ? ((section as Record<string, unknown>).evidence as SnapshotEvidenceV1[]).map((evidence) => [evidence.id, evidence] as const)
          : [],
      )
    : [];
  const expectedEvidenceIndex = new Map<EvidenceId, SnapshotEvidenceV1>(expectedEvidenceEntries);
  const expectedEvidenceIds = expectedEvidenceEntries.map(([id]) => id);

  // Validate evidence index matches sections
  const evidenceIndex = s.evidenceIndex as Map<EvidenceId, SnapshotEvidenceV1>;
  if (!(evidenceIndex instanceof Map)) {
    errors.push('evidenceIndex must be a Map');
  } else {
    if (evidenceIndex.size !== expectedEvidenceIndex.size) {
      errors.push('evidenceIndex must match the evidence derived from sections');
    }

    for (const [evidenceId, expectedEvidence] of expectedEvidenceIndex.entries()) {
      const actualEvidence = evidenceIndex.get(evidenceId);
      if (!hasSameDerivedEvidence(expectedEvidence, actualEvidence)) {
        errors.push(`evidenceIndex entry does not match sections for evidenceId ${evidenceId}`);
      }
    }

    for (const evidenceId of evidenceIndex.keys()) {
      if (!expectedEvidenceIndex.has(evidenceId)) {
        errors.push(`evidenceIndex contains unknown derived evidenceId ${evidenceId}`);
      }
    }
  }

  // Validate evidenceIds
  const evidenceIds = s.evidenceIds as unknown[];
  if (!Array.isArray(evidenceIds)) {
    errors.push('evidenceIds must be an array');
  } else {
    for (const id of evidenceIds) {
      if (!isNonEmptyString(id)) {
        errors.push('Each evidenceId must be a non-empty string');
      }
    }

    if (
      evidenceIds.length !== expectedEvidenceIds.length ||
      evidenceIds.some((id, index) => id !== expectedEvidenceIds[index])
    ) {
      errors.push('evidenceIds must match the evidence derived from sections');
    }
  }

  // Validate statistics
  const statistics = s.statistics as Record<string, unknown>;
  if (!statistics || typeof statistics !== 'object') {
    errors.push('Statistics is required');
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : [],
    warnings,
  };
}

/**
 * Check if an evidence ID exists in the snapshot
 */
export function hasEvidence(
  snapshot: SemanticSnapshotV1,
  evidenceId: EvidenceId,
): boolean {
  return snapshot.evidenceIndex.has(evidenceId);
}

/**
 * Get evidence by ID from snapshot
 */
export function getEvidence(
  snapshot: SemanticSnapshotV1,
  evidenceId: EvidenceId,
): SnapshotEvidenceV1 | undefined {
  return snapshot.evidenceIndex.get(evidenceId);
}

/**
 * Get all evidence of a specific kind
 */
export function getEvidenceByKind(
  snapshot: SemanticSnapshotV1,
  kind: EvidenceKindV1,
): readonly SnapshotEvidenceV1[] {
  return snapshot.evidenceIds
    .map((id) => snapshot.evidenceIndex.get(id))
    .filter((ev): ev is SnapshotEvidenceV1 => ev !== undefined && ev.kind === kind);
}

// ============================================================================
// Type Guards
// ============================================================================

export function isSemanticSnapshotV1(value: unknown): value is SemanticSnapshotV1 {
  if (value === null || typeof value !== 'object') return false;
  const s = value as SemanticSnapshotV1;
  return (
    s.schemaVersion === 1 &&
    typeof s.metadata === 'object' &&
    s.metadata !== null &&
    Array.isArray(s.sections) &&
    s.evidenceIndex instanceof Map &&
    Array.isArray(s.evidenceIds)
  );
}

export function isSnapshotEvidenceV1(value: unknown): value is SnapshotEvidenceV1 {
  if (value === null || typeof value !== 'object') return false;
  const ev = value as SnapshotEvidenceV1;
  return (
    isNonEmptyString(ev.id) &&
    isNonEmptyString(ev.kind) &&
    EVIDENCE_KINDS_V1.includes(ev.kind as EvidenceKindV1) &&
    isNonEmptyString(ev.label) &&
    isNonEmptyString(ev.sourceEntityId) &&
    isNonNegativeInteger(ev.sourceEntityRevision)
  );
}
