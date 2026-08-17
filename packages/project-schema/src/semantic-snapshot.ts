/**
 * Semantic Project Snapshot V1
 * WP-37 S1: Semantic Project Intelligence and Critique
 */

import type { TimeUs } from './time.js';
import type { CompositionId, ProjectId, TrackId } from './model.js';

/** Opaque project revision identifier (compatible with ADR-0012). */
export type ProjectRevisionId = string;

// ============================================================================
// Snapshot Schema V1
// ============================================================================

export interface EvidenceRefV1 {
  readonly id: string;
  readonly kind: 'composition' | 'track' | 'clip' | 'asset' | 'visual-object' | 'caption' | 'marker';
  readonly startUs?: TimeUs;
  readonly endUs?: TimeUs;
}

export interface SnapshotTruncationV1 {
  readonly clipsOmitted: number;
  readonly assetsOmitted: number;
  readonly visualObjectsOmitted: number;
  readonly scenesOmitted: number;
  readonly totalEstimateBytes: number;
}

export interface SnapshotWarningV1 {
  readonly code: 'missing-brand' | 'unavailable-asset' | 'truncated' | 'stale-revision' | 'unsupported-kind';
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly evidence?: readonly EvidenceRefV1[];
}

export type ScenePurposeV1 = 'hook' | 'problem' | 'explanation' | 'proof' | 'cta' | 'unknown';
export type VisualCoverageV1 = 'none' | 'sparse' | 'adequate' | 'dense';

export interface CaptionCoverageV1 {
  readonly hasCaptions: boolean;
  readonly wordCount: number;
  readonly locale: string;
}

export interface NarrationSummaryV1 {
  readonly hasNarration: boolean;
  readonly durationUs: TimeUs;
  readonly clipIds: readonly string[];
}

export interface SemanticElementSummaryV1 {
  readonly id: string;
  readonly kind:
    | 'video-clip'
    | 'composition-clip'
    | 'caption-clip'
    | 'audio-clip'
    | 'visual-object'
    | 'text'
    | 'shape'
    | 'image'
    | 'camera'
    | 'html-scene'
    | 'effect'
    | 'transition'
    | 'unknown';
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
  readonly assetId?: string;
  readonly trackId?: TrackId;
  readonly hasAudio: boolean;
  readonly hasVisual: boolean;
}

export interface SceneSummaryV1 {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly endUs: TimeUs;
  readonly purpose: ScenePurposeV1;
  readonly elements: readonly SemanticElementSummaryV1[];
  readonly narration?: NarrationSummaryV1;
  readonly captionCoverage?: CaptionCoverageV1;
  readonly visualCoverage: VisualCoverageV1;
  readonly evidence: readonly EvidenceRefV1[];
}

export interface BrandSummaryV1 {
  readonly hasBrandKit: boolean;
  readonly colorsAvailable: boolean;
  readonly fontsAvailable: boolean;
  readonly logoAvailable: boolean;
  readonly voiceInstructionsAvailable: boolean;
  readonly toneInstructionsAvailable: boolean;
  readonly prohibitedClaims: readonly string[];
  readonly prohibitedEffects: readonly string[];
  readonly warnings: readonly SnapshotWarningV1[];
}

export interface TimelineSummaryV1 {
  readonly compositionId: CompositionId;
  readonly durationUs: TimeUs;
  readonly frameRate: { readonly num: number; readonly den: number };
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: string;
  readonly visualTrackCount: number;
  readonly audioTrackCount: number;
  readonly totalClipCount: number;
  readonly visualRowIds: readonly string[];
  readonly audioRowIds: readonly string[];
}

export interface AssetSummaryV1 {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image' | 'font' | 'lutt' | 'project' | 'unknown';
  readonly name: string;
  readonly durationUs?: TimeUs;
  readonly hasProvenance: boolean;
  readonly isGenerated: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly warnings: readonly SnapshotWarningV1[];
}

export type CapabilityStatus = 'ready' | 'setup-required' | 'unavailable';

export interface SemanticProjectSnapshotV1 {
  readonly schemaVersion: 1;
  readonly projectId: ProjectId;
  readonly revisionId: ProjectRevisionId;
  readonly capturedAt: string;
  readonly composition: {
    readonly durationUs: TimeUs;
    readonly frameRate: { readonly num: number; readonly den: number };
    readonly width: number;
    readonly height: number;
    readonly aspectRatio: string;
  };
  readonly goal?: {
    readonly destination?: string;
    readonly durationTargetUs?: TimeUs;
    readonly brief?: string;
  };
  readonly brand: BrandSummaryV1;
  readonly scenes: readonly SceneSummaryV1[];
  readonly timeline: TimelineSummaryV1;
  readonly assets: readonly AssetSummaryV1[];
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;
  readonly warnings: readonly SnapshotWarningV1[];
  readonly truncation: SnapshotTruncationV1;
}

// ============================================================================
// Snapshot Options
// ============================================================================

export interface SnapshotOptions {
  /** ISO timestamp for capturedAt (defaults to current time if not provided) */
  readonly clock?: () => string;
  /** Maximum byte size for the snapshot (default: 8192 bytes = 8 KB) */
  readonly maxBytes?: number;
  /** Maximum number of scenes to include (default: 20) */
  readonly maxScenes?: number;
  /** Maximum number of assets to include (default: 50) */
  readonly maxAssets?: number;
  /** Maximum number of clips to include per scene (default: 10) */
  readonly maxClipsPerScene?: number;
}

// ============================================================================
// Validation Result
// ============================================================================

export interface SnapshotValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// ============================================================================
// Exports from implementation
// ============================================================================

export {
  projectToSemanticSnapshot,
  validateSemanticProjectSnapshot,
  segmentCompositionIntoScenes,
} from './semantic-snapshot-impl.js';
