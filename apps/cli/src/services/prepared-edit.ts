import { createHash } from 'node:crypto';
import type { CliProjectDocument } from '../utils/project-loader.js';
import { CommandFailure } from '../utils/project-loader.js';

export interface PreparedOperation {
  readonly id: string;
  readonly op: string;
  readonly [key: string]: unknown;
}

interface TimelineClip extends Record<string, unknown> {
  id: string;
  startUs: number;
  durationUs: number;
}

interface TimelineTrack extends Record<string, unknown> {
  id: string;
  kind?: string;
  family?: string;
  enabled?: boolean;
  order?: number;
  clips: TimelineClip[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON: object keys are sorted as strings at every depth. The members are written
 * by hand because JSON.stringify would reorder integer-like keys numerically, and query and plan
 * identities must agree for the same document.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (isRecord(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable.');
  return serialized;
}

export function sha256Identity(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function preparedPlanId(plan: Record<string, unknown>): string {
  const identity = { ...plan };
  delete identity['planId'];
  return sha256Identity(identity);
}

function rootTracks(project: CliProjectDocument): TimelineTrack[] {
  const root = project.compositions[project.rootCompositionId];
  if (!root || !Array.isArray(root.tracks)) {
    throw new CommandFailure('PROJECT_FILE_INVALID', 'Project has no root composition.');
  }
  return root.tracks as unknown as TimelineTrack[];
}

function findClip(
  tracks: TimelineTrack[],
  clipId: string,
  trackId?: string,
): { track: TimelineTrack; clip: TimelineClip; index: number } {
  const scope = trackId === undefined ? tracks : tracks.filter((track) => track.id === trackId);
  if (trackId !== undefined && scope.length === 0)
    throw new CommandFailure('TRACK_NOT_FOUND', `Track "${trackId}" not found.`);
  for (const track of scope) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  const elsewhere =
    trackId === undefined
      ? undefined
      : tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
  throw new CommandFailure(
    'CLIP_NOT_FOUND',
    elsewhere
      ? `Clip "${clipId}" is not on track "${trackId}" (it is on track "${elsewhere.id}").`
      : `Clip "${clipId}" not found.`,
  );
}

function requireField<T>(
  operation: PreparedOperation,
  key: string,
  isValid: (value: unknown) => value is T,
): T {
  const value = operation[key];
  if (!isValid(value))
    throw new CommandFailure(
      'PLAN_INVALID_OPERATION',
      `Operation "${operation.id}" requires a valid ${key}.`,
    );
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function timeUs(operation: PreparedOperation, key: string, min: number, max: number): number {
  const value = operation[key];
  if (!Number.isSafeInteger(value)) {
    throw new CommandFailure(
      'PLAN_INVALID_OPERATION',
      `Operation "${operation.id}" requires an integer ${key}.`,
    );
  }
  const numeric = value as number;
  if (numeric < min || numeric > max) {
    throw new CommandFailure(
      'RANGE_ERROR',
      `${key} must be between ${min} and ${max} microseconds.`,
    );
  }
  return numeric;
}

function assertNotInTransition(project: CliProjectDocument, clipId: string): void {
  const root = project.compositions[project.rootCompositionId] as unknown as {
    transitions?: unknown;
  };
  const transitions = Array.isArray(root?.transitions) ? root.transitions : [];
  if (
    transitions.some(
      (transition) =>
        isRecord(transition) &&
        (transition.leftClipId === clipId || transition.rightClipId === clipId),
    )
  ) {
    throw new CommandFailure('TRANSITION_IN_USE', `Clip "${clipId}" is part of a transition.`);
  }
}

function family(track: TimelineTrack): string {
  return (
    track.family ??
    (track.kind === 'audio' ? 'audio' : track.kind === 'caption' ? 'caption' : 'visual')
  );
}

function noOverlap(
  track: TimelineTrack,
  startUs: number,
  durationUs: number,
  ignoreId: string,
): void {
  const other = track.clips.find(
    (clip) =>
      clip.id !== ignoreId &&
      startUs < clip.startUs + clip.durationUs &&
      clip.startUs < startUs + durationUs,
  );
  if (other)
    throw new CommandFailure(
      'CLIP_OVERLAP',
      `The clip would overlap clip "${other.id}" on track "${track.id}".`,
    );
}

function advanceSource(clip: TimelineClip, deltaUs: number): void {
  if (clip.kind === 'composition' && typeof clip.childOffsetUs === 'number') {
    const offset = clip.childOffsetUs + deltaUs;
    if (offset < 0)
      throw new CommandFailure(
        'SOURCE_UNDERFLOW',
        `Moving "${clip.id}" there would move the child in-point below 0.`,
      );
    clip.childOffsetUs = offset;
  } else if (typeof clip.sourceInUs === 'number') {
    const rate = typeof clip.playbackRate === 'number' ? clip.playbackRate : 1;
    const direction = clip.reversed === true ? -1 : 1;
    const sourceInUs = clip.sourceInUs + Math.round(deltaUs * rate) * direction;
    if (sourceInUs < 0)
      throw new CommandFailure(
        'SOURCE_UNDERFLOW',
        `Moving "${clip.id}" there would move the source in-point below 0.`,
      );
    clip.sourceInUs = sourceInUs;
  }
}

/** Map trimClip.startUs/endUs/durationUs/trackId to --start/--end/--duration/--track;
 * moveClip.startUs/trackId to --start/--track; all operation clipId fields map to --clip.
 * Timeline position/duration fields are expressed as integer microseconds rather than seconds.
 */
export function applyPreparedOperations<T extends CliProjectDocument>(
  source: T,
  operations: readonly PreparedOperation[],
): T {
  const project = structuredClone(source);
  if (operations.length > 24)
    throw new CommandFailure('PLAN_INVALID', 'A plan can contain at most 24 operations.');
  const ids = new Set<string>();
  for (const operation of operations) {
    if (!isRecord(operation) || !isString(operation.id))
      throw new CommandFailure('PLAN_INVALID', 'Every operation requires a string id.');
    if (ids.has(operation.id))
      throw new CommandFailure('PLAN_INVALID', `Duplicate operation id "${operation.id}".`);
    ids.add(operation.id);
    if (!['trimClip', 'moveClip', 'removeClip'].includes(operation.op)) {
      throw new CommandFailure(
        'PLAN_UNSUPPORTED_OPERATION',
        `Operation "${operation.op}" is not supported by prepared edits.`,
      );
    }
    const allowedFields: Record<string, readonly string[]> = {
      trimClip: ['id', 'op', 'clipId', 'startUs', 'endUs', 'durationUs', 'trackId'],
      moveClip: ['id', 'op', 'clipId', 'startUs', 'trackId'],
      removeClip: ['id', 'op', 'clipId'],
    };
    if (Object.keys(operation).some((key) => !allowedFields[operation.op]!.includes(key))) {
      throw new CommandFailure(
        'PLAN_INVALID_OPERATION',
        `Operation "${operation.id}" contains unsupported fields.`,
      );
    }
    const clipId = requireField(operation, 'clipId', isString);
    const tracks = rootTracks(project);
    if (operation.op === 'trimClip') {
      if (
        operation.startUs === undefined &&
        operation.endUs === undefined &&
        operation.durationUs === undefined
      ) {
        throw new CommandFailure(
          'PLAN_INVALID_OPERATION',
          `trimClip operation "${operation.id}" needs startUs, endUs or durationUs.`,
        );
      }
      assertNotInTransition(project, clipId);
      const trackId =
        operation.trackId === undefined ? undefined : requireField(operation, 'trackId', isString);
      const { track, clip } = findClip(tracks, clipId, trackId);
      const startUs =
        operation.startUs === undefined
          ? clip.startUs
          : timeUs(operation, 'startUs', 0, 86_400_000_000);
      const endUs =
        operation.endUs === undefined ? undefined : timeUs(operation, 'endUs', 0, 86_400_000_000);
      const durationUs =
        operation.durationUs === undefined
          ? undefined
          : timeUs(operation, 'durationUs', 1_000, 86_400_000_000);
      if (endUs !== undefined && durationUs !== undefined)
        throw new CommandFailure(
          'PLAN_INVALID_OPERATION',
          'trimClip accepts endUs or durationUs, not both.',
        );
      const nextDuration = endUs !== undefined ? endUs - startUs : (durationUs ?? clip.durationUs);
      if (nextDuration <= 0 || (endUs !== undefined && endUs <= startUs)) {
        throw new CommandFailure('RANGE_ERROR', 'Trim range must have a positive duration.');
      }
      if (startUs !== clip.startUs || nextDuration !== clip.durationUs) {
        noOverlap(track, startUs, nextDuration, clip.id);
        advanceSource(clip, Math.max(0, startUs - clip.startUs));
        clip.startUs = startUs;
        clip.durationUs = nextDuration;
      }
    } else if (operation.op === 'moveClip') {
      assertNotInTransition(project, clipId);
      const found = findClip(tracks, clipId);
      const startUs =
        operation.startUs === undefined
          ? found.clip.startUs
          : timeUs(operation, 'startUs', 0, 86_400_000_000);
      const targetId =
        operation.trackId === undefined
          ? found.track.id
          : requireField(operation, 'trackId', isString);
      const target = tracks.find((track) => track.id === targetId);
      if (!target) throw new CommandFailure('TRACK_NOT_FOUND', `Track "${targetId}" not found.`);
      if (
        target !== found.track &&
        (family(target) !== family(found.track) || target.kind !== found.track.kind)
      ) {
        throw new CommandFailure(
          'TRACK_KIND_MISMATCH',
          `Clip "${clipId}" cannot move to a different track kind.`,
        );
      }
      if (target !== found.track && target.enabled === false)
        throw new CommandFailure('TRACK_DISABLED', `Track "${target.id}" is disabled.`);
      const assetId = typeof found.clip.assetId === 'string' ? found.clip.assetId : 'asset-default';
      const asset = project.assets?.[assetId];
      if (
        isRecord(asset) &&
        (asset.kind === 'audio' || asset.kind === 'video' || asset.kind === 'image')
      ) {
        const targetIsAudio = family(target) === 'audio';
        if (
          (targetIsAudio && asset.kind !== 'audio') ||
          (!targetIsAudio && asset.kind === 'audio')
        ) {
          throw new CommandFailure(
            'TRACK_KIND_MISMATCH',
            `Asset "${assetId}" does not fit track "${target.id}".`,
          );
        }
      }
      noOverlap(target, startUs, found.clip.durationUs, clipId);
      if (target !== found.track || startUs !== found.clip.startUs) {
        found.track.clips.splice(found.index, 1);
        found.clip.startUs = startUs;
        target.clips.push(found.clip);
      }
    } else {
      const { track, index } = findClip(tracks, clipId);
      track.clips.splice(index, 1);
      const root = project.compositions[project.rootCompositionId] as unknown as {
        transitions?: unknown;
      };
      if (Array.isArray(root?.transitions)) {
        root.transitions = root.transitions.filter(
          (transition) =>
            !isRecord(transition) ||
            (transition.leftClipId !== clipId && transition.rightClipId !== clipId),
        );
      }
    }
  }
  return project;
}

export interface ChangedEntity {
  readonly kind: 'clip' | 'track';
  readonly id: string;
  readonly change: 'added' | 'modified' | 'removed';
}

function entityMap(project: CliProjectDocument, kind: 'clip' | 'track'): Map<string, unknown> {
  const map = new Map<string, unknown>();
  const tracks = rootTracks(project);
  for (const track of tracks) {
    if (kind === 'track') {
      const trackEntity = Object.fromEntries(
        Object.entries(track).filter(([key]) => key !== 'clips'),
      );
      map.set(track.id, trackEntity);
    } else {
      for (const clip of track.clips) map.set(clip.id, { trackId: track.id, clip });
    }
  }
  return map;
}

export function changedEntities(
  before: CliProjectDocument,
  after: CliProjectDocument,
): ChangedEntity[] {
  const changes: ChangedEntity[] = [];
  for (const kind of ['clip', 'track'] as const) {
    const oldItems = entityMap(before, kind);
    const newItems = entityMap(after, kind);
    for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
      const oldItem = oldItems.get(id);
      const newItem = newItems.get(id);
      if (oldItem === undefined) changes.push({ kind, id, change: 'added' });
      else if (newItem === undefined) changes.push({ kind, id, change: 'removed' });
      else if (canonicalJson(oldItem) !== canonicalJson(newItem))
        changes.push({ kind, id, change: 'modified' });
    }
  }
  return changes.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
