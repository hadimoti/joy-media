import { useEffect, useMemo, useRef, useState } from 'react';
import {
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
  PlusIcon,
  MarkerIcon,
  TrackAddIcon,
} from './icons.js';
import {
  TimelineContextMenu,
  type TimelineContextMenuState,
} from './TimelineContextMenu.js';

/** Drags snap to a 100 ms grid, matching the playhead slider's step. */
const SNAP_US = 100_000;
const DRAG_THRESHOLD_PX = 4;
const DEFAULT_PPS = 20;

function TimelineClip({
  clip,
  selected,
  maxStartUs,
  viewport,
  locked,
  onToggleSelection,
  onMove,
  onTrim,
  onContextMenu,
}: {
  readonly clip: Clip;
  readonly selected: boolean;
  readonly maxStartUs: number;
  readonly viewport: TimelineViewport;
  readonly locked: boolean;
  readonly onToggleSelection: (id: string) => void;
  readonly onMove: (clipId: string, newStartUs: number) => boolean;
  readonly onTrim: (clipId: string, edge: 'start' | 'end', timeUs: number) => boolean;
  readonly onContextMenu: (clipId: string, clientX: number, clientY: number) => void;
}) {
  const [dragPx, setDragPx] = useState<number | undefined>(undefined);
  const [trimPreview, setTrimPreview] = useState<
    { edge: 'start' | 'end'; timeUs: number } | undefined
  >(undefined);
  const dragRef = useRef<{ originX: number; moved: boolean } | null>(null);
  const trimRef = useRef<{ edge: 'start' | 'end'; originX: number } | null>(null);
  const pxPerUs = viewport.pixelsPerSecond / 1_000_000;
  const rateBadge = clipRateLabel(clip);

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

  return (
    <button
      className={`timeline-clip${dragPx !== undefined || trimPreview !== undefined ? ' dragging' : ''}`}
      aria-pressed={selected}
      title={`${clip.id} · ${(clip.startUs / 1_000_000).toFixed(1)}s–${((clip.startUs + clip.durationUs) / 1_000_000).toFixed(1)}s`}
      style={{
        left: `${timeToPixel(displayStartUs, viewport)}px`,
        width: `${Math.max(8, displayDurationUs * pxPerUs)}px`,
      }}
      onClick={() => {
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
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { originX: event.clientX, moved: false };
      }}
      onPointerMove={(event) => {
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
      <span className="timeline-clip-label">{clip.id}</span>
      {rateBadge !== undefined && <span className="timeline-clip-badge">{rateBadge}</span>}
      <span className="timeline-clip-waveform" aria-hidden="true" />
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
  onDispatch,
  onAddMarker,
  onRemoveMarker,
}: {
  readonly project: SpikeProject;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedIds: readonly string[];
  readonly markers?: readonly { readonly id: string; readonly timeUs: number; readonly label: string }[];
  readonly onTogglePlayback: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onDispatch: (transaction: CommandTransaction) => void;
  readonly onAddMarker?: (timeUs: number, label: string) => void;
  readonly onRemoveMarker?: (id: string) => void;
}) {
  const [trackFlags, setTrackFlags] = useState<readonly TimelineTrackView[]>([]);
  const [viewport, setViewport] = useState<TimelineViewport>({
    originUs: 0,
    pixelsPerSecond: DEFAULT_PPS,
  });
  const [autoFit, setAutoFit] = useState(true);
  const [tracksHeightPx, setTracksHeightPx] = useState(180);
  const [menu, setMenu] = useState<TimelineContextMenuState | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const laneMeasureRef = useRef<HTMLDivElement | null>(null);

  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('timeline root composition is unavailable');

  const tracks = composition.tracks.map((track, index) => {
    const saved = trackFlags.find((item) => item.id === track.id);
    return (
      saved ?? {
        id: track.id,
        heightPx: 36,
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
  const selectedEndUs =
    selected === undefined ? undefined : selected.clip.startUs + selected.clip.durationUs;
  const canSplit =
    selected !== undefined &&
    !selectedLocked &&
    playheadUs > selected.clip.startUs &&
    playheadUs < (selectedEndUs ?? 0);
  const canDuplicate = selected !== undefined && !selectedLocked;
  const canDelete = selected !== undefined && !selectedLocked;

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
    onDispatch({
      label: `Insert ${asset.displayName ?? asset.assetId}`,
      commands: [
        {
          type: 'timeline.insertClip',
          payload: {
            compositionId: composition.id,
            trackId,
            clip: {
              id: `clip-${asset.assetId}-${Date.now()}`,
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
    onDispatch({
      label: `Split ${clipId}`,
      commands: [
        {
          type: 'timeline.splitClip',
          payload: {
            compositionId: composition.id,
            trackId,
            clipId,
            atUs: playheadUs,
            newClipId: `${clipId}-split-${playheadUs}`,
          },
        },
      ],
    });
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
    const trackView = tracks.find((t) => t.id === trackId);
    const locked = trackView?.locked === true;
    const endUs = clip.startUs + clip.durationUs;
    const canSplitClip = !locked && playheadUs > clip.startUs && playheadUs < endUs;
    const canSpeed = !locked && clip.kind === 'video';
    const canFreeze = !locked && clip.kind === 'video' && canSplitClip;
    setMenu({
      x: clientX,
      y: clientY,
      clipId: clip.id,
      trackId,
      locked,
      selected: selectedIds.includes(clip.id),
      canSplit: canSplitClip,
      canSpeed,
      canFreeze,
      currentRate: clip.kind === 'video' ? normalizePlaybackRate(clip.playbackRate) : 1,
    });
  };

  return (
    <article className="timeline-panel">
      <div className="timeline-toolbar">
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
        <output className="timeline-timecode">{(playheadUs / 1_000_000).toFixed(2)} s</output>
        <button
          className="icon-button"
          onClick={() => onSeek(Math.min(composition.durationUs, playheadUs + 1_000_000))}
          aria-label="Forward one second"
          title="Forward 1s (→)"
        >
          <SkipForwardIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Add video track"
          title="Add track"
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
            title="Add marker"
            data-guide="Add marker"
            onClick={() => onAddMarker(playheadUs, `Marker ${markers.length + 1}`)}
          >
            <MarkerIcon />
          </button>
        )}
        <input
          aria-label="Playhead"
          className="timeline-playhead-slider"
          type="range"
          min={0}
          max={composition.durationUs}
          step={100_000}
          value={playheadUs}
          onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
        />
        <span className="timeline-toolbar-sep" aria-hidden="true" />
        <button
          className="icon-button"
          disabled={!canSplit}
          aria-label="Split at playhead"
          title="Split at playhead (S)"
          onClick={() => {
            if (selected === undefined) return;
            dispatchSplit(selected.track.id, selected.clip.id);
          }}
        >
          <ScissorsIcon />
        </button>
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
        <div className="timeline-tracks-inner" ref={laneMeasureRef}>
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
            return (
              <div className="timeline-track" key={track.id} style={{ height: track.heightPx }}>
                <div className="timeline-track-header">
                  <div className="timeline-track-label">
                    <span className="track-code" dir="ltr">
                      {`V${index + 1}`}
                    </span>
                    <span className="track-name" dir="ltr" title={track.id}>
                      {index === 0 ? 'Main Video' : index === 1 ? 'B-roll' : `Video ${index + 1}`}
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
                    if (event.target === event.currentTarget) seekFromLane(event);
                  }}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(JOY_MEDIA_ASSET_DND)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = track.locked ? 'none' : 'copy';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (track.locked) return;
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
                      onToggleSelection={onToggleSelection}
                      onMove={track.locked ? () => false : moveClip(track.id)}
                      onTrim={track.locked ? () => false : trimClip(track.id)}
                      onContextMenu={(clipId, x, y) => {
                        const target = source.clips.find((c) => c.id === clipId);
                        if (target === undefined) return;
                        openClipMenu(track.id, target, x, y);
                      }}
                    />
                  ))}
                  <span
                    className="timeline-playhead"
                    style={{
                      left: `${timeToPixel(playheadUs, { ...viewport, originUs: 0 })}px`,
                    }}
                    aria-hidden="true"
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="timeline-zoombar">
        <button
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
          className="icon-button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => applyZoom(viewport.pixelsPerSecond * 1.25)}
        >
          <ZoomInIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Fit timeline to width"
          title="Fit to width"
          aria-pressed={autoFit}
          onClick={fitToWidth}
        >
          <FitWidthIcon />
        </button>
      </div>

      {menu !== undefined && (
        <TimelineContextMenu
          menu={menu}
          onClose={() => setMenu(undefined)}
          onSplit={() => dispatchSplit(menu.trackId, menu.clipId)}
          onDuplicate={() => {
            const track = composition.tracks.find((t) => t.id === menu.trackId);
            const clip = track?.clips.find((c) => c.id === menu.clipId);
            if (clip === undefined) return;
            dispatchDuplicate(menu.trackId, clip);
          }}
          onDelete={() => dispatchDelete(menu.trackId, menu.clipId)}
          onFreeze={() => dispatchFreeze(menu.trackId, menu.clipId)}
          onToggleSelect={() => onToggleSelection(menu.clipId)}
          onSetRate={(rate) => dispatchRate(menu.trackId, menu.clipId, rate)}
        />
      )}
    </article>
  );
}
