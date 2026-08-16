import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  buildRulerTicks,
  clipRateLabel,
  createCompoundCommand,
  duplicateClipCommand,
  fitPixelsPerSecond,
  freezeFrameCommand,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  pixelToTime,
  rippleDelete,
  timeToPixel,
  toggleTrackFlag,
  toggleClipReverseCommand,
  trimCommand,
  type TimelineViewport,
} from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, SpikeProject, TransitionV1, VisualObjectV1 } from '@joy-media/project-schema';
import { normalizePlaybackRate } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import type { TimelineTrackView } from '@joy-media/timeline-engine';
import {
  DuplicateIcon,
  FitWidthIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SoloIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MarkerIcon,
  TimelineMarkerIcon,
  CloseIcon,
  TimelineScriptTrackIcon,
  SelectIcon,
  TrackAddIcon,
  LayersIcon,
  ChevronLeftIcon,
} from './icons.js';
import {
  buildClipContextMenu,
  buildEmptyCanvasContextMenu,
  buildTrackHeaderContextMenu,
  buildRulerContextMenu,
  type CommandContext,
  type ContextMenuItem,
} from './commands/timeline-commands.js';
import { TimelineContextMenu } from './TimelineContextMenu.js';
import { ActionOverflowMenu, type ActionOverflowMenuItem } from './ActionOverflowMenu.js';
import { TimelineEmptyState } from './TimelineEmptyState.js';
import { TimelineTrackVisibilityButton } from './TimelineTrackVisibilityButton.js';
import { TimelineRuler, TimelineTracksGrid } from './TimelineRuler.js';
import { timelineTrackKind, type TimelineTrackKind } from './timeline-track-kind.js';
import {
  canPlaceTimelineElement,
  buildTimelineTrackReorderTransaction,
  nextProfessionalTrackId,
  professionalTrackCode,
  professionalTrackName,
  sortTracksForTimelineDisplay,
  timelineTrackFamily,
  trackFamilyForElement,
  type ProfessionalTrackFamily,
} from './timeline-track-family.js';
import {
  TIMELINE_END_PADDING_PX,
  TIMELINE_TRACK_GUTTER_WIDTH_PX,
  timelineContentWidthPx,
  timelineEffectiveDurationUs,
  timelineFollowScrollLeft,
  timelineMinWidthStyle,
  timelineOriginStyle,
} from './timeline-layout.js';
import { formatTime } from './format-time.js';
import { useTimelineMarkerSelection } from './useTimelineMarkerSelection.js';
import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type { DataLane } from './data-lanes.js';
import { countLaneItems } from './data-lanes.js';
import { DataLaneDrawer } from './DataLaneDrawer.js';
import { polishMediaLabel } from './media-label.js';
import {
  buildTimelineMediaImportTransaction,
  type TimelineMediaAsset,
} from './timeline-media-import.js';
import {
  buildTimelineClipGroupMoveTransaction,
  buildTimelineClipMoveTransaction,
  hasExceededDragThreshold,
  keyboardTrimTimeUs,
} from './timeline-clip-interaction.js';
import { TimelinePropertyLanes } from './TimelinePropertyLanes.js';
import { TimelineElementGlyph, TimelineElementMedia } from './TimelineElementVisual.js';
import {
  timelineElementKindForClip,
  type TimelineElementKind,
  type TimelineElementKindMap,
} from './timeline-element-kind.js';
import { TimelineTransitionJunction } from './TimelineTransitionJunction.js';
import {
  hasExceededMarqueeThreshold,
  normalizeTimelineRect,
  timelineRectsIntersect,
  unionTimelineSelection,
  type TimelinePoint,
  type TimelineRect,
} from './timeline-marquee-selection.js';
/** Drags snap to a 100 ms grid, matching the playhead slider's step. */
const SNAP_US = 100_000;
const DRAG_THRESHOLD_PX = 4;
/** Height of a virtual (not-yet-created) empty lane. */
const EMPTY_LANE_HEIGHT_PX = 44;
/** Extra empty lanes rendered below the visible viewport during scrolling. */
const EMPTY_LANE_OVERSCAN = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function frameDurationUs(frameRate: { readonly num: number; readonly den: number }): number {
  return Math.max(1, Math.round((1_000_000 * frameRate.den) / frameRate.num));
}

/** Snap time to composition frames; clamp strictly inside a clip for razor splits. */
function snapSplitUs(
  rawUs: number,
  clipStartUs: number,
  clipDurationUs: number,
  frameUs: number,
): number | undefined {
  const clipEndUs = clipStartUs + clipDurationUs;
  const snapped = Math.round(rawUs / frameUs) * frameUs;
  const minUs = clipStartUs + frameUs;
  const maxUs = clipEndUs - frameUs;
  if (maxUs < minUs) return undefined;
  if (snapped < minUs || snapped > maxUs) return undefined;
  return snapped;
}

function clipDisplayName(id: string): string {
  return polishMediaLabel(id);
}

function TimelineTrackKindIcon({ kind }: { readonly kind: TimelineTrackKind }) {
  if (kind === 'script') return <TimelineScriptTrackIcon />;
  return <TimelineElementGlyph kind={kind} />;
}

function TimelineClip({
  clip,
  elementKind,
  displayName,
  selected,
  isDragOver,
  maxStartUs,
  viewport,
  locked,
  laneIndex,
  splitToolActive,
  frameUs,
  onSelect,
  onMove,
  onTrim,
  onContextMenu,
  onOpenComposition,
  onSplitHover,
  onSplitAt,
}: {
  readonly clip: Clip;
  readonly elementKind: TimelineElementKind;
  readonly displayName?: string;
  readonly selected: boolean;
  readonly isDragOver: boolean;
  readonly maxStartUs: number;
  readonly viewport: TimelineViewport;
  readonly locked: boolean;
  readonly laneIndex: number;
  readonly splitToolActive: boolean;
  readonly frameUs: number;
  /** Plain selection replaces; only Ctrl/Command deliberately toggles. */
  readonly onSelect: (id: string, additive: boolean) => void;
  readonly onMove: (clipId: string, newStartUs: number, targetTrackId?: string) => boolean;
  readonly onTrim: (clipId: string, edge: 'start' | 'end', timeUs: number) => boolean;
  readonly onContextMenu: (clipId: string, clientX: number, clientY: number) => void;
  readonly onOpenComposition?: (compositionId: string) => void;
  readonly onSplitHover: (atUs: number | undefined) => void;
  readonly onSplitAt: (atUs: number) => void;
}) {
  const [dragPx, setDragPx] = useState<number | undefined>(undefined);
  const [trimPreview, setTrimPreview] = useState<
    { edge: 'start' | 'end'; timeUs: number } | undefined
  >(undefined);
  const dragRef = useRef<{ originX: number; originY: number; moved: boolean } | null>(null);
  const trimRef = useRef<{ edge: 'start' | 'end'; originX: number } | null>(null);
  const lastCompoundOpenAtRef = useRef(0);
  const pxPerUs = viewport.pixelsPerSecond / 1_000_000;
  const rateBadge = clipRateLabel(clip);

  const splitTimeFromClientX = (clientX: number, target: HTMLElement): number | undefined => {
    const rect = target.getBoundingClientRect();
    const localX = clientX - rect.left;
    const rawUs = clip.startUs + localX / pxPerUs;
    return snapSplitUs(rawUs, clip.startUs, clip.durationUs, frameUs);
  };

  const dropTimeUs = (deltaPx: number): number => {
    const rawUs = clip.startUs + deltaPx / pxPerUs;
    const snapped = Math.round(rawUs / SNAP_US) * SNAP_US;
    return Math.min(maxStartUs, Math.max(0, snapped));
  };

  const trimTimeUs = (edge: 'start' | 'end', clientX: number, originX: number): number => {
    const deltaUs = (clientX - originX) / pxPerUs;
    if (edge === 'start') {
      const raw = clip.startUs + deltaUs;
      const snapped = Math.round(raw / SNAP_US) * SNAP_US;
      const maxStart = clip.startUs + clip.durationUs - SNAP_US;
      return Math.min(maxStart, Math.max(0, snapped));
    }
    const raw = clip.startUs + clip.durationUs + deltaUs;
    const snapped = Math.round(raw / SNAP_US) * SNAP_US;
    const minEnd = clip.startUs + SNAP_US;
    return Math.max(minEnd, snapped);
  };

  const openComposition = () => {
    if (clip.kind !== 'composition') return;
    // Mouse down on the second click is more reliable than the browser's
    // synthetic dblclick event when a timeline clip is also pointer-captured
    // for drag gestures. The timestamp keeps the subsequent dblclick event
    // idempotent.
    const now = Date.now();
    if (now - lastCompoundOpenAtRef.current < 500) return;
    lastCompoundOpenAtRef.current = now;
    onOpenComposition?.(clip.compositionId);
  };

  const displayStartUs =
    trimPreview?.edge === 'start'
      ? trimPreview.timeUs
      : dragPx !== undefined
        ? dropTimeUs(dragPx)
        : clip.startUs;
  const displayDurationUs =
    trimPreview === undefined
      ? clip.durationUs
      : trimPreview.edge === 'start'
        ? clip.startUs + clip.durationUs - trimPreview.timeUs
        : trimPreview.timeUs - clip.startUs;

  const widthPx = Math.max(8, displayDurationUs * pxPerUs);
  /** Half-gap between adjacent clips; start edge stays flush with timeToPixel. */
  const gapPx = 1;
  const layoutWidthPx = Math.max(6, widthPx - gapPx);
  const label =
    displayName?.trim() || clipDisplayName(clip.id.replace(/^voice-/, '').replace(/^clip-/, ''));
  const durationLabel = `${(displayDurationUs / 1_000_000).toFixed(1)}s`;
  const showChrome = layoutWidthPx >= 48;
  const showDuration = layoutWidthPx >= 100;
  const kindClass =
    clip.kind === 'composition' ? 'timeline-clip--comp' : `timeline-clip--${elementKind}`;
  const laneClass = `timeline-clip--lane-${Math.min(laneIndex, 3)}`;

  return (
    <div
      role="button"
      tabIndex={0}
      className={`timeline-clip ${kindClass} ${laneClass}${dragPx !== undefined || trimPreview !== undefined ? ' dragging' : ''}${isDragOver ? ' is-drag-over' : ''}`}
      aria-pressed={selected}
      aria-label={`${label}, ${durationLabel}`}
      data-clip-id={clip.id}
      data-element-kind={elementKind}
      title={`${label} · ${(clip.startUs / 1_000_000).toFixed(1)}s–${((clip.startUs + clip.durationUs) / 1_000_000).toFixed(1)}s${clip.kind === 'composition' ? ' · Double-click to edit the merged timeline' : ''}`}
      style={{
        left: `${timeToPixel(displayStartUs, viewport)}px`,
        width: `${layoutWidthPx}px`,
      }}
      onClick={(event) => {
        // Selection can remount Dockview between physical clicks. Preserve the
        // browser's second-click intent without treating one click on a member
        // of a multi-selection as an accidental "open composition" action.
        if (clip.kind === 'composition' && !splitToolActive && event.detail >= 2) {
          event.preventDefault();
          event.stopPropagation();
          openComposition();
          return;
        }
        if (splitToolActive) {
          const atUs = splitTimeFromClientX(event.clientX, event.currentTarget as HTMLElement);
          if (atUs !== undefined) {
            onSplitAt(atUs);
          }
          return;
        }
        if (dragRef.current?.moved !== true && trimRef.current === null) {
          onSelect(clip.id, event.metaKey || event.ctrlKey);
        }
        dragRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(clip.id, event.metaKey || event.ctrlKey);
          return;
        }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onContextMenu(clip.id, rect.left + 12, rect.top + 12);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Context actions should apply to the item under the pointer. Preserve
        // an existing selection only when this clip is already a member of it.
        if (!selected) onSelect(clip.id, false);
        onContextMenu(clip.id, event.clientX, event.clientY);
      }}
      onDoubleClick={(event) => {
        if (clip.kind !== 'composition') return;
        event.preventDefault();
        event.stopPropagation();
        openComposition();
      }}
      onMouseDown={(event) => {
        if (clip.kind !== 'composition' || event.detail < 2) return;
        event.preventDefault();
        event.stopPropagation();
        openComposition();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || locked) return;
        if ((event.target as HTMLElement).dataset.trimEdge) return;
        if (splitToolActive) {
          event.preventDefault();
          return;
        }
        // A drag starts before the browser emits click. Select an unselected
        // item now so the drag moves exactly the item the user grabbed rather
        // than the prior selection. Modifier-click remains additive/toggle on
        // the subsequent click event.
        if (!selected && !event.ctrlKey && !event.metaKey) onSelect(clip.id, false);
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { originX: event.clientX, originY: event.clientY, moved: false };
      }}
      onPointerMove={(event) => {
        if (splitToolActive) {
          const atUs = splitTimeFromClientX(event.clientX, event.currentTarget);
          onSplitHover(atUs);
          return;
        }
        const trim = trimRef.current;
        if (trim !== null) {
          setTrimPreview({
            edge: trim.edge,
            timeUs: trimTimeUs(trim.edge, event.clientX, trim.originX),
          });
          return;
        }
        const drag = dragRef.current;
        if (drag === null) return;
        const deltaPx = event.clientX - drag.originX;
        if (hasExceededDragThreshold(deltaPx, event.clientY - drag.originY, DRAG_THRESHOLD_PX))
          drag.moved = true;
        if (drag.moved) setDragPx(deltaPx);
      }}
      onPointerUp={(event) => {
        // Always release capture, including ordinary clicks and trim gestures.
        // Leaving a completed click captured can stop the browser from
        // synthesising the following click/dblclick on the same clip.
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        const trim = trimRef.current;
        if (trim !== null) {
          const timeUs = trimTimeUs(trim.edge, event.clientX, trim.originX);
          trimRef.current = null;
          setTrimPreview(undefined);
          onTrim(clip.id, trim.edge, timeUs);
          return;
        }
        const drag = dragRef.current;
        setDragPx(undefined);
        if (drag === null || !drag.moved) return;
        const targetTrackId = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId;
        onMove(clip.id, dropTimeUs(event.clientX - drag.originX), targetTrackId);
      }}
      onPointerCancel={() => {
        setDragPx(undefined);
        setTrimPreview(undefined);
        dragRef.current = null;
        trimRef.current = null;
      }}
    >
      {!locked && (
        <>
          <button
            type="button"
            className="timeline-clip-trim timeline-clip-trim-start"
            data-trim-edge="start"
            aria-label={`Trim start of ${clip.id}`}
            aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
            title="Trim start · Arrow keys nudge 0.1s; Shift nudges 1s"
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              (event.currentTarget.parentElement as HTMLElement).setPointerCapture(event.pointerId);
              trimRef.current = { edge: 'start', originX: event.clientX };
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const timeUs = keyboardTrimTimeUs({
                clip,
                edge: 'start',
                key: event.key,
                shiftKey: event.shiftKey,
                timelineDurationUs: maxStartUs + clip.durationUs,
              });
              if (timeUs === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              onTrim(clip.id, 'start', timeUs);
            }}
          />
          <button
            type="button"
            className="timeline-clip-trim timeline-clip-trim-end"
            data-trim-edge="end"
            aria-label={`Trim end of ${clip.id}`}
            aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight"
            title="Trim end · Arrow keys nudge 0.1s; Shift nudges 1s"
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              (event.currentTarget.parentElement as HTMLElement).setPointerCapture(event.pointerId);
              trimRef.current = { edge: 'end', originX: event.clientX };
            }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const timeUs = keyboardTrimTimeUs({
                clip,
                edge: 'end',
                key: event.key,
                shiftKey: event.shiftKey,
                timelineDurationUs: maxStartUs + clip.durationUs,
              });
              if (timeUs === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              onTrim(clip.id, 'end', timeUs);
            }}
          />
        </>
      )}
      <TimelineElementMedia
        kind={elementKind}
        seed={clip.id}
        widthPx={layoutWidthPx}
        pixelsPerSecond={viewport.pixelsPerSecond}
      />
      {showChrome && (
        <span className="timeline-clip-chrome">
          <span className="timeline-clip-icon" aria-hidden="true">
            <TimelineElementGlyph kind={elementKind} />
          </span>
          <span className="timeline-clip-label">{label}</span>
          {showDuration && <span className="timeline-clip-duration">{durationLabel}</span>}
          {rateBadge !== undefined && <span className="timeline-clip-badge">{rateBadge}</span>}
        </span>
      )}
    </div>
  );
}

export const JOY_MEDIA_ASSET_DND = 'application/x-joy-media-asset';

function safeAssetDuration(asset: {
  readonly descriptor?: { readonly durationUs?: number };
}): number {
  const durationUs = asset.descriptor?.durationUs;
  return durationUs !== undefined && Number.isSafeInteger(durationUs) && durationUs > 0
    ? durationUs
    : 5_000_000;
}

function parentCompositionFor(project: SpikeProject, compositionId: string): string | undefined {
  return Object.values(project.compositions).find((composition) =>
    composition.tracks.some((track) =>
      track.clips.some(
        (clip) => clip.kind === 'composition' && clip.compositionId === compositionId,
      ),
    ),
  )?.id;
}

export function TimelinePanel({
  project,
  elementKinds = {},
  transitions = [],
  playheadUs,
  playing,
  selectedIds,
  markers = [],
  viewport,
  onViewportChange,
  autoFit,
  onAutoFitChange,
  onTogglePlayback,
  onSeek,
  onSelectClips,
  onToggleSelection,
  onClearSelection,
  onDispatch,
  onAddMarker,
  onRemoveMarker,
  onEffectDrop,
  onTransitionDrop,
  onRevealInFlow,
  dataLanes,
  artifacts,
  onDispatchArtifacts,
  onOpenAssetLibrary,
  onImportMedia,
  onImportFiles,
  onMediaPlaced,
  assetDisplayNames,
  showToast,
  trackFlags: trackFlagsProp,
  onTrackFlagsChange,
  activeCompositionId: activeCompositionIdProp,
  onActiveCompositionChange,
  selectedObject,
  onPropertyDispatch,
}: {
  readonly project: SpikeProject;
  /** Durable clip presentation kinds from the paired creative project. */
  readonly elementKinds?: TimelineElementKindMap;
  readonly transitions?: readonly TransitionV1[];
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedIds: readonly string[];
  readonly viewport: TimelineViewport;
  readonly onViewportChange: (next: TimelineViewport) => void;
  readonly autoFit: boolean;
  readonly onAutoFitChange: (next: boolean) => void;
  readonly markers?: readonly {
    readonly id: string;
    readonly timeUs: number;
    readonly label: string;
  }[];
  readonly onTogglePlayback: () => void;
  readonly onSeek: (timeUs: number) => void;
  /** Replaces selection atomically. Required for normal click and marquee semantics. */
  readonly onSelectClips?: (ids: readonly string[]) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onDispatch: (transaction: CommandTransaction) => void;
  readonly onAddMarker?: (timeUs: number, label: string) => void;
  readonly onRemoveMarker?: (id: string) => void;
  readonly onEffectDrop?: (effectId: string, clipId: string, trackId: string) => void;
  readonly onTransitionDrop?: (
    transitionId: string,
    leftClipId: string,
    rightClipId: string,
    trackId: string,
  ) => void;
  readonly onRevealInFlow?: (clipId: string) => void;
  /**
   * Durable creative data laid against time. Absent unless the Dual Lens flag
   * is on, which is what keeps the default timeline unchanged.
   */
  readonly dataLanes?: readonly DataLane[];
  readonly artifacts?: ArtifactStore;
  readonly onDispatchArtifacts?: (transaction: ArtifactTransaction) => void;
  readonly onOpenAssetLibrary?: () => void;
  readonly onImportMedia?: (file: File) => Promise<TimelineMediaAsset>;
  readonly onImportFiles?: (files: readonly File[]) => void;
  readonly onMediaPlaced?: (asset: TimelineMediaAsset, clipId: string) => void;
  /** Human labels from the creative asset catalog, keyed by opaque asset id. */
  readonly assetDisplayNames?: Readonly<Record<string, string>>;
  readonly showToast?: (message: string, kind: 'info' | 'success' | 'error') => void;
  /** Shared with Dual Lens so lock/visibility/solo stay one source of truth. */
  readonly trackFlags?: readonly TimelineTrackView[];
  readonly onTrackFlagsChange?: (next: readonly TimelineTrackView[]) => void;
  /** Optional controlled compound-timeline view. Omit for internal drill-in state. */
  readonly activeCompositionId?: string;
  /** Called after double-clicking a merged clip or using the toolbar Back button. */
  readonly onActiveCompositionChange?: (compositionId: string) => void;
  /** Selected visual object, provided by the editor when a clip/object is selected. */
  readonly selectedObject?: VisualObjectV1;
  /** Durable visual-object transaction dispatcher for property keyframes. */
  readonly onPropertyDispatch?: (transaction: VisualObjectTransaction) => void;
}) {
  const [localTrackFlags, setLocalTrackFlags] = useState<readonly TimelineTrackView[]>([]);
  const [localActiveCompositionId, setLocalActiveCompositionId] = useState(
    project.rootCompositionId,
  );
  const [compositionPath, setCompositionPath] = useState<readonly string[]>([
    project.rootCompositionId,
  ]);
  const trackFlags = trackFlagsProp ?? localTrackFlags;
  const setTrackFlags = onTrackFlagsChange ?? setLocalTrackFlags;
  const [selectToolActive, setSelectToolActive] = useState(true);
  const [splitToolActive, setSplitToolActive] = useState(false);
  const [splitGuideUs, setSplitGuideUs] = useState<number | undefined>(undefined);
  const [tracksHeightPx, setTracksHeightPx] = useState(180);
  const [tracksViewportWidthPx, setTracksViewportWidthPx] = useState(0);
  const [tracksScrollLeft, setTracksScrollLeft] = useState(0);
  const [showAnimatedProperties, setShowAnimatedProperties] = useState(true);
  /** Clip being dragged over by an effect or transition — shows amber highlight. */
  const [dragEffectOverClipId, setDragEffectOverClipId] = useState<string | null>(null);
  // §6.2: collapsed by default, so standard editing is visually unchanged.
  const [dataLanesOpen, setDataLanesOpen] = useState(false);
  const { selectedMarkerId, selectMarker, removeMarker } = useTimelineMarkerSelection(markers, {
    clipSelected: selectedIds.length > 0,
    ...(onRemoveMarker === undefined ? {} : { onRemoveMarker }),
  });
  const [menu, setMenu] = useState<
    | { x: number; y: number; items: readonly ContextMenuItem[]; trackId?: string; clipId?: string }
    | undefined
  >(undefined);
  const [marqueeRect, setMarqueeRect] = useState<TimelineRect | undefined>(undefined);
  const marqueeRef = useRef<{
    origin: TimelinePoint;
    baselineIds: readonly string[];
    additive: boolean;
    pointerId: number;
    capture: HTMLElement;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneMeasureRef = useRef<HTMLDivElement | null>(null);
  const activeTrackDragRef = useRef<
    { readonly trackId: string; readonly family: ProfessionalTrackFamily } | undefined
  >(undefined);

  const requestedCompositionId = activeCompositionIdProp ?? localActiveCompositionId;
  const activeCompositionId =
    project.compositions[requestedCompositionId] === undefined
      ? project.rootCompositionId
      : requestedCompositionId;
  const composition = project.compositions[activeCompositionId];
  if (composition === undefined) throw new Error('timeline root composition is unavailable');
  const isCompoundView = activeCompositionId !== project.rootCompositionId;

  useEffect(() => {
    if (activeCompositionIdProp !== undefined) return;
    if (project.compositions[localActiveCompositionId] !== undefined) return;
    setLocalActiveCompositionId(project.rootCompositionId);
    setCompositionPath([project.rootCompositionId]);
  }, [activeCompositionIdProp, localActiveCompositionId, project]);

  const setActiveComposition = useCallback(
    (compositionId: string) => {
      if (project.compositions[compositionId] === undefined) return;
      if (activeCompositionIdProp === undefined) setLocalActiveCompositionId(compositionId);
      onActiveCompositionChange?.(compositionId);
    },
    [activeCompositionIdProp, onActiveCompositionChange, project.compositions],
  );

  const openCompoundComposition = useCallback(
    (compositionId: string) => {
      if (project.compositions[compositionId] === undefined) return;
      setCompositionPath((path) => {
        const current = path[path.length - 1];
        return current === compositionId ? path : [...path, compositionId];
      });
      onClearSelection();
      setActiveComposition(compositionId);
    },
    [onClearSelection, project.compositions, setActiveComposition],
  );

  const closeCompoundComposition = useCallback(() => {
    if (!isCompoundView) return;
    const indexedParent = compositionPath.length > 1 ? compositionPath.at(-2) : undefined;
    const parent =
      indexedParent !== undefined && project.compositions[indexedParent] !== undefined
        ? indexedParent
        : (parentCompositionFor(project, activeCompositionId) ?? project.rootCompositionId);
    setCompositionPath((path) => (path.length > 1 ? path.slice(0, -1) : [parent]));
    onClearSelection();
    setActiveComposition(parent);
  }, [
    activeCompositionId,
    compositionPath,
    isCompoundView,
    onClearSelection,
    project,
    setActiveComposition,
  ]);
  const timelineDurationUs = timelineEffectiveDurationUs(
    composition,
    markers.map((marker) => marker.timeUs),
  );

  const familyIndexes: Record<'visual' | 'audio', number> = { visual: 0, audio: 0 };
  const tracks = sortTracksForTimelineDisplay(composition.tracks, elementKinds).map(
    (track, index) => {
      const saved = trackFlags.find((item) => item.id === track.id);
      const family = timelineTrackFamily(track, elementKinds);
      familyIndexes[family] += 1;
      return {
        ...(saved ?? {
          id: track.id,
          heightPx: 44,
          locked: false,
          solo: false,
          order: index,
        }),
        // The schema command is the output source of truth; visibility in this
        // presentation model must follow it after undo/redo or another surface.
        visible: track.enabled ?? true,
        family,
        familyIndex: familyIndexes[family],
      };
    },
  );
  /**
   * Selection must be committed in one render.  The fallback keeps standalone
   * TimelinePanel consumers compatible while the controlled App path uses its
   * real replace-selection callback.
   */
  const replaceSelection = useCallback(
    (ids: readonly string[]) => {
      const uniqueIds = [...new Set(ids)];
      if (onSelectClips !== undefined) {
        onSelectClips(uniqueIds);
        return;
      }
      onClearSelection();
      uniqueIds.forEach((id) => onToggleSelection(id));
    },
    [onClearSelection, onSelectClips, onToggleSelection],
  );
  const selectClip = useCallback(
    (clipId: string, additive: boolean) => {
      if (additive) onToggleSelection(clipId);
      else replaceSelection([clipId]);
    },
    [onToggleSelection, replaceSelection],
  );
  const compositionRef = useRef(composition);
  const tracksRef = useRef(tracks);
  const importingRef = useRef(false);
  const mountedRef = useRef(true);
  compositionRef.current = composition;
  tracksRef.current = tracks;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep every real track mounted. The previous viewport filter always used a
  // zero scroll offset and supplied no spacer rows, so tracks below the first
  // viewport (notably Audio in the showcase) could never render or be reached.
  // The scroll container already bounds paint work and this guarantees that
  // authored layers remain discoverable, selectable, and keyboard accessible.
  const visible = tracks;

  // Virtual (not-yet-created) empty lanes that fill the track viewport below the
  // real tracks, so the grid reaches the bottom of the panel and media can be
  // dropped to create new tracks. Computed from the observed container height
  // minus the space the real tracks occupy.
  const realTracksHeightPx = useMemo(
    () => tracks.reduce((sum, track) => sum + track.heightPx, 0),
    [tracks],
  );
  const virtualLaneCount = useMemo(() => {
    const avail = Math.max(0, tracksHeightPx - realTracksHeightPx);
    return Math.ceil(avail / EMPTY_LANE_HEIGHT_PX) + EMPTY_LANE_OVERSCAN;
  }, [tracksHeightPx, realTracksHeightPx]);

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setTracksHeightPx(entry.contentRect.height);
      setTracksViewportWidthPx(entry.contentRect.width);
      const scrollW = scrollRef.current?.clientWidth ?? entry.contentRect.width;
      const width = timelineContentWidthPx(scrollW);
      if (autoFit && width > 0) {
        onViewportChange({
          ...viewport,
          pixelsPerSecond: fitPixelsPerSecond(timelineDurationUs, width),
        });
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit writer; viewport is output
  }, [autoFit, timelineDurationUs, onViewportChange]);

  useEffect(() => {
    if (!autoFit) return;
    const scrollW = scrollRef.current?.clientWidth ?? 0;
    const width = timelineContentWidthPx(scrollW) || (laneMeasureRef.current?.clientWidth ?? 0);
    if (width <= 0) return;
    onViewportChange({
      ...viewport,
      pixelsPerSecond: fitPixelsPerSecond(timelineDurationUs, width),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit writer
  }, [autoFit, timelineDurationUs, onViewportChange]);

  useEffect(() => {
    if (!playing || autoFit) return;
    const root = scrollRef.current;
    if (root === null) return;
    const next = timelineFollowScrollLeft({
      scrollLeft: root.scrollLeft,
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      playheadContentX:
        TIMELINE_TRACK_GUTTER_WIDTH_PX +
        timeToPixel(Math.min(playheadUs, timelineDurationUs), {
          originUs: 0,
          pixelsPerSecond: viewport.pixelsPerSecond,
        }),
    });
    if (Math.abs(next - root.scrollLeft) >= 1) root.scrollLeft = next;
  }, [autoFit, playing, playheadUs, timelineDurationUs, viewport.pixelsPerSecond]);

  const toggle = (id: string, flag: 'locked' | 'solo') => {
    const next = tracks
      .map((track) => (track.id === id ? toggleTrackFlag(track, flag) : track))
      .map(({ id: trackId, heightPx, locked, visible, solo }) => ({
        id: trackId,
        heightPx,
        locked,
        visible,
        solo,
      }));
    setTrackFlags(next);
  };

  const setVisibility = (id: string, visible: boolean) => {
    const next = tracks
      .map((track) => (track.id === id ? { ...track, visible } : track))
      .map(({ id: trackId, heightPx, locked, visible: trackVisible, solo }) => ({
        id: trackId,
        heightPx,
        locked,
        visible: trackVisible,
        solo,
      }));
    setTrackFlags(next);
    onDispatch({
      label: visible ? `Show ${id}` : `Hide ${id}`,
      commands: [
        {
          type: 'property.setTrackEnabled',
          payload: { compositionId: composition.id, trackId: id, enabled: visible },
        },
      ],
    });
  };

  const collectMarqueeIds = useCallback((rect: TimelineRect): readonly string[] => {
    const root = scrollRef.current;
    if (root === null) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('.timeline-clip[data-clip-id]'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return timelineRectsIntersect(rect, {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        });
      })
      .map((element) => element.dataset.clipId)
      .filter((id): id is string => id !== undefined);
  }, []);

  const endMarquee = useCallback(
    (event: PointerEvent<HTMLElement>, canceled = false) => {
      const gesture = marqueeRef.current;
      if (gesture === null) return;
      if (gesture.capture.hasPointerCapture(gesture.pointerId)) {
        gesture.capture.releasePointerCapture(gesture.pointerId);
      }
      marqueeRef.current = null;
      const rect = marqueeRect;
      setMarqueeRect(undefined);
      if (canceled || rect === undefined) {
        if (
          !canceled &&
          !hasExceededMarqueeThreshold(gesture.origin, { x: event.clientX, y: event.clientY })
        ) {
          onClearSelection();
          const bounds = event.currentTarget.getBoundingClientRect();
          onSeek(
            pixelToTime(event.clientX - bounds.left, {
              originUs: 0,
              pixelsPerSecond: viewport.pixelsPerSecond,
            }),
          );
        }
        return;
      }
      const nextIds = unionTimelineSelection(
        gesture.baselineIds,
        collectMarqueeIds(rect),
        gesture.additive,
      );
      replaceSelection(nextIds);
    },
    [
      collectMarqueeIds,
      marqueeRect,
      onClearSelection,
      onSeek,
      replaceSelection,
      viewport.pixelsPerSecond,
    ],
  );

  const beginMarquee = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!selectToolActive || splitToolActive || event.target !== event.currentTarget) return;
      event.preventDefault();
      const capture = event.currentTarget;
      capture.setPointerCapture(event.pointerId);
      marqueeRef.current = {
        origin: { x: event.clientX, y: event.clientY },
        baselineIds: [...selectedIds],
        additive: event.metaKey || event.ctrlKey,
        pointerId: event.pointerId,
        capture,
      };
      setMarqueeRect(undefined);
    },
    [selectToolActive, selectedIds, splitToolActive],
  );

  const updateMarquee = useCallback((event: PointerEvent<HTMLElement>) => {
    const gesture = marqueeRef.current;
    if (gesture === null) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!hasExceededMarqueeThreshold(gesture.origin, point)) return;
    setMarqueeRect(normalizeTimelineRect(gesture.origin, point));
  }, []);

  const selected = selectedIds
    .map((id) =>
      composition.tracks
        .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
        .find((item) => item.clip.id === id),
    )
    .find((item) => item !== undefined);

  const mergeSelection = useMemo(() => {
    const selectedIdSet = new Set(selectedIds);
    const entries = composition.tracks.flatMap((track) =>
      track.clips.filter((clip) => selectedIdSet.has(clip.id)).map((clip) => ({ track, clip })),
    );
    if (entries.length < 2) {
      return { eligible: false as const, reason: 'Select two or more clips to merge.' };
    }
    const trackId = entries[0]?.track.id;
    if (trackId === undefined || entries.some((entry) => entry.track.id !== trackId)) {
      return {
        eligible: false as const,
        reason: 'Merge clips must be selected on one track.',
      };
    }
    if (tracks.find((track) => track.id === trackId)?.locked === true) {
      return { eligible: false as const, reason: 'Unlock the track before merging clips.' };
    }
    const sourceTrack = composition.tracks.find((track) => track.id === trackId);
    if (sourceTrack === undefined) {
      return { eligible: false as const, reason: 'The selected track is unavailable.' };
    }
    const ordered = [...sourceTrack.clips].sort((a, b) => a.startUs - b.startUs);
    const selectedIndexes = ordered
      .map((clip, index) => (selectedIdSet.has(clip.id) ? index : -1))
      .filter((index) => index >= 0);
    const firstIndex = selectedIndexes[0];
    if (
      firstIndex === undefined ||
      selectedIndexes.some((index, offset) => index !== firstIndex + offset)
    ) {
      return {
        eligible: false as const,
        reason: 'Merge requires a contiguous run without unselected clips between it.',
      };
    }
    return {
      eligible: true as const,
      trackId,
      clipIds: selectedIndexes.map((index) => ordered[index]!.id),
    };
  }, [composition.tracks, selectedIds, tracks]);

  const selectedTrackView =
    selected === undefined ? undefined : tracks.find((t) => t.id === selected.track.id);
  const selectedLocked = selectedTrackView?.locked === true;
  const canDuplicate = selected !== undefined && !selectedLocked;
  const canDelete = selected !== undefined && !selectedLocked;

  const frameUs = useMemo(() => frameDurationUs(composition.frameRate), [composition.frameRate]);

  const dispatchSplitAt = useCallback(
    (trackId: string, clipId: string, atUs: number) => {
      onDispatch({
        label: `Split ${clipId}`,
        commands: [
          {
            type: 'timeline.splitClip',
            payload: {
              compositionId: composition.id,
              trackId,
              clipId,
              atUs,
              newClipId: `${clipId}-split-${atUs}`,
            },
          },
        ],
      });
    },
    [composition.id, onDispatch],
  );

  const moveClip =
    (trackId: string) =>
    (clipId: string, newStartUs: number, targetTrackId = trackId): boolean => {
      try {
        const source = composition.tracks.find((candidate) => candidate.id === trackId);
        const clip = source?.clips.find((candidate) => candidate.id === clipId);
        const target = composition.tracks.find((candidate) => candidate.id === targetTrackId);
        const targetView = tracks.find((candidate) => candidate.id === targetTrackId);
        if (
          source === undefined ||
          clip === undefined ||
          target === undefined ||
          targetView?.locked === true
        )
          return false;
        const elementKind = timelineElementKindForClip(clip, elementKinds);
        if (!canPlaceTimelineElement(elementKind, target, elementKinds)) {
          showToast?.(
            `${elementKind === 'audio' ? 'Audio' : 'Visual'} elements can only move to compatible ${trackFamilyForElement(elementKind)} tracks.`,
            'info',
          );
          return false;
        }
        const selectedIdSet = new Set(selectedIds);
        const selectedEntries = composition.tracks.flatMap((candidateTrack) =>
          candidateTrack.clips
            .filter((candidateClip) => selectedIdSet.has(candidateClip.id))
            .map((candidateClip) => ({ track: candidateTrack, clip: candidateClip })),
        );
        const movingEntries =
          selectedIds.includes(clipId) && selectedEntries.length > 1
            ? selectedEntries
            : [{ track: source, clip }];
        if (
          movingEntries.some((entry) => tracks.find((view) => view.id === entry.track.id)?.locked)
        ) {
          showToast?.('Unlock every selected track before moving the selection.', 'info');
          return false;
        }
        const verticalMove = targetTrackId !== trackId;
        if (verticalMove && movingEntries.some((entry) => entry.track.id !== trackId)) {
          showToast?.(
            'Move clips from one source row vertically, or move a multi-row selection horizontally.',
            'info',
          );
          return false;
        }
        if (
          verticalMove &&
          movingEntries.some(
            (entry) =>
              !canPlaceTimelineElement(
                timelineElementKindForClip(entry.clip, elementKinds),
                target,
                elementKinds,
              ),
          )
        ) {
          showToast?.('A selected group cannot cross the visual/audio boundary.', 'info');
          return false;
        }
        if (movingEntries.length > 1) {
          const deltaUs = newStartUs - clip.startUs;
          const groupTransaction = buildTimelineClipGroupMoveTransaction({
            compositionId: composition.id,
            moves: movingEntries.map((entry) => ({
              sourceTrackId: entry.track.id,
              targetTrackId: verticalMove ? targetTrackId : entry.track.id,
              clipId: entry.clip.id,
              newStartUs: entry.clip.startUs + deltaUs,
            })),
          });
          if (groupTransaction === undefined) return false;
          onDispatch(groupTransaction);
          return true;
        }
        const transaction = buildTimelineClipMoveTransaction({
          compositionId: composition.id,
          sourceTrackId: trackId,
          targetTrackId,
          clip,
          targetClips: target.clips,
          newStartUs,
        });
        if (transaction === undefined) return false;
        onDispatch(transaction);
        return true;
      } catch {
        return false;
      }
    };

  const trimClip =
    (trackId: string) =>
    (clipId: string, edge: 'start' | 'end', timeUs: number): boolean => {
      try {
        onDispatch({
          label: `Trim ${edge} ${clipId}`,
          commands: [trimCommand(composition.id, trackId, clipId, edge, timeUs)],
        });
        return true;
      } catch {
        return false;
      }
    };

  const insertAssetOnTrack = useCallback(
    (
      trackId: string,
      asset: {
        readonly assetId: string;
        readonly kind: string;
        readonly displayName?: string;
        readonly descriptor?: { readonly durationUs?: number };
      },
      dropUs: number,
    ) => {
      const source = composition.tracks.find((t) => t.id === trackId);
      if (source === undefined) return;
      const elementKind = asset.kind === 'audio' ? 'audio' : 'video';
      if (!canPlaceTimelineElement(elementKind, source, elementKinds)) {
        showToast?.(
          `${asset.kind === 'audio' ? 'Audio' : 'Visual'} media must be dropped on a compatible ${trackFamilyForElement(elementKind)} track.`,
          'info',
        );
        return;
      }
      const durationUs = safeAssetDuration(asset);
      const snapped = Math.round(dropUs / SNAP_US) * SNAP_US;
      let startUs = Math.max(0, snapped);
      const sorted = [...source.clips].sort((a, b) => a.startUs - b.startUs);
      for (const existing of sorted) {
        const end = existing.startUs + existing.durationUs;
        if (startUs < end && startUs + durationUs > existing.startUs) startUs = end;
      }
      const isAudio = asset.kind === 'audio';
      const clipId = `${isAudio ? 'voice' : 'clip'}-${asset.assetId}-${Date.now()}`;
      onMediaPlaced?.(
        {
          id: asset.assetId,
          kind: isAudio ? 'audio' : asset.kind === 'image' ? 'image' : 'video',
          displayName: asset.displayName ?? asset.assetId,
          descriptor: asset.descriptor ?? {},
        },
        clipId,
      );
      onDispatch({
        label: `Insert ${asset.displayName ?? asset.assetId}`,
        commands: [
          {
            type: 'timeline.insertClip',
            payload: {
              compositionId: composition.id,
              trackId,
              clip: {
                id: clipId,
                kind: 'video',
                assetId: asset.assetId,
                startUs,
                durationUs,
                sourceInUs: 0,
              },
            },
          },
        ],
      });
    },
    [composition.id, composition.tracks, elementKinds, onDispatch, onMediaPlaced, showToast],
  );

  /** Create a NEW real track for a dropped asset and place the clip on it. */
  const createTrackFromAssetDrop = useCallback(
    (
      asset: {
        readonly assetId: string;
        readonly kind: string;
        readonly displayName?: string;
        readonly descriptor?: { readonly durationUs?: number };
      },
      dropUs: number,
    ) => {
      const order =
        composition.tracks.reduce((highest, track) => Math.max(highest, track.order), -1) + 1;
      const family = asset.kind === 'audio' ? 'audio' : 'visual';
      const familyIndex =
        composition.tracks.filter((track) => timelineTrackFamily(track, elementKinds) === family)
          .length + 1;
      const trackId = nextProfessionalTrackId(composition.tracks, family);
      const durationUs = safeAssetDuration(asset);
      const startUs = Math.max(0, Math.round(dropUs / SNAP_US) * SNAP_US);
      const clipId = `${family === 'audio' ? 'voice' : 'clip'}-${asset.assetId}-${Date.now()}`;
      onMediaPlaced?.(
        {
          id: asset.assetId,
          kind: asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'image' : 'video',
          displayName: asset.displayName ?? asset.assetId,
          descriptor: asset.descriptor ?? {},
        },
        clipId,
      );
      onDispatch({
        label: `Add ${asset.displayName ?? asset.assetId}`,
        commands: [
          {
            type: 'timeline.addTrack',
            payload: {
              compositionId: composition.id,
              track: {
                id: trackId,
                kind: 'video',
                family,
                name: professionalTrackName(family, familyIndex),
                order,
                enabled: true,
                clips: [],
              },
            },
          },
          {
            type: 'timeline.insertClip',
            payload: {
              compositionId: composition.id,
              trackId,
              clip: {
                id: clipId,
                kind: 'video',
                assetId: asset.assetId,
                startUs,
                durationUs,
                sourceInUs: 0,
              },
            },
          },
        ],
      });
    },
    [composition.id, composition.tracks, elementKinds, onDispatch, onMediaPlaced],
  );

  const dispatchSplit = (trackId: string, clipId: string) => {
    dispatchSplitAt(trackId, clipId, playheadUs);
  };

  const dispatchDuplicate = (trackId: string, clip: Clip) => {
    const source = composition.tracks.find((t) => t.id === trackId);
    if (source === undefined) return;
    onDispatch({
      label: `Duplicate ${clip.id}`,
      commands: [
        duplicateClipCommand(
          composition.id,
          trackId,
          clip,
          source.clips.map((c) => ({
            id: c.id,
            startUs: c.startUs,
            durationUs: c.durationUs,
          })),
          `${clip.id}-copy-${Date.now()}`,
        ),
      ],
    });
  };

  const dispatchDelete = (trackId: string, clipId: string) => {
    const source = composition.tracks.find((t) => t.id === trackId);
    if (source === undefined) return;
    onDispatch(
      rippleDelete(
        composition.id,
        trackId,
        source.clips.map((clip) => ({
          id: clip.id,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
        })),
        clipId,
      ),
    );
  };

  const addCompatibleTrack = useCallback(
    (family: 'visual' | 'audio') => {
      const order =
        composition.tracks.reduce((highest, track) => Math.max(highest, track.order), -1) + 1;
      const familyIndex =
        composition.tracks.filter((track) => timelineTrackFamily(track, elementKinds) === family)
          .length + 1;
      onDispatch({
        label: `Add ${family} track`,
        commands: [
          {
            type: 'timeline.addTrack',
            payload: {
              compositionId: composition.id,
              track: {
                id: nextProfessionalTrackId(composition.tracks, family),
                kind: 'video',
                family,
                name: professionalTrackName(family, familyIndex),
                order,
                enabled: true,
                clips: [],
              },
            },
          },
        ],
      });
    },
    [composition.id, composition.tracks, elementKinds, onDispatch],
  );
  const addVisualTrack = useCallback(() => addCompatibleTrack('visual'), [addCompatibleTrack]);
  const addAudioTrack = useCallback(() => addCompatibleTrack('audio'), [addCompatibleTrack]);
  const reorderTrack = useCallback(
    (sourceTrackId: string, targetTrackId: string) => {
      const transaction = buildTimelineTrackReorderTransaction({
        compositionId: composition.id,
        tracks: composition.tracks,
        sourceTrackId,
        targetTrackId,
        elementKinds,
      });
      if (transaction === undefined) {
        showToast?.('Tracks can only be reordered within their visual or audio stack.', 'info');
        return;
      }
      onDispatch(transaction);
    },
    [composition.id, composition.tracks, elementKinds, onDispatch, showToast],
  );

  const overflowItems: readonly ActionOverflowMenuItem[] = [
    { id: 'add-visual-track', label: 'Add Visual Track', onSelect: addVisualTrack },
    { id: 'add-audio-track', label: 'Add Audio Track', onSelect: addAudioTrack },
    {
      id: 'marker',
      label: 'Add Marker',
      onSelect: () => onAddMarker?.(playheadUs, `Marker ${markers.length + 1}`),
      disabled: onAddMarker === undefined,
      disabledReason: 'Markers are unavailable in this view.',
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: () => {
        if (selected !== undefined) dispatchDuplicate(selected.track.id, selected.clip);
      },
      disabled: !canDuplicate,
      disabledReason: 'Select an unlocked clip first.',
    },
    {
      id: 'delete',
      label: selectedMarkerId !== undefined ? 'Remove Marker' : 'Ripple Delete',
      onSelect: () => {
        if (selectedMarkerId !== undefined) removeMarker(selectedMarkerId);
        else if (selected !== undefined) dispatchDelete(selected.track.id, selected.clip.id);
      },
      disabled: !canDelete && selectedMarkerId === undefined,
      disabledReason: 'Select an unlocked clip first.',
      destructive: true,
    },
    {
      id: 'flow',
      label: dataLanesOpen ? 'Hide Data Lanes' : 'Show Data Lanes',
      onSelect: () => setDataLanesOpen((open) => !open),
      disabled: dataLanes === undefined,
      disabledReason: 'Data lanes are unavailable in this workspace.',
    },
  ];

  const dispatchFreeze = (trackId: string, clipId: string) => {
    if (isCompoundView) {
      showToast?.(
        'Freeze is unavailable inside a merged timeline because its parent timing is fixed.',
        'info',
      );
      return;
    }
    onDispatch({
      label: `Freeze ${clipId}`,
      commands: [
        freezeFrameCommand(
          composition.id,
          trackId,
          clipId,
          playheadUs,
          `${clipId}-freeze-${playheadUs}`,
          `${clipId}-right-${playheadUs}`,
        ),
      ],
    });
  };

  const dispatchReverse = (trackId: string, clipId: string) => {
    onDispatch({
      label: `Reverse ${clipId}`,
      commands: [toggleClipReverseCommand(composition.id, trackId, clipId)],
    });
    showToast?.(
      'Reverse video applied. The Program Monitor previews it silently; export reverses its audio.',
      'info',
    );
  };

  const dispatchMerge = () => {
    if (!mergeSelection.eligible) {
      showToast?.(mergeSelection.reason, 'info');
      return;
    }
    const token = Date.now();
    const compoundCompositionId = `${composition.id}-compound-${token}`;
    const compoundClipId = `compound-${token}`;
    onDispatch({
      label: `Merge ${mergeSelection.clipIds.length} clips`,
      commands: [
        createCompoundCommand(
          composition.id,
          mergeSelection.trackId,
          mergeSelection.clipIds,
          compoundCompositionId,
          compoundClipId,
          `Merged ${mergeSelection.clipIds.length} clips`,
        ),
      ],
    });
    onClearSelection();
    showToast?.('Merged clips. Double-click the merged clip to edit its timeline.', 'success');
  };

  const dispatchRate = (trackId: string, clipId: string, playbackRate: number) => {
    if (isCompoundView) {
      showToast?.(
        'Constant speed changes are unavailable inside a merged timeline because its parent timing is fixed.',
        'info',
      );
      return;
    }
    const track = composition.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    const fromFreeze = clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) === 0;
    onDispatch({
      label: `Speed ${clipId} → ${playbackRate}×`,
      commands: [
        {
          type: 'timeline.setClipRate',
          payload: {
            compositionId: composition.id,
            trackId,
            clipId,
            playbackRate,
            preserveSourceRange: !fromFreeze,
          },
        },
      ],
    });
  };

  const laneWidthPx = Math.max(
    64,
    timeToPixel(timelineDurationUs, { ...viewport, originUs: 0 }) + TIMELINE_END_PADDING_PX,
  );

  const rulerTicks = useMemo(
    () =>
      buildRulerTicks({
        durationUs: timelineDurationUs,
        pixelsPerSecond: viewport.pixelsPerSecond,
        originUs: 0,
      }),
    [timelineDurationUs, viewport.pixelsPerSecond],
  );

  const seekFromLane = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const timeUs =
      Math.round(pixelToTime(localX, { ...viewport, originUs: 0 }) / SNAP_US) * SNAP_US;
    onSeek(Math.min(timelineDurationUs, Math.max(0, timeUs)));
  };

  const applyZoom = (nextPps: number, anchorClientX?: number) => {
    onAutoFitChange(false);
    const scrollClientW = scrollRef.current?.clientWidth ?? 0;
    const laneW = laneMeasureRef.current?.clientWidth ?? 0;
    const fitWidth = timelineContentWidthPx(scrollClientW) || laneW || scrollClientW;
    const fitFloor =
      fitWidth > 0
        ? fitPixelsPerSecond(timelineDurationUs, fitWidth)
        : Math.min(MIN_PIXELS_PER_SECOND, viewport.pixelsPerSecond);
    const clamped = Math.min(MAX_PIXELS_PER_SECOND, Math.max(fitFloor, nextPps));
    const lane = laneMeasureRef.current;
    if (lane !== null && anchorClientX !== undefined) {
      const rect = lane.getBoundingClientRect();
      const localX = anchorClientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
      const timeUnder = pixelToTime(localX, {
        originUs: 0,
        pixelsPerSecond: viewport.pixelsPerSecond,
      });
      const newLocalX = timeToPixel(timeUnder, { originUs: 0, pixelsPerSecond: clamped });
      const scrollLeft = Math.max(0, newLocalX - (anchorClientX - rect.left));
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollLeft = scrollLeft;
      });
    }
    onViewportChange({ ...viewport, pixelsPerSecond: clamped });
  };

  const fitToWidth = () => {
    onAutoFitChange(true);
    const scrollClientW = scrollRef.current?.clientWidth ?? 0;
    const laneW = laneMeasureRef.current?.clientWidth ?? 0;
    const width = timelineContentWidthPx(scrollClientW) || laneW || scrollClientW;
    if (width > 0) {
      onViewportChange({
        ...viewport,
        pixelsPerSecond: fitPixelsPerSecond(timelineDurationUs, width),
      });
    }
    if (scrollRef.current !== null) scrollRef.current.scrollLeft = 0;
  };

  const openClipMenu = (trackId: string, clip: Clip, clientX: number, clientY: number) => {
    const fullTrack = composition.tracks.find((t) => t.id === trackId);

    const ctx: CommandContext = {
      project,
      compositionId: composition.id,
      playheadUs,
      selectedClip: fullTrack ? { track: fullTrack, clip } : undefined,
      selectedTrackIds: [trackId],
    };

    const items = buildClipContextMenu(ctx, (cmd) => {
      if (cmd) {
        switch (cmd.type) {
          case 'timeline.splitClip':
            dispatchSplit(cmd.payload.trackId, cmd.payload.clipId);
            break;
          case 'timeline.duplicateClip':
            dispatchDuplicate(cmd.payload.trackId, clip);
            break;
          case 'timeline.removeClip':
            dispatchDelete(cmd.payload.trackId, cmd.payload.clipId);
            break;
          case 'timeline.freezeFrame':
            dispatchFreeze(cmd.payload.trackId, cmd.payload.clipId);
            break;
          case 'timeline.toggleClipReverse':
            dispatchReverse(cmd.payload.trackId, cmd.payload.clipId);
            break;
          case 'timeline.setClipRate':
            dispatchRate(cmd.payload.trackId, cmd.payload.clipId, cmd.payload.playbackRate);
            break;
        }
      }
    });
    const trackIsLocked = tracks.find((candidate) => candidate.id === trackId)?.locked === true;
    // A locked lane must reject every timeline mutation, including mutations
    // reached through a context menu rather than pointer drag/trim. Keep the
    // choices visible with disabled semantics so the reason is discoverable.
    const mutationItems = trackIsLocked
      ? items.map((item) => (item.action === undefined ? item : { ...item, disabled: true }))
      : items;
    // A compound's parent clip defines its root-visible duration. Until a
    // nested ripple/parent-resize command exists, reject actions which can
    // lengthen the child and make its tail silently unplayable in the monitor
    // or export. Reverse remains safe because it preserves duration.
    const fixedWindowItems = isCompoundView
      ? mutationItems.map((item) =>
          item.label === 'Freeze frame at playhead' || item.label === 'Set playback rate…'
            ? { ...item, disabled: true }
            : item,
        )
      : mutationItems;

    // ContextMenu renders a divider entry as a separator only. Keep it as a
    // distinct item so the following action stays visible and keyboardable.
    const mergeItem: ContextMenuItem =
      mergeSelection.eligible && mergeSelection.clipIds.includes(clip.id)
        ? {
            label: `Merge ${mergeSelection.clipIds.length} selected clips`,
            icon: LayersIcon,
            action: dispatchMerge,
          }
        : {
            label:
              mergeSelection.reason ?? 'Select contiguous clips on one unlocked track to merge.',
            icon: LayersIcon,
            action: () => undefined,
            disabled: true,
          };
    const withCompound =
      clip.kind !== 'composition'
        ? [
            ...fixedWindowItems,
            { label: '', action: () => undefined, dividerBefore: true },
            mergeItem,
          ]
        : [
            ...fixedWindowItems,
            { label: '', action: () => undefined, dividerBefore: true },
            {
              label: 'Open merged timeline',
              icon: LayersIcon,
              action: () => openCompoundComposition(clip.compositionId),
            },
            mergeItem,
          ];
    const withReveal =
      onRevealInFlow === undefined
        ? withCompound
        : [
            ...withCompound,
            { label: '', action: () => {}, dividerBefore: true },
            { label: 'Reveal in Flow', action: () => onRevealInFlow(clip.id) },
          ];

    setMenu({ x: clientX, y: clientY, items: withReveal, trackId, clipId: clip.id });
  };

  const handleImportClick = useCallback(() => {
    if (importingRef.current) {
      showToast?.('A media import is already running.', 'info');
      return;
    }
    if (onImportMedia === undefined) {
      onOpenAssetLibrary?.();
      showToast?.('Open the Assets panel to import media in this workspace.', 'info');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,audio/*,image/*';
    input.onchange = (event) => {
      const files = Array.from((event.target as HTMLInputElement).files || []);
      if (files.length === 0) return;
      input.onchange = null;
      importingRef.current = true;
      showToast?.(
        files.length === 1
          ? `Importing ${files[0]!.name}...`
          : `Importing ${files.length} files...`,
        'info',
      );
      void (async () => {
        const imported: TimelineMediaAsset[] = [];
        const failures: string[] = [];
        try {
          for (const file of files) {
            try {
              imported.push(await onImportMedia(file));
            } catch (error) {
              failures.push(`${file.name}: ${errorMessage(error)}`);
            }
          }
          if (!mountedRef.current) return;
          if (imported.length > 0) {
            const lockedTrackIds = new Set(
              tracksRef.current.filter((track) => track.locked).map((track) => track.id),
            );
            const batchToken = Date.now();
            const clipIds = imported.map(
              (asset, index) =>
                `${asset.kind === 'audio' ? 'voice' : 'clip'}-${asset.id}-${batchToken}-${index}`,
            );
            const transaction = buildTimelineMediaImportTransaction(
              compositionRef.current,
              imported,
              playheadUs,
              lockedTrackIds,
              (_asset, index) => clipIds[index]!,
            );
            imported.forEach((asset, index) => onMediaPlaced?.(asset, clipIds[index]!));
            onDispatch(transaction);
          }
          if (failures.length > 0) {
            showToast?.(
              `${imported.length} imported; ${failures.length} failed. ${failures[0]}`,
              'error',
            );
          } else {
            showToast?.(
              imported.length === 1
                ? `${imported[0]!.displayName} backed up and added to the timeline.`
                : `${imported.length} files backed up and added to the timeline.`,
              'success',
            );
          }
        } catch (error) {
          if (mountedRef.current) {
            showToast?.(`Failed to add imported media: ${errorMessage(error)}`, 'error');
          }
        } finally {
          importingRef.current = false;
        }
      })();
    };
    input.click();
  }, [onDispatch, onImportMedia, onMediaPlaced, onOpenAssetLibrary, playheadUs, showToast]);

  const handleFilesDrop = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      if (onImportFiles !== undefined) {
        onImportFiles(files);
        return;
      }
      showToast?.('File import is unavailable in this workspace.', 'error');
    },
    [onImportFiles, showToast],
  );

  const handleAssetDrop = useCallback(
    (asset: {
      readonly assetId: string;
      readonly kind: string;
      readonly displayName?: string;
      readonly descriptor?: TimelineMediaAsset['descriptor'];
    }) => {
      const kind = asset.kind === 'audio' || asset.kind === 'image' ? asset.kind : 'video';
      const timelineAsset: TimelineMediaAsset = {
        id: asset.assetId,
        kind,
        displayName: asset.displayName ?? asset.assetId,
        descriptor: asset.descriptor ?? {},
      };
      const clipId = `${kind === 'audio' ? 'voice' : 'clip'}-${asset.assetId}-${Date.now()}`;
      onMediaPlaced?.(timelineAsset, clipId);
      onDispatch(
        buildTimelineMediaImportTransaction(
          composition,
          [timelineAsset],
          playheadUs,
          new Set(tracksRef.current.filter((track) => track.locked).map((track) => track.id)),
          () => clipId,
        ),
      );
    },
    [composition, onDispatch, onMediaPlaced, playheadUs],
  );

  const handleAddFromLibrary = useCallback(() => {
    if (onOpenAssetLibrary !== undefined) {
      onOpenAssetLibrary();
      return;
    }
    showToast?.('The Assets panel is unavailable in this workspace.', 'info');
  }, [onOpenAssetLibrary, showToast]);

  return (
    <article
      className={
        splitToolActive
          ? 'timeline-panel split-tool-active'
          : selectToolActive
            ? 'timeline-panel select-tool-active'
            : 'timeline-panel'
      }
    >
      <div className="timeline-toolbar">
        {isCompoundView && (
          <>
            <div className="timeline-toolbar-group" aria-label="Merged timeline navigation">
              <button
                type="button"
                className="timeline-data-lanes-toggle"
                onClick={closeCompoundComposition}
                aria-label="Back to parent timeline"
                title="Back to parent timeline"
              >
                <ChevronLeftIcon />
                Back
              </button>
              <span className="timeline-timecode-label" title={composition.name}>
                <LayersIcon />
                Main / {composition.name}
              </span>
            </div>
            <span className="timeline-toolbar-sep" aria-hidden="true" />
          </>
        )}
        <div className="timeline-toolbar-group timeline-toolbar-transport">
          <button
            className="icon-button"
            onClick={onTogglePlayback}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            className="icon-button"
            onClick={() => onSeek(Math.max(0, playheadUs - 1_000_000))}
            aria-label="Back one second"
            title="Back 1s (←)"
          >
            <SkipBackIcon />
          </button>
          <button
            className="icon-button"
            onClick={() => onSeek(Math.min(timelineDurationUs, playheadUs + 1_000_000))}
            aria-label="Forward one second"
            title="Forward 1s (→)"
          >
            <SkipForwardIcon />
          </button>
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group timeline-toolbar-secondary timeline-toolbar-edit">
          <button
            type="button"
            className="icon-button"
            aria-label="Add visual track"
            title="Add visual track"
            data-guide="Add visual track"
            onClick={addVisualTrack}
          >
            <TrackAddIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Add audio track"
            title="Add audio track"
            data-guide="Add audio track"
            onClick={addAudioTrack}
          >
            <span aria-hidden="true">A+</span>
          </button>
          {onAddMarker !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label="Add marker at playhead"
              title="Add marker at playhead"
              data-guide="Add marker"
              onClick={() => onAddMarker(playheadUs, `Marker ${markers.length + 1}`)}
            >
              <MarkerIcon />
            </button>
          )}
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group timeline-toolbar-tools">
          <button
            type="button"
            className="icon-button"
            data-guide="Select"
            aria-label="Select tool"
            title="Select tool"
            aria-pressed={selectToolActive}
            onClick={() => {
              setSelectToolActive((active) => {
                if (active) return false;
                setSplitToolActive(false);
                return true;
              });
            }}
          >
            <SelectIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            data-guide="Split"
            aria-label="Split tool"
            title="Split tool (S)"
            aria-pressed={splitToolActive}
            onClick={() => {
              setSplitToolActive((active) => {
                if (active) return false;
                setSelectToolActive(false);
                return true;
              });
            }}
          >
            <ScissorsIcon />
          </button>
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group timeline-toolbar-secondary timeline-toolbar-edit">
          <button
            className="icon-button"
            disabled={!canDuplicate}
            aria-label="Duplicate clip"
            title="Duplicate (⌘/Ctrl+D)"
            onClick={() => {
              if (selected === undefined) return;
              dispatchDuplicate(selected.track.id, selected.clip);
            }}
          >
            <DuplicateIcon />
          </button>
          <button
            className="icon-button"
            disabled={!canDelete && selectedMarkerId === undefined}
            aria-label={selectedMarkerId !== undefined ? 'Remove marker' : 'Ripple delete'}
            title={selectedMarkerId !== undefined ? 'Remove marker (Del)' : 'Ripple delete (Del)'}
            onClick={() => {
              if (selectedMarkerId !== undefined) {
                removeMarker(selectedMarkerId);
                return;
              }
              if (selected === undefined) return;
              dispatchDelete(selected.track.id, selected.clip.id);
            }}
          >
            <TrashIcon />
          </button>
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group timeline-toolbar-zoom timeline-toolbar-view">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => applyZoom(viewport.pixelsPerSecond / 1.25)}
          >
            <ZoomOutIcon />
          </button>
          <input
            aria-label="Timeline zoom"
            className="timeline-zoom-slider"
            type="range"
            min={Math.min(MIN_PIXELS_PER_SECOND, viewport.pixelsPerSecond)}
            max={MAX_PIXELS_PER_SECOND}
            step={viewport.pixelsPerSecond < MIN_PIXELS_PER_SECOND ? 0.01 : 1}
            value={viewport.pixelsPerSecond}
            onChange={(event) => applyZoom(event.currentTarget.valueAsNumber)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => applyZoom(viewport.pixelsPerSecond * 1.25)}
          >
            <ZoomInIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Fit timeline to width"
            title="Fit to width"
            aria-pressed={autoFit}
            onClick={fitToWidth}
          >
            <FitWidthIcon />
          </button>
          <span className="timeline-zoom-state" aria-label={autoFit ? 'Fit mode' : 'Follow mode'}>
            {autoFit ? 'Fit' : 'Follow'}
          </span>
        </div>

        {dataLanes !== undefined && (
          <>
            <span className="timeline-toolbar-sep" aria-hidden="true" />
            <div className="timeline-toolbar-group timeline-toolbar-secondary">
              <button
                type="button"
                className="timeline-data-lanes-toggle"
                aria-expanded={dataLanesOpen}
                title="Script, transcript, prompts, analysis, generated output, and agent changes"
                onClick={() => setDataLanesOpen((open) => !open)}
              >
                Data Lanes
                {countLaneItems(dataLanes) > 0 && (
                  <span className="timeline-data-lanes-count">{countLaneItems(dataLanes)}</span>
                )}
              </button>
            </div>
          </>
        )}
        <ActionOverflowMenu items={overflowItems} />
      </div>

      <TimelineEmptyState
        project={project}
        _playheadUs={playheadUs}
        compositionDurationUs={timelineDurationUs}
        viewportPixelsPerSecond={viewport.pixelsPerSecond}
        onSeek={onSeek}
        onImportClick={handleImportClick}
        onAddFromLibrary={handleAddFromLibrary}
        onFilesDrop={handleFilesDrop}
        onAssetDrop={handleAssetDrop}
        onContextMenu={(x, y) => {
          const items = buildEmptyCanvasContextMenu(handleImportClick, handleAddFromLibrary);
          setMenu({ x, y, items });
        }}
        onToast={(message) => showToast?.(message, 'info')}
      />

      <div
        className="timeline-tracks"
        ref={scrollRef}
        onScroll={(event) => setTracksScrollLeft(event.currentTarget.scrollLeft)}
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
          applyZoom(viewport.pixelsPerSecond * factor, event.clientX);
        }}
      >
        <div
          className="timeline-scrub-row"
          style={{ minWidth: timelineMinWidthStyle(laneWidthPx) }}
        >
          <div className="timeline-scrub-gutter">
            <output className="timeline-timecode" aria-live="polite">
              {formatTime(playheadUs)}
            </output>
          </div>
          <TimelineRuler
            durationUs={timelineDurationUs}
            playheadUs={playheadUs}
            viewport={{ ...viewport, originUs: 0 }}
            widthPx={laneWidthPx}
            ticks={rulerTicks}
            onSeek={onSeek}
            onContextMenu={(timeUs, clientX, clientY) => {
              const items = buildRulerContextMenu((t) => {
                onAddMarker?.(t, `Marker ${markers.length + 1}`);
              }, timeUs);
              setMenu({ x: clientX, y: clientY, items });
            }}
          />
          <span
            className="timeline-playhead timeline-playhead--scrub"
            style={{
              left: timelineOriginStyle(timeToPixel(playheadUs, { ...viewport, originUs: 0 })),
            }}
            aria-hidden="true"
          />
        </div>
        <div className="timeline-tracks-inner" ref={laneMeasureRef}>
          <TimelineTracksGrid ticks={rulerTicks} widthPx={laneWidthPx} />
          {marqueeRect !== undefined &&
            laneMeasureRef.current !== null &&
            (() => {
              const inner = laneMeasureRef.current!.getBoundingClientRect();
              return (
                <span
                  className="timeline-marquee-selection"
                  aria-hidden="true"
                  style={{
                    left: `${marqueeRect.left - inner.left}px`,
                    top: `${marqueeRect.top - inner.top}px`,
                    width: `${Math.max(0, marqueeRect.right - marqueeRect.left)}px`,
                    height: `${Math.max(0, marqueeRect.bottom - marqueeRect.top)}px`,
                  }}
                />
              );
            })()}
          <span
            className="timeline-playhead"
            style={{
              left: timelineOriginStyle(timeToPixel(playheadUs, { ...viewport, originUs: 0 })),
            }}
            aria-hidden="true"
          />
          {splitToolActive && splitGuideUs !== undefined && (
            <span
              className="timeline-split-guide"
              style={{
                left: timelineOriginStyle(timeToPixel(splitGuideUs, { ...viewport, originUs: 0 })),
              }}
              aria-hidden="true"
            />
          )}
          {visible.map((track, index) => {
            const source = composition.tracks.find((item) => item.id === track.id);
            if (source === undefined) return null;
            const kind =
              track.family === 'audio' ? 'audio' : timelineTrackKind(source, elementKinds);
            const startsAudioStack =
              track.family === 'audio' && (index === 0 || visible[index - 1]?.family !== 'audio');
            return (
              <div
                className={
                  source.clips.some((clip) => selectedIds.includes(clip.id))
                    ? `timeline-track is-selected timeline-track--${track.family}${startsAudioStack ? ' timeline-track--audio-first' : ''}`
                    : `timeline-track timeline-track--${track.family}${startsAudioStack ? ' timeline-track--audio-first' : ''}`
                }
                key={track.id}
                data-track-id={track.id}
                data-track-family={track.family}
                style={{ height: track.heightPx }}
              >
                <div
                  className="timeline-track-header"
                  data-track-id={track.id}
                  draggable
                  aria-roledescription="draggable timeline track"
                  onDragStart={(event) => {
                    if ((event.target as HTMLElement).closest('button') !== null) {
                      event.preventDefault();
                      return;
                    }
                    activeTrackDragRef.current = { trackId: track.id, family: track.family };
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(
                      'application/x-joy-timeline-track',
                      JSON.stringify({ trackId: track.id, family: track.family }),
                    );
                  }}
                  onDragEnd={() => {
                    activeTrackDragRef.current = undefined;
                  }}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes('application/x-joy-timeline-track'))
                      return;
                    if (activeTrackDragRef.current?.family !== track.family) {
                      event.dataTransfer.dropEffect = 'none';
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    if (activeTrackDragRef.current?.family !== track.family) return;
                    const raw = event.dataTransfer.getData('application/x-joy-timeline-track');
                    if (!raw) return;
                    event.preventDefault();
                    try {
                      const payload = JSON.parse(raw) as { trackId?: string; family?: string };
                      if (payload.family !== track.family || payload.trackId === undefined) {
                        showToast?.('Visual and audio rows cannot be interleaved.', 'info');
                        return;
                      }
                      reorderTrack(payload.trackId, track.id);
                    } catch {
                      // Ignore malformed native drag payloads.
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = buildTrackHeaderContextMenu(
                      () => {
                        const order =
                          composition.tracks.reduce(
                            (highest, candidate) => Math.max(highest, candidate.order),
                            -1,
                          ) + 1;
                        const family = 'visual' as const;
                        const familyIndex =
                          composition.tracks.filter(
                            (candidate) => timelineTrackFamily(candidate, elementKinds) === family,
                          ).length + 1;
                        onDispatch({
                          label: 'Add visual track',
                          commands: [
                            {
                              type: 'timeline.addTrack',
                              payload: {
                                compositionId: composition.id,
                                track: {
                                  id: nextProfessionalTrackId(composition.tracks, family),
                                  kind: 'video',
                                  family,
                                  name: professionalTrackName(family, familyIndex),
                                  order,
                                  enabled: true,
                                  clips: [],
                                },
                              },
                            },
                          ],
                        });
                      },
                      () => {
                        onDispatch({
                          label: `Remove ${track.id}`,
                          commands: [
                            {
                              type: 'timeline.removeTrack',
                              payload: { compositionId: composition.id, trackId: track.id },
                            },
                          ],
                        });
                      },
                      (visible: boolean) => setVisibility(track.id, visible),
                      source.enabled ?? true,
                      source.clips.length === 0 && composition.tracks.length > 1,
                    );
                    setMenu({ x: event.clientX, y: event.clientY, items });
                  }}
                >
                  <span
                    className="timeline-track-kind-icon"
                    title={
                      track.family === 'audio' ? 'Audio timeline layer' : 'Visual timeline layer'
                    }
                  >
                    <TimelineTrackKindIcon kind={kind} />
                  </span>
                  <div className="timeline-track-label">
                    <span className="track-code" dir="ltr">
                      {professionalTrackCode(track.family, track.familyIndex)}
                    </span>
                    <span className="track-name" dir="ltr" title={track.id}>
                      {professionalTrackName(
                        track.family,
                        track.familyIndex,
                        source.name ?? source.id,
                      )}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-pressed={track.locked}
                    aria-label={`Lock ${track.id}`}
                    title={track.locked ? 'Unlock track' : 'Lock track'}
                    onClick={() => toggle(track.id, 'locked')}
                  >
                    <LockIcon />
                  </button>
                  <TimelineTrackVisibilityButton
                    trackId={track.id}
                    visible={track.visible}
                    onToggle={(visible) => setVisibility(track.id, visible)}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-pressed={track.solo}
                    aria-label={`Solo ${track.id}`}
                    title={track.solo ? 'Unsolo track' : 'Solo track'}
                    onClick={() => toggle(track.id, 'solo')}
                  >
                    <SoloIcon />
                  </button>
                </div>
                <span
                  className="timeline-lane"
                  data-track-id={track.id}
                  style={{ minWidth: `${laneWidthPx}px` }}
                  onPointerDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (splitToolActive) {
                      setSplitGuideUs(undefined);
                      return;
                    }
                    if (selectToolActive) {
                      beginMarquee(event);
                      return;
                    }
                    seekFromLane(event);
                  }}
                  onPointerMove={(event) => {
                    updateMarquee(event);
                    if (marqueeRef.current !== null) return;
                    if (!splitToolActive) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const localX = event.clientX - rect.left;
                    const rawUs = pixelToTime(localX, {
                      originUs: 0,
                      pixelsPerSecond: viewport.pixelsPerSecond,
                    });
                    const snapped = Math.round(rawUs / frameUs) * frameUs;
                    const source = composition.tracks.find((t) => t.id === track.id);
                    if (source === undefined) return;
                    const clip = source.clips.find((c) => {
                      const end = c.startUs + c.durationUs;
                      return snapped > c.startUs + frameUs && snapped < end - frameUs;
                    });
                    if (clip) {
                      setSplitGuideUs(snapped);
                    } else {
                      setSplitGuideUs(undefined);
                    }
                  }}
                  onPointerLeave={() => {
                    if (splitToolActive) setSplitGuideUs(undefined);
                  }}
                  onPointerUp={(event) => endMarquee(event)}
                  onPointerCancel={(event) => endMarquee(event, true)}
                  onDragOver={(event) => {
                    if (
                      !event.dataTransfer.types.includes(JOY_MEDIA_ASSET_DND) &&
                      !event.dataTransfer.types.includes('application/x-joy-effect') &&
                      !event.dataTransfer.types.includes('application/x-joy-transition')
                    )
                      return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = track.locked ? 'none' : 'copy';

                    const rect = event.currentTarget.getBoundingClientRect();
                    const dropUs = pixelToTime(event.clientX - rect.left, {
                      originUs: 0,
                      pixelsPerSecond: viewport.pixelsPerSecond,
                    });
                    const hitClip = source.clips.find(
                      (c: Clip) => dropUs >= c.startUs && dropUs <= c.startUs + c.durationUs,
                    );
                    setDragEffectOverClipId(hitClip?.id ?? null);
                  }}
                  onDragLeave={() => {
                    setDragEffectOverClipId(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (track.locked) return;
                    setDragEffectOverClipId(null);

                    // Effect drop
                    const effectRaw = event.dataTransfer.getData('application/x-joy-effect');
                    if (effectRaw) {
                      try {
                        const payload = JSON.parse(effectRaw) as {
                          kind: string;
                          effectId: string;
                          source: string;
                        };
                        const rect = event.currentTarget.getBoundingClientRect();
                        const dropUs = pixelToTime(event.clientX - rect.left, {
                          originUs: 0,
                          pixelsPerSecond: viewport.pixelsPerSecond,
                        });
                        const source = composition.tracks.find((t) => t.id === track.id);
                        if (source === undefined) return;
                        const clip = source.clips.find((c) => {
                          const end = c.startUs + c.durationUs;
                          return dropUs >= c.startUs && dropUs <= end;
                        });
                        if (clip) {
                          onEffectDrop?.(payload.effectId, clip.id, track.id);
                        }
                        return;
                      } catch {
                        /* ignore malformed */
                      }
                    }

                    // Transition drop
                    const transitionRaw = event.dataTransfer.getData(
                      'application/x-joy-transition',
                    );
                    if (transitionRaw) {
                      try {
                        const payload = JSON.parse(transitionRaw) as {
                          kind: string;
                          transitionId: string;
                          source: string;
                        };
                        const rect = event.currentTarget.getBoundingClientRect();
                        const dropUs = pixelToTime(event.clientX - rect.left, {
                          originUs: 0,
                          pixelsPerSecond: viewport.pixelsPerSecond,
                        });
                        const source = composition.tracks.find((t) => t.id === track.id);
                        if (source === undefined) return;
                        const sorted = [...source.clips].sort((a, b) => a.startUs - b.startUs);
                        // Find the clip boundary nearest the drop point. Accept the drop
                        // (a) within a small tolerance of the boundary for contiguous clips,
                        // or (b) anywhere inside a real gap between two clips. The old code
                        // required the drop time to land exactly on a gap, which made it
                        // impossible to drop onto two contiguous clips (their shared
                        // boundary is a single instant).
                        const usPerPx =
                          viewport.pixelsPerSecond > 0
                            ? 1_000_000 / viewport.pixelsPerSecond
                            : 1_000_000;
                        const toleranceUs = 6 * usPerPx;
                        for (let i = 0; i < sorted.length - 1; i++) {
                          const left = sorted[i]!;
                          const right = sorted[i + 1]!;
                          const leftEnd = left.startUs + left.durationUs;
                          if (right.startUs < leftEnd) continue; // overlap — not a clean boundary
                          const inGap = dropUs >= leftEnd && dropUs <= right.startUs;
                          const nearBoundary =
                            Math.abs(dropUs - leftEnd) <= toleranceUs ||
                            Math.abs(dropUs - right.startUs) <= toleranceUs;
                          if (inGap || (right.startUs === leftEnd && nearBoundary)) {
                            onTransitionDrop?.(payload.transitionId, left.id, right.id, track.id);
                            return;
                          }
                        }
                      } catch {
                        /* ignore malformed */
                      }
                    }

                    // Existing media asset drop
                    const raw = event.dataTransfer.getData(JOY_MEDIA_ASSET_DND);
                    if (!raw) return;
                    try {
                      const asset = JSON.parse(raw) as {
                        assetId: string;
                        kind: string;
                        displayName?: string;
                        descriptor?: { readonly durationUs?: number };
                      };
                      const rect = event.currentTarget.getBoundingClientRect();
                      const dropUs = pixelToTime(event.clientX - rect.left, {
                        originUs: 0,
                        pixelsPerSecond: viewport.pixelsPerSecond,
                      });
                      insertAssetOnTrack(track.id, asset, dropUs);
                    } catch {
                      /* ignore malformed payload */
                    }
                  }}
                >
                  {index === 0 &&
                    markers.map((marker) => {
                      const selected = selectedMarkerId === marker.id;
                      return (
                        <div
                          key={marker.id}
                          className={selected ? 'timeline-marker is-selected' : 'timeline-marker'}
                          style={{
                            left: `${timeToPixel(marker.timeUs, { ...viewport, originUs: 0 })}px`,
                          }}
                        >
                          <button
                            type="button"
                            className="timeline-marker-hit"
                            aria-pressed={selected}
                            title={`${marker.label} — Delete to remove`}
                            aria-label={`${marker.label}. Delete to remove.`}
                            onClick={() => {
                              onClearSelection();
                              selectMarker(marker.id);
                              onSeek(marker.timeUs);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              removeMarker(marker.id);
                            }}
                          >
                            <TimelineMarkerIcon />
                          </button>
                          <button
                            type="button"
                            className="timeline-marker-remove"
                            aria-label={`Remove ${marker.label}`}
                            title="Remove marker"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              removeMarker(marker.id);
                            }}
                          >
                            <CloseIcon />
                          </button>
                        </div>
                      );
                    })}
                  {source.clips.map((clip) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      elementKind={timelineElementKindForClip(clip, elementKinds)}
                      {...(clip.kind === 'video' && assetDisplayNames?.[clip.assetId] !== undefined
                        ? { displayName: assetDisplayNames[clip.assetId] }
                        : {})}
                      selected={selectedIds.includes(clip.id)}
                      isDragOver={dragEffectOverClipId === clip.id}
                      maxStartUs={timelineDurationUs - clip.durationUs}
                      viewport={{ ...viewport, originUs: 0 }}
                      locked={track.locked}
                      laneIndex={index}
                      splitToolActive={splitToolActive}
                      frameUs={frameUs}
                      onSelect={selectClip}
                      onMove={track.locked ? () => false : moveClip(track.id)}
                      onTrim={track.locked ? () => false : trimClip(track.id)}
                      onContextMenu={(clipId, x, y) => {
                        const target = source.clips.find((c) => c.id === clipId);
                        if (target === undefined) return;
                        openClipMenu(track.id, target, x, y);
                      }}
                      onOpenComposition={openCompoundComposition}
                      onSplitHover={(atUs) => {
                        if (splitToolActive) setSplitGuideUs(atUs);
                      }}
                      onSplitAt={(atUs) => {
                        if (splitToolActive) {
                          dispatchSplitAt(track.id, clip.id, atUs);
                        }
                      }}
                    />
                  ))}
                  {transitions
                    .filter(
                      (transition) =>
                        transition.trackId === source.id &&
                        source.clips.some((clip) => clip.id === transition.leftClipId) &&
                        source.clips.some((clip) => clip.id === transition.rightClipId),
                    )
                    .map((transition) => {
                      const right = source.clips.find((clip) => clip.id === transition.rightClipId);
                      if (right === undefined) return null;
                      return (
                        <TimelineTransitionJunction
                          key={transition.id}
                          transition={transition}
                          boundaryUs={right.startUs}
                          viewport={{ ...viewport, originUs: 0 }}
                          onSeek={onSeek}
                        />
                      );
                    })}
                </span>
              </div>
            );
          })}

          {selectedObject !== undefined && onPropertyDispatch !== undefined && (
            <TimelinePropertyLanes
              object={selectedObject}
              playheadUs={playheadUs}
              frameUs={frameUs}
              pixelsPerSecond={viewport.pixelsPerSecond}
              laneWidthPx={laneWidthPx}
              scrollLeft={tracksScrollLeft}
              viewportWidthPx={Math.max(1, tracksViewportWidthPx)}
              showAnimatedOnly={showAnimatedProperties}
              onShowAnimatedOnlyChange={setShowAnimatedProperties}
              onSeek={onSeek}
              onDispatch={onPropertyDispatch}
            />
          )}

          {/* Virtual empty lanes: let the grid reach the bottom of the panel and
              create a real track when media is dropped into an unused lane. */}
          {Array.from({ length: virtualLaneCount }, (_, laneIndex) => (
            <div
              className="timeline-track timeline-virtual-lane"
              key={`__virtual_${laneIndex}__`}
              style={{ height: EMPTY_LANE_HEIGHT_PX }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(JOY_MEDIA_ASSET_DND)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const raw = event.dataTransfer.getData(JOY_MEDIA_ASSET_DND);
                if (!raw) return;
                try {
                  const asset = JSON.parse(raw) as {
                    assetId: string;
                    kind: string;
                    displayName?: string;
                    descriptor?: { readonly durationUs?: number };
                  };
                  const rect = event.currentTarget.getBoundingClientRect();
                  const dropUs = pixelToTime(event.clientX - rect.left, {
                    originUs: 0,
                    pixelsPerSecond: viewport.pixelsPerSecond,
                  });
                  createTrackFromAssetDrop(asset, dropUs);
                } catch {
                  /* ignore malformed payload */
                }
              }}
            >
              <div className="timeline-track-header timeline-virtual-lane-header">
                <span className="timeline-virtual-lane-plus" aria-hidden="true">
                  +
                </span>
              </div>
              <span
                className="timeline-lane timeline-virtual-lane-canvas"
                style={{ minWidth: `${laneWidthPx}px` }}
                title="Drop media to add a track here"
              />
            </div>
          ))}

          {dataLanesOpen &&
            dataLanes !== undefined &&
            artifacts !== undefined &&
            onDispatchArtifacts !== undefined && (
              <DataLaneDrawer
                lanes={dataLanes}
                artifacts={artifacts}
                laneWidthPx={laneWidthPx}
                playheadUs={playheadUs}
                timeToPixel={(timeUs) => timeToPixel(timeUs, { ...viewport, originUs: 0 })}
                onDispatchArtifacts={onDispatchArtifacts}
                onSeek={onSeek}
              />
            )}
        </div>
      </div>

      {menu !== undefined && <TimelineContextMenu menu={menu} onClose={() => setMenu(undefined)} />}
    </article>
  );
}
