import type { CSSProperties } from 'react';
import {
  canvasToScreenPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';
import type { SnapBox, SnapTarget } from './snap-targets.js';

const READOUT_WIDTH_PX = 264;
const READOUT_HEIGHT_PX = 34;
const CURSOR_GAP_PX = 12;
const VIEWPORT_GAP_PX = 4;

/** Short-lived information shown during a Monitor move or scale gesture. */
export interface MonitorSnapFeedback {
  readonly box: SnapBox;
  readonly angle: number;
  /** Cursor position in authored frame pixels. */
  readonly cursor: { readonly x: number; readonly y: number };
  readonly guides: readonly SnapTarget[];
}

function numberText(value: number): string {
  const rounded = Math.round(value);
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function readoutText(box: SnapBox, angle: number): string {
  return `X ${numberText(box.x)}  Y ${numberText(box.y)}  W ${numberText(box.width)}  H ${numberText(box.height)}  A ${numberText(angle)}°`;
}

function readoutPosition(
  cursor: { readonly x: number; readonly y: number },
  view: MonitorViewState,
  viewport: MonitorSize,
): CSSProperties {
  const point = canvasToScreenPoint(view, cursor);
  const width = Math.min(READOUT_WIDTH_PX, Math.max(0, viewport.width - VIEWPORT_GAP_PX * 2));
  const height = Math.min(READOUT_HEIGHT_PX, Math.max(0, viewport.height - VIEWPORT_GAP_PX * 2));
  const nextX =
    point.x + CURSOR_GAP_PX + width > viewport.width - VIEWPORT_GAP_PX
      ? point.x - CURSOR_GAP_PX - width
      : point.x + CURSOR_GAP_PX;
  const nextY =
    point.y + CURSOR_GAP_PX + height > viewport.height - VIEWPORT_GAP_PX
      ? point.y - CURSOR_GAP_PX - height
      : point.y + CURSOR_GAP_PX;
  return {
    left: `${Math.max(VIEWPORT_GAP_PX, Math.min(nextX, viewport.width - width - VIEWPORT_GAP_PX))}px`,
    top: `${Math.max(VIEWPORT_GAP_PX, Math.min(nextY, viewport.height - height - VIEWPORT_GAP_PX))}px`,
    width: `${width}px`,
  };
}

/** Draws active snap lines and the live box readout above the Monitor picture. */
export function MonitorSnapOverlay({
  feedback,
  view,
  viewportSize,
}: {
  readonly feedback: MonitorSnapFeedback | null;
  readonly view: MonitorViewState;
  readonly viewportSize: MonitorSize;
}) {
  if (feedback === null) return null;
  return (
    <div className="monitor-snap-overlay-layer" data-monitor-snap-overlay="">
      {feedback.guides.length > 0 && (
        <svg
          width={viewportSize.width}
          height={viewportSize.height}
          className="monitor-snap-guides"
          aria-hidden="true"
        >
          {feedback.guides.map((guide, index) => {
            const position =
              guide.axis === 'x'
                ? canvasToScreenPoint(view, { x: guide.position, y: 0 }).x
                : canvasToScreenPoint(view, { x: 0, y: guide.position }).y;
            return (
              <g
                key={`${guide.axis}:${guide.position}:${guide.kind}:${index}`}
                data-monitor-snap-guide={guide.axis}
                data-monitor-snap-kind={guide.kind}
              >
                {guide.axis === 'x' ? (
                  <line x1={position} y1={0} x2={position} y2={viewportSize.height} />
                ) : (
                  <line x1={0} y1={position} x2={viewportSize.width} y2={position} />
                )}
              </g>
            );
          })}
        </svg>
      )}
      <div
        className="monitor-snap-readout"
        data-monitor-snap-readout=""
        style={readoutPosition(feedback.cursor, view, viewportSize)}
      >
        {readoutText(feedback.box, feedback.angle)}
      </div>
    </div>
  );
}
