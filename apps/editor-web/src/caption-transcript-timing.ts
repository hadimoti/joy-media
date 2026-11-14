import type { CaptionDocumentV1, CaptionWordV1 } from '@joy-media/project-schema';

export interface TranscriptPlacement {
  /** Where the media clip starts on the timeline, minus where the caption layer starts. */
  readonly offsetUs: number;
  /** Where the clip starts inside its source file. */
  readonly sourceInUs: number;
  /** How long the clip plays on the timeline. */
  readonly durationUs: number;
  /** Playback speed of the clip (1 = normal). A frozen clip (0) is treated as normal speed. */
  readonly playbackRate?: number;
}

/**
 * A transcript is timed from the start of the source file. The caption document is timed from the start of its
 * caption layer, so the words are moved to where the clip plays: trimmed-off speech is dropped and a sped-up clip
 * is squeezed, so each cue lands on the picture it belongs to.
 */
export function placeTranscriptOnTimeline(
  document: CaptionDocumentV1,
  placement: TranscriptPlacement,
): CaptionDocumentV1 {
  const rate =
    placement.playbackRate !== undefined && placement.playbackRate > 0 ? placement.playbackRate : 1;
  const sourceOutUs = placement.sourceInUs + placement.durationUs * rate;
  const map = (sourceUs: number): number =>
    Math.round(placement.offsetUs + (sourceUs - placement.sourceInUs) / rate);

  const words: Record<string, CaptionWordV1> = {};
  for (const [id, word] of Object.entries(document.words)) {
    if (word.endUs <= placement.sourceInUs || word.startUs >= sourceOutUs) continue;
    const startUs = map(Math.max(word.startUs, placement.sourceInUs));
    const endUs = Math.max(startUs + 1, map(Math.min(word.endUs, sourceOutUs)));
    words[id] = { ...word, startUs, endUs };
  }

  const segments = document.segments.flatMap((segment) => {
    const wordIds = segment.wordIds.filter((id) => words[id] !== undefined);
    if (wordIds.length === 0) return [];
    const kept = wordIds.map((id) => words[id]!);
    return [
      {
        ...segment,
        wordIds,
        startUs: Math.min(...kept.map((word) => word.startUs)),
        endUs: Math.max(...kept.map((word) => word.endUs)),
      },
    ];
  });

  return { ...document, words, segments };
}
