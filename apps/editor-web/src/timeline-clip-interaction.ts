import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, Composition } from '@joy-media/project-schema';

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

/** Build one undoable transaction that inserts media and shifts later clips. */
export function buildTimelineClipInsertTransaction(input: {
  readonly composition: Composition;
  readonly trackId: string;
  readonly asset: {
    readonly assetId: string;
    readonly displayName: string;
    readonly durationUs: number;
  };
  readonly clipId: string;
  readonly startUs: number;
}): CommandTransaction | undefined {
  const track = input.composition.tracks.find((candidate) => candidate.id === input.trackId);
  const startUs = Math.round(input.startUs);
  const durationUs = input.asset.durationUs;
  if (
    track === undefined ||
    track.locked === true ||
    input.asset.assetId.length === 0 ||
    input.clipId.length === 0 ||
    !Number.isSafeInteger(startUs) ||
    startUs < 0 ||
    !Number.isSafeInteger(durationUs) ||
    durationUs <= 0 ||
    input.composition.tracks.some((candidate) =>
      candidate.clips.some((clip) => clip.id === input.clipId),
    ) ||
    track.clips.some((clip) => clip.startUs < startUs && clip.startUs + clip.durationUs > startUs)
  ) {
    return undefined;
  }

  const commands: CommandTransaction['commands'][number][] = track.clips
    .filter((clip) => clip.startUs >= startUs)
    .sort((left, right) => right.startUs - left.startUs)
    .map((clip) => ({
      type: 'timeline.moveClip',
      payload: {
        compositionId: input.composition.id,
        trackId: input.trackId,
        clipId: clip.id,
        newStartUs: clip.startUs + durationUs,
      },
    }));
  commands.push({
    type: 'timeline.insertClip',
    payload: {
      compositionId: input.composition.id,
      trackId: input.trackId,
      clip: {
        id: input.clipId,
        kind: 'video',
        assetId: input.asset.assetId,
        startUs,
        durationUs,
        sourceInUs: 0,
      },
    },
  });

  return { label: `Insert ${input.asset.displayName}`, commands };
}

/** Repoint an existing video clip at another media asset without changing its range. */
export function buildTimelineClipReplaceTransaction(input: {
  readonly composition: Composition;
  readonly trackId: string;
  readonly clip: Clip;
  readonly assetId: string;
  readonly displayName: string;
}): CommandTransaction | undefined {
  const track = input.composition.tracks.find((candidate) => candidate.id === input.trackId);
  if (
    track === undefined ||
    track.locked === true ||
    input.clip.kind !== 'video' ||
    input.assetId.length === 0 ||
    input.assetId === input.clip.assetId ||
    !track.clips.some((candidate) => candidate.id === input.clip.id)
  ) {
    return undefined;
  }

  return {
    label: `Replace with ${input.displayName}`,
    commands: [
      {
        type: 'timeline.setClipAsset',
        payload: {
          compositionId: input.composition.id,
          trackId: input.trackId,
          clipId: input.clip.id,
          assetId: input.assetId,
        },
      },
    ],
  };
}
