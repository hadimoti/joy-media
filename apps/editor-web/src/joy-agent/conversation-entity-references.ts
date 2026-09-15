import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import { isExecutionReceipt, type ExecutionReceipt } from '../execution-receipt.js';

/**
 * Safe, bounded references to entities changed by the most recently committed
 * JOY edit. These are context hints only: they are neither a writer capability
 * nor a substitute for resolving the current canonical project before a run.
 */
export const JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION = 1 as const;
export const JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT = 24;

const MAX_OPAQUE_ID_CHARS = 128;
const MAX_LABEL_CHARS = 64;
const UNSAFE_VALUE =
  /(?:bearer\s+|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|https?:\/\/|ftp:\/\/|blob:|data:|file:|opfs:|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+|\/(?:Users|home|opt|tmp|var|etc)\/|(?:api[_-]?key|authorization|secret|token|password|credential|private[_-]?key)\s*[:=]?)/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;

/**
 * This finite list deliberately omits document names, text content, asset
 * display names, plugin data and provenance. Those fields can contain user
 * input, provider output, paths, URLs or credentials and are not valid
 * conversational identity.
 */
export const JOY_AGENT_CONVERSATION_ENTITY_KINDS = [
  'timeline-composition',
  'timeline-track',
  'timeline-video-clip',
  'timeline-composition-clip',
  'visual-composition',
  'visual-track',
  'visual-video-clip',
  'visual-composition-clip',
  'visual-caption-clip',
  'visual-text',
  'visual-image',
  'visual-shape',
  'visual-null',
  'visual-camera',
  'visual-html-scene',
  'asset-video',
  'asset-audio',
  'asset-image',
  'asset-lut',
  'asset-other',
  'caption-document',
  'marker',
  'chapter-marker',
  'transition',
  'property-animation',
  'audio-clip',
  'audio-bus',
  'audio-effect',
] as const;

export type JoyAgentConversationEntityKind = (typeof JOY_AGENT_CONVERSATION_ENTITY_KINDS)[number];

export interface JoyAgentConversationEntityReference {
  readonly version: typeof JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION;
  /** The timeline document ID bound into the durable host receipt. */
  readonly projectId: string;
  /** Opaque host receipt identity, never a model-supplied plan ID. */
  readonly executionId: string;
  /** The verified result revision recorded by the host receipt. */
  readonly resultRevision: string;
  readonly entityId: string;
  readonly entityKind: JoyAgentConversationEntityKind;
  /** A closed, host-owned label; never a project title/name/text field. */
  readonly label: string;
}

/** The current editor has separate canonical timeline and visual documents. */
export interface JoyAgentConversationEntitySource {
  readonly timeline: SpikeProject;
  readonly visual: JoyProjectV1;
}

export type JoyAgentConversationEntityClarificationCode =
  | 'JOY_AGENT_CONVERSATION_REFERENCE_RECEIPT_UNAVAILABLE'
  | 'JOY_AGENT_CONVERSATION_REFERENCE_PROJECT_MISMATCH'
  | 'JOY_AGENT_CONVERSATION_REFERENCE_MISSING_OR_DELETED'
  | 'JOY_AGENT_CONVERSATION_REFERENCE_AMBIGUOUS';

/**
 * Fixed host wording safe to render locally or send as a bounded planner
 * diagnostic. It deliberately contains no entity name, user prompt, provider
 * response or project metadata.
 */
export interface JoyAgentConversationEntityClarification {
  readonly version: typeof JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION;
  readonly code: JoyAgentConversationEntityClarificationCode;
  readonly message: string;
  /** Only safe opaque IDs from a canonical receipt; never an arbitrary input. */
  readonly entityIds: readonly string[];
  /** Number of receipt IDs that cannot be safely represented in this result. */
  readonly omittedEntityCount: number;
}

export type JoyAgentConversationEntityReferenceDerivation =
  | {
      readonly kind: 'references';
      readonly references: readonly JoyAgentConversationEntityReference[];
      readonly omittedEntityCount: number;
    }
  | {
      readonly kind: 'clarification';
      /** Resolved references stay available for a future explicit selection. */
      readonly references: readonly JoyAgentConversationEntityReference[];
      readonly clarification: JoyAgentConversationEntityClarification;
    };

export type JoyAgentConversationEntityReferenceResolution =
  | { readonly kind: 'resolved'; readonly reference: JoyAgentConversationEntityReference }
  | {
      readonly kind: 'clarification';
      readonly clarification: JoyAgentConversationEntityClarification;
    };

interface EntityCandidate {
  readonly id: string;
  readonly kind: JoyAgentConversationEntityKind;
}

const ENTITY_LABELS: Readonly<Record<JoyAgentConversationEntityKind, string>> = {
  'timeline-composition': 'Timeline composition',
  'timeline-track': 'Timeline track',
  'timeline-video-clip': 'Timeline video clip',
  'timeline-composition-clip': 'Timeline composition clip',
  'visual-composition': 'Visual composition',
  'visual-track': 'Visual track',
  'visual-video-clip': 'Visual video clip',
  'visual-composition-clip': 'Visual composition clip',
  'visual-caption-clip': 'Caption clip',
  'visual-text': 'Text layer',
  'visual-image': 'Image layer',
  'visual-shape': 'Shape layer',
  'visual-null': 'Null layer',
  'visual-camera': 'Camera layer',
  'visual-html-scene': 'Scene layer',
  'asset-video': 'Video asset',
  'asset-audio': 'Audio asset',
  'asset-image': 'Image asset',
  'asset-lut': 'LUT asset',
  'asset-other': 'Other asset',
  'caption-document': 'Caption document',
  marker: 'Marker',
  'chapter-marker': 'Chapter marker',
  transition: 'Transition',
  'property-animation': 'Property animation',
  'audio-clip': 'Audio clip',
  'audio-bus': 'Audio bus',
  'audio-effect': 'Audio effect',
};

const CLARIFICATION_MESSAGES: Readonly<
  Record<JoyAgentConversationEntityClarificationCode, string>
> = {
  JOY_AGENT_CONVERSATION_REFERENCE_RECEIPT_UNAVAILABLE:
    'JOY cannot safely identify the previous edit. Select an existing item before continuing.',
  JOY_AGENT_CONVERSATION_REFERENCE_PROJECT_MISMATCH:
    'The previous edit belongs to a different project. Select an item in the current project before continuing.',
  JOY_AGENT_CONVERSATION_REFERENCE_MISSING_OR_DELETED:
    'A previously edited item is no longer available. Select an existing item before continuing.',
  JOY_AGENT_CONVERSATION_REFERENCE_AMBIGUOUS:
    'JOY cannot safely determine which previous item to use. Select one item before continuing.',
};

/**
 * Derive session-local conversational entity hints from one canonical,
 * committed receipt and the current editor documents. The receipt is the
 * provenance authority; project fields merely prove that its opaque IDs still
 * name one unambiguous current entity.
 */
export function deriveJoyAgentConversationEntityReferences(
  receipt: unknown,
  source: JoyAgentConversationEntitySource,
): JoyAgentConversationEntityReferenceDerivation {
  if (!isExecutionReceipt(receipt) || !hasSafeReceiptIdentity(receipt))
    return clarificationResult('JOY_AGENT_CONVERSATION_REFERENCE_RECEIPT_UNAVAILABLE', [], 0, []);
  if (!isSafeOpaqueId(source.timeline.id) || receipt.projectId !== source.timeline.id)
    return clarificationResult(
      'JOY_AGENT_CONVERSATION_REFERENCE_PROJECT_MISMATCH',
      safeReceiptEntityIds(receipt),
      receipt.changedEntityIds.length,
      [],
    );

  const references: JoyAgentConversationEntityReference[] = [];
  const missingOrDeleted: string[] = [];
  const ambiguous: string[] = [];
  let omittedEntityCount = 0;

  for (const entityId of receipt.changedEntityIds) {
    if (!isSafeOpaqueId(entityId)) {
      omittedEntityCount += 1;
      continue;
    }
    const candidates = entityCandidates(source, entityId);
    if (candidates.length === 0) {
      omittedEntityCount += 1;
      if (missingOrDeleted.length < JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT)
        missingOrDeleted.push(entityId);
      continue;
    }
    if (candidates.length !== 1) {
      omittedEntityCount += 1;
      if (ambiguous.length < JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT)
        ambiguous.push(entityId);
      continue;
    }
    if (references.length >= JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT) {
      omittedEntityCount += 1;
      continue;
    }
    references.push(referenceFromCandidate(receipt, candidates[0]!));
  }

  if (ambiguous.length > 0)
    return clarificationResult(
      'JOY_AGENT_CONVERSATION_REFERENCE_AMBIGUOUS',
      ambiguous,
      omittedEntityCount,
      references,
    );
  if (missingOrDeleted.length > 0)
    return clarificationResult(
      'JOY_AGENT_CONVERSATION_REFERENCE_MISSING_OR_DELETED',
      missingOrDeleted,
      omittedEntityCount,
      references,
    );

  return Object.freeze({
    kind: 'references' as const,
    references: freezeReferences(references),
    omittedEntityCount,
  });
}

/**
 * Re-check a stored bounded reference against the current canonical project
 * immediately before it is used. A deleted or changed entity yields only a
 * fixed clarification result; stale identifiers never become tool arguments.
 */
export function resolveJoyAgentConversationEntityReference(
  value: unknown,
  source: JoyAgentConversationEntitySource,
): JoyAgentConversationEntityReferenceResolution {
  if (!isJoyAgentConversationEntityReference(value))
    return frozenClarification('JOY_AGENT_CONVERSATION_REFERENCE_RECEIPT_UNAVAILABLE', [], 0);
  if (!isSafeOpaqueId(source.timeline.id) || value.projectId !== source.timeline.id)
    return frozenClarification('JOY_AGENT_CONVERSATION_REFERENCE_PROJECT_MISMATCH', [], 1);
  const matches = entityCandidates(source, value.entityId).filter(
    (candidate) => candidate.kind === value.entityKind,
  );
  if (matches.length === 1)
    return Object.freeze({ kind: 'resolved' as const, reference: freezeReference(value) });
  if (matches.length > 1)
    return frozenClarification('JOY_AGENT_CONVERSATION_REFERENCE_AMBIGUOUS', [value.entityId], 1);
  return frozenClarification(
    'JOY_AGENT_CONVERSATION_REFERENCE_MISSING_OR_DELETED',
    [value.entityId],
    1,
  );
}

/** Validate a persisted or cross-component hint before it reaches new model context. */
export function isJoyAgentConversationEntityReference(
  value: unknown,
): value is JoyAgentConversationEntityReference {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'version',
      'projectId',
      'executionId',
      'resultRevision',
      'entityId',
      'entityKind',
      'label',
    ])
  )
    return false;
  if (
    value.version !== JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION ||
    !isSafeOpaqueId(value.projectId) ||
    !isSafeOpaqueId(value.executionId) ||
    !isSafeOpaqueId(value.resultRevision) ||
    !isSafeOpaqueId(value.entityId) ||
    typeof value.entityKind !== 'string' ||
    !isConversationEntityKind(value.entityKind) ||
    typeof value.label !== 'string' ||
    value.label.length > MAX_LABEL_CHARS
  )
    return false;
  return value.label === ENTITY_LABELS[value.entityKind];
}

function clarificationResult(
  code: JoyAgentConversationEntityClarificationCode,
  entityIds: readonly string[],
  omittedEntityCount: number,
  references: readonly JoyAgentConversationEntityReference[],
): JoyAgentConversationEntityReferenceDerivation {
  return Object.freeze({
    kind: 'clarification' as const,
    references: freezeReferences(references),
    clarification: createClarification(code, entityIds, omittedEntityCount),
  });
}

function frozenClarification(
  code: JoyAgentConversationEntityClarificationCode,
  entityIds: readonly string[],
  omittedEntityCount: number,
): JoyAgentConversationEntityReferenceResolution {
  return Object.freeze({
    kind: 'clarification' as const,
    clarification: createClarification(code, entityIds, omittedEntityCount),
  });
}

function createClarification(
  code: JoyAgentConversationEntityClarificationCode,
  entityIds: readonly string[],
  omittedEntityCount: number,
): JoyAgentConversationEntityClarification {
  const safeIds = entityIds
    .filter(isSafeOpaqueId)
    .slice(0, JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT);
  return Object.freeze({
    version: JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION,
    code,
    message: CLARIFICATION_MESSAGES[code],
    entityIds: Object.freeze([...safeIds]),
    omittedEntityCount: Number.isSafeInteger(omittedEntityCount)
      ? Math.max(0, omittedEntityCount)
      : 0,
  });
}

function referenceFromCandidate(
  receipt: ExecutionReceipt,
  candidate: EntityCandidate,
): JoyAgentConversationEntityReference {
  return freezeReference({
    version: JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION,
    projectId: receipt.projectId,
    executionId: receipt.executionId,
    resultRevision: receipt.resultRevision,
    entityId: candidate.id,
    entityKind: candidate.kind,
    label: ENTITY_LABELS[candidate.kind],
  });
}

function freezeReferences(
  references: readonly JoyAgentConversationEntityReference[],
): readonly JoyAgentConversationEntityReference[] {
  return Object.freeze(
    references
      .filter(isJoyAgentConversationEntityReference)
      .slice(0, JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT)
      .map(freezeReference),
  );
}

function freezeReference(
  reference: JoyAgentConversationEntityReference,
): JoyAgentConversationEntityReference {
  return Object.freeze({
    version: JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_VERSION,
    projectId: reference.projectId,
    executionId: reference.executionId,
    resultRevision: reference.resultRevision,
    entityId: reference.entityId,
    entityKind: reference.entityKind,
    label: reference.label,
  });
}

function hasSafeReceiptIdentity(receipt: ExecutionReceipt): boolean {
  return (
    isSafeOpaqueId(receipt.projectId) &&
    isSafeOpaqueId(receipt.executionId) &&
    isSafeOpaqueId(receipt.resultRevision)
  );
}

function safeReceiptEntityIds(receipt: ExecutionReceipt): readonly string[] {
  return receipt.changedEntityIds
    .filter(isSafeOpaqueId)
    .slice(0, JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT);
}

function entityCandidates(
  source: JoyAgentConversationEntitySource,
  entityId: string,
): readonly EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  const add = (id: unknown, kind: JoyAgentConversationEntityKind): void => {
    if (id === entityId && isSafeOpaqueId(id)) candidates.push({ id, kind });
  };

  for (const composition of Object.values(source.timeline.compositions)) {
    if (composition.id !== undefined) add(composition.id, 'timeline-composition');
    for (const track of composition.tracks) {
      add(track.id, 'timeline-track');
      for (const clip of track.clips) {
        if (clip.kind === 'video') add(clip.id, 'timeline-video-clip');
        else if (clip.kind === 'composition') add(clip.id, 'timeline-composition-clip');
      }
    }
  }

  for (const composition of Object.values(source.visual.compositions)) {
    if (composition.id !== undefined) add(composition.id, 'visual-composition');
    for (const track of composition.tracks) {
      add(track.id, 'visual-track');
      for (const clip of track.clips) {
        if (clip.kind === 'video') add(clip.id, 'visual-video-clip');
        else if (clip.kind === 'composition') add(clip.id, 'visual-composition-clip');
        else if (clip.kind === 'caption') add(clip.id, 'visual-caption-clip');
      }
    }
  }

  const visualObject = source.visual.visualObjects[entityId];
  if (visualObject?.id === entityId) {
    switch (visualObject.kind) {
      case 'text':
        add(visualObject.id, 'visual-text');
        break;
      case 'image':
        add(visualObject.id, 'visual-image');
        break;
      case 'shape':
        add(visualObject.id, 'visual-shape');
        break;
      case 'null':
        add(visualObject.id, 'visual-null');
        break;
      case 'camera':
        add(visualObject.id, 'visual-camera');
        break;
      case 'html-scene':
        add(visualObject.id, 'visual-html-scene');
        break;
    }
  }

  const asset = source.visual.assets[entityId];
  if (asset?.id === entityId) {
    switch (asset.kind) {
      case 'video':
        add(asset.id, 'asset-video');
        break;
      case 'audio':
        add(asset.id, 'asset-audio');
        break;
      case 'image':
        add(asset.id, 'asset-image');
        break;
      case 'lut':
        add(asset.id, 'asset-lut');
        break;
      case 'other':
        add(asset.id, 'asset-other');
        break;
    }
  }

  const captionDocument = source.visual.captionDocuments[entityId];
  if (captionDocument?.id === entityId) add(captionDocument.id, 'caption-document');
  for (const marker of source.visual.markers) {
    if (marker.kind === 'chapter') add(marker.id, 'chapter-marker');
    else add(marker.id, 'marker');
  }
  for (const transition of source.visual.transitions ?? []) add(transition.id, 'transition');
  // Own-property checks only: a bare `!== undefined` on a record index reads
  // the prototype chain, so ids like `constructor` or `toString` would report
  // a phantom match and break this module's fail-closed contract.
  const propertyAnimations = source.visual.propertyAnimations;
  if (propertyAnimations !== undefined && Object.hasOwn(propertyAnimations, entityId))
    add(entityId, 'property-animation');
  const audioClips = source.visual.audio?.clips;
  if (audioClips !== undefined && Object.hasOwn(audioClips, entityId)) add(entityId, 'audio-clip');
  for (const bus of source.visual.audio?.buses ?? []) add(bus.id, 'audio-bus');
  for (const effect of source.visual.audio?.effects ?? []) add(effect.id, 'audio-effect');

  return Object.freeze(candidates);
}

function isConversationEntityKind(value: string): value is JoyAgentConversationEntityKind {
  return (JOY_AGENT_CONVERSATION_ENTITY_KINDS as readonly string[]).includes(value);
}

function isSafeOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_CHARS &&
    OPAQUE_ID.test(value) &&
    !UNSAFE_VALUE.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
