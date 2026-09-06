import { applyTransaction } from '@joy-media/commands';
import type {
  MoveClipPayload,
  SpikeCommand,
  TrimClipEndPayload,
  TrimClipStartPayload,
} from '@joy-media/commands';
import type { Clip, SpikeProject, Track } from '@joy-media/project-schema';
import { canonicalJson } from '@joy-media/workflow-engine';

/**
 * Semantic project-state readback for the narrow F5 trim and same-track move
 * lanes. The caller already verifies the whole approved transaction against
 * its durable commit; these assertions additionally name the exact clip that
 * was meant to change. They make no renderer, pixel, decoded-media, or export
 * claim.
 */
export function assertTimelineTrimProjectReadback(
  before: SpikeProject,
  after: SpikeProject,
  commands: readonly SpikeCommand[],
): void {
  const { start, end } = trimPayloads(commands);
  if (
    start.compositionId !== end.compositionId ||
    start.trackId !== end.trackId ||
    start.clipId !== end.clipId ||
    end.newEndUs <= start.newStartUs
  )
    fail('INVALID', 'trim commands must target one clip with an end after its start');

  const beforeTrack = trackFor(before, start.compositionId, start.trackId, 'before');
  const original = clipFor(beforeTrack, start.clipId, 'before');
  if (
    start.newStartUs === original.startUs &&
    end.newEndUs === original.startUs + original.durationUs
  )
    fail('INVALID', `trim for clip "${original.id}" is a no-op`);

  const expected = applyExpectedProject(before, commands);
  const expectedClip = clipFor(
    trackFor(expected, start.compositionId, start.trackId, 'expected'),
    start.clipId,
    'expected',
  );
  const actualClip = clipFor(
    trackFor(after, start.compositionId, start.trackId, 'after'),
    start.clipId,
    'after',
  );
  assertCanonicalEqual(
    actualClip,
    expectedClip,
    `trimmed clip "${start.clipId}" differs from the approved project state`,
  );
  assertCanonicalEqual(after, expected, 'trimmed project differs from the approved project state');
}

export function assertTimelineMoveProjectReadback(
  before: SpikeProject,
  after: SpikeProject,
  command: SpikeCommand,
): void {
  const payload = movePayload(command);
  const beforeTrack = trackFor(before, payload.compositionId, payload.trackId, 'before');
  const original = clipFor(beforeTrack, payload.clipId, 'before');
  if (payload.newStartUs === original.startUs)
    fail('INVALID', `move for clip "${original.id}" is a no-op`);

  const expected = applyExpectedProject(before, [command]);
  const expectedClip = clipFor(
    trackFor(expected, payload.compositionId, payload.trackId, 'expected'),
    payload.clipId,
    'expected',
  );
  const actualClip = clipFor(
    trackFor(after, payload.compositionId, payload.trackId, 'after'),
    payload.clipId,
    'after',
  );
  assertCanonicalEqual(
    actualClip,
    expectedClip,
    `moved clip "${payload.clipId}" differs from the approved project state`,
  );
  assertCanonicalEqual(after, expected, 'moved project differs from the approved project state');
}

function trimPayloads(commands: readonly SpikeCommand[]): {
  readonly start: TrimClipStartPayload;
  readonly end: TrimClipEndPayload;
} {
  if (commands.length !== 2)
    fail('UNSUPPORTED_COMMAND', 'expected one trim start command followed by one trim end command');
  return {
    start: trimStartPayload(commands[0]),
    end: trimEndPayload(commands[1]),
  };
}

function trimStartPayload(command: unknown): TrimClipStartPayload {
  const payload = commandPayload(command, 'timeline.trimClipStart', [
    'compositionId',
    'trackId',
    'clipId',
    'newStartUs',
  ]);
  if (
    !isNonBlankId(payload.compositionId) ||
    !isNonBlankId(payload.trackId) ||
    !isNonBlankId(payload.clipId)
  )
    fail('INVALID', 'trim start identifiers must be non-blank strings');
  if (!isNonNegativeSafeInteger(payload.newStartUs))
    fail('INVALID', 'trim start must be a non-negative safe integer');
  return {
    compositionId: payload.compositionId,
    trackId: payload.trackId,
    clipId: payload.clipId,
    newStartUs: payload.newStartUs,
  };
}

function trimEndPayload(command: unknown): TrimClipEndPayload {
  const payload = commandPayload(command, 'timeline.trimClipEnd', [
    'compositionId',
    'trackId',
    'clipId',
    'newEndUs',
  ]);
  if (
    !isNonBlankId(payload.compositionId) ||
    !isNonBlankId(payload.trackId) ||
    !isNonBlankId(payload.clipId)
  )
    fail('INVALID', 'trim end identifiers must be non-blank strings');
  if (!isNonNegativeSafeInteger(payload.newEndUs))
    fail('INVALID', 'trim end must be a non-negative safe integer');
  return {
    compositionId: payload.compositionId,
    trackId: payload.trackId,
    clipId: payload.clipId,
    newEndUs: payload.newEndUs,
  };
}

function movePayload(command: unknown): MoveClipPayload {
  const payload = commandPayload(command, 'timeline.moveClip', [
    'compositionId',
    'trackId',
    'clipId',
    'newStartUs',
  ]);
  if (
    !isNonBlankId(payload.compositionId) ||
    !isNonBlankId(payload.trackId) ||
    !isNonBlankId(payload.clipId)
  )
    fail('INVALID', 'move identifiers must be non-blank strings');
  if (!isNonNegativeSafeInteger(payload.newStartUs))
    fail('INVALID', 'move start must be a non-negative safe integer');
  return {
    compositionId: payload.compositionId,
    trackId: payload.trackId,
    clipId: payload.clipId,
    newStartUs: payload.newStartUs,
  };
}

function commandPayload(
  command: unknown,
  type: string,
  exactKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(command) || command.type !== type) fail('UNSUPPORTED_COMMAND', `expected ${type}`);
  if (!isRecord(command.payload) || !hasExactKeys(command.payload, exactKeys))
    fail('INVALID', `${type} payload is malformed`);
  return command.payload;
}

function applyExpectedProject(
  before: SpikeProject,
  commands: readonly SpikeCommand[],
): SpikeProject {
  try {
    return applyTransaction(before, { label: 'JOY timeline semantic readback', commands }).project;
  } catch {
    fail('STALE', 'approved timeline command no longer applies to the source project state');
  }
}

function trackFor(
  project: SpikeProject,
  compositionId: string,
  trackId: string,
  phase: 'before' | 'expected' | 'after',
): Track {
  const composition = project.compositions[compositionId];
  if (composition === undefined)
    fail('STALE', `${phase} project has no composition "${compositionId}"`);
  const track = composition.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) fail('STALE', `${phase} project has no track "${trackId}"`);
  return track;
}

function clipFor(track: Track, clipId: string, phase: 'before' | 'expected' | 'after'): Clip {
  const clips = track.clips.filter((candidate) => candidate.id === clipId);
  if (clips.length !== 1)
    fail('STALE', `${phase} track has ${clips.length} clips named "${clipId}"`);
  return clips[0]!;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail('MISMATCH', message);
}

function fail(
  code: 'INVALID' | 'UNSUPPORTED_COMMAND' | 'STALE' | 'MISMATCH',
  message: string,
): never {
  throw new Error(`JOY_CODE_TIMELINE_EDIT_READBACK_${code}: ${message}`);
}
