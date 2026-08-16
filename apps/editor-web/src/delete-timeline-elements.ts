import type { CommandTransaction } from '@joy-media/commands';
import type { Composition } from '@joy-media/project-schema';

export interface TimelineDeleteTrackState {
  readonly id: string;
  readonly locked: boolean;
}

export type TimelineDeletePlan =
  | {
      readonly ok: true;
      readonly transaction: CommandTransaction;
      readonly clipIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Builds one non-ripple transaction for the complete selection. The command
 * layer computes the inverse for every remove command, so EditorSession can
 * undo the entire batch as one compound history entry.
 */
export function buildTimelineDeletePlan(input: {
  readonly composition: Composition;
  readonly selectedIds: readonly string[];
  readonly tracks?: readonly TimelineDeleteTrackState[];
}): TimelineDeletePlan {
  const selected = new Set(input.selectedIds);
  if (selected.size === 0) return { ok: false, reason: 'Select one or more timeline elements.' };

  const trackViews = new Map((input.tracks ?? []).map((track) => [track.id, track]));
  const entries = input.composition.tracks.flatMap((track) =>
    track.clips.filter((clip) => selected.has(clip.id)).map((clip) => ({ clip, track })),
  );
  if (entries.length !== selected.size) {
    const missing = [...selected].filter((id) => !entries.some((entry) => entry.clip.id === id));
    return {
      ok: false,
      reason: `Some selected timeline elements are unavailable: ${missing.join(', ')}`,
    };
  }

  const locked = entries.find((entry) => trackViews.get(entry.track.id)?.locked === true);
  if (locked !== undefined) {
    return { ok: false, reason: `Unlock ${locked.track.id} before deleting the selection.` };
  }

  const ordered = [...entries].sort(
    (left, right) =>
      right.track.order - left.track.order ||
      left.clip.startUs - right.clip.startUs ||
      left.clip.id.localeCompare(right.clip.id),
  );
  return {
    ok: true,
    clipIds: ordered.map((entry) => entry.clip.id),
    transaction: {
      label: `Delete ${ordered.length} timeline element${ordered.length === 1 ? '' : 's'}`,
      commands: ordered.map(({ clip, track }) => ({
        type: 'timeline.removeClip' as const,
        payload: { compositionId: input.composition.id, trackId: track.id, clipId: clip.id },
      })),
    },
  };
}
