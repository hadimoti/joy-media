/** Production-facing v1 project document subset (WP-01.1). */

import type { CompositionId, ProjectDiagnostic, TimelineTrackFamily, TrackId } from './model.js';
import type { Rational, TimeUs } from './time.js';
import { clipTimeRange, rational } from './time.js';
import { isValidPlaybackRate, MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from './model.js';
import type { ColorGradeV2 } from './color.js';
import type { PropertyAnimationV2 } from './property-animation.js';
import type { CaptionClipStyleV2 } from './caption-style.js';
import { normalizeCaptionClipStyle } from './caption-style.js';
import type { TextDocumentV1, TextStyleV1 } from './text-style.js';
import { isContentFontFamily } from './content-fonts.js';
import { validatePropertyAnimations } from './property-animation.js';
import type { UniversalTimelineDocument } from './universal-timeline.js';
import { validateUniversalTimelineDocument } from './universal-timeline.js';
import type { TimelineTrackDeckDocument } from './timeline-track-deck.js';
import { validateTimelineTrackDeckDocument } from './timeline-track-deck.js';

export type EffectParamValue =
  | number
  | string
  | boolean
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number];

export interface EffectInstanceV1 {
  readonly id: string;
  readonly effectId: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, EffectParamValue>>;
  readonly animations?: Readonly<Partial<Record<string, AnimationCurveV1>>>;
  readonly label?: string;
}

export interface JoyProjectV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rootCompositionId: CompositionId;
  readonly settings: { readonly defaultLocale: string };
  readonly compositions: Readonly<Record<CompositionId, CompositionV1>>;
  readonly assets: Readonly<Record<string, AssetRecordV1>>;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly markers: readonly MarkerV1[];
  /** Visual objects are first-class project data, addressed globally by id. */
  readonly visualObjects: Readonly<Record<string, VisualObjectV1>>;
  /** Structured language data (§20.5); caption clips reference documents by id. */
  readonly captionDocuments: Readonly<Record<string, CaptionDocumentV1>>;
  /** Namespaced JSON only; plugin runtime objects never enter the project. */
  readonly pluginData: Readonly<Record<string, JsonValue>>;
  /** Optional durable audio graph (mixer / buses / FX). */
  readonly audio?: ProjectAudioV1;
  /** Optional master color grade (DaVinci-lite). */
  readonly colorGrade?: ColorGradeV1 | ColorGradeV2;
  /** Optional clip-local grades keyed by timeline clip id. */
  readonly clipColorGrades?: Readonly<Record<string, ColorGradeV2>>;
  /** Optional clip-junction transitions. */
  readonly transitions?: readonly TransitionV1[];
  /** Last chosen export preset id. */
  readonly exportPreset?: ExportPresetId;
  /**
   * Optional universal property animations (WP34-05), keyed by an animation id.
   * Each entry addresses a target via a stable `ownerKind`/`ownerId`/`propertyId`
   * binding and carries a discriminated curve/value. Absent = none. Cross-checks
   * (owner existence, canonical ids, ranges, key ordering) land in WP34-06.
   */
  readonly propertyAnimations?: Readonly<Record<string, PropertyAnimationV2>>;
  /** Versioned universal Timeline bindings; absent means legacy projection. */
  readonly universalTimeline?: UniversalTimelineDocument;
  /** Optional validated projection of the editor's universal row deck. */
  readonly timelineTrackDeck?: TimelineTrackDeckDocument;
}

export interface VisualObjectTransformV1 {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDeg: number;
  readonly opacity: number;
  /**
   * Depth offset from the composition's z=0 plane (§36 P10, ADR-0015). Absent
   * means 0 — a depth-only "2.5D" value with no per-layer 3D tilt; it only has
   * a visual effect when a composition has an `activeCameraId`.
   */
  readonly positionZ?: number;
  readonly crop: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

/** Universal animatable transform channels (§20.3, extended by ADR-0015); each maps to a scalar curve. */
export type AnimatablePropertyV1 =
  'x' | 'y' | 'scaleX' | 'scaleY' | 'rotationDeg' | 'opacity' | 'positionZ';

export const ANIMATABLE_PROPERTIES: readonly AnimatablePropertyV1[] = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotationDeg',
  'opacity',
  'positionZ',
];

/** Interpolation of the segment *leaving* a keyframe toward the next one. */
export type KeyframeInterpolationV1 = 'hold' | 'linear' | 'eased' | 'bezier';

/**
 * Cubic-bezier temporal easing handles in normalized segment space: `x` is the
 * time fraction in [0, 1], `y` the value fraction. Required only for the
 * `'bezier'` interpolation mode.
 */
export interface BezierHandlesV1 {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface SpatialKeyframe {
  readonly timeUs: TimeUs;
  readonly point: Vec2;
  readonly interpolation: KeyframeInterpolationV1;
  readonly bezier?: BezierHandlesV1;
  readonly outTangent?: Vec2;
  readonly inTangent?: Vec2;
}

export interface KeyframeV1 {
  /** Object-local (composition-local) time, integer microseconds. */
  readonly timeUs: TimeUs;
  readonly value: number;
  readonly interpolation: KeyframeInterpolationV1;
  /** Present iff `interpolation === 'bezier'`. */
  readonly bezier?: BezierHandlesV1;
}

/** A scalar animation curve: at least one keyframe, strictly increasing in time. */
export interface AnimationCurveV1 {
  readonly keyframes: readonly KeyframeV1[];
}

/** A durable 2D spatial path (P14.2). */
export interface SpatialPathV1 {
  readonly keyframes: readonly SpatialKeyframe[];
}

/** Basic motion blur (§20.3): a shutter interval sampled at a quality level. */
export interface MotionBlurV1 {
  readonly enabled: boolean;
  /** Shutter opening in degrees, [0, 360]; 180 is the film-standard half-frame. */
  readonly shutterAngleDeg: number;
  /** Sample count across the shutter interval; the quality knob, integer >= 1. */
  readonly samples: number;
}

/**
 * A depth-only 2.5D camera's own parameters (ADR-0015). Position/roll reuse the
 * object's ordinary transform (`x`, `y`, `positionZ`, `rotationDeg`); this only
 * carries the field of view. Deliberately no yaw/pitch — see ADR-0015.
 */
export interface CameraParamsV1 {
  /** Vertical field of view in degrees, exclusive of (0, 170]. */
  readonly fieldOfViewDeg: number;
}

/**
 * A visual object. `kind: 'null'` is a controller ("null object"): it renders
 * nothing but contributes a transform that its children inherit (§20.3
 * parenting). `kind: 'camera'` is a depth-only 2.5D camera controller (ADR-0015):
 * it renders nothing but its resolved transform + `camera` params drive
 * perspective projection for a composition's `activeCameraId`. `kind: 'html-scene'`
 * references a first-party or packaged HTML scene (`scenePackageId`) for
 * Monitor/export (P04). `parentId` links an object to its parent for transform
 * inheritance; the graph must stay acyclic.
 */
export interface VisualObjectV1 {
  readonly id: string;
  readonly kind: 'image' | 'text' | 'shape' | 'null' | 'camera' | 'html-scene';
  readonly transform: VisualObjectTransformV1;
  /** Optional per-channel keyframe curves; a present channel overrides the static value (§20.3). */
  readonly animations?: Readonly<Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>>;
  /**
   * Optional per-channel restricted expressions (§20.3, ADR-0015): source text
   * evaluated by `@joy-media/expression-core`. A present channel overrides its
   * keyframe curve/static value when it evaluates cleanly; project-schema only
   * checks the shape here (non-empty string) since it cannot depend on the
   * expression engine (§9.1 — dependency points inward). Compile/cycle
   * validity is enforced at command time (`object.setExpression`); a stored
   * expression that fails to compile or evaluate always falls back safely at
   * evaluation time rather than breaking the render.
   */
  readonly expressions?: Readonly<Partial<Record<AnimatablePropertyV1, string>>>;
  /** Optional durable 2D spatial path (P14.2). */
  readonly spatialPath?: SpatialPathV1;
  /** Parent object id for transform inheritance; must reference an existing, non-cyclic object. */
  readonly parentId?: string;
  readonly motionBlur?: MotionBlurV1;
  readonly assetId?: string;
  readonly text?: string;
  /** Structured editable text; absent legacy text is normalized at render time. */
  readonly textDocument?: TextDocumentV1;
  /** Base typography/effects for `textDocument` runs. */
  readonly textStyle?: TextStyleV1;
  readonly shape?: 'rectangle' | 'ellipse';
  /** Present iff `kind === 'camera'` (ADR-0015). */
  readonly camera?: CameraParamsV1;
  /** Present iff `kind === 'html-scene'` — first-party or package scene id (P04). */
  readonly scenePackageId?: string;
  /** Applied visual effects (P16). Stable per-instance IDs; order = application order. */
  readonly effects?: readonly EffectInstanceV1[];
}

export interface CompositionV1 {
  readonly id: CompositionId;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixelAspectRatio: Rational;
  readonly frameRate: Rational;
  readonly durationUs: TimeUs;
  readonly background: string;
  readonly tracks: readonly TrackV1[];
  /** The `kind: 'camera'` object driving this composition's projection (ADR-0015); absent = no camera. */
  readonly activeCameraId?: string;
}

export interface TrackV1 {
  readonly id: TrackId;
  readonly kind: 'video' | 'audio' | 'caption' | 'object' | 'control';
  /** Explicit compatibility family for professional timeline layout. */
  readonly family?: TimelineTrackFamily;
  readonly name: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly clips: readonly ClipV1[];
}

interface ClipV1Base {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly durationUs: TimeUs;
}

export interface VideoClipV1 extends ClipV1Base {
  readonly kind: 'video';
  readonly assetId: string;
  readonly sourceInUs: TimeUs;
  /** Optional; omit = 1×. `0` = freeze/hold. Otherwise `0.1…8`. */
  readonly playbackRate?: number;
  /** Source time runs backward from `sourceInUs` while rate remains positive. */
  readonly reversed?: boolean;
}

export interface CompositionClipV1 extends ClipV1Base {
  readonly kind: 'composition';
  readonly compositionId: CompositionId;
  readonly childOffsetUs: TimeUs;
}

/**
 * Caption clip: places a caption document on a caption track. Document times
 * are clip-relative — moving the clip moves every cue with it.
 */
export interface CaptionClipV1 extends ClipV1Base {
  readonly kind: 'caption';
  readonly captionDocumentId: string;
  /** Optional per-clip appearance; absent preserves legacy document-template rendering. */
  readonly style?: CaptionClipStyleV2;
}

export type ClipV1 = VideoClipV1 | CompositionClipV1 | CaptionClipV1;

/**
 * Caption model (§20.5): captions are structured language data before they are
 * graphics. Words are the immutable source tokens, addressed by id at document
 * level; segments group word ids and may carry a display-text override without
 * ever mutating the tokens themselves (§20.5 "AI edits must preserve source
 * text and timing history").
 */
export interface CaptionWordV1 {
  readonly id: string;
  readonly text: string;
  /** Clip-relative time, end-exclusive like every other durable range. */
  readonly startUs: TimeUs;
  readonly endUs: TimeUs;
  /** Recognition confidence in [0, 1] when a transcription provider supplied it. */
  readonly confidence?: number;
  readonly speakerId?: string;
}

export interface CaptionSegmentV1 {
  readonly id: string;
  readonly startUs: TimeUs;
  readonly endUs: TimeUs;
  /** Ordered references into the document's word table. */
  readonly wordIds: readonly string[];
  /** Edited display text; source tokens in `wordIds` stay untouched. */
  readonly textOverride?: string;
  readonly speakerId?: string;
}

export interface CaptionSpeakerV1 {
  readonly id: string;
  readonly name: string;
}

export interface CaptionDocumentV1 {
  readonly id: string;
  /** BCP-47 language tag, e.g. "fa-IR". */
  readonly language: string;
  /** 'auto' resolves from the first strong directional character at layout time. */
  readonly direction: 'ltr' | 'rtl' | 'auto';
  readonly speakers: readonly CaptionSpeakerV1[];
  readonly words: Readonly<Record<string, CaptionWordV1>>;
  readonly segments: readonly CaptionSegmentV1[];
  /** Style/animation registries land with WP-03.3; references stay stable now. */
  readonly styleRef?: string;
  readonly animationRef?: string;
  /** Normalized provider/model record; never provider-specific runtime data. */
  readonly provenance?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly createdAt: string;
  };
}

export interface AssetRecordV1 {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image' | 'lut' | 'other';
  readonly displayName: string;
  /** Safe integrity metadata copied from the owner catalog when available. */
  readonly sha256?: string;
  readonly bytes?: number;
  readonly descriptor?: AssetDescriptorV1;
  /** Reproducibility record for provider/Worker-generated media. */
  readonly generationProvenance?: GenerationProvenanceV1;
}

export interface AssetDescriptorV1 {
  readonly mimeType: string;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly animation?: AnimationDescriptorV1;
}

export interface AnimationDescriptorV1 {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** Zero means the source declares infinite looping. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

export interface GenerationProvenanceV1 {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly prompt: string;
  readonly seed?: string | number;
  readonly inputAssetHashes: readonly string[];
  readonly parameters: JsonValue;
  readonly generatedAssetId: string;
  readonly cost?: {
    readonly amount: string;
    readonly currency: string;
  };
  readonly createdAt: string;
}

export interface MarkerV1 {
  readonly id: string;
  readonly timeUs: TimeUs;
  readonly label: string;
  readonly color?: string;
  readonly kind?: 'marker' | 'chapter';
}

export interface ProjectAudioClipV1 {
  /** Optional processed/generated source replacing the clip's authored audio. */
  readonly sourceAssetId?: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
}

export interface ProjectAudioBusV1 {
  readonly id: string;
  readonly name: string;
  readonly gain: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly inputs: readonly string[];
}

export interface ProjectAudioEffectV1 {
  readonly id: string;
  readonly targetId: string;
  readonly effect: JsonValue;
}

export interface ProjectAudioV1 {
  readonly clips: Readonly<Record<string, ProjectAudioClipV1>>;
  readonly buses: readonly ProjectAudioBusV1[];
  readonly effects: readonly ProjectAudioEffectV1[];
}

export interface ColorGradeV1 {
  readonly lift: number;
  readonly gamma: number;
  readonly gain: number;
  readonly saturation: number;
  readonly lutId?: 'none' | 'rec709' | 'contrast';
}

/**
 * Clip-junction transition. `type` is a registry id:
 * legacy `dissolve` | `wipe` | `slide`, or curated `gl:*` shader ids
 * from `@joy-media/transition-shaders`.
 */
export interface TransitionV1 {
  readonly id: string;
  readonly trackId: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly type: string;
  readonly durationUs: TimeUs;
  /** Optional numeric overrides for gl-transition uniforms. */
  readonly params?: Readonly<Record<string, number>>;
}

export type ExportPresetId =
  'social-h264-aac' | 'reels-1080' | 'shorts-1080' | 'youtube-1080' | 'high-bitrate';

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Runtime diagnostics for untrusted JSON; this boundary is intentionally dependency-free. */
export function validateJoyProjectV1(value: unknown): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  if (!isRecord(value))
    return [diagnostic('PROJECT_SCHEMA_V1_NOT_OBJECT', 'project must be an object', '')];
  if (value.schemaVersion !== 1)
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VERSION', 'schemaVersion must be 1', 'schemaVersion'),
    );
  if (!isNonEmptyString(value.id))
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_ID', 'id must be a non-empty string', 'id'));
  if (!isNonEmptyString(value.title))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TITLE', 'title must be a non-empty string', 'title'),
    );
  if (!isNonEmptyString(value.rootCompositionId))
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_ROOT',
        'rootCompositionId must be a non-empty string',
        'rootCompositionId',
      ),
    );
  if (!isRecord(value.compositions))
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_COMPOSITIONS',
        'compositions must be an object',
        'compositions',
      ),
    );
  if (
    isRecord(value.compositions) &&
    isNonEmptyString(value.rootCompositionId) &&
    value.compositions[value.rootCompositionId] === undefined
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_ROOT',
        'rootCompositionId must exist in compositions',
        'rootCompositionId',
      ),
    );
  }
  const captionDocumentIds = new Set<string>(
    isRecord(value.captionDocuments) ? Object.keys(value.captionDocuments) : [],
  );
  if (isRecord(value.compositions)) {
    for (const [compositionId, composition] of Object.entries(value.compositions)) {
      validateComposition(
        composition,
        `compositions.${compositionId}`,
        diagnostics,
        captionDocumentIds,
      );
    }
  }
  if (!isRecord(value.assets))
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_ASSETS', 'assets must be an object', 'assets'));
  else {
    for (const [assetId, asset] of Object.entries(value.assets))
      validateAsset(asset, `assets.${assetId}`, assetId, diagnostics);
  }
  if (!isRecord(value.variables))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VARIABLES', 'variables must be an object', 'variables'),
    );
  if (!Array.isArray(value.markers))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_MARKERS', 'markers must be an array', 'markers'),
    );
  if (!isRecord(value.visualObjects))
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_VISUAL_OBJECTS',
        'visualObjects must be an object',
        'visualObjects',
      ),
    );
  else {
    for (const [objectId, object] of Object.entries(value.visualObjects))
      validateVisualObject(object, `visualObjects.${objectId}`, diagnostics);
    validateObjectParenting(value.visualObjects, diagnostics);
    if (isRecord(value.compositions))
      validateActiveCameras(value.compositions, value.visualObjects, diagnostics);
  }
  if (!isRecord(value.captionDocuments))
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_CAPTION_DOCUMENTS',
        'captionDocuments must be an object',
        'captionDocuments',
      ),
    );
  else {
    for (const [documentId, document] of Object.entries(value.captionDocuments))
      validateCaptionDocument(document, `captionDocuments.${documentId}`, diagnostics);
  }
  if (!isRecord(value.pluginData))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_PLUGIN_DATA', 'pluginData must be an object', 'pluginData'),
    );
  if (value.universalTimeline !== undefined) {
    diagnostics.push(...validateUniversalTimelineDocument(value.universalTimeline));
  }
  if (value.timelineTrackDeck !== undefined) {
    diagnostics.push(...validateTimelineTrackDeckDocument(value.timelineTrackDeck));
  }
  diagnostics.push(...validatePropertyAnimations(value.propertyAnimations));
  return diagnostics;
}

function validateAsset(
  value: unknown,
  path: string,
  assetId: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (
    !isRecord(value) ||
    value.id !== assetId ||
    !isNonEmptyString(value.displayName) ||
    !['video', 'audio', 'image', 'lut', 'other'].includes(String(value.kind))
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_ASSET',
        'asset must match its key and include a valid kind and display name',
        path,
      ),
    );
    return;
  }
  if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(String(value.sha256))) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_ASSET_METADATA',
        'asset sha256 must be lowercase hex',
        `${path}.sha256`,
      ),
    );
  }
  if (
    value.bytes !== undefined &&
    (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1)
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_ASSET_METADATA',
        'asset bytes must be a positive integer',
        `${path}.bytes`,
      ),
    );
  }
  if (value.descriptor !== undefined) {
    const descriptor = value.descriptor;
    if (
      !isRecord(descriptor) ||
      !isNonEmptyString(descriptor.mimeType) ||
      (descriptor.durationUs !== undefined &&
        (!Number.isSafeInteger(descriptor.durationUs) || Number(descriptor.durationUs) <= 0)) ||
      (descriptor.width !== undefined &&
        (!Number.isSafeInteger(descriptor.width) || Number(descriptor.width) <= 0)) ||
      (descriptor.height !== undefined &&
        (!Number.isSafeInteger(descriptor.height) || Number(descriptor.height) <= 0))
    ) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_ASSET_METADATA',
          'asset descriptor metadata is invalid',
          `${path}.descriptor`,
        ),
      );
    }
  }
  if (value.generationProvenance === undefined) return;
  const provenance = value.generationProvenance;
  if (
    !isRecord(provenance) ||
    provenance.generatedAssetId !== assetId ||
    !isNonEmptyString(provenance.providerId) ||
    !isNonEmptyString(provenance.modelId) ||
    !isNonEmptyString(provenance.modelVersion) ||
    typeof provenance.prompt !== 'string' ||
    !Array.isArray(provenance.inputAssetHashes) ||
    provenance.inputAssetHashes.some((hash) => !isNonEmptyString(hash)) ||
    !isJsonValue(provenance.parameters) ||
    !isNonEmptyString(provenance.createdAt) ||
    Number.isNaN(Date.parse(provenance.createdAt))
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_GENERATION_PROVENANCE',
        'generated asset provenance is incomplete or invalid',
        `${path}.generationProvenance`,
      ),
    );
    return;
  }
  if (
    provenance.seed !== undefined &&
    typeof provenance.seed !== 'string' &&
    (typeof provenance.seed !== 'number' || !Number.isFinite(provenance.seed))
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_GENERATION_PROVENANCE',
        'generation seed must be a string or finite number',
        `${path}.generationProvenance.seed`,
      ),
    );
  }
  if (
    provenance.cost !== undefined &&
    (!isRecord(provenance.cost) ||
      !isNonEmptyString(provenance.cost.amount) ||
      !isNonEmptyString(provenance.cost.currency))
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_GENERATION_PROVENANCE',
        'generation cost must include amount and currency',
        `${path}.generationProvenance.cost`,
      ),
    );
  }
}

function validateCaptionDocument(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_CAPTION_DOCUMENT', 'caption document id is required', path),
    );
    return;
  }
  if (!isNonEmptyString(value.language))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_CAPTION_DOCUMENT', 'caption language is required', path),
    );
  if (value.direction !== 'ltr' && value.direction !== 'rtl' && value.direction !== 'auto')
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_CAPTION_DOCUMENT',
        'caption direction must be ltr, rtl, or auto',
        path,
      ),
    );
  const speakerIds = new Set<string>();
  if (!Array.isArray(value.speakers))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_CAPTION_SPEAKER', 'speakers must be an array', path),
    );
  else {
    for (const speaker of value.speakers) {
      if (
        !isRecord(speaker) ||
        !isNonEmptyString(speaker.id) ||
        !isNonEmptyString(speaker.name) ||
        speakerIds.has(speaker.id)
      ) {
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_SPEAKER',
            'speakers need unique ids and names',
            `${path}.speakers`,
          ),
        );
        continue;
      }
      speakerIds.add(speaker.id);
    }
  }
  const wordIds = new Set<string>();
  if (!isRecord(value.words))
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_CAPTION_WORD', 'words must be an object', path));
  else {
    for (const [wordKey, word] of Object.entries(value.words)) {
      const wordPath = `${path}.words.${wordKey}`;
      if (!isRecord(word) || word.id !== wordKey || typeof word.text !== 'string') {
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_WORD',
            'word entries must match their key and carry text',
            wordPath,
          ),
        );
        continue;
      }
      wordIds.add(wordKey);
      validateCaptionRange(word, wordPath, 'PROJECT_SCHEMA_V1_CAPTION_WORD', diagnostics);
      if (
        word.confidence !== undefined &&
        (typeof word.confidence !== 'number' || word.confidence < 0 || word.confidence > 1)
      )
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_WORD',
            'word confidence must be in [0, 1]',
            wordPath,
          ),
        );
      if (word.speakerId !== undefined && !speakerIds.has(word.speakerId as string))
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_WORD',
            `word references unknown speaker "${String(word.speakerId)}"`,
            wordPath,
          ),
        );
    }
  }
  if (!Array.isArray(value.segments)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_CAPTION_SEGMENT', 'segments must be an array', path),
    );
    return;
  }
  const segmentIds = new Set<string>();
  for (const segment of value.segments) {
    if (!isRecord(segment) || !isNonEmptyString(segment.id) || segmentIds.has(segment.id)) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CAPTION_SEGMENT',
          'segments need unique non-empty ids',
          `${path}.segments`,
        ),
      );
      continue;
    }
    segmentIds.add(segment.id);
    const segmentPath = `${path}.segments.${segment.id}`;
    validateCaptionRange(segment, segmentPath, 'PROJECT_SCHEMA_V1_CAPTION_SEGMENT', diagnostics);
    if (!Array.isArray(segment.wordIds))
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_CAPTION_SEGMENT', 'wordIds must be an array', segmentPath),
      );
    else {
      for (const wordId of segment.wordIds) {
        if (typeof wordId !== 'string' || !wordIds.has(wordId))
          diagnostics.push(
            diagnostic(
              'PROJECT_SCHEMA_V1_CAPTION_SEGMENT',
              `segment references unknown word "${String(wordId)}"`,
              segmentPath,
            ),
          );
      }
    }
    if (segment.textOverride !== undefined && typeof segment.textOverride !== 'string')
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CAPTION_SEGMENT',
          'textOverride must be a string',
          segmentPath,
        ),
      );
    if (segment.speakerId !== undefined && !speakerIds.has(segment.speakerId as string))
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CAPTION_SEGMENT',
          `segment references unknown speaker "${String(segment.speakerId)}"`,
          segmentPath,
        ),
      );
  }
}

function validateCaptionRange(
  value: Record<string, unknown>,
  path: string,
  code: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (
    !isNonNegativeSafeInteger(value.startUs) ||
    !isNonNegativeSafeInteger(value.endUs) ||
    (value.endUs as number) <= (value.startUs as number)
  )
    diagnostics.push(diagnostic(code, 'startUs/endUs must satisfy 0 <= startUs < endUs', path));
}

function validateVisualObject(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object id is required', path));
    return;
  }
  if (
    value.kind !== 'image' &&
    value.kind !== 'text' &&
    value.kind !== 'shape' &&
    value.kind !== 'null' &&
    value.kind !== 'camera' &&
    value.kind !== 'html-scene'
  )
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object kind is invalid', path));
  if (value.kind === 'camera') {
    const camera = value.camera;
    if (
      !isRecord(camera) ||
      !Number.isFinite(camera.fieldOfViewDeg) ||
      (camera.fieldOfViewDeg as number) <= 0 ||
      (camera.fieldOfViewDeg as number) > 170
    )
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CAMERA',
          'camera objects require fieldOfViewDeg in (0, 170]',
          path,
        ),
      );
  } else if (value.camera !== undefined) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_CAMERA', 'only camera objects may carry camera params', path),
    );
  }
  if (value.kind === 'html-scene') {
    if (!isNonEmptyString(value.scenePackageId))
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_HTML_SCENE',
          'html-scene objects require a non-empty scenePackageId',
          path,
        ),
      );
  } else if (value.scenePackageId !== undefined) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_HTML_SCENE',
        'only html-scene objects may carry scenePackageId',
        path,
      ),
    );
  }
  if (value.parentId !== undefined && !isNonEmptyString(value.parentId))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'parentId must be a non-empty string', path),
    );
  if (value.motionBlur !== undefined) {
    const blur = value.motionBlur;
    if (
      !isRecord(blur) ||
      typeof blur.enabled !== 'boolean' ||
      !Number.isFinite(blur.shutterAngleDeg) ||
      (blur.shutterAngleDeg as number) < 0 ||
      (blur.shutterAngleDeg as number) > 360 ||
      !isPositiveInteger(blur.samples)
    )
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'motionBlur config is invalid', path),
      );
  }
  if (!isRecord(value.transform)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object transform is required', path),
    );
    return;
  }
  for (const key of ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg', 'opacity'] as const) {
    if (!Number.isFinite(value.transform[key]))
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', `transform ${key} must be finite`, path),
      );
  }
  if (value.transform.positionZ !== undefined && !Number.isFinite(value.transform.positionZ))
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'transform positionZ must be finite', path),
    );
  if (typeof value.transform.scaleX === 'number' && value.transform.scaleX <= 0)
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'scaleX must be positive', path),
    );
  if (typeof value.transform.scaleY === 'number' && value.transform.scaleY <= 0)
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'scaleY must be positive', path),
    );
  if (
    typeof value.transform.opacity === 'number' &&
    (value.transform.opacity < 0 || value.transform.opacity > 1)
  )
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'opacity must be in [0, 1]', path),
    );
  const crop = value.transform.crop;
  if (
    !isRecord(crop) ||
    !['left', 'top', 'right', 'bottom'].every((key) => Number.isFinite(crop[key]))
  )
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'crop edges must be finite', path),
    );
  if (value.animations !== undefined) {
    if (!isRecord(value.animations)) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_ANIMATION', 'animations must be an object', path),
      );
    } else {
      for (const [property, curve] of Object.entries(value.animations)) {
        if (!(ANIMATABLE_PROPERTIES as readonly string[]).includes(property))
          diagnostics.push(
            diagnostic(
              'PROJECT_SCHEMA_V1_ANIMATION',
              `"${property}" is not an animatable property`,
              `${path}.animations`,
            ),
          );
        validateAnimationCurve(curve, `${path}.animations.${property}`, diagnostics);
      }
    }
  }
  if (value.expressions !== undefined) {
    if (!isRecord(value.expressions)) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_EXPRESSION', 'expressions must be an object', path),
      );
    } else {
      for (const [property, source] of Object.entries(value.expressions)) {
        if (!(ANIMATABLE_PROPERTIES as readonly string[]).includes(property))
          diagnostics.push(
            diagnostic(
              'PROJECT_SCHEMA_V1_EXPRESSION',
              `"${property}" is not an animatable property`,
              `${path}.expressions`,
            ),
          );
        if (!isNonEmptyString(source))
          diagnostics.push(
            diagnostic(
              'PROJECT_SCHEMA_V1_EXPRESSION',
              `expression for "${property}" must be a non-empty string`,
              `${path}.expressions`,
            ),
          );
      }
    }
  }
  if (
    value.textDocument !== undefined ||
    value.textStyle !== undefined ||
    value.text !== undefined
  ) {
    if (value.kind !== 'text') {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_TEXT', 'text fields are only valid on text objects', path),
      );
    } else {
      if (value.textDocument !== undefined)
        validateTextDocument(value.textDocument, `${path}.textDocument`, diagnostics);
      if (value.textStyle !== undefined)
        validateTextStyle(value.textStyle, `${path}.textStyle`, diagnostics);
    }
  }
}

function validateTextDocument(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.blocks) ||
    value.blocks.length === 0
  ) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TEXT', 'textDocument must be version 1 with blocks', path),
    );
    return;
  }
  for (const block of value.blocks) {
    if (
      !isRecord(block) ||
      !isNonEmptyString(block.id) ||
      !Array.isArray(block.runs) ||
      block.runs.length === 0
    ) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_TEXT', 'text blocks require id and runs', path),
      );
      continue;
    }
    for (const run of block.runs) {
      if (!isRecord(run) || typeof run.text !== 'string')
        diagnostics.push(
          diagnostic('PROJECT_SCHEMA_V1_TEXT', 'text runs require string text', path),
        );
    }
  }
}

function validateTextStyle(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (
    !isRecord(value) ||
    !isContentFontFamily(value.fontFamily) ||
    !Number.isFinite(value.fontSizePx) ||
    (value.fontSizePx as number) <= 0 ||
    !Number.isSafeInteger(value.fontWeight) ||
    (value.fontWeight as number) < 100 ||
    (value.fontWeight as number) > 1000 ||
    typeof value.italic !== 'boolean' ||
    !Number.isFinite(value.lineHeight) ||
    (value.lineHeight as number) <= 0 ||
    !Number.isFinite(value.tracking) ||
    !['ltr', 'rtl', 'auto'].includes(String(value.direction)) ||
    !['start', 'center', 'end'].includes(String(value.align)) ||
    !isRecord(value.fill) ||
    !['solid', 'linear-gradient'].includes(String(value.fill.kind)) ||
    !['normal', 'multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'difference'].includes(
      String(value.blendMode),
    ) ||
    !Number.isFinite(value.opacity) ||
    (value.opacity as number) < 0 ||
    (value.opacity as number) > 1
  ) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TEXT', 'textStyle is malformed or outside safe ranges', path),
    );
  }
}

/**
 * Project-level parenting integrity (§20.3): every `parentId` must reference an
 * existing object, an object cannot parent itself, and the parent graph must be
 * acyclic. Cross-object checks live here because a single object can't see them.
 */
function validateObjectParenting(
  visualObjects: Record<string, unknown>,
  diagnostics: ProjectDiagnostic[],
): void {
  const parentOf = new Map<string, string>();
  for (const [objectId, object] of Object.entries(visualObjects)) {
    if (!isRecord(object) || object.parentId === undefined) continue;
    const parentId = object.parentId;
    if (typeof parentId !== 'string') continue; // shape already reported per-object
    const path = `visualObjects.${objectId}`;
    if (parentId === objectId) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_OBJECT_PARENT', 'an object cannot be its own parent', path),
      );
      continue;
    }
    if (visualObjects[parentId] === undefined) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_OBJECT_PARENT', `parent "${parentId}" does not exist`, path),
      );
      continue;
    }
    parentOf.set(objectId, parentId);
  }
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start]);
    let current = parentOf.get(start);
    while (current !== undefined) {
      if (seen.has(current)) {
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_OBJECT_PARENT',
            'parenting graph contains a cycle',
            `visualObjects.${start}`,
          ),
        );
        break;
      }
      seen.add(current);
      current = parentOf.get(current);
    }
  }
}

/**
 * Every composition's `activeCameraId` (ADR-0015), if present, must reference an
 * existing `kind: 'camera'` object. Cross-object/cross-composition, so it lives
 * at the project level like parenting integrity.
 */
function validateActiveCameras(
  compositions: Record<string, unknown>,
  visualObjects: Record<string, unknown>,
  diagnostics: ProjectDiagnostic[],
): void {
  for (const [compositionId, composition] of Object.entries(compositions)) {
    if (!isRecord(composition) || composition.activeCameraId === undefined) continue;
    const cameraId = composition.activeCameraId;
    if (typeof cameraId !== 'string') continue; // shape already reported per-composition
    const path = `compositions.${compositionId}.activeCameraId`;
    const camera = visualObjects[cameraId];
    if (camera === undefined) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_CAMERA', `camera "${cameraId}" does not exist`, path),
      );
    } else if (!isRecord(camera) || camera.kind !== 'camera') {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_CAMERA', `"${cameraId}" is not a camera object`, path),
      );
    }
  }
}

const INTERPOLATION_MODES: readonly string[] = ['hold', 'linear', 'eased', 'bezier'];

/** Validates a single scalar animation curve (§20.3): non-empty, strictly increasing, finite. */
export function validateAnimationCurve(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  const code = 'PROJECT_SCHEMA_V1_ANIMATION';
  if (!isRecord(value) || !Array.isArray(value.keyframes)) {
    diagnostics.push(diagnostic(code, 'curve must carry a keyframes array', path));
    return;
  }
  if (value.keyframes.length === 0) {
    diagnostics.push(diagnostic(code, 'curve must hold at least one keyframe', path));
    return;
  }
  let previousTimeUs = -1;
  for (const [index, keyframe] of value.keyframes.entries()) {
    const at = `${path}.keyframes[${index}]`;
    if (!isRecord(keyframe)) {
      diagnostics.push(diagnostic(code, 'keyframe must be an object', at));
      continue;
    }
    if (!isNonNegativeSafeInteger(keyframe.timeUs))
      diagnostics.push(diagnostic(code, 'keyframe timeUs must be a non-negative integer µs', at));
    else if ((keyframe.timeUs as number) <= previousTimeUs)
      diagnostics.push(diagnostic(code, 'keyframe times must strictly increase', at));
    else previousTimeUs = keyframe.timeUs as number;
    if (!Number.isFinite(keyframe.value))
      diagnostics.push(diagnostic(code, 'keyframe value must be finite', at));
    if (
      typeof keyframe.interpolation !== 'string' ||
      !INTERPOLATION_MODES.includes(keyframe.interpolation)
    )
      diagnostics.push(diagnostic(code, 'keyframe interpolation is invalid', at));
    if (keyframe.interpolation === 'bezier') {
      const bezier = keyframe.bezier;
      if (
        !isRecord(bezier) ||
        !['x1', 'y1', 'x2', 'y2'].every((key) => Number.isFinite(bezier[key]))
      )
        diagnostics.push(diagnostic(code, 'bezier interpolation requires finite handles', at));
      else if (
        (bezier.x1 as number) < 0 ||
        (bezier.x1 as number) > 1 ||
        (bezier.x2 as number) < 0 ||
        (bezier.x2 as number) > 1
      )
        diagnostics.push(diagnostic(code, 'bezier handle x must be within [0, 1]', at));
    } else if (keyframe.bezier !== undefined) {
      diagnostics.push(diagnostic(code, 'bezier handles only apply to bezier interpolation', at));
    }
  }
}

function validateComposition(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
  captionDocumentIds: ReadonlySet<string>,
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_COMPOSITION', 'composition must be an object', path),
    );
    return;
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_COMPOSITION', 'composition id and name are required', path),
    );
  }
  if (
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    !isNonNegativeSafeInteger(value.durationUs)
  ) {
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_COMPOSITION',
        'composition dimensions/duration are invalid',
        path,
      ),
    );
  }
  if (!isRational(value.frameRate) || !isRational(value.pixelAspectRatio)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_COMPOSITION', 'composition rationals are invalid', path),
    );
  }
  if (value.activeCameraId !== undefined && !isNonEmptyString(value.activeCameraId))
    diagnostics.push(
      diagnostic(
        'PROJECT_SCHEMA_V1_CAMERA',
        'activeCameraId must be a non-empty string',
        `${path}.activeCameraId`,
      ),
    );
  if (!Array.isArray(value.tracks)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TRACKS', 'tracks must be an array', `${path}.tracks`),
    );
    return;
  }
  for (const track of value.tracks)
    validateTrack(track, `${path}.tracks`, diagnostics, captionDocumentIds);
  if (value.transitions !== undefined)
    validateTransitions(value.transitions, value.tracks, `${path}.transitions`, diagnostics);
}

function validateTrack(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
  captionDocumentIds: ReadonlySet<string>,
): void {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !Array.isArray(value.clips)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TRACK', 'track id and clips are required', path),
    );
    return;
  }
  for (const clip of value.clips) {
    if (
      !isRecord(clip) ||
      !isNonEmptyString(clip.id) ||
      !isNonNegativeSafeInteger(clip.startUs) ||
      !isPositiveInteger(clip.durationUs)
    ) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CLIP',
          'clip id/range are invalid',
          `${path}.${value.id}.clips`,
        ),
      );
      continue;
    }
    try {
      clipTimeRange(clip.startUs, clip.durationUs);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CLIP',
          (error as Error).message,
          `${path}.${value.id}.clips.${clip.id}`,
        ),
      );
    }
    if (clip.kind === 'caption') {
      const clipPath = `${path}.${value.id}.clips.${clip.id}`;
      if (value.kind !== 'caption')
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_CLIP',
            'caption clips are only valid on caption tracks',
            clipPath,
          ),
        );
      if (
        !isNonEmptyString(clip.captionDocumentId) ||
        !captionDocumentIds.has(clip.captionDocumentId)
      )
        diagnostics.push(
          diagnostic(
            'PROJECT_SCHEMA_V1_CAPTION_CLIP',
            `caption clip references unknown document "${String(clip.captionDocumentId)}"`,
            clipPath,
          ),
        );
      if (clip.style !== undefined) {
        try {
          normalizeCaptionClipStyle(clip.style);
        } catch {
          diagnostics.push(
            diagnostic(
              'PROJECT_SCHEMA_V1_CAPTION_STYLE',
              'caption clip style is malformed or outside safe ranges',
              `${clipPath}.style`,
            ),
          );
        }
      }
    } else if (clip.style !== undefined) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CAPTION_STYLE',
          'only caption clips may carry a style',
          `${path}.${value.id}.clips.${clip.id}.style`,
        ),
      );
    }
    if (
      clip.kind === 'video' &&
      clip.playbackRate !== undefined &&
      (typeof clip.playbackRate !== 'number' || !isValidPlaybackRate(clip.playbackRate))
    ) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CLIP',
          `playbackRate must be 0 (freeze) or in [${MIN_PLAYBACK_RATE}, ${MAX_PLAYBACK_RATE}]`,
          `${path}.${value.id}.clips.${clip.id}`,
        ),
      );
    }
    if (
      clip.kind === 'video' &&
      clip.reversed !== undefined &&
      typeof clip.reversed !== 'boolean'
    ) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_CLIP',
          'reversed must be a boolean when present',
          `${path}.${value.id}.clips.${clip.id}`,
        ),
      );
    }
  }
}

function validateTransitions(
  value: unknown,
  tracks: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TRANSITION', 'transitions must be an array', path),
    );
    return;
  }
  if (!Array.isArray(tracks)) return;
  const seen = new Set<string>();
  const trackMap = new Map<string, Record<string, unknown>>();
  for (const track of tracks)
    if (isRecord(track) && isNonEmptyString(track.id)) trackMap.set(track.id, track);
  for (const transition of value) {
    if (
      !isRecord(transition) ||
      !isNonEmptyString(transition.id) ||
      seen.has(String(transition.id)) ||
      !isNonEmptyString(transition.trackId) ||
      !isNonEmptyString(transition.leftClipId) ||
      !isNonEmptyString(transition.rightClipId) ||
      !isNonEmptyString(transition.type) ||
      !isPositiveInteger(transition.durationUs)
    ) {
      diagnostics.push(
        diagnostic('PROJECT_SCHEMA_V1_TRANSITION', 'transition shape or id is invalid', path),
      );
      continue;
    }
    seen.add(transition.id);
    const track = trackMap.get(transition.trackId);
    const clips = track && Array.isArray(track.clips) ? track.clips.filter(isRecord) : [];
    const left = clips.find((clip) => clip.id === transition.leftClipId);
    const right = clips.find((clip) => clip.id === transition.rightClipId);
    if (
      !track ||
      track.kind !== 'video' ||
      !left ||
      !right ||
      left.kind !== 'video' ||
      right.kind !== 'video' ||
      (left.startUs as number) + (left.durationUs as number) !== right.startUs ||
      (transition.durationUs as number) >
        Math.min(left.durationUs as number, right.durationUs as number) / 2
    ) {
      diagnostics.push(
        diagnostic(
          'PROJECT_SCHEMA_V1_TRANSITION',
          'transition must reference adjacent visual clips within safe duration',
          path,
        ),
      );
    }
  }
}

function diagnostic(code: string, message: string, path: string): ProjectDiagnostic {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRational(value: unknown): value is Rational {
  if (!isRecord(value) || !isPositiveInteger(value.num) || !isPositiveInteger(value.den))
    return false;
  try {
    rational(value.num, value.den);
    return true;
  } catch {
    return false;
  }
}
