/**
 * Reads the timeline's tracks and returns what the A1 linked-audio strips need.
 *
 * Pure and read-only: it never writes the project. A strip shows the audio of a
 * video clip, so each strip needs the part of the clip's source it covers; this
 * file maps a strip back to a source window with the clip's own speed and
 * direction, the same mapping the waveform slicer uses for real audio clips.
 */

import type { Clip, Track } from '@joy-media/project-schema';
import type {
  LinkedAudioLaneSpan,
  LinkedAudioSourceClip,
  LinkedAudioStrip,
} from './timeline-linked-audio.js';
import {
  timelineElementKindForClip,
  type TimelineElementKindMap,
} from './timeline-element-kind.js';
import { sortTracksForTimelineDisplay, timelineTrackFamily } from './timeline-track-family.js';
import type { TimelineElementMediaSource } from './timeline-media.js';

export interface LinkedAudioVideoClip extends LinkedAudioSourceClip {
  readonly sourceInUs: number;
  readonly playbackRate?: number;
  readonly reversed?: boolean;
}

export interface LinkedAudioLaneInputs {
  /** The first shown audio row in display order (A1), or `undefined` when there is none. */
  readonly a1TrackId: string | undefined;
  readonly a1Clips: readonly LinkedAudioLaneSpan[];
  readonly videoClips: readonly LinkedAudioVideoClip[];
}

/**
 * Video clips that can lend their audio to A1, and the real clips already on A1.
 * A clip on a hidden or muted row, an image-like clip and a clip with a custom
 * time remap contribute nothing: their audio is not what the strip would show.
 */
export function collectLinkedAudioInputs(
  tracks: readonly Track[],
  elementKinds: TimelineElementKindMap = {},
): LinkedAudioLaneInputs {
  const ordered = sortTracksForTimelineDisplay(tracks, elementKinds);
  // A hidden audio row draws nothing, so the strips go to the first audio row that is shown.
  const a1 = ordered.find(
    (track) => timelineTrackFamily(track, elementKinds) === 'audio' && track.enabled !== false,
  );
  const videoClips: LinkedAudioVideoClip[] = [];
  for (const track of ordered) {
    if (timelineTrackFamily(track, elementKinds) !== 'visual') continue;
    if (track.enabled === false || track.muted === true) continue;
    for (const clip of track.clips) {
      if (!isLinkedAudioSource(clip, elementKinds)) continue;
      videoClips.push({
        clipId: clip.id,
        assetId: clip.assetId,
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        sourceInUs: clip.sourceInUs,
        ...(clip.playbackRate === undefined ? {} : { playbackRate: clip.playbackRate }),
        ...(clip.reversed === undefined ? {} : { reversed: clip.reversed }),
      });
    }
  }
  return {
    a1TrackId: a1?.id,
    a1Clips: (a1?.clips ?? []).map((clip) => ({
      startUs: clip.startUs,
      durationUs: clip.durationUs,
    })),
    videoClips,
  };
}

function isLinkedAudioSource(
  clip: Clip,
  elementKinds: TimelineElementKindMap,
): clip is Clip & { readonly kind: 'video' } {
  return (
    clip.kind === 'video' &&
    clip.timeRemap === undefined &&
    timelineElementKindForClip(clip, elementKinds) === 'video'
  );
}

/**
 * The source window one strip plays. A strip may be only part of its clip (a real
 * A1 clip cut a piece out), so the in-point moves by the cut offset at the clip's
 * speed, forward or backward.
 */
export function linkedStripMedia(
  clip: LinkedAudioVideoClip,
  strip: LinkedAudioStrip,
): TimelineElementMediaSource {
  const rate = clip.playbackRate ?? 1;
  const offsetUs = Math.max(0, strip.startUs - clip.startUs);
  const shiftUs = Math.round(offsetUs * (rate > 0 ? rate : 0));
  const reversed = clip.reversed === true;
  return {
    assetId: clip.assetId,
    sourceInUs: Math.max(0, reversed ? clip.sourceInUs - shiftUs : clip.sourceInUs + shiftUs),
    durationUs: strip.endUs - strip.startUs,
    ...(clip.playbackRate === undefined ? {} : { playbackRate: clip.playbackRate }),
    ...(reversed ? { reversed: true } : {}),
  };
}
