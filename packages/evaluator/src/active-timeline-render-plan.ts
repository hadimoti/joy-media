import {
  normalizeUniversalTimeline,
  sourceTimeAtVideoClipTime,
  type Clip,
  type JoyProjectV1,
  type SpikeProject,
  type TimeUs,
  type TimelineElementKind,
  type UniversalTimelineItem,
  type VideoClip,
} from '@joy-media/project-schema';

export interface ActiveTimelineRenderItem extends UniversalTimelineItem {
  /** Persisted track order (ascending is bottom-to-top). */
  readonly trackOrder: number;
  /** Stable order for overlapping items on the same track. */
  readonly withinTrackOrder: number;
  /** Higher values render later/on top. */
  readonly zIndex: number;
  readonly objectId?: string;
  readonly assetId?: string;
}

export interface ActiveTimelineRenderPlan {
  readonly compositionId: string;
  readonly timeUs: TimeUs;
  readonly items: readonly ActiveTimelineRenderItem[];
  readonly diagnostics: readonly string[];
}

export interface ActiveTimelineRenderPlanOptions {
  readonly elementKindByClipId?: Readonly<Record<string, TimelineElementKind>>;
  readonly objectIdByClipId?: Readonly<Record<string, string>>;
}

/**
 * Pure active-layer projection shared by monitor/export adapters. Legacy
 * schema-0 clips remain readable; element capabilities are supplied by the
 * caller rather than inferred from track names or asset IDs.
 */
export function buildActiveTimelineRenderPlan(
  project: SpikeProject | JoyProjectV1,
  timeUs: TimeUs,
  options: ActiveTimelineRenderPlanOptions = {},
): ActiveTimelineRenderPlan {
  if (project.schemaVersion === 1) return buildV1Plan(project, timeUs, options);
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined)
    return {
      compositionId: project.rootCompositionId,
      timeUs,
      items: [],
      diagnostics: [`Missing root composition ${project.rootCompositionId}`],
    };

  const minOrder = composition.tracks.reduce((min, track) => Math.min(min, track.order), 0);
  const diagnostics: string[] = [];
  const items: ActiveTimelineRenderItem[] = [];
  for (const track of [...composition.tracks].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  )) {
    // Audio belongs to the mixer, never the visual compositor.  Older projects
    // may not yet carry `family`, so the item-level explicit kind below remains
    // the compatibility fallback.
    if (!track.enabled || track.family === 'audio') continue;
    const withinTrack = [...track.clips].sort(
      (a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id),
    );
    withinTrack.forEach((clip, withinTrackOrder) => {
      if (timeUs < clip.startUs || timeUs >= clip.startUs + clip.durationUs) return;
      const item = itemFromClip(
        clip,
        composition.id,
        track.id,
        track.order,
        minOrder,
        withinTrackOrder,
        options,
      );
      if (item === undefined) diagnostics.push(`Unsupported active clip ${clip.id}`);
      else if (item.elementKind === 'audio') return;
      else items.push(item);
    });
  }
  return {
    compositionId: composition.id,
    timeUs,
    // Lower tracks enter first; the top track is composited last.
    items: items.sort((a, b) => a.zIndex - b.zIndex || a.withinTrackOrder - b.withinTrackOrder),
    diagnostics,
  };
}

function buildV1Plan(
  project: JoyProjectV1,
  timeUs: TimeUs,
  options: ActiveTimelineRenderPlanOptions,
): ActiveTimelineRenderPlan {
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) {
    return {
      compositionId: project.rootCompositionId,
      timeUs,
      items: [],
      diagnostics: [`Missing root composition ${project.rootCompositionId}`],
    };
  }
  const normalized = normalizeUniversalTimeline(project);
  const diagnostics = normalized.diagnostics.map(
    (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
  );
  const orders = [...new Set(normalized.items.map((item) => item.trackOrder))].sort(
    (a, b) => a - b,
  );
  const orderIndex = new Map(orders.map((order, index) => [order, index]));
  const items: ActiveTimelineRenderItem[] = [];
  for (const item of normalized.items) {
    // A project may contain nested compositions. The root render plan owns
    // only the root composition's timeline items; child compositions are
    // resolved by their parent composition renderer and must not leak into
    // the root at their own local timestamps.
    if (item.compositionId !== composition.id) continue;
    const track = composition.tracks.find((candidate) => candidate.id === item.trackId);
    if (!item.trackEnabled || track?.family === 'audio' || track?.kind === 'audio') continue;
    if (timeUs < item.startUs || timeUs >= item.startUs + item.durationUs) continue;
    const elementKind = options.elementKindByClipId?.[item.id] ?? item.elementKind;
    if (elementKind === 'audio') continue;
    const zIndex = (orderIndex.get(item.trackOrder) ?? 0) + 1;
    items.push({
      ...item,
      elementKind,
      zIndex,
      ...(item.source.kind === 'object' ? { objectId: item.source.id } : {}),
      ...(item.source.kind === 'asset' ? { assetId: item.source.id } : {}),
      ...(options.objectIdByClipId?.[item.id] === undefined
        ? {}
        : { objectId: options.objectIdByClipId[item.id] }),
    });
  }
  return {
    compositionId: composition.id,
    timeUs,
    items: items.sort(
      (left, right) => left.zIndex - right.zIndex || left.withinTrackOrder - right.withinTrackOrder,
    ),
    diagnostics,
  };
}

function itemFromClip(
  clip: Clip,
  compositionId: string,
  trackId: string,
  trackOrder: number,
  minOrder: number,
  withinTrackOrder: number,
  options: ActiveTimelineRenderPlanOptions,
): ActiveTimelineRenderItem | undefined {
  const elementKind =
    options.elementKindByClipId?.[clip.id] ?? (clip.kind === 'video' ? 'video' : 'composition');
  const objectId = options.objectIdByClipId?.[clip.id];
  const source =
    clip.kind === 'video'
      ? { kind: 'asset' as const, id: clip.assetId }
      : { kind: 'composition' as const, id: clip.compositionId };
  return {
    id: clip.id,
    compositionId,
    trackId,
    elementKind,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
    source,
    ...(clip.kind === 'video' ? { sourceInUs: sourceTimeAtVideoClipTime(clip, clip.startUs) } : {}),
    trackOrder,
    withinTrackOrder,
    zIndex: trackOrder - minOrder + 1,
    ...(objectId === undefined ? {} : { objectId }),
    ...(clip.kind === 'video' ? { assetId: clip.assetId } : {}),
  };
}

export function isVideoRenderItem(
  item: ActiveTimelineRenderItem,
): item is ActiveTimelineRenderItem & {
  readonly elementKind: 'video';
  readonly assetId: string;
} {
  return item.elementKind === 'video' && item.assetId !== undefined;
}

export type { TimelineElementKind, UniversalTimelineItem };
export type { VideoClip };
