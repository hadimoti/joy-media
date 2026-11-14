import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  TIMELINE_TRACK_GUTTER_MIN_PX,
  TIMELINE_TRACK_GUTTER_WIDTH_PX,
  clampTimelineTrackGutterWidthPx,
} from './timeline-layout.js';

/** Per-user (per-profile) memory of the Timeline track titles width. */
export const TIMELINE_TRACK_GUTTER_STORAGE_KEY = 'joy-media.timeline.track-gutter-width-px';

export const TIMELINE_TRACK_GUTTER_KEY_STEP_PX = 8;
export const TIMELINE_TRACK_GUTTER_KEY_STEP_LARGE_PX = 32;

/** The remembered width, or the 168 px default when storage is empty, broken or blocked. */
export function readStoredTimelineTrackGutterWidthPx(): number {
  try {
    const raw = globalThis.localStorage?.getItem(TIMELINE_TRACK_GUTTER_STORAGE_KEY);
    if (raw === null || raw === undefined) return TIMELINE_TRACK_GUTTER_WIDTH_PX;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampTimelineTrackGutterWidthPx(parsed)
      : TIMELINE_TRACK_GUTTER_WIDTH_PX;
  } catch {
    return TIMELINE_TRACK_GUTTER_WIDTH_PX;
  }
}

export function writeStoredTimelineTrackGutterWidthPx(widthPx: number): void {
  try {
    globalThis.localStorage?.setItem(
      TIMELINE_TRACK_GUTTER_STORAGE_KEY,
      String(Math.round(widthPx)),
    );
  } catch {
    // The panel works without storage; the width is simply not remembered.
  }
}

/** The width a key asks for, or undefined when the key does not resize. */
export function timelineTrackGutterWidthForKey(
  key: string,
  shiftKey: boolean,
  currentPx: number,
): number | undefined {
  const step = shiftKey
    ? TIMELINE_TRACK_GUTTER_KEY_STEP_LARGE_PX
    : TIMELINE_TRACK_GUTTER_KEY_STEP_PX;
  if (key === 'ArrowLeft') return currentPx - step;
  if (key === 'ArrowRight') return currentPx + step;
  if (key === 'Home') return TIMELINE_TRACK_GUTTER_WIDTH_PX;
  return undefined;
}

interface TimelineTrackGutterHandleProps {
  /** The width the titles column is drawn at. */
  readonly widthPx: number;
  readonly maxPx: number;
  /** Live change while dragging; `commit` marks the end of a gesture or a key press. */
  readonly onResize: (widthPx: number, commit: boolean) => void;
}

/**
 * The thin vertical splitter on the right edge of the Timeline track titles.
 * It sits outside the scroll container, so it stays put while the tracks
 * scroll in either direction; the titles themselves are sticky on the left.
 */
export function TimelineTrackGutterHandle({
  widthPx,
  maxPx,
  onResize,
}: TimelineTrackGutterHandleProps) {
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startWidth: number;
    lastWidth: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The capture is already gone.
    }
    onResize(drag.lastWidth, true);
  };

  return (
    <div
      className={dragging ? 'timeline-gutter-resizer is-dragging' : 'timeline-gutter-resizer'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize track titles"
      aria-valuenow={widthPx}
      aria-valuemin={TIMELINE_TRACK_GUTTER_MIN_PX}
      aria-valuemax={maxPx}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: widthPx,
          lastWidth: widthPx,
        };
        setDragging(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Some hosts refuse capture; the drag still follows while the pointer is over the handle.
        }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const next = drag.startWidth + (event.clientX - drag.startX);
        drag.lastWidth = next;
        onResize(next, false);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={(event) => {
        if (dragRef.current !== null) endDrag(event);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onResize(TIMELINE_TRACK_GUTTER_WIDTH_PX, true);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const next = timelineTrackGutterWidthForKey(event.key, event.shiftKey, widthPx);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(next, true);
      }}
    />
  );
}
