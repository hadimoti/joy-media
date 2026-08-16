/**
 * Universal Timeline Compatibility Mode (WP-35R / ADR-0035).
 *
 * The persisted document is deliberately a small binding layer. It does not
 * duplicate the creative project or decide how an element renders; it says
 * which element occupies which neutral track and when. Legacy projects are
 * projected into the same shape without being rewritten on open.
 */

import type { Clip, ProjectDiagnostic, SpikeProject } from './model.js';
import type { JoyProjectV1, VisualObjectV1 } from './v1.js';

export const UNIVERSAL_TIMELINE_SCHEMA_VERSION = 1 as const;
/** Latest binding shape written on copy-on-write; v1 remains readable. */
export const UNIVERSAL_TIMELINE_LATEST_SCHEMA_VERSION = 2 as const;

export type TimelinePlacementKind =
  | 'video'
  | 'audio'
  | 'image'
  | 'text'
  | 'shape'
  | 'overlay'
  | 'sticker'
  | 'caption'
  | 'motion'
  | 'effect'
  | 'filter'
  | 'adjustment'
  | 'scene3d'
  | 'html-scene'
  | 'composition'
  | 'camera'
  | 'controller';

/** Backwards-compatible name used by the v1 universal binding API. */
export type TimelineElementKind = TimelinePlacementKind;

export const TIMELINE_ELEMENT_KINDS: readonly TimelineElementKind[] = [
  'video',
  'audio',
  'image',
  'text',
  'shape',
  'overlay',
  'sticker',
  'caption',
  'motion',
  'effect',
  'filter',
  'adjustment',
  'scene3d',
  'html-scene',
  'composition',
  'camera',
  'controller',
];

export type UniversalTimelineSource =
  | { readonly kind: 'asset'; readonly id: string }
  | { readonly kind: 'object'; readonly id: string }
  | { readonly kind: 'caption'; readonly id: string }
  | { readonly kind: 'composition'; readonly id: string }
  | { readonly kind: 'controller'; readonly id: string };

export interface UniversalTimelineItem {
  readonly id: string;
  readonly compositionId: string;
  readonly trackId: string;
  readonly elementKind: TimelineElementKind;
  readonly startUs: number;
  readonly durationUs: number;
  readonly source: UniversalTimelineSource;
  readonly sourceInUs?: number;
  /** Stable ordering for items that share a track. */
  readonly withinTrackOrder: number;
}

export interface UniversalTimelineDocument {
  readonly schemaVersion:
    typeof UNIVERSAL_TIMELINE_SCHEMA_VERSION | typeof UNIVERSAL_TIMELINE_LATEST_SCHEMA_VERSION;
  readonly items: readonly UniversalTimelineItem[];
}

export interface NormalizedUniversalTimelineItem extends UniversalTimelineItem {
  readonly trackOrder: number;
  readonly trackEnabled: boolean;
  readonly trackLocked: boolean;
}

export interface NormalizedUniversalTimeline {
  readonly document: UniversalTimelineDocument;
  readonly items: readonly NormalizedUniversalTimelineItem[];
  readonly diagnostics: readonly ProjectDiagnostic[];
  readonly usedLegacyFallback: boolean;
  /** True when an old project can be migrated on its first valid edit. */
  readonly needsCopyOnWriteMigration: boolean;
}

export function validateUniversalTimelineDocument(
  value: unknown,
  path = 'universalTimeline',
): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  if (!isRecord(value)) {
    return [{ code: 'UNIVERSAL_TIMELINE_OBJECT', message: 'must be an object', path }];
  }
  if (
    value.schemaVersion !== UNIVERSAL_TIMELINE_SCHEMA_VERSION &&
    value.schemaVersion !== UNIVERSAL_TIMELINE_LATEST_SCHEMA_VERSION
  ) {
    diagnostics.push({
      code: 'UNIVERSAL_TIMELINE_VERSION',
      message: `schemaVersion must be ${UNIVERSAL_TIMELINE_SCHEMA_VERSION} or ${UNIVERSAL_TIMELINE_LATEST_SCHEMA_VERSION}`,
      path: `${path}.schemaVersion`,
    });
  }
  if (!Array.isArray(value.items)) {
    diagnostics.push({
      code: 'UNIVERSAL_TIMELINE_ITEMS',
      message: 'items must be an array',
      path: `${path}.items`,
    });
    return diagnostics;
  }

  const itemIds = new Set<string>();
  const trackOrders = new Map<string, Set<number>>();
  value.items.forEach((rawItem, index) => {
    const itemPath = `${path}.items.${index}`;
    if (!isRecord(rawItem)) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_ITEM_OBJECT',
        message: 'item must be an object',
        path: itemPath,
      });
      return;
    }
    const id = rawItem.id;
    if (!isNonEmptyString(id)) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_ITEM_ID',
        message: 'id must be a non-empty string',
        path: `${itemPath}.id`,
      });
    } else if (itemIds.has(id)) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_DUPLICATE_ITEM',
        message: `duplicate item id "${id}"`,
        path: `${itemPath}.id`,
      });
    } else {
      itemIds.add(id);
    }
    if (!isNonEmptyString(rawItem.compositionId))
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_COMPOSITION_ID',
        message: 'compositionId must be a non-empty string',
        path: `${itemPath}.compositionId`,
      });
    if (!isNonEmptyString(rawItem.trackId))
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_TRACK_ID',
        message: 'trackId must be a non-empty string',
        path: `${itemPath}.trackId`,
      });
    if (!isTimelineElementKind(rawItem.elementKind))
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_ELEMENT_KIND',
        message: `unsupported elementKind "${String(rawItem.elementKind)}"`,
        path: `${itemPath}.elementKind`,
      });
    if (!isTimeRange(rawItem.startUs, rawItem.durationUs)) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_RANGE',
        message: 'startUs must be non-negative and durationUs must be positive safe integers',
        path: `${itemPath}.startUs`,
      });
    }
    const withinTrackOrder = rawItem.withinTrackOrder;
    if (
      typeof withinTrackOrder !== 'number' ||
      !Number.isSafeInteger(withinTrackOrder) ||
      withinTrackOrder < 0
    ) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_ORDER',
        message: 'withinTrackOrder must be a non-negative safe integer',
        path: `${itemPath}.withinTrackOrder`,
      });
    } else if (isNonEmptyString(rawItem.trackId) && isNonEmptyString(rawItem.compositionId)) {
      const orderKey = `${rawItem.compositionId}:${rawItem.trackId}`;
      const orders = trackOrders.get(orderKey) ?? new Set<number>();
      if (orders.has(withinTrackOrder)) {
        diagnostics.push({
          code: 'UNIVERSAL_TIMELINE_DUPLICATE_ORDER',
          message: `duplicate withinTrackOrder ${withinTrackOrder} on track "${rawItem.trackId}"`,
          path: `${itemPath}.withinTrackOrder`,
        });
      }
      orders.add(withinTrackOrder);
      trackOrders.set(orderKey, orders);
    }
    diagnostics.push(...validateSource(rawItem.source, `${itemPath}.source`));
    if (
      rawItem.sourceInUs !== undefined &&
      (typeof rawItem.sourceInUs !== 'number' ||
        !Number.isSafeInteger(rawItem.sourceInUs) ||
        rawItem.sourceInUs < 0)
    ) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_SOURCE_IN',
        message: 'sourceInUs must be a non-negative safe integer',
        path: `${itemPath}.sourceInUs`,
      });
    }
  });
  return diagnostics;
}

/**
 * Normalizes both the schema-0 editor timeline and the production v1 project
 * into one deterministic runtime projection. No input is mutated.
 */
export function normalizeUniversalTimeline(
  project: SpikeProject | JoyProjectV1,
): NormalizedUniversalTimeline {
  const persisted = project.schemaVersion === 1 ? project.universalTimeline : undefined;
  const persistedDiagnostics =
    persisted === undefined ? [] : validateUniversalTimelineDocument(persisted);
  // Keep an explicitly persisted document visible even when it is malformed.
  // Falling back to legacy items here would silently hide user data and make a
  // repair impossible. Diagnostics mark the affected items non-renderable
  // rather than deleting them from the normalized projection.
  const usePersisted = persisted !== undefined;
  const items = usePersisted ? [...persisted!.items] : legacyItems(project);
  const diagnostics = [...persistedDiagnostics];
  const tracksByKey = new Map<string, { order: number; enabled: boolean; locked: boolean }>();
  // The universal editor deck is authoritative when present. Creative tracks
  // remain a legacy fallback because their identities are not guaranteed to be
  // the same as the editor rows.
  if (project.schemaVersion === 1 && project.timelineTrackDeck !== undefined) {
    for (const row of project.timelineTrackDeck.rows) {
      tracksByKey.set(`${row.compositionId}:${row.trackId}`, {
        order: row.order,
        enabled: row.enabled,
        locked: row.locked,
      });
    }
  }
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      const key = `${composition.id}:${track.id}`;
      if (tracksByKey.has(key)) continue;
      tracksByKey.set(key, {
        order: track.order,
        enabled: track.enabled,
        locked: 'locked' in track && track.locked === true,
      });
    }
  }

  for (const item of items) validateUniversalSourceReference(project, item, diagnostics);

  const normalized = items.map((item) => {
    const track = tracksByKey.get(`${item.compositionId}:${item.trackId}`);
    if (track === undefined) {
      diagnostics.push({
        code: 'UNIVERSAL_TIMELINE_DANGLING_TRACK',
        message: `item "${item.id}" references missing track "${item.trackId}"`,
        path: `universalTimeline.items.${item.id}.trackId`,
      });
      return {
        ...item,
        trackOrder: Number.MAX_SAFE_INTEGER,
        trackEnabled: false,
        trackLocked: true,
      };
    }
    return {
      ...item,
      trackOrder: track.order,
      trackEnabled: track.enabled,
      trackLocked: track.locked,
    };
  });

  normalized.sort(
    (left, right) =>
      left.trackOrder - right.trackOrder ||
      left.withinTrackOrder - right.withinTrackOrder ||
      left.startUs - right.startUs ||
      left.id.localeCompare(right.id),
  );
  return {
    document: { schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION, items },
    items: normalized,
    diagnostics,
    usedLegacyFallback: !usePersisted,
    needsCopyOnWriteMigration: project.schemaVersion === 1 && persisted === undefined,
  };
}

function validateUniversalSourceReference(
  project: SpikeProject | JoyProjectV1,
  item: UniversalTimelineItem,
  diagnostics: ProjectDiagnostic[],
): void {
  if (project.schemaVersion === 0) return;
  const sourceExists = (() => {
    switch (item.source.kind) {
      case 'asset':
        return project.assets[item.source.id] !== undefined;
      case 'object':
        return project.visualObjects[item.source.id] !== undefined;
      case 'caption':
        return project.captionDocuments[item.source.id] !== undefined;
      case 'composition':
        return project.compositions[item.source.id] !== undefined;
      case 'controller':
        return project.visualObjects[item.source.id] !== undefined;
    }
  })();
  if (!sourceExists) {
    diagnostics.push({
      code: 'UNIVERSAL_TIMELINE_DANGLING_SOURCE',
      message: `item "${item.id}" references missing ${item.source.kind} "${item.source.id}"`,
      path: `universalTimeline.items.${item.id}.source.id`,
    });
  }
}

export function universalTimelineForProject(
  project: SpikeProject | JoyProjectV1,
): UniversalTimelineDocument {
  return normalizeUniversalTimeline(project).document;
}

function legacyItems(project: SpikeProject | JoyProjectV1): UniversalTimelineItem[] {
  const output: UniversalTimelineItem[] = [];
  const objectMap = project.schemaVersion === 1 ? readClipObjectMap(project) : {};
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      const clips = [...track.clips].sort(
        (left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id),
      );
      clips.forEach((clip, index) => {
        output.push(legacyClipItem(project, composition.id, track.id, clip, index * 2));
        if (project.schemaVersion === 1) {
          const objectId = objectMap[clip.id];
          const object = objectId === undefined ? undefined : project.visualObjects[objectId];
          if (object !== undefined) {
            output.push({
              id: `${clip.id}:object:${object.id}`,
              compositionId: composition.id,
              trackId: track.id,
              elementKind: visualObjectElementKind(object),
              startUs: clip.startUs,
              durationUs: clip.durationUs,
              source: { kind: object.kind === 'camera' ? 'controller' : 'object', id: object.id },
              withinTrackOrder: index * 2 + 1,
            });
          }
        }
      });
    }
  }
  return output;
}

function legacyClipItem(
  project: SpikeProject | JoyProjectV1,
  compositionId: string,
  trackId: string,
  clip: Clip | JoyProjectV1['compositions'][string]['tracks'][number]['clips'][number],
  withinTrackOrder: number,
): UniversalTimelineItem {
  if (clip.kind === 'composition') {
    return {
      id: clip.id,
      compositionId,
      trackId,
      elementKind: 'composition',
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      source: { kind: 'composition', id: clip.compositionId },
      sourceInUs: clip.childOffsetUs,
      withinTrackOrder,
    };
  }
  if (clip.kind === 'caption') {
    return {
      id: clip.id,
      compositionId,
      trackId,
      elementKind: 'caption',
      startUs: clip.startUs,
      durationUs: clip.durationUs,
      source: { kind: 'caption', id: clip.captionDocumentId },
      withinTrackOrder,
    };
  }
  const assetId = clip.assetId;
  const asset = project.schemaVersion === 1 ? project.assets[assetId] : undefined;
  const elementKind: TimelineElementKind = asset?.kind === 'audio' ? 'audio' : 'video';
  return {
    id: clip.id,
    compositionId,
    trackId,
    elementKind,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    source: { kind: 'asset', id: assetId },
    sourceInUs: clip.sourceInUs,
    withinTrackOrder,
  };
}

function visualObjectElementKind(object: VisualObjectV1): TimelineElementKind {
  switch (object.kind) {
    case 'image':
      return 'image';
    case 'text':
      return 'text';
    case 'shape':
      return 'shape';
    case 'html-scene':
      return 'html-scene';
    case 'camera':
      return 'camera';
    case 'null':
      return 'controller';
  }
}

function readClipObjectMap(project: JoyProjectV1): Readonly<Record<string, string>> {
  const raw = project.pluginData['joy.clipObjects'];
  if (!isRecord(raw)) return {};
  const output: Record<string, string> = {};
  for (const [clipId, objectId] of Object.entries(raw)) {
    if (typeof objectId === 'string' && objectId.length > 0) output[clipId] = objectId;
  }
  return output;
}

function validateSource(value: unknown, path: string): ProjectDiagnostic[] {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    return [{ code: 'UNIVERSAL_TIMELINE_SOURCE', message: 'source must have an id', path }];
  }
  if (
    value.kind !== 'asset' &&
    value.kind !== 'object' &&
    value.kind !== 'caption' &&
    value.kind !== 'composition' &&
    value.kind !== 'controller'
  ) {
    return [
      {
        code: 'UNIVERSAL_TIMELINE_SOURCE_KIND',
        message: `unsupported source kind "${String(value.kind)}"`,
        path: `${path}.kind`,
      },
    ];
  }
  return [];
}

function isTimelineElementKind(value: unknown): value is TimelineElementKind {
  return typeof value === 'string' && TIMELINE_ELEMENT_KINDS.includes(value as TimelineElementKind);
}

function isTimeRange(startUs: unknown, durationUs: unknown): boolean {
  return (
    Number.isSafeInteger(startUs) &&
    (startUs as number) >= 0 &&
    Number.isSafeInteger(durationUs) &&
    (durationUs as number) > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
