/**
 * Display-only strips for the audio of video clips, drawn on the A1 lane.
 *
 * Pure: it reads clip spans and never writes the document, so the project
 * model and the export are untouched. A video clip contributes a strip only
 * when its asset is known to have an audio stream; an unknown answer draws
 * nothing. Where the A1 lane already holds a real audio clip, the real clip
 * wins and the strip is cut out for that span.
 */

export interface LinkedAudioSourceClip {
  readonly clipId: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly durationUs: number;
}

export interface LinkedAudioLaneSpan {
  readonly startUs: number;
  readonly durationUs: number;
}

export interface LinkedAudioStrip {
  readonly clipId: string;
  readonly assetId: string;
  readonly startUs: number;
  readonly endUs: number;
}

export interface LinkedAudioInput {
  /** Video clips on visual tracks, in any order. */
  readonly videoClips: readonly LinkedAudioSourceClip[];
  /** Real clips already on the A1 lane; these take precedence. */
  readonly a1Clips: readonly LinkedAudioLaneSpan[];
  /** `true` only when the asset is known to carry an audio stream. */
  readonly hasAudioStream: (assetId: string) => boolean | undefined;
}

function isUsableSpan(startUs: number, durationUs: number): boolean {
  return Number.isFinite(startUs) && Number.isFinite(durationUs) && durationUs > 0;
}

/** Parts of [startUs, endUs) that no covering span touches. */
function uncoveredParts(
  startUs: number,
  endUs: number,
  covers: readonly (readonly [number, number])[],
): (readonly [number, number])[] {
  const parts: (readonly [number, number])[] = [];
  let cursorUs = startUs;
  for (const [coverStartUs, coverEndUs] of covers) {
    if (coverEndUs <= cursorUs) continue;
    if (coverStartUs >= endUs) break;
    if (coverStartUs > cursorUs) parts.push([cursorUs, coverStartUs]);
    cursorUs = Math.max(cursorUs, coverEndUs);
    if (cursorUs >= endUs) break;
  }
  if (cursorUs < endUs) parts.push([cursorUs, endUs]);
  return parts;
}

export function linkedAudioStrips(input: LinkedAudioInput): readonly LinkedAudioStrip[] {
  const covers = input.a1Clips
    .filter((clip) => isUsableSpan(clip.startUs, clip.durationUs))
    .map((clip) => [clip.startUs, clip.startUs + clip.durationUs] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const strips: LinkedAudioStrip[] = [];
  const sources = input.videoClips
    .filter((clip) => isUsableSpan(clip.startUs, clip.durationUs))
    .filter((clip) => input.hasAudioStream(clip.assetId) === true)
    .sort((left, right) => left.startUs - right.startUs || left.clipId.localeCompare(right.clipId));

  for (const clip of sources) {
    const endUs = clip.startUs + clip.durationUs;
    for (const [partStartUs, partEndUs] of uncoveredParts(clip.startUs, endUs, covers)) {
      strips.push({
        clipId: clip.clipId,
        assetId: clip.assetId,
        startUs: partStartUs,
        endUs: partEndUs,
      });
    }
  }
  return strips;
}
