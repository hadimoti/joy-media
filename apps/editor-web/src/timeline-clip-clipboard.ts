import type { CommandTransaction } from '@joy-media/commands';
import type {
  AssetRecordV1,
  Clip,
  Composition,
  JoyProjectV1,
  SpikeProject,
} from '@joy-media/project-schema';
import {
  buildTimelineDeletePlan,
  type TimelineDeleteTrackState,
} from './delete-timeline-elements.js';
import { readClipMediaKindMap, readClipObjectMap } from './sticker-bindings.js';
import type { TimelineMediaPlacement } from './timeline-media-placement.js';
import {
  readTimelineElementKindMap,
  timelineElementKindForClip,
  type TimelineElementKindMap,
} from './timeline-element-kind.js';
import { sortTracksForTimelineDisplay } from './timeline-track-family.js';
import { timelineTrackKind, type TimelineTrackKind } from './timeline-track-kind.js';

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
 * Builds the clipboard for the selected clips without touching the module
 * clipboard. Linked audio/video pairs: the document model has no link field
 * on clips (no `linked`/partner id exists in the schema), so each copied clip
 * is independent. If a link field is ever added, the partner must be copied
 * here too and pasted under one new shared link id.
 */
function clipboardFromSelection(
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

  return { items };
}

/**
 * Copies the currently selected clips from the given composition to clipboard.
 * Preserves the original track ID and the relative temporal offset between clips.
 */
export function copyTimelineClips(
  composition: Composition,
  selectedClipIds: readonly string[],
): TimelineClipClipboardData | undefined {
  const data = clipboardFromSelection(composition, selectedClipIds);
  if (data !== undefined) activeClipboard = data;
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
 * Cuts the selected clips: validates the removal first, then copies them to the
 * clipboard and builds one compound transaction using existing removeClip
 * commands. A refused cut (locked track, unknown id) leaves the clipboard as it was.
 */
export function buildTimelineCutPlan(input: {
  readonly composition: Composition;
  readonly selectedClipIds: readonly string[];
  readonly tracks?: readonly TimelineDeleteTrackState[];
}): TimelineCutPlan {
  if (input.selectedClipIds.length === 0) {
    return { ok: false, reason: 'Select one or more clips to cut.' };
  }

  // A track is locked when the document says so or when the panel's flags do.
  const lockedTrackIds = new Set([
    ...input.composition.tracks.filter((track) => track.locked === true).map((track) => track.id),
    ...(input.tracks ?? []).filter((track) => track.locked).map((track) => track.id),
  ]);
  const deletePlan = buildTimelineDeletePlan({
    composition: input.composition,
    selectedIds: input.selectedClipIds,
    tracks: [...lockedTrackIds].map((id) => ({ id, locked: true })),
  });
  if (!deletePlan.ok) {
    return { ok: false, reason: deletePlan.reason };
  }

  const clipboard = clipboardFromSelection(input.composition, input.selectedClipIds);
  if (!clipboard || clipboard.items.length === 0) {
    return { ok: false, reason: 'Select one or more clips to cut.' };
  }
  activeClipboard = clipboard;

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

/**
 * Every id the project already uses: timeline clips in all compositions, visual
 * objects, and the per-clip bindings. A pasted clip id must not collide with any.
 */
export function projectIdsInUse(
  timelineProject: SpikeProject,
  visualProject: JoyProjectV1,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const composition of Object.values(timelineProject.compositions)) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) ids.add(clip.id);
    }
  }
  for (const id of Object.keys(visualProject.visualObjects)) ids.add(id);
  for (const id of Object.keys(readClipObjectMap(visualProject))) ids.add(id);
  for (const id of Object.keys(readTimelineElementKindMap(visualProject))) ids.add(id);
  for (const id of Object.keys(readClipMediaKindMap(visualProject))) ids.add(id);
  return ids;
}

/** One pasted clip: the new id, the id it was copied from, and the track it lands on. */
export interface TimelinePastedClip {
  readonly clipId: string;
  readonly sourceClipId: string;
  readonly trackId: string;
  readonly clip: Clip;
}

export type TimelinePastePlan =
  | {
      readonly ok: true;
      readonly transaction: CommandTransaction;
      readonly pastedClipIds: readonly string[];
      readonly pastes: readonly TimelinePastedClip[];
    }
  | { readonly ok: false; readonly reason: string };

export interface TimelinePasteInput {
  readonly composition: Composition;
  readonly clipboard?: TimelineClipClipboardData;
  readonly playheadUs: number;
  readonly tracks?: readonly TimelineDeleteTrackState[];
  /** Element kinds of the project, used to find the kind of each track. */
  readonly elementKinds?: TimelineElementKindMap;
  /**
   * Ids already used anywhere in the project (clips, visual objects, bindings).
   * A pasted id must avoid these and the `media-controller-<id>` object id too.
   */
  readonly reservedIds?: ReadonlySet<string>;
  readonly idGenerator?: (originalId: string, index: number) => string;
}

interface Interval {
  readonly startUs: number;
  readonly endUs: number;
}

function overlapsAny(interval: Interval, intervals: readonly Interval[]): boolean {
  return intervals.some(
    (other) => interval.startUs < other.endUs && interval.endUs > other.startUs,
  );
}

/**
 * Pastes clips at the playhead, preserving their spacing and their relative tracks.
 *
 * Each source track's clips go to one target track together: the source track
 * itself when it is unlocked and free for the whole group at the paste time,
 * otherwise the first unlocked track of the same kind (in display order) that is
 * free for the group. A group with no such track refuses the whole paste.
 * Built from existing insert commands as one undo step.
 */
export function buildTimelinePastePlan(input: TimelinePasteInput): TimelinePastePlan {
  const clipboard = input.clipboard ?? getTimelineClipClipboard();
  if (!clipboard || clipboard.items.length === 0) {
    return { ok: false, reason: 'Nothing on the clipboard to paste.' };
  }

  const elementKinds = input.elementKinds ?? {};
  const trackById = new Map(input.composition.tracks.map((t) => [t.id, t]));
  const trackStateMap = new Map((input.tracks ?? []).map((t) => [t.id, t]));
  const isLocked = (trackId: string): boolean =>
    trackById.get(trackId)?.locked === true || trackStateMap.get(trackId)?.locked === true;

  const basePlayheadUs = Math.max(0, Math.round(input.playheadUs));

  // Occupied time per track: existing clips first, then every clip planned so far.
  const occupied = new Map<string, Interval[]>();
  for (const track of input.composition.tracks) {
    occupied.set(
      track.id,
      track.clips.map((clip) => ({ startUs: clip.startUs, endUs: clip.startUs + clip.durationUs })),
    );
  }

  // Group the clipboard by source track, keeping the order the items were copied in.
  const groupOrder: string[] = [];
  const groups = new Map<string, TimelineClipClipboardData['items'][number][]>();
  for (const item of clipboard.items) {
    const group = groups.get(item.trackId);
    if (group === undefined) {
      groupOrder.push(item.trackId);
      groups.set(item.trackId, [item]);
    } else {
      group.push(item);
    }
  }

  const sourceKind = (sourceTrackId: string): TimelineTrackKind | undefined => {
    const track = trackById.get(sourceTrackId);
    return track === undefined ? undefined : timelineTrackKind(track, elementKinds);
  };
  const displayTracks = sortTracksForTimelineDisplay(input.composition.tracks, elementKinds);

  const targetByGroup = new Map<string, string>();
  for (const sourceTrackId of groupOrder) {
    const group = groups.get(sourceTrackId)!;
    const fallbackKind = timelineElementKindForClip(group[0]!.clip, elementKinds);
    const kind: TimelineTrackKind = sourceKind(sourceTrackId) ?? fallbackKind;
    const intervals = group.map((item) => ({
      startUs: basePlayheadUs + item.offsetUs,
      endUs: basePlayheadUs + item.offsetUs + item.clip.durationUs,
    }));

    // The source track first, then the other tracks of the same kind in display order.
    const candidates = [
      ...(trackById.has(sourceTrackId) ? [sourceTrackId] : []),
      ...displayTracks
        .filter(
          (track) => track.id !== sourceTrackId && timelineTrackKind(track, elementKinds) === kind,
        )
        .map((track) => track.id),
    ];

    const target = candidates.find(
      (trackId) =>
        !isLocked(trackId) &&
        !intervals.some((interval) => overlapsAny(interval, occupied.get(trackId) ?? [])),
    );
    if (target === undefined) {
      return {
        ok: false,
        reason: `No unlocked ${kind} track is free at the playhead for the copied clips.`,
      };
    }
    targetByGroup.set(sourceTrackId, target);
    occupied.set(target, [...(occupied.get(target) ?? []), ...intervals]);
  }

  // Ids: unique against the project and against each other (loop until free).
  const taken = new Set<string>(input.reservedIds ?? []);
  for (const track of input.composition.tracks) {
    for (const clip of track.clips) taken.add(clip.id);
  }
  const isTaken = (id: string): boolean => taken.has(id) || taken.has(`media-controller-${id}`);
  const defaultIdGen = (orig: string, idx: number) => `${orig}-pasted-${Date.now()}-${idx}`;
  const idGen = input.idGenerator ?? defaultIdGen;
  const uniqueId = (orig: string, idx: number): string => {
    const base = idGen(orig, idx);
    let candidate = base;
    for (let suffix = 2; isTaken(candidate); suffix++) candidate = `${base}-${suffix}`;
    taken.add(candidate);
    taken.add(`media-controller-${candidate}`);
    return candidate;
  };

  const pastes: TimelinePastedClip[] = clipboard.items.map((item, index) => {
    const clipId = uniqueId(item.clip.id, index);
    return {
      clipId,
      sourceClipId: item.clip.id,
      trackId: targetByGroup.get(item.trackId)!,
      clip: {
        ...item.clip,
        id: clipId,
        startUs: basePlayheadUs + item.offsetUs,
      },
    };
  });

  return {
    ok: true,
    pastedClipIds: pastes.map((paste) => paste.clipId),
    pastes,
    transaction: {
      label: `Paste ${pastes.length} clip${pastes.length === 1 ? '' : 's'}`,
      commands: pastes.map(({ trackId, clip }) => ({
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

/**
 * Media placements for pasted image, video and audio clips. Each one rebinds the
 * clip to a fresh media controller exactly as an import does. Clips whose asset is
 * missing or of another kind (for example a text or adjustment clip) get no media
 * placement; their clip-object binding is copied by the Duplicate path instead.
 */
export function timelinePastePlacements(
  pastes: readonly TimelinePastedClip[],
  assets: Readonly<Record<string, AssetRecordV1>>,
  frame: { readonly width: number; readonly height: number },
): readonly TimelineMediaPlacement[] {
  const placements: TimelineMediaPlacement[] = [];
  for (const paste of pastes) {
    if (paste.clip.kind !== 'video') continue;
    const asset = assets[paste.clip.assetId];
    if (asset === undefined || asset.kind === 'lut' || asset.kind === 'other') continue;
    placements.push({
      asset: {
        id: asset.id,
        kind: asset.kind,
        displayName: asset.displayName,
        ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
        ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
        // Same fallback as an import, so the asset keeps the descriptor the import wrote.
        descriptor: asset.descriptor ?? { mimeType: 'application/octet-stream' },
        ...(asset.generationProvenance === undefined
          ? {}
          : { generationProvenance: asset.generationProvenance }),
      },
      clipId: paste.clipId,
      frame,
    });
  }
  return placements;
}
