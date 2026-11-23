import type { CommandTransaction } from '@joy-media/commands';
import type { Composition, JoyProjectV1 } from '@joy-media/project-schema';
import {
  buildTimelineMediaImportTransaction,
  type TimelineMediaAsset,
} from './timeline-media-import.js';

export interface SpeechVoicePlacementArgs {
  readonly composition: Composition;
  readonly asset: TimelineMediaAsset;
  readonly playheadUs: number;
  readonly lockedTrackIds?: ReadonlySet<string>;
  readonly clipId: string;
}

/** Convert the captured Generate position into the selected caption layer's clock. */
export function speechCaptionOffsetUs(capturedStartUs: number, captionStartUs: number): number {
  if (
    !Number.isSafeInteger(capturedStartUs) ||
    capturedStartUs < 0 ||
    !Number.isSafeInteger(captionStartUs) ||
    captionStartUs < 0
  ) {
    throw new Error('The captured speech and caption start positions must be valid.');
  }
  return capturedStartUs - captionStartUs;
}

export interface SpeechCaptionPlacement {
  readonly clipStartUs: number;
  readonly clipEndUs: number;
  readonly offsetUs: number;
}

/** Extend the caption clip to cover speech while preserving its existing timeline cues. */
export function speechCaptionPlacement(
  captionStartUs: number,
  captionDurationUs: number,
  capturedStartUs: number,
  speechDurationUs: number,
): SpeechCaptionPlacement {
  if (
    !Number.isSafeInteger(captionStartUs) ||
    captionStartUs < 0 ||
    !Number.isSafeInteger(captionDurationUs) ||
    captionDurationUs <= 0 ||
    !Number.isSafeInteger(capturedStartUs) ||
    capturedStartUs < 0 ||
    !Number.isSafeInteger(speechDurationUs) ||
    speechDurationUs <= 0
  ) {
    throw new Error('The speech and caption clip ranges must be valid.');
  }
  const clipStartUs = Math.min(captionStartUs, capturedStartUs);
  const clipEndUs = Math.max(
    captionStartUs + captionDurationUs,
    capturedStartUs + speechDurationUs,
  );
  if (!Number.isSafeInteger(clipEndUs)) throw new Error('The speech end position is invalid.');
  return {
    clipStartUs,
    clipEndUs,
    offsetUs: speechCaptionOffsetUs(capturedStartUs, clipStartUs),
  };
}

/** Update the caption clip in the same visual document snapshot as its captions. */
export function withSpeechCaptionClipPlacement(
  project: JoyProjectV1,
  clipId: string,
  newStartUs: number,
  newEndUs: number,
  captionDocumentId?: string,
): JoyProjectV1 {
  if (
    !Number.isSafeInteger(newStartUs) ||
    newStartUs < 0 ||
    !Number.isSafeInteger(newEndUs) ||
    newEndUs <= newStartUs
  ) {
    throw new Error('The caption clip range must be valid.');
  }
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('The caption composition is unavailable.');
  const track = composition.tracks.find((candidate) =>
    candidate.clips.some((clip) => clip.id === clipId),
  );
  const clip = track?.clips.find((candidate) => candidate.id === clipId);
  if (track === undefined || clip?.kind !== 'caption')
    throw new Error('The caption clip is no longer available.');
  const currentEndUs = clip.startUs + clip.durationUs;
  if (newStartUs > clip.startUs || newEndUs < currentEndUs)
    throw new Error('Speech captions can only extend the caption clip.');
  const nextDocumentId = captionDocumentId ?? clip.captionDocumentId;
  if (
    newStartUs === clip.startUs &&
    newEndUs === currentEndUs &&
    nextDocumentId === clip.captionDocumentId
  )
    return project;
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    compositions: {
      ...project.compositions,
      [composition.id]: {
        ...composition,
        tracks: composition.tracks.map((candidate) =>
          candidate.id !== track.id
            ? candidate
            : {
                ...candidate,
                clips: candidate.clips.map((item) =>
                  item.id !== clipId
                    ? item
                    : item.kind === 'caption'
                      ? {
                          ...item,
                          startUs: newStartUs,
                          durationUs: newEndUs - newStartUs,
                          captionDocumentId: nextDocumentId,
                        }
                      : item,
                ),
              },
        ),
      },
    },
  };
}

/** Build a single atomic voice clip insertion after its durable audio asset exists. */
export function buildSpeechVoicePlacement({
  composition,
  asset,
  playheadUs,
  lockedTrackIds = new Set(),
  clipId,
}: SpeechVoicePlacementArgs): CommandTransaction {
  const durationUs = asset.descriptor.durationUs;
  if (
    asset.kind !== 'audio' ||
    durationUs === undefined ||
    !Number.isSafeInteger(durationUs) ||
    durationUs <= 0
  ) {
    throw new Error('Speech audio must have a validated positive duration.');
  }
  if (!Number.isSafeInteger(playheadUs) || playheadUs < 0) {
    throw new Error('The captured playhead is invalid.');
  }
  return buildTimelineMediaImportTransaction(
    composition,
    [asset],
    playheadUs,
    lockedTrackIds,
    () => clipId,
    { mode: 'first-free', startUs: playheadUs },
  );
}
