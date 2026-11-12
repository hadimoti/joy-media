import type { CSSProperties } from 'react';
import type { EditorOverlayIR } from '@joy-media/render-ir';
import type { MonitorSize } from './monitor-view-state.js';

/**
 * The thin selection outline on the Monitor (T-M04). It draws the editor
 * overlay (`EditorOverlayIR`) as SVG above the canvas, in the frame's own
 * pixels, so zoom and pan move it with the picture. It is never painted into
 * the frame, the export or `readPixels`, and it takes no pointer events.
 * No handles and no box yet: that is T-M05.
 */
export function MonitorSelectionOverlay({
  overlay,
  frame,
  frameRect,
  clipIdOf,
}: {
  readonly overlay: EditorOverlayIR;
  readonly frame: MonitorSize;
  /** Where the frame sits in the viewport (`monitorFrameRect`). */
  readonly frameRect: CSSProperties;
  /** The timeline clip of each outlined node (for tests and the live driver). */
  readonly clipIdOf?: (nodeId: string) => string | undefined;
}) {
  if (overlay.selections.length === 0 || frame.width <= 0 || frame.height <= 0) return null;
  return (
    <svg
      className="monitor-selection-overlay"
      style={frameRect}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-monitor-selection={overlay.selections.map((selection) => selection.nodeId).join(' ')}
    >
      {overlay.selections.map((selection) => {
        const corners =
          selection.corners !== undefined && selection.corners.length >= 3
            ? selection.corners
            : [
                { x: selection.x, y: selection.y },
                { x: selection.x + selection.width, y: selection.y },
                { x: selection.x + selection.width, y: selection.y + selection.height },
                { x: selection.x, y: selection.y + selection.height },
              ];
        return (
          <polygon
            key={selection.nodeId}
            className="monitor-selection-outline"
            data-node-id={selection.nodeId}
            data-clip-id={clipIdOf?.(selection.nodeId)}
            points={corners.map((corner) => `${corner.x},${corner.y}`).join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}
