import { validateCreativeBrief, type CreativeBriefV1 } from '@joy-media/agent-tools';
import {
  isJoyAgentConversationEntityReference,
  JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT,
  type JoyAgentConversationEntityReference,
} from './conversation-entity-references.js';

export interface JoyAgentContextSnapshot {
  readonly projectId: string;
  /**
   * The canonical timeline project that owns any optional conversational
   * entity references. The visual document ID remains `projectId`; keeping
   * the two scopes explicit prevents a valid receipt from being silently
   * dropped when the editor uses distinct document IDs.
   */
  readonly entityReferenceProjectId?: string;
  readonly revision: string;
  readonly compositionId?: string;
  readonly trackIds?: readonly string[];
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly clips: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
  /**
   * Fixed, host-derived identities from the last committed JOY edit. These
   * are deliberately not labels/names copied from project data: the exact
   * reference validator admits only a closed vocabulary and opaque IDs.
   */
  readonly recentEntityReferences?: readonly JoyAgentConversationEntityReference[];
  /** Recent project-scoped conversation turns, stripped to safe bounded text. */
  readonly conversation?: readonly {
    readonly role: 'user' | 'assistant';
    readonly body: string;
  }[];
  /** Bounded Inspector/motion targets; no raw project object crosses the Worker boundary. */
  readonly visualObjects?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly text?: string;
    readonly transform?: Readonly<Record<string, number>>;
    readonly animatedProperties: readonly string[];
  }[];
  /**
   * Applied Living Look instances read from the reopened canonical
   * `LookInstancesDocument`. Present only when the project has at least one; an
   * absent field and an empty project both mean "no Look is applied". Every
   * field is an opaque id, an enum, a bounded scalar map, or a small id list —
   * the same value classes a persisted `LookInstance` already admits.
   */
  readonly lookInstances?: readonly JoyAgentLookInstanceContext[];
  /** A validated, read-only brief artifact attached to the next Composer run. */
  readonly creativeBrief?: CreativeBriefV1;
  readonly omitted: readonly string[];
}

/**
 * One applied Living Look instance, reduced to the identities and state a cold
 * agent session needs to reason about `look_update` / `look_reset_overrides` /
 * `look_detach` — without any prior chat memory or owner-supplied ids. It never
 * carries a project document, URL, path, or credential.
 */
export interface JoyAgentLookInstanceContext {
  /** The canonical Look-instance id (`look-…`), the mutation tools' key. */
  readonly instanceId: string;
  readonly definitionId: string;
  /** The pack version this instance is pinned to (never "latest"). */
  readonly definitionVersion: number;
  readonly compositionId: string;
  /** Whether the pinned pack id still resolves to a known built-in definition. */
  readonly packStatus: 'known' | 'unknown';
  readonly packTitle?: string;
  /** The catalogue's current version for this pack, when the pack is known. */
  readonly packLatestVersion?: number;
  /** bindingId -> bound entity id. */
  readonly entityBindings: Readonly<Record<string, string>>;
  /** Binding ids whose target entity is no longer a live visual object. */
  readonly missingBindingIds: readonly string[];
  /** True when any binding target is missing (mirrors the panel's orphan flag). */
  readonly orphaned: boolean;
  /** Bindings the operator hand-edited; a reset must name these. */
  readonly overriddenBindingIds: readonly string[];
  readonly controlValues: Readonly<Record<string, number | string | boolean>>;
  readonly createdEntityIds: readonly string[];
}

const MAX_CONTEXT_BYTES = 60_000;
const MAX_CLIPS = 128;
const MAX_ASSETS = 128;
const MAX_VISUAL_OBJECTS = 128;
const MAX_LOOK_INSTANCES = 64;
const MAX_LOOK_BINDINGS = 32;
const MAX_LOOK_CONTROL_VALUES = 32;
const MAX_LOOK_OVERRIDES = 64;
const MAX_LOOK_CREATED_ENTITIES = 64;
const LOOK_INSTANCE_ID_PATTERN = /^look-[A-Za-z0-9][A-Za-z0-9-]{7,64}$/;
const LOOK_DEFINITION_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const LOOK_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_OMISSION_LABELS = [
  'selectedClipIds',
  'selectedVisualObjectIds',
  'clips',
  'assets',
  'visualObjects',
  'lookInstances',
  'recentEntityReferences',
  'conversation',
  'trackIds',
] as const;
const UNSAFE_CONTEXT_TEXT =
  /(?:https?:\/\/|ftp:\/\/|(?:[A-Za-z]:[\\/]|\\\\)[^\s]+|\/(?:Users|home|opt|tmp|var|etc)\/|(?:api[_-]?key|authorization|bearer|secret|token)\s*[:=]|sk-[A-Za-z0-9_-]{20,})/i;

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().slice(0, maxLength);
  return normalized.length === 0 || UNSAFE_CONTEXT_TEXT.test(normalized) ? undefined : normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accept an identifier only if it is already valid — never a truncated,
 * trimmed, or otherwise altered version of a longer string. A mutation key that
 * `safeText` would silently shorten into a *different* id must be rejected, not
 * forwarded, so a caller cannot act on an identity the project never held.
 */
function exactId(value: unknown, pattern: RegExp, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > maxLength) return undefined;
  if (value !== value.trim()) return undefined;
  if (UNSAFE_CONTEXT_TEXT.test(value)) return undefined;
  return pattern.test(value) ? value : undefined;
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Source facts from which JOY derives either a compact model snapshot or host pages. */
export interface JoyAgentContextSnapshotInput {
  readonly projectId: string;
  /**
   * Optional canonical timeline project ID for recent entity references.
   * Omit it when the visual and timeline documents share the same ID.
   */
  readonly entityReferenceProjectId?: string;
  readonly revision: string;
  readonly compositionId?: string;
  readonly trackIds?: readonly string[];
  readonly selectedClipIds?: readonly string[];
  /** Optional selected visual-object IDs used to prioritize Inspector targets. */
  readonly selectedVisualObjectIds?: readonly string[];
  readonly playheadUs?: number;
  readonly clips?: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
  /**
   * Optional persisted conversation hints. They are treated as untrusted at
   * this boundary and must pass the exact host-reference validator again.
   */
  readonly recentEntityReferences?: readonly JoyAgentConversationEntityReference[];
  readonly visualObjects?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly text?: string;
    readonly transform?: Readonly<Record<string, number>>;
    readonly animatedProperties?: readonly string[];
  }[];
  readonly conversation?: readonly {
    readonly role: 'user' | 'assistant';
    readonly body: string;
  }[];
  /**
   * Applied Look instances, already read from the hydrated canonical
   * `LookInstancesDocument`. Treated as untrusted here and re-sanitized like
   * every other field; a record that fails validation is dropped and reported
   * in `omitted`.
   */
  readonly lookInstances?: readonly JoyAgentLookInstanceContext[];
  /** Optional validated brief context; bounded before crossing into the Worker. */
  readonly creativeBrief?: CreativeBriefV1;
}

/**
 * Re-sanitize persisted Look-instance context at the boundary. Every rejected
 * record, rejected field, dropped list entry, and truncated collection is
 * reported through `omitted` (the reserved `'lookInstances'` label) so a reader
 * can always tell an *incomplete* projection from an *empty* project. Malformed
 * runtime shapes (a non-array where a list is expected, a scalar where a map is
 * expected) are handled predictably here — they never reach a bare
 * `.slice`/`.map`/`Object.entries` that could throw.
 */
function sanitizeLookInstances(
  input: readonly JoyAgentLookInstanceContext[] | undefined,
  omitted: Set<string>,
): JoyAgentLookInstanceContext[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    omitted.add('lookInstances');
    return [];
  }
  if (input.length > MAX_LOOK_INSTANCES) omitted.add('lookInstances');
  const out: JoyAgentLookInstanceContext[] = [];
  for (const raw of input.slice(0, MAX_LOOK_INSTANCES)) {
    const sanitized = sanitizeLookInstance(raw, omitted);
    if (sanitized !== undefined) out.push(sanitized);
  }
  return out;
}

/** Filter a persisted id list, reporting truncation and every dropped entry. */
function sanitizeLookIdList(
  value: unknown,
  cap: number,
  omitted: Set<string>,
  accept: (id: string) => boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    omitted.add('lookInstances');
    return [];
  }
  if (value.length > cap) omitted.add('lookInstances');
  const out: string[] = [];
  for (const entry of value.slice(0, cap)) {
    const id = exactId(entry, LOOK_TOKEN_PATTERN, 128);
    if (id === undefined || !accept(id)) {
      omitted.add('lookInstances');
      continue;
    }
    out.push(id);
  }
  return out;
}

function sanitizeLookInstance(
  raw: unknown,
  omitted: Set<string>,
): JoyAgentLookInstanceContext | undefined {
  if (!isPlainRecord(raw)) {
    omitted.add('lookInstances');
    return undefined;
  }
  const instanceId = exactId(raw.instanceId, LOOK_INSTANCE_ID_PATTERN, 80);
  const definitionId = exactId(raw.definitionId, LOOK_DEFINITION_ID_PATTERN, 64);
  const compositionId = exactId(raw.compositionId, LOOK_TOKEN_PATTERN, 128);
  const definitionVersion = raw.definitionVersion;
  if (
    instanceId === undefined ||
    definitionId === undefined ||
    compositionId === undefined ||
    typeof definitionVersion !== 'number' ||
    !Number.isInteger(definitionVersion) ||
    definitionVersion < 1
  ) {
    omitted.add('lookInstances');
    return undefined;
  }

  // entityBindings: bindingId -> entity id. A non-record shape (array, scalar)
  // is reported and the record kept with no bindings — never read positionally.
  const entityBindings: Record<string, string> = {};
  if (raw.entityBindings !== undefined && !isPlainRecord(raw.entityBindings)) {
    omitted.add('lookInstances');
  } else if (isPlainRecord(raw.entityBindings)) {
    const entries = Object.entries(raw.entityBindings);
    if (entries.length > MAX_LOOK_BINDINGS) omitted.add('lookInstances');
    for (const [key, value] of entries.slice(0, MAX_LOOK_BINDINGS)) {
      const target = exactId(value, LOOK_TOKEN_PATTERN, 128);
      if (!LOOK_TOKEN_PATTERN.test(key) || target === undefined) {
        omitted.add('lookInstances');
        continue;
      }
      entityBindings[key] = target;
    }
  }
  const knownBindingIds = new Set(Object.keys(entityBindings));

  const controlValues: Record<string, number | string | boolean> = {};
  if (raw.controlValues !== undefined && !isPlainRecord(raw.controlValues)) {
    omitted.add('lookInstances');
  } else if (isPlainRecord(raw.controlValues)) {
    const entries = Object.entries(raw.controlValues);
    if (entries.length > MAX_LOOK_CONTROL_VALUES) omitted.add('lookInstances');
    for (const [key, value] of entries.slice(0, MAX_LOOK_CONTROL_VALUES)) {
      if (!LOOK_TOKEN_PATTERN.test(key)) {
        omitted.add('lookInstances');
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) controlValues[key] = value;
      else if (typeof value === 'boolean') controlValues[key] = value;
      else {
        const text = safeText(value, 120);
        if (text === undefined) {
          omitted.add('lookInstances');
          continue;
        }
        controlValues[key] = text;
      }
    }
  }

  const overriddenBindingIds = sanitizeLookIdList(
    raw.overriddenBindingIds,
    MAX_LOOK_OVERRIDES,
    omitted,
    () => true,
  );
  const missingBindingIds = sanitizeLookIdList(
    raw.missingBindingIds,
    MAX_LOOK_BINDINGS,
    omitted,
    (id) => knownBindingIds.has(id),
  );
  const createdEntityIds = sanitizeLookIdList(
    raw.createdEntityIds,
    MAX_LOOK_CREATED_ENTITIES,
    omitted,
    () => true,
  );

  let packTitle: string | undefined;
  if (raw.packTitle !== undefined) {
    packTitle = safeText(raw.packTitle, 160);
    if (packTitle === undefined) omitted.add('lookInstances');
  }
  let packLatestVersion: number | undefined;
  if (raw.packLatestVersion !== undefined) {
    if (
      typeof raw.packLatestVersion === 'number' &&
      Number.isInteger(raw.packLatestVersion) &&
      raw.packLatestVersion >= 1
    )
      packLatestVersion = raw.packLatestVersion;
    else omitted.add('lookInstances');
  }
  const packStatus = raw.packStatus === 'known' ? 'known' : 'unknown';

  return Object.freeze({
    instanceId,
    definitionId,
    definitionVersion,
    compositionId,
    packStatus,
    ...(packStatus === 'known' && packTitle !== undefined ? { packTitle } : {}),
    ...(packStatus === 'known' && packLatestVersion !== undefined ? { packLatestVersion } : {}),
    entityBindings: Object.freeze(entityBindings),
    missingBindingIds: Object.freeze(missingBindingIds),
    orphaned: missingBindingIds.length > 0 || raw.orphaned === true,
    overriddenBindingIds: Object.freeze(overriddenBindingIds),
    controlValues: Object.freeze(controlValues),
    createdEntityIds: Object.freeze(createdEntityIds),
  });
}

/** Build one immutable, byte-bounded model context; never forwards project objects. */
export function createJoyAgentContextSnapshot(
  input: JoyAgentContextSnapshotInput,
): JoyAgentContextSnapshot {
  const omitted = new Set<string>();
  const projectId = safeText(input.projectId, 128);
  const revision = safeText(input.revision, 256);
  if (projectId === undefined || revision === undefined)
    throw new RangeError('JOY context identity is invalid or missing');
  const entityReferenceProjectId =
    input.entityReferenceProjectId === undefined
      ? projectId
      : safeText(input.entityReferenceProjectId, 128);
  const compositionId = safeText(input.compositionId, 128);
  const selectedClipIds = (input.selectedClipIds ?? [])
    .slice(0, 64)
    .map((id) => safeText(id, 128))
    .filter((id): id is string => id !== undefined);
  if (selectedClipIds.length !== (input.selectedClipIds ?? []).length)
    omitted.add('selectedClipIds');
  const selectedVisualObjectIds = new Set(
    (input.selectedVisualObjectIds ?? [])
      .map((id) => safeText(id, 128))
      .filter((id): id is string => id !== undefined),
  );
  if (selectedVisualObjectIds.size !== (input.selectedVisualObjectIds ?? []).length)
    omitted.add('selectedVisualObjectIds');
  const clips = (input.clips ?? [])
    .map((clip) => {
      const id = safeText(clip.id, 128);
      const trackId = safeText(clip.trackId, 128);
      if (id === undefined || trackId === undefined) return undefined;
      return {
        id,
        trackId,
        startUs: Number.isFinite(clip.startUs) ? Math.max(0, clip.startUs) : 0,
        durationUs: Number.isFinite(clip.durationUs) ? Math.max(0, clip.durationUs) : 0,
      };
    })
    .filter((clip): clip is NonNullable<typeof clip> => clip !== undefined);
  const assets = (input.assets ?? [])
    .slice(0, MAX_ASSETS)
    .map((asset) => {
      const id = safeText(asset.id, 128);
      const kind = safeText(asset.kind, 64);
      const displayName = safeText(asset.displayName, 160);
      if (id === undefined || kind === undefined || displayName === undefined) return undefined;
      return { id, kind, displayName };
    })
    .filter((asset): asset is NonNullable<typeof asset> => asset !== undefined);
  const recentEntityReferenceInput = Array.isArray(input.recentEntityReferences)
    ? input.recentEntityReferences
    : [];
  const recentEntityReferenceInputCount = Array.isArray(input.recentEntityReferences)
    ? input.recentEntityReferences.length
    : input.recentEntityReferences === undefined
      ? 0
      : 1;
  const recentEntityReferences = recentEntityReferenceInput
    .slice(0, JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT)
    .filter(
      (reference): reference is JoyAgentConversationEntityReference =>
        isJoyAgentConversationEntityReference(reference) &&
        entityReferenceProjectId !== undefined &&
        reference.projectId === entityReferenceProjectId,
    )
    .map((reference) =>
      Object.freeze({
        version: reference.version,
        projectId: reference.projectId,
        executionId: reference.executionId,
        resultRevision: reference.resultRevision,
        entityId: reference.entityId,
        entityKind: reference.entityKind,
        label: reference.label,
      }),
    );
  const visualObjects = (input.visualObjects ?? [])
    .map((object) => {
      const id = safeText(object.id, 128);
      const kind = safeText(object.kind, 64);
      const text = object.text === undefined ? undefined : safeText(object.text, 500);
      if (id === undefined || kind === undefined) return undefined;
      const transform = Object.fromEntries(
        Object.entries(object.transform ?? {})
          .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
          .slice(0, 16),
      ) as Record<string, number>;
      return {
        id,
        kind,
        ...(text === undefined ? {} : { text }),
        ...(Object.keys(transform).length === 0 ? {} : { transform }),
        animatedProperties: Object.freeze(
          (object.animatedProperties ?? [])
            .slice(0, 32)
            .map((property) => safeText(property, 128))
            .filter((property): property is string => property !== undefined),
        ),
      };
    })
    .filter((object): object is NonNullable<typeof object> => object !== undefined);
  const conversation = (input.conversation ?? [])
    .slice(-12)
    .map((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return undefined;
      const body = safeText(message.body, 1_000);
      return body === undefined ? undefined : { role: message.role, body };
    })
    .filter((message): message is NonNullable<typeof message> => message !== undefined);
  const lookInstances = sanitizeLookInstances(input.lookInstances, omitted);
  if (lookInstances.length !== (input.lookInstances?.length ?? 0)) omitted.add('lookInstances');
  if (clips.length !== (input.clips?.length ?? 0) || (input.clips?.length ?? 0) > MAX_CLIPS)
    omitted.add('clips');
  if (assets.length !== (input.assets?.length ?? 0) || (input.assets?.length ?? 0) > MAX_ASSETS)
    omitted.add('assets');
  if (
    recentEntityReferences.length !==
      Math.min(
        recentEntityReferenceInputCount,
        JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT,
      ) ||
    recentEntityReferenceInputCount > JOY_AGENT_CONVERSATION_ENTITY_REFERENCE_MAX_COUNT ||
    (input.entityReferenceProjectId !== undefined && entityReferenceProjectId === undefined)
  )
    omitted.add('recentEntityReferences');
  if (
    visualObjects.length !== (input.visualObjects?.length ?? 0) ||
    (input.visualObjects?.length ?? 0) > MAX_VISUAL_OBJECTS
  )
    omitted.add('visualObjects');
  if (conversation.length !== (input.conversation?.slice(-12).length ?? 0))
    omitted.add('conversation');
  const creativeBrief =
    input.creativeBrief === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(input.creativeBrief)) as CreativeBriefV1);
  if (creativeBrief !== undefined) {
    const bytes = byteLength(creativeBrief);
    if (bytes > 32_768 || UNSAFE_CONTEXT_TEXT.test(JSON.stringify(creativeBrief)))
      throw new RangeError('creative brief context is invalid or too large');
    if (
      !validateCreativeBrief(creativeBrief).valid ||
      creativeBrief.projectId !== projectId ||
      creativeBrief.snapshotRevisionId !== revision
    )
      throw new RangeError('creative brief context is invalid or stale');
  }
  const trackIds =
    input.trackIds === undefined
      ? []
      : input.trackIds
          .slice(0, 128)
          .map((id) => safeText(id, 128))
          .filter((id): id is string => id !== undefined);
  if (trackIds.length !== (input.trackIds?.length ?? 0)) omitted.add('trackIds');
  const orderedClips = [...clips].sort(
    (left, right) =>
      Number(!selectedClipIds.includes(left.id)) - Number(!selectedClipIds.includes(right.id)),
  );
  if (orderedClips.length > MAX_CLIPS) omitted.add('clips');
  const boundedClips = orderedClips.slice(0, MAX_CLIPS);
  const orderedVisualObjects = [...visualObjects].sort(
    (left, right) =>
      Number(!selectedVisualObjectIds.has(left.id)) -
      Number(!selectedVisualObjectIds.has(right.id)),
  );
  if (orderedVisualObjects.length > MAX_VISUAL_OBJECTS) omitted.add('visualObjects');
  const boundedVisualObjects = orderedVisualObjects.slice(0, MAX_VISUAL_OBJECTS);
  const base = {
    projectId,
    ...(recentEntityReferences.length > 0 && entityReferenceProjectId !== projectId
      ? { entityReferenceProjectId }
      : {}),
    revision,
    ...(compositionId === undefined ? {} : { compositionId }),
    ...(input.trackIds === undefined ? {} : { trackIds: [] as string[] }),
    selectedClipIds: Object.freeze(selectedClipIds),
    playheadUs: Number.isFinite(input.playheadUs) ? Math.max(0, input.playheadUs ?? 0) : 0,
    clips: [] as typeof clips,
    assets: [] as typeof assets,
    recentEntityReferences: [] as typeof recentEntityReferences,
    visualObjects: [] as typeof visualObjects,
    lookInstances: [] as typeof lookInstances,
    conversation: [] as typeof conversation,
    ...(creativeBrief === undefined ? {} : { creativeBrief }),
  };
  if (byteLength(base) > MAX_CONTEXT_BYTES)
    throw new RangeError('JOY context snapshot is too large');
  let snapshot = base;
  const append = <
    K extends
      | 'trackIds'
      | 'clips'
      | 'assets'
      | 'recentEntityReferences'
      | 'visualObjects'
      | 'lookInstances'
      | 'conversation',
  >(
    key: K,
    records: readonly (K extends 'trackIds'
      ? string
      : K extends 'clips'
        ? (typeof clips)[number]
        : K extends 'assets'
          ? (typeof assets)[number]
          : K extends 'recentEntityReferences'
            ? (typeof recentEntityReferences)[number]
            : K extends 'visualObjects'
              ? (typeof visualObjects)[number]
              : K extends 'lookInstances'
                ? (typeof lookInstances)[number]
                : (typeof conversation)[number])[],
    label: string,
  ): void => {
    const kept: unknown[] = [];
    for (const record of records) {
      // Reserve the metadata entry for this field while packing. Otherwise a
      // nearly-full snapshot can fit all records and then overflow when the
      // final `omitted` array is appended.
      const candidate = {
        ...snapshot,
        [key]: [...kept, record],
        // Reserve the complete bounded metadata envelope. Later fields may
        // discover additional omissions, so reserving only the current label
        // can still let a boundary-sized candidate overflow at finalization.
        omitted: [...new Set([...omitted, ...RESERVED_OMISSION_LABELS, label])],
      };
      if (byteLength(candidate) <= MAX_CONTEXT_BYTES) kept.push(record);
      else omitted.add(label);
    }
    snapshot = { ...snapshot, [key]: kept } as typeof snapshot;
  };
  append('trackIds', trackIds, 'trackIds');
  append('clips', boundedClips, 'clips');
  append('visualObjects', boundedVisualObjects, 'visualObjects');
  append('assets', assets, 'assets');
  append('lookInstances', lookInstances, 'lookInstances');
  append('recentEntityReferences', recentEntityReferences, 'recentEntityReferences');
  append('conversation', conversation, 'conversation');
  const {
    conversation: packedConversation,
    recentEntityReferences: packedRecentEntityReferences,
    lookInstances: packedLookInstances,
    ...snapshotWithoutOptionalCollections
  } = snapshot;
  const finalSnapshot = {
    ...snapshotWithoutOptionalCollections,
    ...(packedConversation.length > 0 ? { conversation: Object.freeze(packedConversation) } : {}),
    ...(packedRecentEntityReferences.length > 0
      ? { recentEntityReferences: Object.freeze(packedRecentEntityReferences) }
      : {}),
    ...(packedLookInstances.length > 0
      ? { lookInstances: Object.freeze(packedLookInstances) }
      : {}),
    trackIds: Object.freeze(snapshot.trackIds ?? []),
    clips: Object.freeze(snapshot.clips),
    assets: Object.freeze(snapshot.assets),
    visualObjects: Object.freeze(snapshot.visualObjects),
    omitted: Object.freeze([...omitted]),
  } as JoyAgentContextSnapshot;
  if (byteLength(finalSnapshot) > MAX_CONTEXT_BYTES)
    throw new RangeError('JOY context snapshot is too large');
  return Object.freeze(finalSnapshot);
}

/**
 * Trusted-host paging source for a single frozen editor revision.
 *
 * The compact `snapshot` remains the only thing eligible to cross into a
 * plan-only provider prompt. The paged collections stay on the main thread
 * and are returned only in individually bounded host-RPC responses. This
 * lets a model discover a matching asset/title beyond the first 128 records
 * without giving a Worker a project object, writer, or storage location.
 */
export interface JoyAgentPagedContext {
  readonly snapshot: JoyAgentContextSnapshot;
  readonly clips: JoyAgentContextSnapshot['clips'];
  readonly assets: JoyAgentContextSnapshot['assets'];
  readonly visualObjects: NonNullable<JoyAgentContextSnapshot['visualObjects']>;
  readonly lookInstances: NonNullable<JoyAgentContextSnapshot['lookInstances']>;
  readonly trackIds: readonly string[];
  readonly omitted: readonly string[];
}

export const JOY_AGENT_HOST_CONTEXT_MAX_RECORDS = 4_096;

function pageChunks<T>(records: readonly T[], size: number): readonly (readonly T[])[] {
  const pages: T[][] = [];
  for (let cursor = 0; cursor < records.length; cursor += size)
    pages.push(records.slice(cursor, cursor + size));
  return pages;
}

function uniqueOmitted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function freezeRecords<T extends object>(records: readonly T[]): readonly T[] {
  return Object.freeze(
    records.map((record) => deepFreeze(JSON.parse(JSON.stringify(record)) as T)),
  );
}

/**
 * Normalize every retained page through the same source sanitizer as the
 * model snapshot. The host has a record-count cap in addition to the
 * response byte cap enforced by host RPC; an oversized project reports an
 * omission rather than silently reading an unbounded collection.
 */
export function createJoyAgentPagedContext(
  input: JoyAgentContextSnapshotInput,
): JoyAgentPagedContext {
  const snapshot = createJoyAgentContextSnapshot(input);
  const common = { projectId: input.projectId, revision: input.revision } as const;
  const omitted: string[] = [];
  const normalizeClips = (input.clips ?? []).flatMap((records) => records);
  const clips = pageChunks(normalizeClips, MAX_CLIPS)
    .flatMap((page) => createJoyAgentContextSnapshot({ ...common, clips: page }).clips)
    .slice(0, JOY_AGENT_HOST_CONTEXT_MAX_RECORDS);
  const normalizeAssets = input.assets ?? [];
  const assets = pageChunks(normalizeAssets, MAX_ASSETS)
    .flatMap((page) => createJoyAgentContextSnapshot({ ...common, assets: page }).assets)
    .slice(0, JOY_AGENT_HOST_CONTEXT_MAX_RECORDS);
  const normalizeVisualObjects = input.visualObjects ?? [];
  const visualObjects = pageChunks(normalizeVisualObjects, MAX_VISUAL_OBJECTS)
    .flatMap(
      (page) =>
        createJoyAgentContextSnapshot({ ...common, visualObjects: page }).visualObjects ?? [],
    )
    .slice(0, JOY_AGENT_HOST_CONTEXT_MAX_RECORDS);
  const normalizeTrackIds = input.trackIds ?? [];
  const trackIds = pageChunks(normalizeTrackIds, 128)
    .flatMap((page) => createJoyAgentContextSnapshot({ ...common, trackIds: page }).trackIds ?? [])
    .slice(0, JOY_AGENT_HOST_CONTEXT_MAX_RECORDS);
  const normalizeLookInstances = Array.isArray(input.lookInstances) ? input.lookInstances : [];
  if (input.lookInstances !== undefined && !Array.isArray(input.lookInstances))
    omitted.push('lookInstances');
  const lookInstanceChunks = pageChunks(normalizeLookInstances, MAX_LOOK_INSTANCES).map((page) =>
    createJoyAgentContextSnapshot({ ...common, lookInstances: page }),
  );
  const lookInstances = lookInstanceChunks
    .flatMap((chunk) => chunk.lookInstances ?? [])
    .slice(0, JOY_AGENT_HOST_CONTEXT_MAX_RECORDS);
  // Preserve omission metadata from EVERY Look chunk — including chunks past the
  // first MAX_LOOK_INSTANCES that the compact model snapshot never inspects, so
  // a field truncated or dropped only in a later chunk is still reported.
  if (lookInstanceChunks.some((chunk) => chunk.omitted.includes('lookInstances')))
    omitted.push('lookInstances');

  if (clips.length < normalizeClips.length) omitted.push('clips');
  if (assets.length < normalizeAssets.length) omitted.push('assets');
  if (visualObjects.length < normalizeVisualObjects.length) omitted.push('visualObjects');
  if (trackIds.length < normalizeTrackIds.length) omitted.push('trackIds');
  if (lookInstances.length < normalizeLookInstances.length) omitted.push('lookInstances');
  if (normalizeClips.length > JOY_AGENT_HOST_CONTEXT_MAX_RECORDS) omitted.push('host-clips-cap');
  if (normalizeAssets.length > JOY_AGENT_HOST_CONTEXT_MAX_RECORDS) omitted.push('host-assets-cap');
  if (normalizeVisualObjects.length > JOY_AGENT_HOST_CONTEXT_MAX_RECORDS)
    omitted.push('host-visual-objects-cap');
  if (normalizeTrackIds.length > JOY_AGENT_HOST_CONTEXT_MAX_RECORDS)
    omitted.push('host-track-ids-cap');
  if (normalizeLookInstances.length > JOY_AGENT_HOST_CONTEXT_MAX_RECORDS)
    omitted.push('host-look-instances-cap');

  return Object.freeze({
    snapshot,
    clips: freezeRecords(clips),
    assets: freezeRecords(assets),
    visualObjects:
      freezeRecords<NonNullable<JoyAgentContextSnapshot['visualObjects']>[number]>(visualObjects),
    lookInstances:
      freezeRecords<NonNullable<JoyAgentContextSnapshot['lookInstances']>[number]>(lookInstances),
    trackIds: Object.freeze([...trackIds]),
    omitted: uniqueOmitted([...snapshot.omitted, ...omitted]),
  });
}
