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
  Composition,
  CompositionId,
  SpikeProject,
  TimeUs,
  Track,
  TrackId,
  TimeRemapV2,
  VideoClip,
} from '@joy-media/project-schema';
import {
  clipTimeRange,
  isValidPlaybackRate,
  normalizePlaybackRate,
  rangeEndUs,
  validateSpikeProject,
  validateTimeRemap,
} from '@joy-media/project-schema';

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
/** Move an element between neutral tracks while preserving its duration/source timing. */
export interface MoveElementPayload {
  readonly compositionId: CompositionId;
  readonly sourceTrackId: TrackId;
  readonly targetTrackId: TrackId;
  readonly clipId: string;
  readonly newStartUs: TimeUs;
}
export interface ReorderTrackPayload {
  readonly compositionId: CompositionId;
  readonly trackId: TrackId;
  readonly newOrder: number;
}
export interface RenameTrackPayload {
  readonly compositionId: CompositionId;
  readonly trackId: TrackId;
  readonly newName?: string;
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
export interface DuplicateClipPayload extends TrackTarget {
  readonly clipId: string;
  readonly newClipId: string;
  /** When omitted, the duplicate is placed immediately after the source clip. */
  readonly newStartUs?: TimeUs;
}
export interface SetClipRatePayload extends TrackTarget {
  readonly clipId: string;
  readonly playbackRate: number;
  /**
   * CapCut-like default: keep the source window, rescale timeline duration.
   * `newDuration = oldDuration * (oldRate / newRate)`. Forbidden when either rate is 0.
   */
  readonly preserveSourceRange?: boolean;
}
export interface FreezeFramePayload extends TrackTarget {
  readonly clipId: string;
  readonly atUs: TimeUs;
  readonly holdUs: TimeUs;
  readonly freezeClipId: string;
  readonly rightClipId: string;
}
/** Toggle a video clip's direction while preserving its source window. */
export interface ToggleClipReversePayload extends TrackTarget {
  readonly clipId: string;
}
export interface SetTimeRemapPayload extends TrackTarget {
  readonly clipId: string;
  /** Omit to restore the legacy playback-rate mapping. */
  readonly timeRemap?: TimeRemapV2;
}
/**
 * Turn a contiguous run of clips on one track into a nested composition clip.
 * IDs are supplied by the caller so the command can be persisted and replayed
 * exactly; the child composition itself is derived from the selected clips.
 */
export interface CreateCompoundPayload extends TrackTarget {
  readonly clipIds: readonly string[];
  readonly compoundCompositionId: CompositionId;
  readonly compoundClipId: string;
  readonly name?: string;
}
/** Exact inverse of {@link CreateCompoundPayload}. */
export interface RestoreCompoundPayload extends TrackTarget {
  readonly compoundCompositionId: CompositionId;
  readonly compoundClipId: string;
  readonly clips: readonly Clip[];
}
export interface RestoreTrackClipsPayload extends TrackTarget {
  readonly clips: readonly Clip[];
}
/** Update a composition canvas while preserving all timeline content. */
export interface SetCompositionDimensionsPayload {
  readonly compositionId: CompositionId;
  readonly width: number;
  readonly height: number;
}
export interface AddTrackPayload {
  readonly compositionId: CompositionId;
  readonly track: Track;
}
export interface RemoveTrackPayload {
  readonly compositionId: CompositionId;
  readonly trackId: TrackId;
}

export type SpikeCommand =
  | { readonly type: 'timeline.insertClip'; readonly payload: InsertClipPayload }
  | { readonly type: 'timeline.removeClip'; readonly payload: RemoveClipPayload }
  | { readonly type: 'timeline.moveClip'; readonly payload: MoveClipPayload }
  | { readonly type: 'timeline.moveElement'; readonly payload: MoveElementPayload }
  | { readonly type: 'timeline.trimClipStart'; readonly payload: TrimClipStartPayload }
  | { readonly type: 'timeline.trimClipEnd'; readonly payload: TrimClipEndPayload }
  | { readonly type: 'timeline.splitClip'; readonly payload: SplitClipPayload }
  | { readonly type: 'timeline.joinClips'; readonly payload: JoinClipsPayload }
  | { readonly type: 'timeline.duplicateClip'; readonly payload: DuplicateClipPayload }
  | { readonly type: 'timeline.setClipRate'; readonly payload: SetClipRatePayload }
  | { readonly type: 'timeline.freezeFrame'; readonly payload: FreezeFramePayload }
  | { readonly type: 'timeline.toggleClipReverse'; readonly payload: ToggleClipReversePayload }
  | { readonly type: 'timeline.setTimeRemap'; readonly payload: SetTimeRemapPayload }
  | { readonly type: 'timeline.createCompound'; readonly payload: CreateCompoundPayload }
  | { readonly type: 'timeline.restoreCompound'; readonly payload: RestoreCompoundPayload }
  | { readonly type: 'timeline.restoreTrackClips'; readonly payload: RestoreTrackClipsPayload }
  | {
      readonly type: 'timeline.setCompositionDimensions';
      readonly payload: SetCompositionDimensionsPayload;
    }
  | { readonly type: 'timeline.addTrack'; readonly payload: AddTrackPayload }
  | { readonly type: 'timeline.removeTrack'; readonly payload: RemoveTrackPayload }
  | { readonly type: 'timeline.reorderTrack'; readonly payload: ReorderTrackPayload }
  | { readonly type: 'timeline.renameTrack'; readonly payload: RenameTrackPayload }
  | { readonly type: 'property.setTrackEnabled'; readonly payload: SetTrackEnabledPayload };

export type SpikeCommandType = SpikeCommand['type'];

/** Discoverable command registry used by UI/agent tooling; handlers remain pure below. */
export const COMMAND_REGISTRY: Readonly<
  Record<SpikeCommandType, { readonly description: string }>
> = {
  'timeline.insertClip': { description: 'Insert a non-overlapping clip into a track.' },
  'timeline.removeClip': { description: 'Remove a clip while preserving it in the inverse.' },
  'timeline.moveClip': { description: 'Move a clip within its track.' },
  'timeline.moveElement': { description: 'Move an element between neutral tracks.' },
  'timeline.trimClipStart': { description: 'Trim a clip start and shift its source offset.' },
  'timeline.trimClipEnd': { description: 'Trim a clip end.' },
  'timeline.splitClip': { description: 'Split a clip into source-continuous halves.' },
  'timeline.joinClips': { description: 'Join adjacent source-continuous clips.' },
  'timeline.duplicateClip': { description: 'Clone a clip onto the same track after it.' },
  'timeline.setClipRate': {
    description: 'Set clip playback rate (0.1–8×); rescale duration by default.',
  },
  'timeline.freezeFrame': {
    description: 'Insert a freeze/hold segment at a time inside a video clip.',
  },
  'timeline.toggleClipReverse': {
    description: 'Reverse or restore a video clip while preserving its source window.',
  },
  'timeline.setTimeRemap': {
    description: 'Set or clear a validated monotonic clip-local source-time remap.',
  },
  'timeline.createCompound': {
    description: 'Merge a contiguous run of clips into an editable nested composition.',
  },
  'timeline.restoreCompound': {
    description: 'Restore the original clips and remove a nested compound composition.',
  },
  'timeline.restoreTrackClips': {
    description: 'Replace a track clip list (undo for compound edits).',
  },
  'timeline.setCompositionDimensions': {
    description: 'Set a composition canvas width and height.',
  },
  'timeline.addTrack': { description: 'Add a track to a composition.' },
  'timeline.removeTrack': { description: 'Remove an empty track from a composition.' },
  'timeline.reorderTrack': { description: 'Change a track visual layer order.' },
  'timeline.renameTrack': { description: 'Rename a neutral Timeline track.' },
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
    case 'timeline.moveElement':
      return applyMoveElement(project, command.payload);
    case 'timeline.trimClipStart':
      return applyTrimClipStart(project, command.payload);
    case 'timeline.trimClipEnd':
      return applyTrimClipEnd(project, command.payload);
    case 'timeline.splitClip':
      return applySplitClip(project, command.payload);
    case 'timeline.joinClips':
      return applyJoinClips(project, command.payload);
    case 'timeline.duplicateClip':
      return applyDuplicateClip(project, command.payload);
    case 'timeline.setClipRate':
      return applySetClipRate(project, command.payload);
    case 'timeline.freezeFrame':
      return applyFreezeFrame(project, command.payload);
    case 'timeline.toggleClipReverse':
      return applyToggleClipReverse(project, command.payload);
    case 'timeline.setTimeRemap':
      return applySetTimeRemap(project, command.payload);
    case 'timeline.createCompound':
      return applyCreateCompound(project, command.payload);
    case 'timeline.restoreCompound':
      return applyRestoreCompound(project, command.payload);
    case 'timeline.restoreTrackClips':
      return applyRestoreTrackClips(project, command.payload);
    case 'timeline.setCompositionDimensions':
      return applySetCompositionDimensions(project, command.payload);
    case 'timeline.addTrack':
      return applyAddTrack(project, command.payload);
    case 'timeline.removeTrack':
      return applyRemoveTrack(project, command.payload);
    case 'timeline.reorderTrack':
      return applyReorderTrack(project, command.payload);
    case 'timeline.renameTrack':
      return applyRenameTrack(project, command.payload);
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

/** Source-side offset field for a clip kind: video shifts sourceInUs by rate×delta. */
function shiftSourceForStartTrim(clip: Clip, deltaUs: number): Clip {
  if (clip.kind === 'video') {
    const rate = normalizePlaybackRate(clip.playbackRate);
    const direction = clip.reversed === true ? -1 : 1;
    const sourceInUs = clip.sourceInUs + Math.round(deltaUs * rate) * direction;
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

function sourceAdvanceUs(clip: Clip): number {
  if (clip.kind === 'video') {
    const advanceUs = Math.round(clip.durationUs * normalizePlaybackRate(clip.playbackRate));
    return clip.reversed === true ? -advanceUs : advanceUs;
  }
  return clip.durationUs;
}

function withPlaybackRate(clip: VideoClip, playbackRate: number): VideoClip {
  if (playbackRate === 1) {
    const withoutRate = { ...clip };
    Reflect.deleteProperty(withoutRate, 'playbackRate');
    return withoutRate;
  }
  return { ...clip, playbackRate };
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

function applyMoveElement(project: SpikeProject, payload: MoveElementPayload): ApplyResult {
  const sourceTrack = getTrack(project, {
    compositionId: payload.compositionId,
    trackId: payload.sourceTrackId,
  });
  const targetTrack = getTrack(project, {
    compositionId: payload.compositionId,
    trackId: payload.targetTrackId,
  });
  const clip = getClip(sourceTrack, payload.clipId);
  assertClipRange(payload.newStartUs, clip.durationUs, 'moveElement');
  assertNoOverlap(
    targetTrack,
    payload.newStartUs,
    clip.durationUs,
    sourceTrack.id === targetTrack.id ? clip.id : undefined,
    'moveElement',
  );
  const moved: Clip = { ...clip, startUs: payload.newStartUs };
  const composition = project.compositions[payload.compositionId]!;
  const tracks = composition.tracks.map((track) => {
    if (track.id === sourceTrack.id && track.id === targetTrack.id) {
      return {
        ...track,
        clips: [...track.clips.filter((item) => item.id !== clip.id), moved].sort(
          (a, b) => a.startUs - b.startUs,
        ),
      };
    }
    if (track.id === sourceTrack.id) {
      return { ...track, clips: track.clips.filter((item) => item.id !== clip.id) };
    }
    if (track.id === targetTrack.id) {
      return { ...track, clips: [...track.clips, moved].sort((a, b) => a.startUs - b.startUs) };
    }
    return track;
  });
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [payload.compositionId]: { ...composition, tracks },
      },
    },
    inverse: {
      type: 'timeline.moveElement',
      payload: {
        compositionId: payload.compositionId,
        sourceTrackId: payload.targetTrackId,
        targetTrackId: payload.sourceTrackId,
        clipId: payload.clipId,
        newStartUs: clip.startUs,
      },
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
    return (
      a.assetId === b.assetId &&
      normalizePlaybackRate(a.playbackRate) === normalizePlaybackRate(b.playbackRate) &&
      a.reversed === b.reversed &&
      b.sourceInUs === a.sourceInUs + sourceAdvanceUs(a)
    );
  }
  if (first.kind === 'composition' && second.kind === 'composition') {
    return (
      first.compositionId === second.compositionId &&
      second.childOffsetUs === first.childOffsetUs + first.durationUs
    );
  }
  return false;
}

function applyDuplicateClip(project: SpikeProject, payload: DuplicateClipPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  if (clip.kind === 'composition') {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      'duplicateClip: duplicate a nested composition only after creating an independent copy',
    );
  }
  if (track.clips.some((c) => c.id === payload.newClipId)) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `duplicateClip: new clip id "${payload.newClipId}" already exists`,
    );
  }
  const newStartUs = payload.newStartUs ?? clip.startUs + clip.durationUs;
  assertClipRange(newStartUs, clip.durationUs, 'duplicateClip');
  assertNoOverlap(track, newStartUs, clip.durationUs, undefined, 'duplicateClip');
  const clone: Clip = { ...clip, id: payload.newClipId, startUs: newStartUs };
  return {
    project: withTrackClips(project, payload, [...track.clips, clone]),
    inverse: {
      type: 'timeline.removeClip',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipId: payload.newClipId,
      },
    },
  };
}

function applySetClipRate(project: SpikeProject, payload: SetClipRatePayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  if (clip.kind !== 'video') {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      `setClipRate: only video clips support playback rate (got "${clip.kind}")`,
    );
  }
  if (!isValidPlaybackRate(payload.playbackRate) || payload.playbackRate === 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_RANGE',
      `setClipRate: playbackRate must be in [0.1, 8] (use freezeFrame for rate 0)`,
    );
  }
  const oldRate = normalizePlaybackRate(clip.playbackRate);
  if (oldRate === payload.playbackRate) {
    return {
      project,
      inverse: { type: 'timeline.setClipRate', payload },
    };
  }
  const preserve = payload.preserveSourceRange !== false;
  let durationUs = clip.durationUs;
  if (preserve) {
    if (oldRate === 0) {
      throw new CommandError(
        'COMMAND_VALIDATION_RANGE',
        'setClipRate: cannot preserve source range when leaving a freeze clip',
      );
    }
    durationUs = Math.max(1, Math.round(clip.durationUs * (oldRate / payload.playbackRate)));
  }
  assertClipRange(clip.startUs, durationUs, 'setClipRate');
  assertNoOverlap(track, clip.startUs, durationUs, clip.id, 'setClipRate');
  const updated = withPlaybackRate({ ...clip, durationUs }, payload.playbackRate);
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((c) => c.id !== clip.id),
      updated,
    ]),
    inverse: {
      type: 'timeline.setClipRate',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipId: clip.id,
        playbackRate: oldRate === 0 ? 1 : oldRate,
        preserveSourceRange: preserve,
      },
    },
  };
}

function applyFreezeFrame(project: SpikeProject, payload: FreezeFramePayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  if (clip.kind !== 'video') {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      `freezeFrame: only video clips can freeze (got "${clip.kind}")`,
    );
  }
  const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
  if (!(payload.atUs > clip.startUs && payload.atUs < endUs)) {
    throw new CommandError(
      'COMMAND_VALIDATION_RANGE',
      `freezeFrame: atUs ${payload.atUs} must be strictly inside [${clip.startUs}, ${endUs})`,
    );
  }
  if (!(payload.holdUs > 0)) {
    throw new CommandError('COMMAND_VALIDATION_RANGE', 'freezeFrame: holdUs must be positive');
  }
  for (const id of [payload.freezeClipId, payload.rightClipId]) {
    if (track.clips.some((c) => c.id === id) || id === clip.id) {
      throw new CommandError(
        'COMMAND_VALIDATION_DUPLICATE_ID',
        `freezeFrame: clip id "${id}" already exists`,
      );
    }
  }
  const previousClips = track.clips;
  const localUs = payload.atUs - clip.startUs;
  const rate = normalizePlaybackRate(clip.playbackRate);
  const sourceAtCut =
    clip.sourceInUs + Math.round(localUs * rate) * (clip.reversed === true ? -1 : 1);
  const left: VideoClip = { ...clip, durationUs: localUs };
  const freeze: VideoClip = withPlaybackRate(
    {
      kind: 'video',
      id: payload.freezeClipId,
      startUs: payload.atUs,
      durationUs: payload.holdUs,
      assetId: clip.assetId,
      sourceInUs: sourceAtCut,
      playbackRate: 0,
    },
    0,
  );
  const right: VideoClip = {
    ...clip,
    id: payload.rightClipId,
    startUs: payload.atUs + payload.holdUs,
    durationUs: endUs - payload.atUs,
    sourceInUs: sourceAtCut,
  };
  const others = track.clips
    .filter((c) => c.id !== clip.id)
    .map((c) => (c.startUs >= payload.atUs ? { ...c, startUs: c.startUs + payload.holdUs } : c));
  const nextClips = [...others, left, freeze, right];
  for (const item of nextClips) {
    assertClipRange(item.startUs, item.durationUs, 'freezeFrame');
  }
  // Overlap check across the rebuilt list.
  const sorted = [...nextClips].sort((a, b) => a.startUs - b.startUs);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startUs < prev.startUs + prev.durationUs) {
      throw new CommandError(
        'COMMAND_VALIDATION_OVERLAP',
        `freezeFrame: result overlaps at "${cur.id}"`,
      );
    }
  }
  return {
    project: withTrackClips(project, payload, nextClips),
    inverse: {
      type: 'timeline.restoreTrackClips',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clips: previousClips,
      },
    },
  };
}

/**
 * Flip direction without storing a signed playback rate. `sourceInUs` always
 * names the source frame at the timeline start, so swapping direction moves it
 * to the opposite end of the existing source window. The `-1` is the same
 * end-exclusive boundary convention used by preview sampling.
 */
function applySetTimeRemap(project: SpikeProject, payload: SetTimeRemapPayload): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  if (clip.kind !== 'video') {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      `setTimeRemap: only video clips support source-time remapping (got "${clip.kind}")`,
    );
  }
  if (payload.timeRemap !== undefined) {
    const errors = validateTimeRemap(payload.timeRemap, clip.durationUs);
    if (errors.length > 0) {
      throw new CommandError('COMMAND_VALIDATION_RANGE', `setTimeRemap: ${errors[0]}`);
    }
  }
  const previous = clip.timeRemap;
  const updated: VideoClip =
    payload.timeRemap === undefined
      ? (() => {
          const restored = { ...clip };
          Reflect.deleteProperty(restored, 'timeRemap');
          return restored;
        })()
      : { ...clip, timeRemap: payload.timeRemap };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((item) => item.id !== clip.id),
      updated,
    ]),
    inverse: {
      type: 'timeline.setTimeRemap',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipId: clip.id,
        ...(previous === undefined ? {} : { timeRemap: previous }),
      },
    },
  };
}

function applyToggleClipReverse(
  project: SpikeProject,
  payload: ToggleClipReversePayload,
): ApplyResult {
  const track = getTrack(project, payload);
  const clip = getClip(track, payload.clipId);
  if (clip.kind !== 'video') {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      `toggleClipReverse: only video clips support reverse (got "${clip.kind}")`,
    );
  }
  const rate = normalizePlaybackRate(clip.playbackRate);
  if (rate === 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      'toggleClipReverse: a frozen clip has no playback direction',
    );
  }
  const sourceSpanUs = Math.max(0, Math.round((clip.durationUs - 1) * rate));
  const sourceInUs =
    clip.reversed === true ? clip.sourceInUs - sourceSpanUs : clip.sourceInUs + sourceSpanUs;
  if (sourceInUs < 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_SOURCE_UNDERFLOW',
      `toggleClipReverse: reversing "${clip.id}" would read before source time 0`,
    );
  }
  const updated: VideoClip =
    clip.reversed === true
      ? (() => {
          const forward = { ...clip };
          Reflect.deleteProperty(forward, 'reversed');
          return { ...forward, sourceInUs };
        })()
      : { ...clip, sourceInUs, reversed: true };
  return {
    project: withTrackClips(project, payload, [
      ...track.clips.filter((item) => item.id !== clip.id),
      updated,
    ]),
    inverse: { type: 'timeline.toggleClipReverse', payload },
  };
}

function assertCompoundSelection(track: Track, payload: CreateCompoundPayload): readonly Clip[] {
  const uniqueClipIds = [...new Set(payload.clipIds)];
  if (uniqueClipIds.length < 2 || uniqueClipIds.length !== payload.clipIds.length) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_SELECTION',
      'createCompound: select two or more distinct clips',
    );
  }
  const selected = uniqueClipIds.map((clipId) => getClip(track, clipId));
  const sortedTrack = [...track.clips].sort((a, b) => a.startUs - b.startUs);
  const selectedIds = new Set(uniqueClipIds);
  const selectedIndexes = sortedTrack
    .map((clip, index) => (selectedIds.has(clip.id) ? index : -1))
    .filter((index) => index >= 0);
  const firstIndex = selectedIndexes[0];
  if (
    firstIndex === undefined ||
    selectedIndexes.length !== uniqueClipIds.length ||
    selectedIndexes.some((index, offset) => index !== firstIndex + offset)
  ) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_NON_CONTIGUOUS',
      'createCompound: selected clips must be contiguous on one track',
    );
  }
  return selected.sort((a, b) => a.startUs - b.startUs);
}

function assertClipListHasNoOverlap(clips: readonly Clip[], context: string): void {
  const sorted = [...clips].sort((a, b) => a.startUs - b.startUs);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.startUs < previous.startUs + previous.durationUs) {
      throw new CommandError(
        'COMMAND_VALIDATION_OVERLAP',
        `${context}: "${current.id}" overlaps "${previous.id}"`,
      );
    }
  }
}

function compoundCompositionFromSelection(
  parent: Composition,
  sourceTrack: Track,
  selected: readonly Clip[],
  payload: CreateCompoundPayload,
): { readonly composition: Composition; readonly compoundClip: Clip } {
  const startUs = selected[0]!.startUs;
  const endUs = Math.max(...selected.map((clip) => clip.startUs + clip.durationUs));
  const durationUs = endUs - startUs;
  assertClipRange(startUs, durationUs, 'createCompound');
  const composition: Composition = {
    id: payload.compoundCompositionId,
    name: payload.name?.trim() || `Merged ${selected.length} clips`,
    width: parent.width,
    height: parent.height,
    frameRate: parent.frameRate,
    durationUs,
    tracks: [
      {
        id: `${sourceTrack.id}__compound`,
        kind: 'video',
        order: 0,
        enabled: sourceTrack.enabled,
        clips: selected.map((clip) => ({ ...clip, startUs: clip.startUs - startUs })),
      },
    ],
  };
  return {
    composition,
    compoundClip: {
      id: payload.compoundClipId,
      kind: 'composition',
      startUs,
      durationUs,
      compositionId: payload.compoundCompositionId,
      childOffsetUs: 0,
    },
  };
}

function applyCreateCompound(project: SpikeProject, payload: CreateCompoundPayload): ApplyResult {
  const parent = project.compositions[payload.compositionId];
  if (parent === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown composition "${payload.compositionId}"`,
    );
  }
  const track = getTrack(project, payload);
  if (payload.compoundCompositionId === payload.compositionId) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_CYCLE',
      'createCompound: a composition cannot contain itself',
    );
  }
  if (project.compositions[payload.compoundCompositionId] !== undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `createCompound: composition id "${payload.compoundCompositionId}" already exists`,
    );
  }
  if (track.clips.some((clip) => clip.id === payload.compoundClipId)) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `createCompound: clip id "${payload.compoundClipId}" already exists on track "${track.id}"`,
    );
  }
  const selected = assertCompoundSelection(track, payload);
  const { composition: child, compoundClip } = compoundCompositionFromSelection(
    parent,
    track,
    selected,
    payload,
  );
  const selectedIds = new Set(selected.map((clip) => clip.id));
  const nextTrackClips = [...track.clips.filter((clip) => !selectedIds.has(clip.id)), compoundClip];
  assertClipListHasNoOverlap(nextTrackClips, 'createCompound');
  const nextProject = withTrackClips(project, payload, nextTrackClips);
  return {
    project: {
      ...nextProject,
      compositions: { ...nextProject.compositions, [child.id]: child },
    },
    inverse: {
      type: 'timeline.restoreCompound',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        compoundCompositionId: payload.compoundCompositionId,
        compoundClipId: payload.compoundClipId,
        clips: selected,
      },
    },
  };
}

function clipsMatchCompound(
  child: Composition,
  compoundClip: Extract<Clip, { readonly kind: 'composition' }>,
  originalClips: readonly Clip[],
): boolean {
  if (child.tracks.length !== 1 || child.durationUs !== compoundClip.durationUs) return false;
  const childClips = [...child.tracks[0]!.clips].sort((a, b) => a.startUs - b.startUs);
  const originals = [...originalClips].sort((a, b) => a.startUs - b.startUs);
  if (childClips.length !== originals.length) return false;
  return childClips.every((clip, index) => {
    const source = originals[index];
    if (source === undefined) return false;
    const expected = { ...source, startUs: source.startUs - compoundClip.startUs };
    return JSON.stringify(clip) === JSON.stringify(expected);
  });
}

function applyRestoreCompound(project: SpikeProject, payload: RestoreCompoundPayload): ApplyResult {
  const track = getTrack(project, payload);
  const compound = getClip(track, payload.compoundClipId);
  if (compound.kind !== 'composition' || compound.compositionId !== payload.compoundCompositionId) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_MISMATCH',
      `restoreCompound: "${payload.compoundClipId}" does not reference "${payload.compoundCompositionId}"`,
    );
  }
  if (payload.compoundCompositionId === project.rootCompositionId) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_MISMATCH',
      'restoreCompound: the root composition cannot be removed',
    );
  }
  const child = project.compositions[payload.compoundCompositionId];
  if (child === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `restoreCompound: child composition "${payload.compoundCompositionId}" is unavailable`,
    );
  }
  const references = Object.values(project.compositions).flatMap((composition) =>
    composition.tracks.flatMap((item) =>
      item.clips.filter(
        (clip) =>
          clip.kind === 'composition' && clip.compositionId === payload.compoundCompositionId,
      ),
    ),
  );
  if (references.length !== 1 || references[0]?.id !== compound.id) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_SHARED',
      'restoreCompound: the child composition is referenced by another clip',
    );
  }
  const restoredIds = new Set<string>();
  for (const clip of payload.clips) {
    if (restoredIds.has(clip.id)) {
      throw new CommandError(
        'COMMAND_VALIDATION_DUPLICATE_ID',
        `restoreCompound: duplicate clip id "${clip.id}"`,
      );
    }
    restoredIds.add(clip.id);
    assertClipRange(clip.startUs, clip.durationUs, 'restoreCompound');
  }
  if (payload.clips.length < 2 || !clipsMatchCompound(child, compound, payload.clips)) {
    throw new CommandError(
      'COMMAND_VALIDATION_COMPOUND_MISMATCH',
      'restoreCompound: the child timeline no longer matches the original merged clips',
    );
  }
  const remaining = track.clips.filter((clip) => clip.id !== compound.id);
  if (remaining.some((clip) => restoredIds.has(clip.id))) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      'restoreCompound: a restored clip id already exists on the parent track',
    );
  }
  const nextTrackClips = [...remaining, ...payload.clips];
  assertClipListHasNoOverlap(nextTrackClips, 'restoreCompound');
  const withRestoredTrack = withTrackClips(project, payload, nextTrackClips);
  const remainingCompositions = { ...withRestoredTrack.compositions };
  Reflect.deleteProperty(remainingCompositions, payload.compoundCompositionId);
  return {
    project: { ...withRestoredTrack, compositions: remainingCompositions },
    inverse: {
      type: 'timeline.createCompound',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clipIds: payload.clips.map((clip) => clip.id),
        compoundCompositionId: payload.compoundCompositionId,
        compoundClipId: payload.compoundClipId,
        name: child.name,
      },
    },
  };
}

function applyRestoreTrackClips(
  project: SpikeProject,
  payload: RestoreTrackClipsPayload,
): ApplyResult {
  const track = getTrack(project, payload);
  const previousClips = track.clips;
  const ids = new Set<string>();
  for (const clip of payload.clips) {
    if (ids.has(clip.id)) {
      throw new CommandError(
        'COMMAND_VALIDATION_DUPLICATE_ID',
        `restoreTrackClips: duplicate clip id "${clip.id}"`,
      );
    }
    ids.add(clip.id);
    assertClipRange(clip.startUs, clip.durationUs, 'restoreTrackClips');
  }
  const sorted = [...payload.clips].sort((a, b) => a.startUs - b.startUs);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startUs < prev.startUs + prev.durationUs) {
      throw new CommandError(
        'COMMAND_VALIDATION_OVERLAP',
        `restoreTrackClips: overlaps at "${cur.id}"`,
      );
    }
  }
  return {
    project: withTrackClips(project, payload, payload.clips),
    inverse: {
      type: 'timeline.restoreTrackClips',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        clips: previousClips,
      },
    },
  };
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

function isCanvasDimension(value: number): boolean {
  // Renderer and browser canvas limits vary, but 32K is a conservative durable
  // document bound. The UI may choose any common portrait, square, or wide ratio
  // inside it; commands never silently clamp a requested canvas.
  return Number.isSafeInteger(value) && value > 0 && value <= 32_768;
}

function applySetCompositionDimensions(
  project: SpikeProject,
  payload: SetCompositionDimensionsPayload,
): ApplyResult {
  const composition = project.compositions[payload.compositionId];
  if (composition === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown composition "${payload.compositionId}"`,
    );
  }
  if (!isCanvasDimension(payload.width) || !isCanvasDimension(payload.height)) {
    throw new CommandError(
      'COMMAND_VALIDATION_RANGE',
      'setCompositionDimensions: width and height must be whole pixels in [1, 32768]',
    );
  }
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [composition.id]: { ...composition, width: payload.width, height: payload.height },
      },
    },
    inverse: {
      type: 'timeline.setCompositionDimensions',
      payload: {
        compositionId: payload.compositionId,
        width: composition.width,
        height: composition.height,
      },
    },
  };
}

function applyAddTrack(project: SpikeProject, payload: AddTrackPayload): ApplyResult {
  const comp = project.compositions[payload.compositionId];
  if (comp === undefined) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNKNOWN_TARGET',
      `unknown composition "${payload.compositionId}"`,
    );
  }
  if (comp.tracks.some((track) => track.id === payload.track.id)) {
    throw new CommandError(
      'COMMAND_VALIDATION_DUPLICATE_ID',
      `track id "${payload.track.id}" already exists`,
    );
  }
  if (payload.track.clips.length > 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      'addTrack: create an empty track, then insert clips in the same transaction',
    );
  }
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [payload.compositionId]: { ...comp, tracks: [...comp.tracks, payload.track] },
      },
    },
    inverse: {
      type: 'timeline.removeTrack',
      payload: { compositionId: payload.compositionId, trackId: payload.track.id },
    },
  };
}

function applyRemoveTrack(project: SpikeProject, payload: RemoveTrackPayload): ApplyResult {
  const track = getTrack(project, payload);
  if (track.clips.length > 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      `removeTrack: track "${payload.trackId}" still has clips`,
    );
  }
  const comp = project.compositions[payload.compositionId]!;
  if (comp.tracks.length <= 1) {
    throw new CommandError(
      'COMMAND_VALIDATION_UNSUPPORTED',
      'removeTrack: cannot remove the last track',
    );
  }
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [payload.compositionId]: {
          ...comp,
          tracks: comp.tracks.filter((item) => item.id !== payload.trackId),
        },
      },
    },
    inverse: {
      type: 'timeline.addTrack',
      payload: { compositionId: payload.compositionId, track },
    },
  };
}

function applyReorderTrack(project: SpikeProject, payload: ReorderTrackPayload): ApplyResult {
  const track = getTrack(project, payload);
  if (!Number.isSafeInteger(payload.newOrder) || payload.newOrder < 0) {
    throw new CommandError(
      'COMMAND_VALIDATION_RANGE',
      'reorderTrack: newOrder must be a non-negative safe integer',
    );
  }
  const composition = project.compositions[payload.compositionId]!;
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [payload.compositionId]: {
          ...composition,
          tracks: composition.tracks.map((item) =>
            item.id === track.id ? { ...item, order: payload.newOrder } : item,
          ),
        },
      },
    },
    inverse: {
      type: 'timeline.reorderTrack',
      payload: { ...payload, newOrder: track.order },
    },
  };
}

function applyRenameTrack(project: SpikeProject, payload: RenameTrackPayload): ApplyResult {
  const track = getTrack(project, payload);
  const name = payload.newName?.trim();
  if (name !== undefined && name.length === 0) {
    throw new CommandError('COMMAND_VALIDATION_RANGE', 'renameTrack: name cannot be empty');
  }
  const composition = project.compositions[payload.compositionId]!;
  const tracks = composition.tracks.map((item) => {
    if (item.id !== track.id) return item;
    if (name === undefined) {
      const withoutName = { ...item };
      Reflect.deleteProperty(withoutName, 'name');
      return withoutName;
    }
    return { ...item, name };
  });
  return {
    project: {
      ...project,
      compositions: {
        ...project.compositions,
        [payload.compositionId]: { ...composition, tracks },
      },
    },
    inverse: {
      type: 'timeline.renameTrack',
      payload: {
        compositionId: payload.compositionId,
        trackId: payload.trackId,
        ...(track.name === undefined ? {} : { newName: track.name }),
      },
    },
  };
}
