import type { CommandTransaction } from '@joy-media/commands';
import type { Clip } from '@joy-media/project-schema';

export const TIMELINE_KEYBOARD_NUDGE_US = 100_000;

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
        type: 'timeline.removeClip',
        payload: {
          compositionId: input.compositionId,
          trackId: input.sourceTrackId,
          clipId: input.clip.id,
        },
      },
      {
        type: 'timeline.insertClip',
        payload: {
          compositionId: input.compositionId,
          trackId: input.targetTrackId,
          clip: { ...input.clip, startUs: newStartUs },
        },
      },
    ],
  };
}
