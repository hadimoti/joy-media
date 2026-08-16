import type { CommandTransaction } from '@joy-media/commands';
import type { Clip } from '@joy-media/project-schema';

export const TIMELINE_KEYBOARD_NUDGE_US = 100_000;

/** Pointer movement activation for clip drags; both axes count. */
export function hasExceededDragThreshold(deltaX: number, deltaY: number, thresholdPx = 4): boolean {
  return Math.hypot(deltaX, deltaY) >= thresholdPx;
}

export function keyboardTrimTimeUs(input: {
  readonly clip: Clip;
  readonly edge: 'start' | 'end';
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly timelineDurationUs: number;
}): number | undefined {
  if (input.key !== 'ArrowLeft' && input.key !== 'ArrowRight') return undefined;
  const direction = input.key === 'ArrowLeft' ? -1 : 1;
  const delta = TIMELINE_KEYBOARD_NUDGE_US * (input.shiftKey ? 10 : 1) * direction;
  const clipEndUs = input.clip.startUs + input.clip.durationUs;

  if (input.edge === 'start') {
    return Math.min(
      clipEndUs - TIMELINE_KEYBOARD_NUDGE_US,
      Math.max(0, input.clip.startUs + delta),
    );
  }

  return Math.min(
    Math.max(input.timelineDurationUs, clipEndUs),
    Math.max(input.clip.startUs + TIMELINE_KEYBOARD_NUDGE_US, clipEndUs + delta),
  );
}

export function buildTimelineClipMoveTransaction(input: {
  readonly compositionId: string;
  readonly sourceTrackId: string;
  readonly targetTrackId: string;
  readonly clip: Clip;
  readonly targetClips: readonly Clip[];
  readonly newStartUs: number;
}): CommandTransaction | undefined {
  const newStartUs = Math.max(0, Math.round(input.newStartUs));
  const newEndUs = newStartUs + input.clip.durationUs;
  const overlaps = input.targetClips.some((candidate) => {
    if (input.sourceTrackId === input.targetTrackId && candidate.id === input.clip.id) return false;
    const candidateEndUs = candidate.startUs + candidate.durationUs;
    return newStartUs < candidateEndUs && newEndUs > candidate.startUs;
  });
  if (overlaps) return undefined;

  if (input.sourceTrackId === input.targetTrackId) {
    return {
      label: `Move ${input.clip.id}`,
      commands: [
        {
          type: 'timeline.moveClip',
          payload: {
            compositionId: input.compositionId,
            trackId: input.sourceTrackId,
            clipId: input.clip.id,
            newStartUs,
          },
        },
      ],
    };
  }

  return {
    label: `Move ${input.clip.id} to ${input.targetTrackId}`,
    commands: [
      {
        type: 'timeline.moveElement',
        payload: {
          compositionId: input.compositionId,
          sourceTrackId: input.sourceTrackId,
          targetTrackId: input.targetTrackId,
          clipId: input.clip.id,
          newStartUs,
        },
      },
    ],
  };
}

/** Build one undoable command for a multi-selection drag. */
export function buildTimelineClipGroupMoveTransaction(input: {
  readonly compositionId: string;
  readonly moves: readonly {
    readonly sourceTrackId: string;
    readonly targetTrackId: string;
    readonly clipId: string;
    readonly newStartUs: number;
  }[];
}): CommandTransaction | undefined {
  if (input.moves.length < 2) return undefined;
  const clipIds = new Set<string>();
  const moves: {
    compositionId: string;
    sourceTrackId: string;
    targetTrackId: string;
    clipId: string;
    newStartUs: number;
  }[] = [];
  for (const move of input.moves) {
    if (clipIds.has(move.clipId)) return undefined;
    clipIds.add(move.clipId);
    moves.push({
      compositionId: input.compositionId,
      sourceTrackId: move.sourceTrackId,
      targetTrackId: move.targetTrackId,
      clipId: move.clipId,
      newStartUs: Math.max(0, Math.round(move.newStartUs)),
    });
  }
  return {
    label: `Move ${moves.length} selected clips`,
    commands: [
      {
        type: 'timeline.moveElements',
        payload: { compositionId: input.compositionId, moves },
      },
    ],
  };
}
