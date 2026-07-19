/**
 * P00 command spike (master plan §11, §36-P0-2, ADR-0003).
 *
 * Commands are a discriminated union of semantic timeline mutations applied by
 * pure functions over the immutable spike project. `applyCommand` returns the
 * next project AND the inverse command, computed from pre-state, so history can
 * undo without patches. Commands that would produce an invalid project are
 * rejected with a coded error and leave state untouched.
 *
 * Spike simplifications (revisit in P01): single-track moves only, no overlap
 * allowed within a track, no actor/revision/idempotency envelope fields yet.
 */

import type {
  Clip,
  CompositionId,
  SpikeProject,
  TimeUs,
  Track,
  TrackId,
  VideoClip,
} from '@joy-media/project-schema';
import { clipTimeRange, rangeEndUs, validateSpikeProject } from '@joy-media/project-schema';

export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

export interface TrackTarget {
  readonly compositionId: CompositionId;
  readonly trackId: TrackId;
}

export interface InsertClipPayload extends TrackTarget {
  readonly clip: Clip;
}
export interface RemoveClipPayload extends TrackTarget {
  readonly clipId: string;
}
export interface MoveClipPayload extends TrackTarget {
  readonly clipId: string;
  readonly newStartUs: TimeUs;
}
export interface TrimClipStartPayload extends TrackTarget {
  readonly clipId: string;
  /** New timeline start; source in-point / child offset shifts by the same delta. */
  readonly newStartUs: TimeUs;
}
export interface TrimClipEndPayload extends TrackTarget {
  readonly clipId: string;
  readonly newEndUs: TimeUs;
}
export interface SplitClipPayload extends TrackTarget {
  readonly clipId: string;
  readonly atUs: TimeUs;
  /** Caller supplies the new id so serialization/replay is deterministic (ADR-0003). */
  readonly newClipId: string;
}
export interface JoinClipsPayload extends TrackTarget {
  readonly firstClipId: string;
  readonly secondClipId: string;
}
export interface SetTrackEnabledPayload extends TrackTarget {
  readonly enabled: boolean;
}

export type SpikeCommand =
  | { readonly type: 'timeline.insertClip'; readonly payload: InsertClipPayload }
  | { readonly type: 'timeline.removeClip'; readonly payload: RemoveClipPayload }
  | { readonly type: 'timeline.moveClip'; readonly payload: MoveClipPayload }
  | { readonly type: 'timeline.trimClipStart'; readonly payload: TrimClipStartPayload }
  | { readonly type: 'timeline.trimClipEnd'; readonly payload: TrimClipEndPayload }
  | { readonly type: 'timeline.splitClip'; readonly payload: SplitClipPayload }
  | { readonly type: 'timeline.joinClips'; readonly payload: JoinClipsPayload }
  | { readonly type: 'property.setTrackEnabled'; readonly payload: SetTrackEnabledPayload };

export type SpikeCommandType = SpikeCommand['type'];

/** Discoverable command registry used by UI/agent tooling; handlers remain pure below. */
export const COMMAND_REGISTRY: Readonly<
  Record<SpikeCommandType, { readonly description: string }>
> = {
  'timeline.insertClip': { description: 'Insert a non-overlapping clip into a track.' },
  'timeline.removeClip': { description: 'Remove a clip while preserving it in the inverse.' },
  'timeline.moveClip': { description: 'Move a clip within its track.' },
  'timeline.trimClipStart': { description: 'Trim a clip start and shift its source offset.' },
  'timeline.trimClipEnd': { description: 'Trim a clip end.' },
  'timeline.splitClip': { description: 'Split a clip into source-continuous halves.' },
  'timeline.joinClips': { description: 'Join adjacent source-continuous clips.' },
  'property.setTrackEnabled': { description: 'Set a track enabled state.' },
};

export interface ApplyResult {
  readonly project: SpikeProject;
  readonly inverse: SpikeCommand;
}

/** Applies one command, returning the next project and its inverse. Throws CommandError; never mutates. */
export function applyCommand(project: SpikeProject, command: SpikeCommand): ApplyResult {
  const result = applyCommandUnchecked(project, command);
  const diagnostics = validateSpikeProject(result.project);
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    throw new CommandError(
      'COMMAND_VALIDATION_RESULT_INVALID',
      `${command.type} would produce an invalid project: [${first.code}] ${first.message}`,
    );
  }
  return result;
}

function applyCommandUnchecked(project: SpikeProject, command: SpikeCommand): ApplyResult {
  switch (command.type) {
    case 'timeline.insertClip':
      return applyInsertClip(project, command.payload);
    case 'timeline.removeClip':
      return applyRemoveClip(project, command.payload);
    case 'timeline.moveClip':
      return applyMoveClip(project, command.payload);
    case 'timeline.trimClipStart':
      return applyTrimClipStart(project, command.payload);
    case 'timeline.trimClipEnd':
      return applyTrimClipEnd(project, command.payload);
    case 'timeline.splitClip':
      return applySplitClip(project, command.payload);
    case 'timeline.joinClips':
      return applyJoinClips(project, command.payload);
    case 'property.setTrackEnabled':
      return applySetTrackEnabled(project, command.payload);
    default: {
      const exhaustive: never = command;
      throw new CommandError(
        'COMMAND_VALIDATION_UNKNOWN_TYPE',
        `unknown command ${String(exhaustive)}`,
      );
    }
  }
}

// ---------- helpers ----------

function getTrack(project: SpikeProject, target: TrackTarget): Track {
  const comp = project.compositions[target.compositionId];
  if (comp === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown composition "${target.compositionId}"`,
    );
  }
  const track = comp.tracks.find((t) => t.id === target.trackId);
  if (track === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown track "${target.trackId}" in composition "${target.compositionId}"`,
    );
  }
  return track;
}

function getClip(track: Track, clipId: string): Clip {
  const clip = track.clips.find((c) => c.id === clipId);
  if (clip === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown clip "${clipId}" on track "${track.id}"`,
    );
  }
  return clip;
}

function withTrackClips(
  project: SpikeProject,
  target: TrackTarget,
  clips: readonly Clip[],
): SpikeProject {
  const comp = project.compositions[target.compositionId]!;
  const tracks = comp.tracks.map((track) =>
    track.id === target.trackId
      ? { ...track, clips: [...clips].sort((a, b) => a.startUs - b.startUs) }
      : track,
  );
  return {
    ...project,
    compositions: { ...project.compositions, [target.compositionId]: { ...comp, tracks } },
  };
}

function assertClipRange(startUs: TimeUs, durationUs: number, context: string): void {
  try {
    clipTimeRange(startUs, durationUs);
  } catch (error) {
    throw new CommandError('COMMAND_VALIDATION_RANGE', `${context}: ${(error as Error).message}`);
  }
}

function assertNoOverlap(
  track: Track,
  startUs: TimeUs,
  durationUs: number,
  excludeClipId: string | undefined,
  context: string,
): void {
  const endUs = startUs + durationUs;
  for (const other of track.clips) {
    if (other.id === excludeClipId) continue;
    const otherEnd = rangeEndUs({ startUs: other.startUs, durationUs: other.durationUs });
    if (startUs < otherEnd && other.startUs < endUs) {
      throw new CommandError(
        'COMMAND_VALIDATION_OVERLAP',
        `${context}: [${startUs}, ${endUs}) overlaps clip "${other.id}" [${other.startUs}, ${otherEnd})`,
      );
    }
  }
}

/** Source-side offset field for a clip kind: video shifts sourceInUs, nested shifts childOffsetUs. */
function shiftSourceForStartTrim(clip: Clip, deltaUs: number): Clip {
  if (clip.kind === 'video') {
    const sourceInUs = clip.sourceInUs + deltaUs;
    if (sourceInUs < 0) {
      throw new CommandError(
        'COMMAND_VALIDATION_SOURCE_UNDERFLOW',
        `trim would move source in-point of "${clip.id}" below 0 (${sourceInUs})`,
      );
    }
    return { ...clip, sourceInUs };
  }
  const childOffsetUs = clip.childOffsetUs + deltaUs;
  if (childOffsetUs < 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_SOURCE_UNDERFLOW',
      `trim would move child offset of "${clip.id}" below 0 (${childOffsetUs})`,
    );
  }
  return { ...clip, childOffsetUs };
}

// ---------- handlers ----------

function applyInsertClip(project: SpikeProject, payload: InsertClipPayload): ApplyResult {
  const track = getTrack(project, payload);
  if (track.clips.some((c) => c.id === payload.clip.id)) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `clip id "${payload.clip.id}" already exists on track "${track.id}"`,
    );
  }
  assertClipRange(payload.clip.startUs, payload.clip.durationUs, 'insertClip');
  assertNoOverlap(track, payload.clip.startUs, payload.clip.durationUs, undefined, 'insertClip');
  return {
    project: withTrackClips(project, payload, [...track.clips, payload.clip]),
    inverse: {
      type: 'timeline.removeClip',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipId: payload.clip.id,
      },
    },
  };
}

function applyRemoveClip(project: SpikeProject, payload: RemoveClipPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  return {
    project: withTrackClips(
      project,
      payload,
      track.clips.filter((c) => c.id !== payload.clipId),
    ),
    inverse: {
      type: 'timeline.insertClip',
      payload: { compositionId: payload.compositionId, trackId: payload.trackId, clip },
    },
  };
}

function applyMoveClip(project: SpikeProject, payload: MoveClipPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  assertClipRange(payload.newStartUs, clip.durationUs, 'moveClip');
  assertNoOverlap(track, payload.newStartUs, clip.durationUs, clip.id, 'moveClip');
  const moved: Clip = { ...clip, startUs: payload.newStartUs };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== clip.id),
      moved,
    ]),
    inverse: {
      type: 'timeline.moveClip',
      payload: { ...payload, newStartUs: clip.startUs },
    },
  };
}

function applyTrimClipStart(project: SpikeProject, payload: TrimClipStartPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
  const deltaUs = payload.newStartUs - clip.startUs;
  assertClipRange(payload.newStartUs, endUs - payload.newStartUs, 'trimClipStart');
  assertNoOverlap(track, payload.newStartUs, endUs - payload.newStartUs, clip.id, 'trimClipStart');
  const trimmed: Clip = {
    ...shiftSourceForStartTrim(clip, deltaUs),
    startUs: payload.newStartUs,
    durationUs: endUs - payload.newStartUs,
  };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== clip.id),
      trimmed,
    ]),
    inverse: {
      type: 'timeline.trimClipStart',
      payload: { ...payload, newStartUs: clip.startUs },
    },
  };
}

function applyTrimClipEnd(project: SpikeProject, payload: TrimClipEndPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  assertClipRange(clip.startUs, payload.newEndUs - clip.startUs, 'trimClipEnd');
  assertNoOverlap(track, clip.startUs, payload.newEndUs - clip.startUs, clip.id, 'trimClipEnd');
  const trimmed: Clip = { ...clip, durationUs: payload.newEndUs - clip.startUs };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== clip.id),
      trimmed,
    ]),
    inverse: {
      type: 'timeline.trimClipEnd',
      payload: {
        ...payload,
        newEndUs: rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs }),
      },
    },
  };
}

function applySplitClip(project: SpikeProject, payload: SplitClipPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
  if (!(payload.atUs > clip.startUs && payload.atUs < endUs)) {
    throw new CommandError(
      'COMMAND_VALIDATION_RANGE',
      `splitClip: atUs ${payload.atUs} must be strictly inside [${clip.startUs}, ${endUs})`,
    );
  }
  if (track.clips.some((c) => c.id === payload.newClipId)) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `splitClip: new clip id "${payload.newClipId}" already exists`,
    );
  }
  const localUs = payload.atUs - clip.startUs;
  const first: Clip = { ...clip, durationUs: localUs };
  const secondBase = shiftSourceForStartTrim(clip, localUs);
  const second: Clip = {
    ...secondBase,
    id: payload.newClipId,
    startUs: payload.atUs,
    durationUs: endUs - payload.atUs,
  };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== clip.id),
      first,
      second,
    ]),
    inverse: {
      type: 'timeline.joinClips',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        firstClipId: clip.id,
        secondClipId: payload.newClipId,
      },
    },
  };
}

function applyJoinClips(project: SpikeProject, payload: JoinClipsPayload): ApplyResult {
  const track = getTrack(project, payload);
  const first = getClip(track, payload.firstClipId);
  const second = getClip(track, payload.secondClipId);
  const firstEnd = rangeEndUs({ startUs: first.startUs, durationUs: first.durationUs });
  if (firstEnd !== second.startUs) {
    throw new CommandError(
      'COMMAND_VALIDATION_NOT_ADJACENT',
      `joinClips: "${payload.firstClipId}" ends at ${firstEnd} but "${payload.secondClipId}" starts at ${second.startUs}`,
    );
  }
  if (!sourceContinuous(first, second)) {
    throw new CommandError(
      'COMMAND_VALIDATION_NOT_ADJACENT',
      `joinClips: clips are adjacent on the timeline but not continuous in their source`,
    );
  }
  const joined: Clip = { ...first, durationUs: first.durationUs + second.durationUs };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== first.id && c.id !== second.id),
      joined,
    ]),
    inverse: {
      type: 'timeline.splitClip',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipId: first.id,
        atUs: second.startUs,
        newClipId: second.id,
      },
    },
  };
}

function sourceContinuous(first: Clip, second: Clip): boolean {
  if (first.kind === 'video' && second.kind === 'video') {
    const a = first as VideoClip;
    const b = second as VideoClip;
    return a.assetId === b.assetId && b.sourceInUs === a.sourceInUs + a.durationUs;
  }
  if (first.kind === 'composition' && second.kind === 'composition') {
    return (
      first.compositionId === second.compositionId &&
      second.childOffsetUs === first.childOffsetUs + first.durationUs
    );
  }
  return false;
}

function applySetTrackEnabled(project: SpikeProject, payload: SetTrackEnabledPayload): ApplyResult {
  const track = getTrack(project, payload);
  const comp = project.compositions[payload.compositionId]!;
  const tracks = comp.tracks.map((t) =>
    t.id === payload.trackId ? { ...t, enabled: payload.enabled } : t,
  );
  return {
    project: {
      ...project,
      compositions: { ...project.compositions, [payload.compositionId]: { ...comp, tracks } },
    },
    inverse: {
      type: 'property.setTrackEnabled',
      payload: { ...payload, enabled: track.enabled },
    },
  };
}
