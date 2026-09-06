import type { SpikeCommand, SplitClipPayload } from '@joy-media/commands';
import {
  normalizePlaybackRate,
  type Clip,
  type SpikeProject,
  type Track,
} from '@joy-media/project-schema';
import { canonicalJson } from '@joy-media/workflow-engine';

/**
 * Operation-specific semantic readback for the first F5 timeline slice.
 *
 * The generic compound runner already checks that its committed timeline is
 * byte-for-byte equal to the prepared transaction. That is important atomic
 * integrity, but it does not say which creative operation was observed. This
 * verifier intentionally names one bounded operation -- an isolated split --
 * and checks the durable project state that a human timeline user would see.
 *
 * It is deliberately not a renderer assertion: no pixels, decoded media, or
 * final export are claimed by this module. Mixed timeline transactions are not
 * passed here because a later command may legitimately mutate either split
 * half; those need their own ordered readback slice rather than a misleading
 * final-state shortcut.
 */
export function assertTimelineSplitProjectReadback(
  before: SpikeProject,
  after: SpikeProject,
  command: SpikeCommand,
): void {
  const payload = splitPayload(command);
  const beforeTrack = trackFor(before, payload, 'before');
  const afterTrack = trackFor(after, payload, 'after');
  const original = clipFor(beforeTrack, payload.clipId, 'before');

  if (beforeTrack.clips.some((clip) => clip.id === payload.newClipId))
    fail('INVALID', `new clip id "${payload.newClipId}" existed before the split`);

  const originalAfter = singleClipFor(afterTrack, payload.clipId, 'after');
  const derivedAfter = singleClipFor(afterTrack, payload.newClipId, 'after');
  const endUs = original.startUs + original.durationUs;
  if (!(payload.atUs > original.startUs && payload.atUs < endUs))
    fail(
      'STALE',
      `split point ${payload.atUs} is not strictly inside source clip "${original.id}"`,
    );

  const firstDurationUs = payload.atUs - original.startUs;
  const expectedFirst: Clip = { ...original, durationUs: firstDurationUs };
  const expectedSecond = splitSecond(original, payload.newClipId, payload.atUs, endUs);

  assertCanonicalEqual(
    originalAfter,
    expectedFirst,
    `first split half "${payload.clipId}" differs from the approved project state`,
  );
  assertCanonicalEqual(
    derivedAfter,
    expectedSecond,
    `second split half "${payload.newClipId}" differs from the approved project state`,
  );
}

function splitPayload(command: SpikeCommand): SplitClipPayload {
  if (command.type !== 'timeline.splitClip')
    fail('UNSUPPORTED_COMMAND', `expected timeline.splitClip, got ${command.type}`);
  const payload = command.payload as Partial<SplitClipPayload>;
  const atUs = payload.atUs;
  if (
    !nonBlank(payload.compositionId) ||
    !nonBlank(payload.trackId) ||
    !nonBlank(payload.clipId) ||
    !nonBlank(payload.newClipId) ||
    payload.newClipId === payload.clipId ||
    typeof atUs !== 'number' ||
    !Number.isSafeInteger(atUs) ||
    atUs < 0
  )
    fail('INVALID', 'split command payload is malformed');
  return {
    compositionId: payload.compositionId!,
    trackId: payload.trackId!,
    clipId: payload.clipId!,
    atUs,
    newClipId: payload.newClipId!,
  };
}

function trackFor(
  project: SpikeProject,
  payload: SplitClipPayload,
  phase: 'before' | 'after',
): Track {
  const composition = project.compositions[payload.compositionId];
  if (composition === undefined)
    fail('STALE', `${phase} project has no composition "${payload.compositionId}"`);
  const track = composition.tracks.find((candidate) => candidate.id === payload.trackId);
  if (track === undefined) fail('STALE', `${phase} project has no track "${payload.trackId}"`);
  return track;
}

function clipFor(track: Track, clipId: string, phase: 'before' | 'after'): Clip {
  const clips = track.clips.filter((candidate) => candidate.id === clipId);
  if (clips.length !== 1)
    fail('STALE', `${phase} track has ${clips.length} clips named "${clipId}"`);
  return clips[0]!;
}

function singleClipFor(track: Track, clipId: string, phase: 'after'): Clip {
  return clipFor(track, clipId, phase);
}

function splitSecond(original: Clip, newClipId: string, atUs: number, endUs: number): Clip {
  const localUs = atUs - original.startUs;
  if (original.kind === 'video') {
    const rate = normalizePlaybackRate(original.playbackRate);
    const direction = original.reversed === true ? -1 : 1;
    return {
      ...original,
      id: newClipId,
      startUs: atUs,
      durationUs: endUs - atUs,
      sourceInUs: original.sourceInUs + Math.round(localUs * rate) * direction,
    };
  }
  return {
    ...original,
    id: newClipId,
    startUs: atUs,
    durationUs: endUs - atUs,
    childOffsetUs: original.childOffsetUs + localUs,
  };
}

function assertCanonicalEqual(actual: unknown, expected: unknown, message: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail('MISMATCH', message);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function fail(
  code: 'INVALID' | 'UNSUPPORTED_COMMAND' | 'STALE' | 'MISMATCH',
  message: string,
): never {
  throw new Error(`JOY_CODE_TIMELINE_SPLIT_READBACK_${code}: ${message}`);
}
