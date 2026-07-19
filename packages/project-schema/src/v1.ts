/** Production-facing v1 project document subset (WP-01.1). */

import type { CompositionId, ProjectDiagnostic, TrackId } from './model.js';
import type { Rational, TimeUs } from './time.js';
import { clipTimeRange, rational } from './time.js';

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
}

export interface VisualObjectTransformV1 {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotationDeg: number;
  readonly opacity: number;
  readonly crop: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export interface VisualObjectV1 {
  readonly id: string;
  readonly kind: 'image' | 'text' | 'shape';
  readonly transform: VisualObjectTransformV1;
  readonly assetId?: string;
  readonly text?: string;
  readonly shape?: 'rectangle' | 'ellipse';
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
}

export interface TrackV1 {
  readonly id: TrackId;
  readonly kind: 'video' | 'audio' | 'caption' | 'object' | 'control';
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
  readonly kind: 'video' | 'audio' | 'image' | 'other';
  readonly displayName: string;
}

export interface MarkerV1 {
  readonly id: string;
  readonly timeUs: TimeUs;
  readonly label: string;
}

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
  return diagnostics;
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
  if (value.kind !== 'image' && value.kind !== 'text' && value.kind !== 'shape')
    diagnostics.push(diagnostic('PROJECT_SCHEMA_V1_VISUAL_OBJECT', 'object kind is invalid', path));
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
  if (!Array.isArray(value.tracks)) {
    diagnostics.push(
      diagnostic('PROJECT_SCHEMA_V1_TRACKS', 'tracks must be an array', `${path}.tracks`),
    );
    return;
  }
  for (const track of value.tracks)
    validateTrack(track, `${path}.tracks`, diagnostics, captionDocumentIds);
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
    }
  }
}

function diagnostic(code: string, message: string, path: string): ProjectDiagnostic {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
