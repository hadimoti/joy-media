import {
  normalizePlaybackRate,
  sourceTimeAtVideoClipTime,
  type TransitionV1,
  type VideoClip,
} from '@joy-media/project-schema';

/**
 * Source time for a clip during an active A↔B transition. The outgoing clip
 * keeps its normal mapping. The incoming clip moves through the window as if it
 * had started there, in its own direction: a forward clip plays on toward its
 * in-point, and a reversed clip plays back down to its in-point. Either way the
 * cut meets the normal mapping.
 */
export function sourceTimeForTransitionSample(
  clip: VideoClip,
  playheadUs: number,
  transition: TransitionV1 | undefined,
): number {
  if (transition !== undefined && clip.id === transition.rightClipId && playheadUs < clip.startUs) {
    const rate = normalizePlaybackRate(clip.playbackRate);
    if (rate === 0) return clip.sourceInUs;
    const windowStart = clip.startUs - transition.durationUs;
    const direction = clip.reversed === true ? -1 : 1;
    if (direction === 1) {
      // The incoming clip's window starts one transition length before its in-point. Before the
      // in-point there are only handle frames: a clip with no handle holds its first frame, and the
      // window ends on the in-point frame, so the cut does not jump back to the first frame.
      return Math.max(
        0,
        clip.sourceInUs - transition.durationUs * rate + (playheadUs - windowStart) * rate,
      );
    }
    // A reversed clip plays downward from `sourceInUs`, so its window runs the other way: it starts
    // one transition length above the in-point and comes down to it at the cut.
    return clip.sourceInUs + Math.round((clip.startUs - playheadUs) * rate);
  }
  if (playheadUs < clip.startUs) return clip.sourceInUs;
  if (playheadUs >= clip.startUs + clip.durationUs) {
    const rate = normalizePlaybackRate(clip.playbackRate);
    if (rate === 0) return clip.sourceInUs;
    const direction = clip.reversed === true ? -1 : 1;
    return clip.sourceInUs + Math.max(0, Math.round((clip.durationUs - 1) * rate)) * direction;
  }
  return sourceTimeAtVideoClipTime(clip, playheadUs);
}
