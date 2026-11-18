import type { CSSProperties } from 'react';
import type { NodeBounds } from '@joy-media/render-ir';
import type { MonitorSize } from './monitor-view-state.js';

export interface MonitorHoverOutlineTarget {
  readonly id: string;
  readonly bounds: Pick<NodeBounds, 'corners'>;
}

/** A pointer-only outline, drawn in authored frame pixels above the Monitor canvas. */
export function MonitorHoverOutline({
  target,
  frame,
  frameRect,
}: {
  readonly target: MonitorHoverOutlineTarget | null;
  readonly frame: MonitorSize;
  readonly frameRect: CSSProperties;
}) {
  if (target === null || frame.width <= 0 || frame.height <= 0) return null;
  const points = target.bounds.corners.map((corner) => `${corner.x},${corner.y}`).join(' ');
  return (
    <svg
      className="monitor-hover-outline-layer"
      style={frameRect}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-monitor-hover={target.id}
    >
      <polygon
        className="monitor-hover-outline-keyline"
        points={points}
        vectorEffect="non-scaling-stroke"
      />
      <polygon
        className="monitor-hover-outline"
        points={points}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
