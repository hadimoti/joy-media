import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRulerTicks,
  clampPixelsPerSecond,
  clipRateLabel,
  duplicateClipCommand,
  fitPixelsPerSecond,
  freezeFrameCommand,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  pixelToTime,
  rippleDelete,
  timeToPixel,
  toggleTrackFlag,
  trimCommand,
  virtualTracks,
  type TimelineViewport,
} from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, SpikeProject } from '@joy-media/project-schema';
import { normalizePlaybackRate } from '@joy-media/project-schema';
import type { TimelineTrackView } from '@joy-media/timeline-engine';
import {
  DuplicateIcon,
  FitWidthIcon,
  LockIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SoloIcon,
  SpeakerOnIcon,
  TrashIcon,
  ZoomInIcon,
  ZoomOutIcon,
  MarkerIcon,
  SelectIcon,
  TrackAddIcon,
} from './icons.js';
import {
  buildClipContextMenu,
  buildEmptyCanvasContextMenu,
  buildTrackHeaderContextMenu,
  buildRulerContextMenu,
  type CommandContext,
  type ContextMenuItem,
} from './commands/timeline-commands.js';
import { ContextMenu } from './ContextMenu.js';
import { TimelineEmptyState } from './TimelineEmptyState.js';
import { TimelineRuler, TimelineTracksGrid } from './TimelineRuler.js';
/** Drags snap to a 100 ms grid, matching the playhead slider's step. */
const SNAP_US = 100_000;
const DRAG_THRESHOLD_PX = 4;
const DEFAULT_PPS = 20;

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
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (ch) => ch.toUpperCase())
    .trim();
}

function hashUnit(seed: string, salt: number): number {
  let h = (salt + 1) * 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 1000 / 1000;
}

function filmstripCellCount(widthPx: number): number {
  return Math.max(2, Math.min(24, Math.floor(widthPx / 28)));
}

/** Voice/audio clips: denser bars as zoom (pps) increases for beat-accurate cuts. */
function waveformBarCount(widthPx: number, pixelsPerSecond: number): number {
  const barPitchPx = Math.max(1.25, Math.min(8, 140 / Math.max(5, pixelsPerSecond)));
  return Math.max(8, Math.min(512, Math.round(widthPx / barPitchPx)));
}

function isVoiceClip(clip: Clip): boolean {
  if (clip.kind !== 'video') return false;
  const id = `${clip.id}\0${clip.assetId}`;
  return /(?:^|[-_])(voice|audio|vo|sfx|music|aiff|wav|mp3|m4a)(?:$|[-_])/i.test(id);
}

function TimelineClip({
  clip,
  selected,
  maxStartUs,
  viewport,
  locked,
  laneIndex,
  splitToolActive,
  frameUs,
  onToggleSelection,
  onMove,
  onTrim,
  onContextMenu,
  onSplitHover,
  onSplitAt,
}: {
  readonly clip: Clip;
  readonly selected: boolean;
  readonly maxStartUs: number;
  readonly viewport: TimelineViewport;
  readonly locked: boolean;
  readonly laneIndex: number;
  readonly splitToolActive: boolean;
  readonly frameUs: number;
  readonly onToggleSelection: (id: string) => void;
  readonly onMove: (clipId: string, newStartUs: number) => boolean;
  readonly onTrim: (clipId: string, edge: 'start' | 'end', timeUs: number) => boolean;
  readonly onContextMenu: (clipId: string, clientX: number, clientY: number) => void;
  readonly onSplitHover: (atUs: number | undefined) => void;
  readonly onSplitAt: (atUs: number) => void;
}) {
  const [dragPx, setDragPx] = useState<number | undefined>(undefined);
  const [trimPreview, setTrimPreview] = useState<
    { edge: 'start' | 'end'; timeUs: number } | undefined
  >(undefined);
  const dragRef = useRef<{ originX: number; moved: boolean } | null>(null);
  const trimRef = useRef<{ edge: 'start' | 'end'; originX: number } | null>(null);
  const pxPerUs = viewport.pixelsPerSecond / 1_000_000;
  const rateBadge = clipRateLabel(clip);
  const voice = isVoiceClip(clip);

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
  const gapPx = 1;
  const layoutWidthPx = Math.max(6, widthPx - gapPx * 2);
  const cellCount = filmstripCellCount(layoutWidthPx);
  const waveCount = waveformBarCount(layoutWidthPx, viewport.pixelsPerSecond);
  const label = clipDisplayName(clip.id.replace(/^voice-/, '').replace(/^clip-/, ''));
  const durationLabel = `${(displayDurationUs / 1_000_000).toFixed(1)}s`;
  const showChrome = layoutWidthPx >= 48;
  const showDuration = layoutWidthPx >= 100;
  const kindClass =
    clip.kind === 'composition'
      ? 'timeline-clip--comp'
      : voice
        ? 'timeline-clip--voice'
        : 'timeline-clip--video';
  const laneClass = `timeline-clip--lane-${Math.min(laneIndex, 3)}`;

  return (
    <button
      className={`timeline-clip ${kindClass} ${laneClass}${dragPx !== undefined || trimPreview !== undefined ? ' dragging' : ''}`}
      aria-pressed={selected}
      title={`${label} · ${(clip.startUs / 1_000_000).toFixed(1)}s–${((clip.startUs + clip.durationUs) / 1_000_000).toFixed(1)}s`}
      style={{
        left: `${timeToPixel(displayStartUs, viewport) + gapPx}px`,
        width: `${layoutWidthPx}px`,
      }}
      onClick={(event) => {
        if (splitToolActive) {
          const atUs = splitTimeFromClientX(event.clientX, event.currentTarget as HTMLElement);
          if (atUs !== undefined) {
            onSplitAt(atUs);
          }
          return;
        }
        if (dragRef.current?.moved !== true && trimRef.current === null) onToggleSelection(clip.id);
        dragRef.current = null;
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(clip.id, event.clientX, event.clientY);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || locked) return;
        if ((event.target as HTMLElement).dataset.trimEdge) return;
        if (splitToolActive) {
          event.preventDefault();
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { originX: event.clientX, moved: false };
      }}
      onPointerMove={(event) => {
        if (splitToolActive) {
          const atUs = splitTimeFromClientX(event.clientX, event.currentTarget);
          onSplitHover(atUs);
          return;
        }
        const trim = trimRef.current;
        if (trim !== null) {
          setTrimPreview({ edge: trim.edge, timeUs: trimTimeUs(trim.edge, event.clientX, trim.originX) });
          return;
        }
        const drag = dragRef.current;
        if (drag === null) return;
        const deltaPx = event.clientX - drag.originX;
        if (Math.abs(deltaPx) > DRAG_THRESHOLD_PX) drag.moved = true;
        if (drag.moved) setDragPx(deltaPx);
      }}
      onPointerUp={(event) => {
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
        event.currentTarget.releasePointerCapture(event.pointerId);
        onMove(clip.id, dropTimeUs(event.clientX - drag.originX));
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
          <span
            className="timeline-clip-trim timeline-clip-trim-start"
            data-trim-edge="start"
            aria-label={`Trim start of ${clip.id}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              (event.currentTarget.parentElement as HTMLElement).setPointerCapture(event.pointerId);
              trimRef.current = { edge: 'start', originX: event.clientX };
            }}
          />
          <span
            className="timeline-clip-trim timeline-clip-trim-end"
            data-trim-edge="end"
            aria-label={`Trim end of ${clip.id}`}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              (event.currentTarget.parentElement as HTMLElement).setPointerCapture(event.pointerId);
              trimRef.current = { edge: 'end', originX: event.clientX };
            }}
          />
        </>
      )}
      {voice ? (
        <span className="timeline-clip-waveform" aria-hidden="true">
          {Array.from({ length: waveCount }, (_, index) => {
            const amp = hashUnit(clip.id, index);
            const beat = index % 8 === 0 ? 0.22 : index % 4 === 0 ? 0.1 : 0;
            const level = Math.min(1, 0.28 + amp * 0.62 + beat);
            const tone = level > 0.78 ? 'is-peak' : level > 0.48 ? '' : 'is-mid';
            return (
              <span
                key={index}
                className={`timeline-clip-wave-bar ${tone}`.trim()}
                style={{ height: `${Math.round(level * 100)}%` }}
              />
            );
          })}
        </span>
      ) : (
        <span className="timeline-clip-filmstrip" aria-hidden="true">
          {Array.from({ length: cellCount }, (_, index) => {
            const t = hashUnit(clip.id, index);
            const light = 14 + Math.round(t * 18);
            return (
              <span
                key={index}
                className="timeline-clip-cell"
                style={{ backgroundColor: `hsl(42 42% ${light}%)` }}
              />
            );
          })}
        </span>
      )}
      {showChrome && (
        <span className="timeline-clip-chrome">
          <span className="timeline-clip-label">{label}</span>
          {showDuration && <span className="timeline-clip-duration">{durationLabel}</span>}
          {rateBadge !== undefined && <span className="timeline-clip-badge">{rateBadge}</span>}
        </span>
      )}
    </button>
  );
}

export const JOY_MEDIA_ASSET_DND = 'application/x-joy-media-asset';

export function TimelinePanel({
  project,
  playheadUs,
  playing,
  selectedIds,
  markers = [],
  onTogglePlayback,
  onSeek,
  onToggleSelection,
  onClearSelection,
  onDispatch,
  onAddMarker,
  onRemoveMarker,
  onEffectDrop,
  onTransitionDrop,
  showToast,
}: {
  readonly project: SpikeProject;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedIds: readonly string[];
  readonly markers?: readonly { readonly id: string; readonly timeUs: number; readonly label: string }[];
  readonly onTogglePlayback: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onClearSelection: () => void;
  readonly onDispatch: (transaction: CommandTransaction) => void;
  readonly onAddMarker?: (timeUs: number, label: string) => void;
  readonly onRemoveMarker?: (id: string) => void;
  readonly onEffectDrop?: (effectId: string, clipId: string, trackId: string) => void;
  readonly onTransitionDrop?: (transitionId: string, leftClipId: string, rightClipId: string, trackId: string) => void;
  readonly showToast?: (message: string, kind: 'info' | 'success' | 'error') => void;
}) {
  const [trackFlags, setTrackFlags] = useState<readonly TimelineTrackView[]>([]);
  const [viewport, setViewport] = useState<TimelineViewport>({
    originUs: 0,
    pixelsPerSecond: DEFAULT_PPS,
  });
  const [autoFit, setAutoFit] = useState(true);
  const [selectToolActive, setSelectToolActive] = useState(true);
  const [splitToolActive, setSplitToolActive] = useState(false);
  const [splitGuideUs, setSplitGuideUs] = useState<number | undefined>(undefined);
  const [tracksHeightPx, setTracksHeightPx] = useState(180);
  const [menu, setMenu] = useState<{ x: number; y: number; items: readonly ContextMenuItem[]; trackId?: string; clipId?: string } | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneMeasureRef = useRef<HTMLDivElement | null>(null);

  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('timeline root composition is unavailable');

  const tracks = composition.tracks.map((track, index) => {
    const saved = trackFlags.find((item) => item.id === track.id);
    return (
      saved ?? {
        id: track.id,
        heightPx: 44,
        locked: false,
        muted: !track.enabled,
        solo: false,
        order: index,
      }
    );
  });

  const visible = useMemo(
    () => virtualTracks(tracks, 0, Math.max(36, tracksHeightPx)),
    [tracks, tracksHeightPx],
  );

  useEffect(() => {
    const root = scrollRef.current;
    if (root === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setTracksHeightPx(entry.contentRect.height);
      const lane = laneMeasureRef.current;
      const width = lane?.clientWidth ?? entry.contentRect.width;
      if (autoFit && width > 0) {
        setViewport((prev) => ({
          ...prev,
          pixelsPerSecond: fitPixelsPerSecond(composition.durationUs, width),
        }));
      }
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [autoFit, composition.durationUs]);

  useEffect(() => {
    if (!autoFit) return;
    const width = laneMeasureRef.current?.clientWidth ?? scrollRef.current?.clientWidth ?? 0;
    if (width <= 0) return;
    setViewport((prev) => ({
      ...prev,
      pixelsPerSecond: fitPixelsPerSecond(composition.durationUs, width),
    }));
  }, [autoFit, composition.durationUs]);

  const toggle = (id: string, flag: 'locked' | 'muted' | 'solo') =>
    setTrackFlags(() => {
      const next = tracks.map((track) => (track.id === id ? toggleTrackFlag(track, flag) : track));
      return next.map(({ id: trackId, heightPx, locked, muted, solo }) => ({
        id: trackId,
        heightPx,
        locked,
        muted,
        solo,
      }));
    });

  const selected = selectedIds
    .map((id) =>
      composition.tracks
        .flatMap((track) => track.clips.map((clip) => ({ clip, track })))
        .find((item) => item.clip.id === id),
    )
    .find((item) => item !== undefined);

  const selectedTrackView =
    selected === undefined ? undefined : tracks.find((t) => t.id === selected.track.id);
  const selectedLocked = selectedTrackView?.locked === true;
  const canDuplicate = selected !== undefined && !selectedLocked;
  const canDelete = selected !== undefined && !selectedLocked;

  const frameUs = useMemo(
    () => frameDurationUs(composition.frameRate),
    [composition.frameRate],
  );

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

  const moveClip = (trackId: string) => (clipId: string, newStartUs: number) => {
    try {
      onDispatch({
        label: `Move ${clipId}`,
        commands: [
          {
            type: 'timeline.moveClip',
            payload: { compositionId: composition.id, trackId, clipId, newStartUs },
          },
        ],
      });
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

  const insertAssetOnTrack = (
    trackId: string,
    asset: { readonly assetId: string; readonly kind: string; readonly displayName?: string },
    dropUs: number,
  ) => {
    const source = composition.tracks.find((t) => t.id === trackId);
    if (source === undefined) return;
    const durationUs = 5_000_000;
    const snapped = Math.round(dropUs / SNAP_US) * SNAP_US;
    let startUs = Math.max(0, snapped);
    const sorted = [...source.clips].sort((a, b) => a.startUs - b.startUs);
    for (const existing of sorted) {
      const end = existing.startUs + existing.durationUs;
      if (startUs < end && startUs + durationUs > existing.startUs) startUs = end;
    }
    const isAudio = asset.kind === 'audio';
    onDispatch({
      label: `Insert ${asset.displayName ?? asset.assetId}`,
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: composition.id,
            trackId,
            clip: {
              id: `${isAudio ? 'voice' : 'clip'}-${asset.assetId}-${Date.now()}`,
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
  };

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

  const dispatchFreeze = (trackId: string, clipId: string) => {
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

  const dispatchRate = (trackId: string, clipId: string, playbackRate: number) => {
    const track = composition.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    const fromFreeze =
      clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) === 0;
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
    timeToPixel(composition.durationUs, { ...viewport, originUs: 0 }),
  );

  const rulerTicks = useMemo(
    () =>
      buildRulerTicks({
        durationUs: composition.durationUs,
        pixelsPerSecond: viewport.pixelsPerSecond,
        originUs: 0,
      }),
    [composition.durationUs, viewport.pixelsPerSecond],
  );

  const seekFromLane = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const timeUs =
      Math.round(pixelToTime(localX, { ...viewport, originUs: 0 }) / SNAP_US) * SNAP_US;
    onSeek(Math.min(composition.durationUs, Math.max(0, timeUs)));
  };

  const applyZoom = (nextPps: number, anchorClientX?: number) => {
    setAutoFit(false);
    const clamped = clampPixelsPerSecond(nextPps);
    const lane = laneMeasureRef.current;
    if (lane !== null && anchorClientX !== undefined) {
      const rect = lane.getBoundingClientRect();
      const localX = anchorClientX - rect.left + (scrollRef.current?.scrollLeft ?? 0);
      const timeUnder = pixelToTime(localX, { originUs: 0, pixelsPerSecond: viewport.pixelsPerSecond });
      const newLocalX = timeToPixel(timeUnder, { originUs: 0, pixelsPerSecond: clamped });
      const scrollLeft = Math.max(0, newLocalX - (anchorClientX - rect.left));
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollLeft = scrollLeft;
      });
    }
    setViewport((prev) => ({ ...prev, pixelsPerSecond: clamped }));
  };

  const fitToWidth = () => {
    setAutoFit(true);
    const width = laneMeasureRef.current?.clientWidth ?? scrollRef.current?.clientWidth ?? 0;
    if (width > 0) {
      setViewport((prev) => ({
        ...prev,
        pixelsPerSecond: fitPixelsPerSecond(composition.durationUs, width),
      }));
    }
  };

  const openClipMenu = (trackId: string, clip: Clip, clientX: number, clientY: number) => {
    const fullTrack = composition.tracks.find((t) => t.id === trackId);

    const ctx: CommandContext = {
      project,
      compositionId: project.rootCompositionId,
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
          case 'timeline.setClipRate':
            dispatchRate(cmd.payload.trackId, cmd.payload.clipId, cmd.payload.playbackRate);
            break;
        }
      }
    });

    setMenu({ x: clientX, y: clientY, items, trackId, clipId: clip.id });
  };

  const handleImportClick = useCallback(() => {
      // Trigger file input for importing media
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'video/*,audio/*,image/*,.srt,.vtt,.ass,.webp,.gif';
      input.onchange = async (event) => {
        const files = Array.from((event.target as HTMLInputElement).files || []);
        if (files.length === 0) return;

        // Import assets into the project
        const composition = project.compositions[project.rootCompositionId];
        if (!composition) return;

        // For each file, create an asset and insert a clip
        for (const file of files) {
          const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const isAudio = file.type.startsWith('audio/');

          onDispatch({
            label: `Import ${file.name}`,
            commands: [
              {
                type: 'timeline.insertClip',
                payload: {
                  compositionId: composition.id,
                  trackId: '', // Will be determined by finding target track
                  clip: {
                    id: `${isAudio ? 'voice' : 'clip'}-${assetId}-${Date.now()}`,
                    kind: 'video',
                    assetId,
                    startUs: 0, // Will be set by finding space
                    durationUs: 5_000_000,
                    sourceInUs: 0,
                  },
                },
              },
            ],
          });

          // Insert clip on first compatible track or create new
          const targetTrack = tracks.find(t =>
            t.id === (isAudio ? 'audio' : 'video') && !t.locked
          );
          if (targetTrack) {
            const dropUs = playheadUs > 0 ? playheadUs : 0;
            insertAssetOnTrack(targetTrack.id, { assetId, kind: isAudio ? 'audio' : 'video', displayName: file.name }, dropUs);
          }
        }
      };
      input.click();
    }, [project, composition, playheadUs, onDispatch, insertAssetOnTrack]);

  const handleAddFromLibrary = useCallback(() => {
    // TODO: Open media library modal
    console.log('Add from library clicked');
  }, []);

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
        <div className="timeline-toolbar-group">
          <button
            className="icon-button"
            onClick={onTogglePlayback}
            aria-label={playing ? 'Pause' : 'Play proxy'}
            title={playing ? 'Pause (Space)' : 'Play proxy (Space)'}
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
            onClick={() => onSeek(Math.min(composition.durationUs, playheadUs + 1_000_000))}
            aria-label="Forward one second"
            title="Forward 1s (→)"
          >
            <SkipForwardIcon />
          </button>
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Add video track"
            data-guide="Add track"
            onClick={() => {
              const order = composition.tracks.length;
              onDispatch({
                label: 'Add track',
                commands: [
                  {
                    type: 'timeline.addTrack',
                    payload: {
                      compositionId: composition.id,
                      track: {
                        id: `V${order + 1}`,
                        kind: 'video',
                        order,
                        enabled: true,
                        clips: [],
                      },
                    },
                  },
                ],
              });
            }}
          >
            <TrackAddIcon />
          </button>
          {onAddMarker !== undefined && (
            <button
              type="button"
              className="icon-button"
              aria-label="Add marker at playhead"
              data-guide="Add marker"
              onClick={() => onAddMarker(playheadUs, `Marker ${markers.length + 1}`)}
            >
              <MarkerIcon />
            </button>
          )}
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group">
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

        <div className="timeline-toolbar-group">
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
            disabled={!canDelete}
            aria-label="Ripple delete"
            title="Ripple delete (Del)"
            onClick={() => {
              if (selected === undefined) return;
              dispatchDelete(selected.track.id, selected.clip.id);
            }}
          >
            <TrashIcon />
          </button>
        </div>

        <span className="timeline-toolbar-sep" aria-hidden="true" />

        <div className="timeline-toolbar-group timeline-toolbar-zoom">
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
            min={MIN_PIXELS_PER_SECOND}
            max={MAX_PIXELS_PER_SECOND}
            step={1}
            value={Math.round(viewport.pixelsPerSecond)}
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
        </div>
      </div>

      <TimelineEmptyState
        project={project}
        _playheadUs={playheadUs}
        compositionDurationUs={composition.durationUs}
        viewportPixelsPerSecond={viewport.pixelsPerSecond}
        onSeek={onSeek}
        onImportClick={handleImportClick}
        onAddFromLibrary={handleAddFromLibrary}
        onContextMenu={(x, y) => {
          const items = buildEmptyCanvasContextMenu(
            handleImportClick,
            handleAddFromLibrary
          );
          setMenu({ x, y, items });
        }}
        onToast={(message) => showToast?.(message, 'info')}
      />

      <div
        className="timeline-tracks"
        ref={scrollRef}
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
          applyZoom(viewport.pixelsPerSecond * factor, event.clientX);
        }}
      >
        <div
          className="timeline-scrub-row"
          style={{ minWidth: `calc(9.5rem + ${laneWidthPx}px)` }}
        >
          <div className="timeline-scrub-gutter">
            <output className="timeline-timecode" aria-live="polite">
              {(playheadUs / 1_000_000).toFixed(2)} s
            </output>
          </div>
          <TimelineRuler
            durationUs={composition.durationUs}
            playheadUs={playheadUs}
            viewport={{ ...viewport, originUs: 0 }}
            widthPx={laneWidthPx}
            ticks={rulerTicks}
            onSeek={onSeek}
            onContextMenu={(timeUs, clientX, clientY) => {
              const items = buildRulerContextMenu((t) => {
                console.log('Add marker at', t); // TODO: implement marker.add command
              }, timeUs);
              setMenu({ x: clientX, y: clientY, items });
            }}
          />
          <span
            className="timeline-playhead timeline-playhead--scrub"
            style={{
              left: `calc(9.5rem + ${timeToPixel(playheadUs, { ...viewport, originUs: 0 })}px)`,
            }}
            aria-hidden="true"
          />
        </div>
        <div className="timeline-tracks-inner" ref={laneMeasureRef}>
          <TimelineTracksGrid ticks={rulerTicks} widthPx={laneWidthPx} />
          <span
            className="timeline-playhead"
            style={{
              left: `calc(9.5rem + ${timeToPixel(playheadUs, { ...viewport, originUs: 0 })}px)`,
            }}
            aria-hidden="true"
          />
          {splitToolActive && splitGuideUs !== undefined && (
            <span
              className="timeline-split-guide"
              style={{
                left: `calc(9.5rem + ${timeToPixel(splitGuideUs, { ...viewport, originUs: 0 })}px)`,
              }}
              aria-hidden="true"
            />
          )}
          {markers.length > 0 && (
            <div className="timeline-marker-rail" style={{ minWidth: `${laneWidthPx}px` }}>
              {markers.map((marker) => (
                <button
                  key={marker.id}
                  type="button"
                  className="timeline-marker"
                  style={{
                    left: `${timeToPixel(marker.timeUs, { ...viewport, originUs: 0 })}px`,
                  }}
                  title={marker.label}
                  onClick={() => onSeek(marker.timeUs)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onRemoveMarker?.(marker.id);
                  }}
                >
                  ▼
                </button>
              ))}
            </div>
          )}
          {visible.map((track, index) => {
            const source = composition.tracks.find((item) => item.id === track.id);
            if (source === undefined) return null;
            const voiceDominant =
              source.clips.length > 0 && source.clips.every((c) => isVoiceClip(c));
            const audioIndex = visible
              .slice(0, index + 1)
              .filter((t) => {
                const s = composition.tracks.find((item) => item.id === t.id);
                return s !== undefined && s.clips.length > 0 && s.clips.every((c) => isVoiceClip(c));
              }).length;
            return (
              <div className="timeline-track" key={track.id} style={{ height: track.heightPx }}>
                <div className="timeline-track-header" onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const items = buildTrackHeaderContextMenu(
                      track.id,
                      () => {
                        const order = composition.tracks.length;
                        onDispatch({
                          label: 'Add video track',
                          commands: [{
                            type: 'timeline.addTrack',
                            payload: {
                              compositionId: composition.id,
                              track: {
                                id: `V${order + 1}`,
                                kind: 'video',
                                order,
                                enabled: true,
                                clips: [],
                              },
                            },
                          }],
                        });
                      },
                      () => {
                        onDispatch({
                          label: `Remove ${track.id}`,
                          commands: [{
                            type: 'timeline.removeTrack',
                            payload: { compositionId: composition.id, trackId: track.id },
                          }],
                        });
                      },
                      (enabled: boolean) => {
                        onDispatch({
                          label: enabled ? `Enable ${track.id}` : `Mute ${track.id}`,
                          commands: [{
                            type: 'property.setTrackEnabled',
                            payload: {
                              compositionId: composition.id,
                              trackId: track.id,
                              enabled,
                            },
                          }],
                        });
                      },
                      source.enabled ?? true
                    );
                    setMenu({ x: event.clientX, y: event.clientY, items });
                  }}>
                  <div className="timeline-track-label">
                    <span className="track-code" dir="ltr">
                      {voiceDominant ? `A${audioIndex}` : `V${index + 1}`}
                    </span>
                    <span className="track-name" dir="ltr" title={track.id}>
                      {voiceDominant
                        ? audioIndex === 1
                          ? 'Voice'
                          : `Audio ${audioIndex}`
                        : index === 0
                          ? 'Main Video'
                          : index === 1
                            ? 'B-roll'
                            : `Video ${index + 1}`}
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    aria-pressed={track.locked}
                    aria-label={`Lock ${track.id}`}
                    title={track.locked ? 'Unlock track' : 'Lock track'}
                    onClick={() => toggle(track.id, 'locked')}
                  >
                    <LockIcon />
                  </button>
                  <button
                    className="icon-button"
                    aria-pressed={track.muted}
                    aria-label={`Mute ${track.id}`}
                    title={track.muted ? 'Unmute track' : 'Mute track'}
                    onClick={() => {
                      toggle(track.id, 'muted');
                      onDispatch({
                        label: track.muted ? `Enable ${track.id}` : `Mute ${track.id}`,
                        commands: [
                          {
                            type: 'property.setTrackEnabled',
                            payload: {
                              compositionId: composition.id,
                              trackId: track.id,
                              enabled: track.muted,
                            },
                          },
                        ],
                      });
                    }}
                  >
                    {track.muted ? <MuteIcon /> : <SpeakerOnIcon />}
                  </button>
                  <button
                    className="icon-button"
                    aria-pressed={track.solo}
                    aria-label={`Solo ${track.id}`}
                    title={track.solo ? 'Unsolo track' : 'Solo track'}
                    onClick={() => toggle(track.id, 'solo')}
                  >
                    <SoloIcon />
                  </button>
                  {source.clips.length === 0 && composition.tracks.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove track ${track.id}`}
                      title="Remove empty track"
                      onClick={() =>
                        onDispatch({
                          label: `Remove ${track.id}`,
                          commands: [
                            {
                              type: 'timeline.removeTrack',
                              payload: {
                                compositionId: composition.id,
                                trackId: track.id,
                              },
                            },
                          ],
                        })
                      }
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
                <span
                  className="timeline-lane"
                  style={{ minWidth: `${laneWidthPx}px` }}
                  onPointerDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (splitToolActive) {
                      setSplitGuideUs(undefined);
                      return;
                    }
                    if (selectToolActive) onClearSelection();
                    seekFromLane(event);
                  }}
                  onPointerMove={(event) => {
                    if (!splitToolActive) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const localX = event.clientX - rect.left;
                    const rawUs = pixelToTime(localX, {
                      originUs: 0,
                      pixelsPerSecond: viewport.pixelsPerSecond,
                    });
                    const snapped =
                      Math.round(rawUs / frameUs) * frameUs;
                    const source = composition.tracks.find(
                      (t) => t.id === track.id,
                    );
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
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(JOY_MEDIA_ASSET_DND) &&
                        !event.dataTransfer.types.includes('application/x-joy-effect') &&
                        !event.dataTransfer.types.includes('application/x-joy-transition')) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = track.locked ? 'none' : 'copy';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (track.locked) return;

                    // Effect drop
                    const effectRaw = event.dataTransfer.getData('application/x-joy-effect');
                    if (effectRaw) {
                      try {
                        const payload = JSON.parse(effectRaw) as { kind: string; effectId: string; source: string };
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
                      } catch { /* ignore malformed */ }
                    }

                    // Transition drop
                    const transitionRaw = event.dataTransfer.getData('application/x-joy-transition');
                    if (transitionRaw) {
                      try {
                        const payload = JSON.parse(transitionRaw) as { kind: string; transitionId: string; source: string };
                        const rect = event.currentTarget.getBoundingClientRect();
                        const dropUs = pixelToTime(event.clientX - rect.left, {
                          originUs: 0,
                          pixelsPerSecond: viewport.pixelsPerSecond,
                        });
                        const source = composition.tracks.find((t) => t.id === track.id);
                        if (source === undefined) return;
                        const sorted = [...source.clips].sort((a, b) => a.startUs - b.startUs);
                        for (let i = 0; i < sorted.length - 1; i++) {
                          const left = sorted[i]!;
                          const right = sorted[i + 1]!;
                          const leftEnd = left.startUs + left.durationUs;
                          if (dropUs >= leftEnd && dropUs <= right.startUs) {
                            onTransitionDrop?.(payload.transitionId, left.id, right.id, track.id);
                            return;
                          }
                        }
                      } catch { /* ignore malformed */ }
                    }

                    // Existing media asset drop
                    const raw = event.dataTransfer.getData(JOY_MEDIA_ASSET_DND);
                    if (!raw) return;
                    try {
                      const asset = JSON.parse(raw) as {
                        assetId: string;
                        kind: string;
                        displayName?: string;
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
                  {source.clips.map((clip) => (
                    <TimelineClip
                      key={clip.id}
                      clip={clip}
                      selected={selectedIds.includes(clip.id)}
                      maxStartUs={composition.durationUs - clip.durationUs}
                      viewport={{ ...viewport, originUs: 0 }}
                      locked={track.locked}
                      laneIndex={index}
                      splitToolActive={splitToolActive}
                      frameUs={frameUs}
                      onToggleSelection={onToggleSelection}
                      onMove={track.locked ? () => false : moveClip(track.id)}
                      onTrim={track.locked ? () => false : trimClip(track.id)}
                      onContextMenu={(clipId, x, y) => {
                        const target = source.clips.find((c) => c.id === clipId);
                        if (target === undefined) return;
                        openClipMenu(track.id, target, x, y);
                      }}
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
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {menu !== undefined && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(undefined)}
        />
      )}
    </article>
  );
}
