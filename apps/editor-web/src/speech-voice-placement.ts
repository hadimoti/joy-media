import type { CommandTransaction } from '@joy-media/commands';
import type { Composition } from '@joy-media/project-schema';
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
  return Math.max(0, capturedStartUs - captionStartUs);
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
