import type { CommandTransaction } from '@joy-media/commands';
import type {
  Clip,
  JoyProjectV1,
  TrackV1,
  TimelineElementKind,
  UniversalTimelineItem,
  UniversalTimelineSource,
} from '@joy-media/project-schema';
import {
  normalizeUniversalTimeline,
  UNIVERSAL_TIMELINE_SCHEMA_VERSION,
} from '@joy-media/project-schema';

export interface UniversalPlacementBinding {
  readonly id: string;
  readonly compositionId: string;
  readonly trackId: string;
  readonly elementKind: TimelineElementKind;
  readonly startUs: number;
  readonly durationUs: number;
  readonly source: UniversalTimelineSource;
  readonly sourceInUs?: number;
  readonly withinTrackOrder?: number;
}

/**
 * Copy-on-write update for the universal Timeline document. Legacy bindings are
 * projected first, so adding the first new element does not discard old clips.
 */
export function upsertUniversalTimelineBinding(
  project: JoyProjectV1,
  binding: UniversalPlacementBinding,
): JoyProjectV1 {
  const normalized = normalizeUniversalTimeline(project);
  const withoutBinding = normalized.document.items.filter((item) => item.id !== binding.id);
  const trackItems = withoutBinding.filter(
    (item) => item.compositionId === binding.compositionId && item.trackId === binding.trackId,
  );
  const nextOrder =
    binding.withinTrackOrder ??
    trackItems.reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) + 1;
  const item: UniversalTimelineItem = {
    id: binding.id,
    compositionId: binding.compositionId,
    trackId: binding.trackId,
    elementKind: binding.elementKind,
    startUs: binding.startUs,
    durationUs: binding.durationUs,
    source: binding.source,
    withinTrackOrder: nextOrder,
    ...(binding.sourceInUs === undefined ? {} : { sourceInUs: binding.sourceInUs }),
  };
  return {
    ...project,
    universalTimeline: {
      schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION,
      items: [...withoutBinding, item],
    },
    updatedAt: new Date().toISOString(),
  };
}

export function removeUniversalTimelineBinding(
  project: JoyProjectV1,
  itemId: string,
): JoyProjectV1 {
  const normalized = normalizeUniversalTimeline(project);
  const items = normalized.document.items.filter((item) => item.id !== itemId);
  if (items.length === normalized.document.items.length) return project;
  return {
    ...project,
    universalTimeline: { schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION, items },
    updatedAt: new Date().toISOString(),
  };
}

/** Keeps copy-on-write bindings aligned with ordinary Timeline commands. */
export function updateUniversalTimelineForTransaction(
  project: JoyProjectV1,
  transaction: CommandTransaction,
): JoyProjectV1 {
  const normalized = normalizeUniversalTimeline(project);
  let items = [...normalized.document.items];
  let changed = false;
  for (const command of transaction.commands) {
    switch (command.type) {
      case 'timeline.moveElement': {
        const movingIds = items
          .filter(
            (item) =>
              item.id === command.payload.clipId ||
              item.id.startsWith(`${command.payload.clipId}:object:`),
          )
          .map((item) => item.id);
        const moving = items.find(
          (item) =>
            item.id === command.payload.clipId ||
            item.id.startsWith(`${command.payload.clipId}:object:`),
        );
        const targetItems = items.filter(
          (item) =>
            item.compositionId === command.payload.compositionId &&
            item.trackId === command.payload.targetTrackId &&
            item.id !== command.payload.clipId &&
            !item.id.startsWith(`${command.payload.clipId}:object:`),
        );
        const targetOrder =
          moving === undefined
            ? 0
            : targetItems.reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) +
              1;
        items = items.map((item) =>
          item.id === command.payload.clipId ||
          item.id.startsWith(`${command.payload.clipId}:object:`)
            ? {
                ...item,
                trackId: command.payload.targetTrackId,
                startUs: command.payload.newStartUs,
                ...(moving?.trackId === command.payload.targetTrackId
                  ? {}
                  : {
                      withinTrackOrder: targetOrder + Math.max(0, movingIds.indexOf(item.id)),
                    }),
              }
            : item,
        );
        changed = true;
        break;
      }
      case 'timeline.moveElements': {
        const movingClipIds = new Set(command.payload.moves.map((move) => move.clipId));
        for (const move of command.payload.moves) {
          const movingIds = items
            .filter(
              (item) => item.id === move.clipId || item.id.startsWith(`${move.clipId}:object:`),
            )
            .map((item) => item.id);
          const targetOrder =
            items
              .filter(
                (item) =>
                  item.compositionId === move.compositionId &&
                  item.trackId === move.targetTrackId &&
                  !movingClipIds.has(item.id) &&
                  ![...movingClipIds].some((id) => item.id.startsWith(`${id}:object:`)),
              )
              .reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) + 1;
          items = items.map((item) =>
            item.id === move.clipId || item.id.startsWith(`${move.clipId}:object:`)
              ? {
                  ...item,
                  trackId: move.targetTrackId,
                  startUs: move.newStartUs,
                  ...(move.sourceTrackId === move.targetTrackId
                    ? {}
                    : {
                        withinTrackOrder: targetOrder + Math.max(0, movingIds.indexOf(item.id)),
                      }),
                }
              : item,
          );
        }
        changed = true;
        break;
      }
      case 'timeline.moveClip': {
        items = items.map((item) =>
          item.id === command.payload.clipId ||
          item.id.startsWith(`${command.payload.clipId}:object:`)
            ? { ...item, startUs: command.payload.newStartUs }
            : item,
        );
        changed = true;
        break;
      }
      case 'timeline.removeClip': {
        const next = items.filter(
          (item) =>
            item.id !== command.payload.clipId &&
            !item.id.startsWith(`${command.payload.clipId}:object:`),
        );
        changed ||= next.length !== items.length;
        items = next;
        break;
      }
      case 'timeline.insertClip': {
        if (items.some((item) => item.id === command.payload.clip.id)) break;
        const trackItems = items.filter(
          (item) =>
            item.compositionId === command.payload.compositionId &&
            item.trackId === command.payload.trackId,
        );
        items.push({
          id: command.payload.clip.id,
          compositionId: command.payload.compositionId,
          trackId: command.payload.trackId,
          elementKind: command.payload.expectedFamily === 'audio' ? 'audio' : 'video',
          startUs: command.payload.clip.startUs,
          durationUs: command.payload.clip.durationUs,
          source:
            command.payload.clip.kind === 'video'
              ? { kind: 'asset', id: command.payload.clip.assetId }
              : { kind: 'composition', id: command.payload.clip.compositionId },
          ...(command.payload.clip.kind === 'video'
            ? { sourceInUs: command.payload.clip.sourceInUs }
            : {}),
          withinTrackOrder:
            trackItems.reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) + 1,
        });
        changed = true;
        break;
      }
      case 'timeline.addTrack': {
        const composition = project.compositions[command.payload.compositionId];
        if (
          composition === undefined ||
          composition.tracks.some((track) => track.id === command.payload.track.id)
        )
          break;
        const track = adaptSpikeTrack(command.payload.track);
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: [...composition.tracks, track],
            },
          },
        };
        for (const clip of track.clips) {
          if (items.some((item) => item.id === clip.id)) continue;
          const trackItems = items.filter(
            (item) =>
              item.compositionId === command.payload.compositionId && item.trackId === track.id,
          );
          items.push({
            id: clip.id,
            compositionId: command.payload.compositionId,
            trackId: track.id,
            elementKind:
              clip.kind === 'caption'
                ? 'caption'
                : clip.kind === 'composition'
                  ? 'composition'
                  : 'video',
            startUs: clip.startUs,
            durationUs: clip.durationUs,
            source:
              clip.kind === 'video'
                ? { kind: 'asset', id: clip.assetId }
                : clip.kind === 'composition'
                  ? { kind: 'composition', id: clip.compositionId }
                  : { kind: 'caption', id: clip.captionDocumentId },
            ...(clip.kind === 'video' ? { sourceInUs: clip.sourceInUs } : {}),
            withinTrackOrder:
              trackItems.reduce((highest, item) => Math.max(highest, item.withinTrackOrder), -1) +
              1,
          });
        }
        changed = true;
        break;
      }
      case 'timeline.removeTrack': {
        const composition = project.compositions[command.payload.compositionId];
        if (
          composition === undefined ||
          !composition.tracks.some((track) => track.id === command.payload.trackId)
        )
          break;
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: composition.tracks.filter((track) => track.id !== command.payload.trackId),
            },
          },
        };
        const next = items.filter(
          (item) =>
            item.compositionId !== command.payload.compositionId ||
            item.trackId !== command.payload.trackId,
        );
        changed ||= next.length !== items.length;
        items = next;
        changed = true;
        break;
      }
      case 'timeline.reorderTrack': {
        const composition = project.compositions[command.payload.compositionId];
        if (composition === undefined) break;
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: composition.tracks.map((track) =>
                track.id === command.payload.trackId
                  ? { ...track, order: command.payload.newOrder }
                  : track,
              ),
            },
          },
        };
        changed = true;
        break;
      }
      case 'timeline.reorderTracks': {
        const composition = project.compositions[command.payload.compositionId];
        if (composition === undefined) break;
        const orders = new Map(
          command.payload.orders.map((entry) => [entry.trackId, entry.newOrder]),
        );
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: composition.tracks.map((track) => {
                const order = orders.get(track.id);
                return order === undefined ? track : { ...track, order };
              }),
            },
          },
        };
        changed = true;
        break;
      }
      case 'timeline.renameTrack': {
        const composition = project.compositions[command.payload.compositionId];
        if (composition === undefined) break;
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: composition.tracks.map((track) => {
                if (track.id !== command.payload.trackId) return track;
                if (command.payload.newName === undefined) {
                  const withoutName = { ...track };
                  Reflect.deleteProperty(withoutName, 'name');
                  return withoutName;
                }
                return { ...track, name: command.payload.newName };
              }),
            },
          },
        };
        changed = true;
        break;
      }
      case 'timeline.setTrackFamily':
      case 'timeline.setTrackLocked': {
        const composition = project.compositions[command.payload.compositionId];
        if (composition === undefined) break;
        project = {
          ...project,
          compositions: {
            ...project.compositions,
            [command.payload.compositionId]: {
              ...composition,
              tracks: composition.tracks.map((track) => {
                if (track.id !== command.payload.trackId) return track;
                if (command.type === 'timeline.setTrackFamily') {
                  const next = { ...track };
                  if (command.payload.family === undefined) Reflect.deleteProperty(next, 'family');
                  else next.family = command.payload.family;
                  return next;
                }
                return { ...track, locked: command.payload.locked };
              }),
            },
          },
        };
        changed = true;
        break;
      }
      case 'timeline.setTrackLabelColor': {
        // Label color belongs to the editor deck. Keep creative tracks byte
        // stable; a deck-aware caller mirrors this metadata separately.
        changed = true;
        break;
      }
      default:
        break;
    }
  }
  if (!changed) return project;
  const deckProject = syncTrackDeckMetadata(project, transaction);
  return {
    ...deckProject,
    universalTimeline: { schemaVersion: UNIVERSAL_TIMELINE_SCHEMA_VERSION, items },
    updatedAt: new Date().toISOString(),
  };
}

function adaptSpikeTrack(track: {
  readonly id: string;
  readonly family?: 'visual' | 'audio';
  readonly name?: string;
  readonly order: number;
  readonly enabled: boolean;
  readonly locked?: boolean;
  readonly clips: readonly Clip[];
}): TrackV1 {
  return {
    id: track.id,
    kind: track.family === 'audio' ? 'audio' : 'video',
    ...(track.family === undefined ? {} : { family: track.family }),
    name: track.name ?? track.id,
    order: track.order,
    enabled: track.enabled,
    locked: track.locked === true,
    clips: track.clips.map((clip) => (clip.kind === 'composition' ? { ...clip } : { ...clip })),
  };
}

function syncTrackDeckMetadata(
  project: JoyProjectV1,
  transaction: CommandTransaction,
): JoyProjectV1 {
  const rows = [...(project.timelineTrackDeck?.rows ?? [])];
  const rowIndex = (compositionId: string, trackId: string) =>
    rows.findIndex((row) => row.compositionId === compositionId && row.trackId === trackId);
  const upsert = (
    compositionId: string,
    trackId: string,
    patch: Partial<(typeof rows)[number]>,
  ) => {
    const index = rowIndex(compositionId, trackId);
    const creative = project.compositions[compositionId]?.tracks.find(
      (track) => track.id === trackId,
    );
    const base =
      index >= 0
        ? rows[index]!
        : {
            compositionId,
            trackId,
            family: creative?.family === 'audio' ? ('audio' as const) : ('visual' as const),
            name: creative?.name ?? trackId,
            order: creative?.order ?? 0,
            enabled: creative?.enabled ?? true,
            locked: creative?.locked ?? false,
          };
    const next = { ...base, ...patch };
    if (index >= 0) rows[index] = next;
    else rows.push(next);
  };
  for (const command of transaction.commands) {
    if (command.type === 'timeline.setTrackLabelColor')
      upsert(
        command.payload.compositionId,
        command.payload.trackId,
        command.payload.labelColor === undefined ? {} : { labelColor: command.payload.labelColor },
      );
    else if (command.type === 'timeline.setTrackLocked')
      upsert(command.payload.compositionId, command.payload.trackId, {
        locked: command.payload.locked,
      });
    else if (command.type === 'timeline.setTrackFamily' && command.payload.family !== undefined)
      upsert(command.payload.compositionId, command.payload.trackId, {
        family: command.payload.family,
      });
    else if (command.type === 'timeline.renameTrack' && command.payload.newName !== undefined)
      upsert(command.payload.compositionId, command.payload.trackId, {
        name: command.payload.newName,
      });
    else if (command.type === 'timeline.reorderTracks')
      for (const entry of command.payload.orders)
        upsert(command.payload.compositionId, entry.trackId, { order: entry.newOrder });
    else if (command.type === 'timeline.addTrack') {
      const track = command.payload.track;
      upsert(command.payload.compositionId, track.id, {
        family: track.family === 'audio' ? 'audio' : 'visual',
        ...(track.name === undefined ? {} : { name: track.name }),
        order: track.order,
        enabled: track.enabled,
        locked: track.locked === true,
        ...(track.labelColor === undefined ? {} : { labelColor: track.labelColor }),
      });
    } else if (command.type === 'timeline.removeTrack') {
      const index = rowIndex(command.payload.compositionId, command.payload.trackId);
      if (index >= 0) rows.splice(index, 1);
    }
  }
  return { ...project, timelineTrackDeck: { schemaVersion: 1, rows } };
}
