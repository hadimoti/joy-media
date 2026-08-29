import { useCallback, useRef } from 'react';
import {
  formatRulerLabel,
  pixelToTime,
  type RulerTick,
  type TimelineViewport,
} from '@joy-media/timeline-engine';

const SEEK_SNAP_US = 100_000;

export interface TimelineRulerProps {
  readonly durationUs: number;
  readonly playheadUs: number;
  readonly viewport: TimelineViewport;
  readonly widthPx: number;
  readonly ticks: readonly RulerTick[];
  readonly onSeek: (timeUs: number) => void;
  readonly onContextMenu?: (timeUs: number, clientX: number, clientY: number) => void;
}

function snapSeek(timeUs: number, durationUs: number): number {
  const snapped = Math.round(timeUs / SEEK_SNAP_US) * SEEK_SNAP_US;
  return Math.min(durationUs, Math.max(0, snapped));
}

/** NLE scrub ruler — major/minor ticks + pointer seek (role=slider). */
export function TimelineRuler({
  durationUs,
  playheadUs,
  viewport,
  widthPx,
  ticks,
  onSeek,
  onContextMenu,
}: TimelineRulerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = rootRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left;
      const timeUs = pixelToTime(localX, viewport);
      onSeek(snapSeek(timeUs, durationUs));
    },
    [durationUs, onSeek, viewport],
  );

  return (
    <div
      ref={rootRef}
      className="timeline-ruler"
      style={{ width: widthPx }}
      role="slider"
      tabIndex={0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={durationUs}
      aria-valuenow={playheadUs}
      aria-valuetext={formatRulerLabel(playheadUs)}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Home End"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        seekFromClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        seekFromClientX(event.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(event) => {
        const step = SEEK_SNAP_US * (event.shiftKey ? 10 : 1);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          onSeek(snapSeek(playheadUs - step, durationUs));
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          onSeek(snapSeek(playheadUs + step, durationUs));
        } else if (event.key === 'Home') {
          event.preventDefault();
          onSeek(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          onSeek(durationUs);
        }
      }}
      onContextMenu={(event) => {
        if (onContextMenu) {
          event.preventDefault();
          event.stopPropagation();
          const el = event.currentTarget;
          const rect = el.getBoundingClientRect();
          const localX = event.clientX - rect.left;
          const timeUs = pixelToTime(localX, viewport);
          onContextMenu(timeUs, event.clientX, event.clientY);
        }
      }}
    >
      {ticks.map((tick) => (
        <span
          key={`${tick.timeUs}-${tick.major ? 'M' : 'm'}`}
          className={
            tick.major
              ? `timeline-ruler-tick major${tick.timeUs === 0 ? ' timeline-ruler-tick--origin' : ''}`
              : 'timeline-ruler-tick'
          }
          style={{ left: `${tick.xPx}px` }}
          aria-hidden="true"
        >
          {tick.major ? formatRulerLabel(tick.timeUs) : null}
        </span>
      ))}
    </div>
  );
}

export function TimelineTracksGrid({
  ticks,
  widthPx,
}: {
  readonly ticks: readonly RulerTick[];
  readonly widthPx: number;
}) {
  return (
    <div className="timeline-tracks-grid" style={{ width: widthPx }} aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={`${tick.timeUs}-${tick.major ? 'M' : 'm'}`}
          className={tick.major ? 'timeline-grid-line major' : 'timeline-grid-line'}
          style={{ left: `${tick.xPx}px` }}
        />
      ))}
    </div>
  );
}
