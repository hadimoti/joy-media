import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, Composition } from '@joy-media/project-schema';
import {
  buildTimelineDeletePlan,
  type TimelineDeleteTrackState,
} from './delete-timeline-elements.js';

export interface TimelineClipboardClip {
  readonly trackId: string;
  readonly clip: Clip;
  readonly offsetUs: number; // Offset relative to the earliest clip in the selection
}

export interface TimelineClipClipboardData {
  readonly items: readonly TimelineClipboardClip[];
}

let activeClipboard: TimelineClipClipboardData | undefined;

/**
 * Copies the currently selected clips from the given composition to clipboard.
 * Preserves the original track ID and the relative temporal offset between clips.
 */
export function copyTimelineClips(
  composition: Composition,
  selectedClipIds: readonly string[],
): TimelineClipClipboardData | undefined {
  if (selectedClipIds.length === 0) return undefined;
  const selectedSet = new Set(selectedClipIds);

  const matched: { trackId: string; clip: Clip }[] = [];
  for (const track of composition.tracks) {
    for (const clip of track.clips) {
      if (selectedSet.has(clip.id)) {
        matched.push({ trackId: track.id, clip });
      }
    }
  }

  if (matched.length === 0) return undefined;

  const minStartUs = Math.min(...matched.map((m) => m.clip.startUs));
  const items: TimelineClipboardClip[] = matched.map((m) => ({
    trackId: m.trackId,
    clip: JSON.parse(JSON.stringify(m.clip)) as Clip,
    offsetUs: m.clip.startUs - minStartUs,
  }));

  const data: TimelineClipClipboardData = { items };
  activeClipboard = data;
  return data;
}

export function getTimelineClipClipboard(): TimelineClipClipboardData | undefined {
  return activeClipboard;
}

export function setTimelineClipClipboard(data: TimelineClipClipboardData | undefined): void {
  activeClipboard = data;
}

export function clearTimelineClipClipboard(): void {
  activeClipboard = undefined;
}

export type TimelineCutPlan =
  | {
      readonly ok: true;
      readonly clipboard: TimelineClipClipboardData;
      readonly transaction: CommandTransaction;
      readonly removedClipIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Cuts the selected clips: copies them to clipboard and builds one compound
 * transaction using existing removeClip commands to remove them in one undo step.
 */
export function buildTimelineCutPlan(input: {
  readonly composition: Composition;
  readonly selectedClipIds: readonly string[];
  readonly tracks?: readonly TimelineDeleteTrackState[];
}): TimelineCutPlan {
  const clipboard = copyTimelineClips(input.composition, input.selectedClipIds);
  if (!clipboard || clipboard.items.length === 0) {
    return { ok: false, reason: 'Select one or more clips to cut.' };
  }

  const deletePlan = buildTimelineDeletePlan({
    composition: input.composition,
    selectedIds: input.selectedClipIds,
    ...(input.tracks === undefined ? {} : { tracks: input.tracks }),
  });

  if (!deletePlan.ok) {
    return { ok: false, reason: deletePlan.reason };
  }

  return {
    ok: true,
    clipboard,
    transaction: {
      label: `Cut ${clipboard.items.length} clip${clipboard.items.length === 1 ? '' : 's'}`,
      commands: deletePlan.transaction.commands,
    },
    removedClipIds: deletePlan.clipIds,
  };
}

export type TimelinePastePlan =
  | {
      readonly ok: true;
      readonly transaction: CommandTransaction;
      readonly pastedClipIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Pastes clips from clipboard at the current playhead position on the same tracks.
 * Spacing between clips is preserved. Built from existing insert commands as one undo step.
 */
export function buildTimelinePastePlan(input: {
  readonly composition: Composition;
  readonly clipboard?: TimelineClipClipboardData;
  readonly playheadUs: number;
  readonly tracks?: readonly TimelineDeleteTrackState[];
  readonly idGenerator?: (originalId: string, index: number) => string;
}): TimelinePastePlan {
  const clipboard = input.clipboard ?? getTimelineClipClipboard();
  if (!clipboard || clipboard.items.length === 0) {
    return { ok: false, reason: 'Nothing on the clipboard to paste.' };
  }

  const trackMap = new Map(input.composition.tracks.map((t) => [t.id, t]));
  const trackStateMap = new Map((input.tracks ?? []).map((t) => [t.id, t]));

  // Verify tracks exist and are unlocked
  for (const item of clipboard.items) {
    const track = trackMap.get(item.trackId);
    if (!track) {
      return { ok: false, reason: `Target track "${item.trackId}" no longer exists.` };
    }
    if (track.locked === true || trackStateMap.get(item.trackId)?.locked === true) {
      return { ok: false, reason: `Unlock track "${item.trackId}" before pasting.` };
    }
  }

  const basePlayheadUs = Math.max(0, Math.round(input.playheadUs));
  const defaultIdGen = (orig: string, idx: number) => `${orig}-pasted-${Date.now()}-${idx}`;
  const idGen = input.idGenerator ?? defaultIdGen;

  const plannedClips: { trackId: string; clip: Clip }[] = [];
  const pastedClipIds: string[] = [];

  for (let i = 0; i < clipboard.items.length; i++) {
    const item = clipboard.items[i]!;
    const newStartUs = basePlayheadUs + item.offsetUs;
    const newId = idGen(item.clip.id, i);
    const newClip: Clip = {
      ...item.clip,
      id: newId,
      startUs: newStartUs,
    };
    plannedClips.push({ trackId: item.trackId, clip: newClip });
    pastedClipIds.push(newId);
  }

  // Check for overlaps with existing clips or between pasted clips on the same track
  for (const { trackId, clip } of plannedClips) {
    const track = trackMap.get(trackId)!;
    const clipEndUs = clip.startUs + clip.durationUs;

    for (const existing of track.clips) {
      const existingEndUs = existing.startUs + existing.durationUs;
      if (clip.startUs < existingEndUs && clipEndUs > existing.startUs) {
        return {
          ok: false,
          reason: `Pasting would overlap existing media on track "${track.id}".`,
        };
      }
    }

    for (const other of plannedClips) {
      if (other.clip === clip || other.trackId !== trackId) continue;
      const otherEndUs = other.clip.startUs + other.clip.durationUs;
      if (clip.startUs < otherEndUs && clipEndUs > other.clip.startUs) {
        return {
          ok: false,
          reason: `Pasting would cause overlapping clips on track "${trackId}".`,
        };
      }
    }
  }

  return {
    ok: true,
    pastedClipIds,
    transaction: {
      label: `Paste ${plannedClips.length} clip${plannedClips.length === 1 ? '' : 's'}`,
      commands: plannedClips.map(({ trackId, clip }) => ({
        type: 'timeline.insertClip' as const,
        payload: {
          compositionId: input.composition.id,
          trackId,
          clip,
        },
      })),
    },
  };
}
