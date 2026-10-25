import type { TimelineElementKind, UniversalTimelineSource } from '@joy-media/project-schema';

export interface TimelineElementBindingPlacement {
  readonly id: string;
  readonly compositionId: string;
  readonly trackId: string;
  readonly elementKind: TimelineElementKind;
  readonly startUs: number;
  readonly durationUs: number;
  readonly source: UniversalTimelineSource;
  readonly sourceInUs?: number;
}

/** Pure projection from the editor's planned clip placement to its binding. */
export function createTimelineElementBindingPlacement(input: {
  readonly clipId: string;
  readonly compositionId: string;
  readonly trackId: string;
  readonly elementKind: TimelineElementKind;
  readonly startUs: number;
  readonly durationUs: number;
  readonly source: UniversalTimelineSource;
  readonly sourceInUs?: number;
}): TimelineElementBindingPlacement {
  return {
    id: input.clipId,
    compositionId: input.compositionId,
    trackId: input.trackId,
    elementKind: input.elementKind,
    startUs: input.startUs,
    durationUs: input.durationUs,
    source: input.source,
    ...(input.sourceInUs === undefined ? {} : { sourceInUs: input.sourceInUs }),
  };
}
