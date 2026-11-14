import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { TextGradientPointV1 } from '@joy-media/project-schema';
import type { MonitorOverlay } from './monitor-overlay-model.js';
import { anchorToCanvas, canvasToAnchor } from './monitor-gradient-anchors.js';
import {
  canvasToScreenPoint,
  screenToCanvasPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';

/**
 * The two anchors of a text gradient, drawn on the Monitor above the picture (never in it, the export or
 * `readPixels`). Drag the start or the end anywhere, also beyond the text; the line between them is the
 * direction of the gradient. The dots carry the colours of the first and the last stop.
 */

export interface MonitorGradientAnchorsProps {
  /** The selected text's box. */
  readonly overlay: MonitorOverlay;
  readonly start: TextGradientPointV1;
  readonly end: TextGradientPointV1;
  readonly startColor: string;
  readonly endColor: string;
  readonly view: MonitorViewState;
  readonly viewportSize: MonitorSize;
  /** False while the Hand is in use: the dots let the pointer through. */
  readonly interactive: boolean;
  readonly onChange: (next: {
    readonly start: TextGradientPointV1;
    readonly end: TextGradientPointV1;
  }) => void;
}

type Which = 'start' | 'end';

export function MonitorGradientAnchors({
  overlay,
  start,
  end,
  startColor,
  endColor,
  view,
  viewportSize,
  interactive,
  onChange,
}: MonitorGradientAnchorsProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; which: Which } | null>(null);
  const latest = useRef({ start, end, view, overlay, onChange });
  latest.current = { start, end, view, overlay, onChange };

  if (viewportSize.width <= 0 || viewportSize.height <= 0) return null;

  const startScreen = canvasToScreenPoint(view, anchorToCanvas(overlay.localToCanvas, start));
  const endScreen = canvasToScreenPoint(view, anchorToCanvas(overlay.localToCanvas, end));

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const rect = layerRef.current?.getBoundingClientRect();
    const canvas = screenToCanvasPoint(latest.current.view, {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    });
    const anchor = canvasToAnchor(latest.current.overlay.localToCanvas, canvas);
    if (anchor === undefined) return;
    latest.current.onChange(
      drag.which === 'start'
        ? { start: anchor, end: latest.current.end }
        : { start: latest.current.start, end: anchor },
    );
  };
  const down = (which: Which, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !interactive) return;
    // The dot owns this press: no selection click and no marquee.
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, which };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const up = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    move(event);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const dot = (which: Which, point: { x: number; y: number }, color: string) => (
    <div
      key={which}
      role="button"
      tabIndex={-1}
      className={`monitor-gradient-anchor monitor-gradient-anchor-${which}`}
      data-gradient-anchor={which}
      aria-label={which === 'start' ? 'Gradient start' : 'Gradient end'}
      title={which === 'start' ? 'Gradient start' : 'Gradient end'}
      style={{ left: `${point.x}px`, top: `${point.y}px`, background: color }}
      onPointerDown={(event) => down(which, event)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={(event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
    />
  );

  return (
    <div
      ref={layerRef}
      className={`monitor-gradient-layer${interactive ? '' : ' passive'}`}
      data-monitor-gradient={overlay.elementId}
    >
      <svg
        className="monitor-gradient-line"
        width={viewportSize.width}
        height={viewportSize.height}
        aria-hidden="true"
      >
        <line x1={startScreen.x} y1={startScreen.y} x2={endScreen.x} y2={endScreen.y} />
      </svg>
      {dot('start', startScreen, startColor)}
      {dot('end', endScreen, endColor)}
    </div>
  );
}
