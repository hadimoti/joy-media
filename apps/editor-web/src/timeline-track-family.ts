import type { Track, TimelineTrackFamily } from '@joy-media/project-schema';
import type { CommandTransaction } from '@joy-media/commands';
import type { TimelineElementKind, TimelineElementKindMap } from './timeline-element-kind.js';
import { timelineElementKindForClip } from './timeline-element-kind.js';

export type ProfessionalTrackFamily = TimelineTrackFamily;

/** Audio is the only timeline family that cannot be visually composited. */
export function trackFamilyForElement(kind: TimelineElementKind): ProfessionalTrackFamily {
  return kind === 'audio' ? 'audio' : 'visual';
}

/**
 * Legacy documents have no family. Derive a stable view without reading a
 * human track name; ambiguous mixed legacy rows stay visual so no renderable
 * item disappears. New rows always persist an explicit family.
 */
export function timelineTrackFamily(
  track: Pick<Track, 'family' | 'clips'>,
  elementKinds: TimelineElementKindMap = {},
): ProfessionalTrackFamily {
  if (track.family !== undefined) return track.family;
  const kinds = track.clips.map((clip) => timelineElementKindForClip(clip, elementKinds));
  return kinds.length > 0 && kinds.every((kind) => trackFamilyForElement(kind) === 'audio')
    ? 'audio'
    : 'visual';
}

export function canPlaceTimelineElement(
  kind: TimelineElementKind,
  track: Pick<Track, 'family' | 'clips'>,
  elementKinds: TimelineElementKindMap = {},
): boolean {
  return trackFamilyForElement(kind) === timelineTrackFamily(track, elementKinds);
}

/**
 * UI invariant: the first visual row is the top composited layer and all audio
 * rows follow the visual stack. Existing renderer order is bottom-to-top, so
 * visual rows intentionally display in descending `Track.order`.
 */
export function sortTracksForTimelineDisplay(
  tracks: readonly Track[],
  elementKinds: TimelineElementKindMap = {},
): readonly Track[] {
  return [...tracks].sort((left, right) => {
    const leftFamily = timelineTrackFamily(left, elementKinds);
    const rightFamily = timelineTrackFamily(right, elementKinds);
    if (leftFamily !== rightFamily) return leftFamily === 'visual' ? -1 : 1;
    return right.order - left.order || left.id.localeCompare(right.id);
  });
}

export function professionalTrackCode(family: ProfessionalTrackFamily, index: number): string {
  return `${family === 'audio' ? 'A' : 'V'}${Math.max(1, index)}`;
}

/** Allocate a durable track identifier without reusing a removed row's ID. */
export function nextProfessionalTrackId(
  tracks: readonly Pick<Track, 'id'>[],
  family: ProfessionalTrackFamily,
): string {
  const prefix = family === 'audio' ? 'A' : 'V';
  const nextIndex =
    tracks.reduce((highest, track) => {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(track.id);
      return match === null ? highest : Math.max(highest, Number(match[1]));
    }, 0) + 1;
  return `${prefix}${nextIndex}`;
}

export function professionalTrackName(
  family: ProfessionalTrackFamily,
  index: number,
  explicitName?: string,
): string {
  const name = explicitName?.trim();
  if (name !== undefined && name.length > 0) return name;
  return `${family === 'audio' ? 'Audio' : 'Visual'} ${Math.max(1, index)}`;
}

/**
 * Reorder one complete row within its family. Every changed order is emitted in
 * the same command transaction, so undo restores the whole stack in one step.
 */
export function buildTimelineTrackReorderTransaction(input: {
  readonly compositionId: string;
  readonly tracks: readonly Track[];
  readonly sourceTrackId: string;
  readonly targetTrackId: string;
  readonly elementKinds?: TimelineElementKindMap;
}): CommandTransaction | undefined {
  const elementKinds = input.elementKinds ?? {};
  const source = input.tracks.find((track) => track.id === input.sourceTrackId);
  const target = input.tracks.find((track) => track.id === input.targetTrackId);
  if (source === undefined || target === undefined || source.id === target.id) return undefined;
  const family = timelineTrackFamily(source, elementKinds);
  if (timelineTrackFamily(target, elementKinds) !== family) return undefined;

  const familyTracks = sortTracksForTimelineDisplay(input.tracks, elementKinds).filter(
    (track) => timelineTrackFamily(track, elementKinds) === family,
  );
  const sourceIndex = familyTracks.findIndex((track) => track.id === source.id);
  const targetIndex = familyTracks.findIndex((track) => track.id === target.id);
  if (sourceIndex < 0 || targetIndex < 0) return undefined;

  const next = familyTracks.filter((track) => track.id !== source.id);
  next.splice(targetIndex, 0, source);
  const availableOrders = familyTracks.map((track) => track.order).sort((a, b) => a - b);
  const commands = next.flatMap((track, displayIndex) => {
    const newOrder = availableOrders[availableOrders.length - 1 - displayIndex]!;
    return track.order === newOrder
      ? []
      : [
          {
            type: 'timeline.reorderTrack' as const,
            payload: { compositionId: input.compositionId, trackId: track.id, newOrder },
          },
        ];
  });
  if (commands.length === 0) return undefined;
  return {
    label: `Reorder ${family} layers`,
    commands,
  };
}
