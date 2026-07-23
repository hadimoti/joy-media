import { useMemo, useRef, useState } from 'react';
import { rippleDelete, toggleTrackFlag, virtualTracks } from '@joy-media/timeline-engine';
import type { CommandTransaction } from '@joy-media/commands';
import type { Clip, SpikeProject } from '@joy-media/project-schema';
import type { TimelineTrackView } from '@joy-media/timeline-engine';
import {
  LockIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SoloIcon,
  TrashIcon,
  TrimIcon,
} from './icons.js';

const PX_PER_SECOND = 20;
const PX_PER_US = PX_PER_SECOND / 1_000_000;
/** Drags snap to a 100 ms grid, matching the playhead slider's step. */
const SNAP_US = 100_000;
const DRAG_THRESHOLD_PX = 4;

function TimelineClip({
  clip,
  selected,
  maxStartUs,
  onToggleSelection,
  onMove,
}: {
  readonly clip: Clip;
  readonly selected: boolean;
  readonly maxStartUs: number;
  readonly onToggleSelection: (id: string) => void;
  readonly onMove: (clipId: string, newStartUs: number) => boolean;
}) {
  const [dragPx, setDragPx] = useState<number | undefined>(undefined);
  const dragRef = useRef<{ originX: number; moved: boolean } | null>(null);

  const dropTimeUs = (deltaPx: number): number => {
    const rawUs = clip.startUs + deltaPx / PX_PER_US;
    const snapped = Math.round(rawUs / SNAP_US) * SNAP_US;
    return Math.min(maxStartUs, Math.max(0, snapped));
  };

  return (
    <button
      className={`timeline-clip${dragPx !== undefined ? ' dragging' : ''}`}
      aria-pressed={selected}
      title={`${clip.id} · ${(clip.startUs / 1_000_000).toFixed(1)}s–${((clip.startUs + clip.durationUs) / 1_000_000).toFixed(1)}s (drag to move)`}
      style={{
        left: `${(clip.startUs + (dragPx !== undefined ? dropTimeUs(dragPx) - clip.startUs : 0)) * PX_PER_US}px`,
        width: `${Math.max(8, clip.durationUs * PX_PER_US)}px`,
      }}
      onClick={() => {
        if (dragRef.current?.moved !== true) onToggleSelection(clip.id);
        dragRef.current = null;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { originX: event.clientX, moved: false };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        const deltaPx = event.clientX - drag.originX;
        if (Math.abs(deltaPx) > DRAG_THRESHOLD_PX) drag.moved = true;
        if (drag.moved) setDragPx(deltaPx);
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        setDragPx(undefined);
        if (drag === null || !drag.moved) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onMove(clip.id, dropTimeUs(event.clientX - drag.originX));
      }}
      onPointerCancel={() => {
        setDragPx(undefined);
        dragRef.current = null;
      }}
    >
      {clip.id}
    </button>
  );
}

export function TimelinePanel({
  project,
  playheadUs,
  playing,
  selectedIds,
  onTogglePlayback,
  onSeek,
  onToggleSelection,
  onDispatch,
}: {
  readonly project: SpikeProject;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedIds: readonly string[];
  readonly onTogglePlayback: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onDispatch: (transaction: CommandTransaction) => void;
}) {
  const [trackFlags, setTrackFlags] = useState<readonly TimelineTrackView[]>([]);
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
  const visible = useMemo(() => virtualTracks(tracks, 0, 180), [tracks]);
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
  const selectedEndUs =
    selected === undefined ? undefined : selected.clip.startUs + selected.clip.durationUs;
  const canSplit =
    selected !== undefined &&
    playheadUs > selected.clip.startUs &&
    playheadUs < (selectedEndUs ?? 0);

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
      // Overlapping or otherwise invalid drop: the clip snaps back untouched.
      return false;
    }
  };

  const laneWidthPx = composition.durationUs * PX_PER_US;
  const seekFromLane = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const timeUs = Math.round((event.clientX - rect.left) / PX_PER_US / SNAP_US) * SNAP_US;
    onSeek(Math.min(composition.durationUs, Math.max(0, timeUs)));
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
        <output>{(playheadUs / 1_000_000).toFixed(2)} s</output>
        <button
          className="icon-button"
          onClick={() => onSeek(Math.min(composition.durationUs, playheadUs + 1_000_000))}
          aria-label="Forward one second"
          title="Forward 1s (→)"
        >
          <SkipForwardIcon />
        </button>
        <input
          aria-label="Playhead"
          type="range"
          min={0}
          max={composition.durationUs}
          step={100_000}
          value={playheadUs}
          onChange={(event) => onSeek(event.currentTarget.valueAsNumber)}
        />
      </div>
      {selected !== undefined && (
        <div className="timeline-toolbar" aria-label="Selected clip actions">
          <strong>{selected.clip.id}</strong>
          <button
            className="icon-button"
            disabled={!canSplit}
            aria-label="Split at playhead"
            title="Split at playhead (S)"
            onClick={() =>
              onDispatch({
                label: `Split ${selected.clip.id}`,
                commands: [
                  {
                    type: 'timeline.splitClip',
                    payload: {
                      compositionId: composition.id,
                      trackId: selected.track.id,
                      clipId: selected.clip.id,
                      atUs: playheadUs,
                      newClipId: `${selected.clip.id}-split-${playheadUs}`,
                    },
                  },
                ],
              })
            }
          >
            <ScissorsIcon />
          </button>
          <button
            className="icon-button"
            disabled={selected.clip.durationUs <= 1_000_000}
            aria-label="Trim one second off the end"
            title="Trim 1s off the end"
            onClick={() =>
              onDispatch({
                label: `Trim ${selected.clip.id}`,
                commands: [
                  {
                    type: 'timeline.trimClipEnd',
                    payload: {
                      compositionId: composition.id,
                      trackId: selected.track.id,
                      clipId: selected.clip.id,
                      newEndUs: selectedEndUs! - 1_000_000,
                    },
                  },
                ],
              })
            }
          >
            <TrimIcon />
          </button>
          <button
            className="icon-button"
            aria-label="Ripple delete"
            title="Ripple delete (Del)"
            onClick={() =>
              onDispatch(
                rippleDelete(
                  composition.id,
                  selected.track.id,
                  selected.track.clips.map((clip) => ({
                    id: clip.id,
                    startUs: clip.startUs,
                    durationUs: clip.durationUs,
                  })),
                  selected.clip.id,
                ),
              )
            }
          >
            <TrashIcon />
          </button>
        </div>
      )}
      <div className="timeline-tracks">
        {visible.map((track) => {
          const source = composition.tracks.find((item) => item.id === track.id);
          if (source === undefined) return null;
          return (
            <div className="timeline-track" key={track.id}>
              <strong dir="ltr" title={track.id}>
                {track.id}
              </strong>
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
                onClick={() => toggle(track.id, 'muted')}
              >
                <MuteIcon />
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
              <span
                className="timeline-lane"
                style={{ minWidth: `${laneWidthPx}px` }}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) seekFromLane(event);
                }}
              >
                {source.clips.map((clip) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    selected={selectedIds.includes(clip.id)}
                    maxStartUs={composition.durationUs - clip.durationUs}
                    onToggleSelection={onToggleSelection}
                    onMove={track.locked ? () => false : moveClip(track.id)}
                  />
                ))}
                <span
                  className="timeline-playhead"
                  style={{ left: `${playheadUs * PX_PER_US}px` }}
                  aria-hidden="true"
                />
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}
