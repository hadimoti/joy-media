import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { NodePoint } from '@joy-media/render-ir';
import type {
  MonitorOverlay,
  MonitorOverlayAnchor,
  MonitorOverlayHandle,
} from './monitor-overlay-model.js';
import type { MonitorHandle } from './monitor-transform-maths.js';
import type { MonitorTransformDrag, MonitorTransformGesture } from './monitor-transform-drag.js';
import { TRANSFORM_BLOCK_MESSAGES } from './monitor-transform-targets.js';
import {
  canvasToScreenPoint,
  screenToCanvasPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';

/**
 * The free-transform box on the Monitor (ADR-0046 section 5, T-M05a): eight
 * scale handles and a rotate handle around the selected element, drawn in
 * HTML and SVG above the canvas in screen pixels (so handles keep their size
 * at any zoom). It is never drawn into the picture, the export or
 * `readPixels`. Only the handles take the pointer; a drag inside the box is
 * routed by the viewport (`MonitorViewportSelection.dragElement`).
 *
 * T-M05b: one element also shows its anchor point, which can be dragged; with
 * several elements selected a group box around them carries the handles, which
 * scale and turn the group as one.
 */

const PRIMARY_BUTTON = 0;

const HANDLE_LABELS: Readonly<Record<MonitorHandle, string>> = {
  nw: 'Scale from the top-left corner',
  n: 'Scale from the top edge',
  ne: 'Scale from the top-right corner',
  e: 'Scale from the right edge',
  se: 'Scale from the bottom-right corner',
  s: 'Scale from the bottom edge',
  sw: 'Scale from the bottom-left corner',
  w: 'Scale from the left edge',
  rotate: 'Rotate (Shift snaps to 15 degrees)',
};

const ANCHOR_LABEL = 'Anchor point: drag to move the point the element turns about';

function gestureFor(handle: MonitorHandle, group: boolean): MonitorTransformGesture {
  if (group)
    return handle === 'rotate' ? { kind: 'group-rotate' } : { kind: 'group-scale', handle };
  return handle === 'rotate' ? { kind: 'rotate' } : { kind: 'scale', handle };
}

export interface MonitorTransformBoxProps {
  readonly overlays: readonly MonitorOverlay[];
  /** The group box when several elements are selected (T-M05b). */
  readonly group?: MonitorOverlay | undefined;
  readonly view: MonitorViewState;
  readonly viewportSize: MonitorSize;
  /** False while the Hand is in use: the handles let the pointer through. */
  readonly interactive: boolean;
  /** Starts a handle gesture at a canvas point (`undefined` when not allowed). */
  readonly startGesture: (
    gesture: MonitorTransformGesture,
    start: NodePoint,
  ) => MonitorTransformDrag | undefined;
}

export function MonitorTransformBox({
  overlays,
  group,
  view,
  viewportSize,
  interactive,
  startGesture,
}: MonitorTransformBoxProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; drag: MonitorTransformDrag } | null>(null);
  const latestView = useRef(view);
  latestView.current = view;

  if (overlays.length === 0 || viewportSize.width <= 0 || viewportSize.height <= 0) return null;

  const canvasPoint = (event: { clientX: number; clientY: number }): NodePoint => {
    const rect = layerRef.current?.getBoundingClientRect();
    return screenToCanvasPoint(latestView.current, {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    });
  };
  const screen = (point: NodePoint) => canvasToScreenPoint(view, point);

  const onPointerDown = (
    gesture: MonitorTransformGesture,
    blocked: MonitorOverlayHandle['blocked'],
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== PRIMARY_BUTTON || !interactive) return;
    // The handle owns this press: no selection click and no marquee.
    event.stopPropagation();
    event.preventDefault();
    if (blocked !== undefined) return;
    const drag = startGesture(gesture, canvasPoint(event));
    if (drag === undefined) return;
    dragRef.current = { pointerId: event.pointerId, drag };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    current.drag.update(canvasPoint(event), { shift: event.shiftKey, alt: event.altKey });
  };
  const finish = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (commit)
      current.drag.update(canvasPoint(event), { shift: event.shiftKey, alt: event.altKey });
    current.drag.end(commit);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const boxes = group === undefined ? overlays : [...overlays, group];
  const anchorOf = (overlay: MonitorOverlay, anchor: MonitorOverlayAnchor) => {
    const point = screen(anchor.point);
    const blocked = anchor.blocked !== undefined;
    return (
      <div
        key={`${overlay.elementId}:anchor`}
        role="button"
        tabIndex={-1}
        className={`monitor-transform-anchor${blocked ? ' blocked' : ''}`}
        data-monitor-anchor={overlay.elementId}
        data-node-id={overlay.elementId}
        data-clip-id={overlay.clipId}
        aria-label={ANCHOR_LABEL}
        aria-disabled={blocked ? 'true' : undefined}
        title={
          anchor.blocked === undefined ? ANCHOR_LABEL : TRANSFORM_BLOCK_MESSAGES[anchor.blocked]
        }
        style={{ left: `${point.x}px`, top: `${point.y}px` }}
        onPointerDown={(event) => onPointerDown({ kind: 'anchor' }, anchor.blocked, event)}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => finish(event, true)}
        onPointerCancel={(event) => finish(event, false)}
        onLostPointerCapture={(event) => finish(event, false)}
      />
    );
  };

  return (
    <div
      ref={layerRef}
      className={`monitor-transform-layer${interactive ? '' : ' passive'}`}
      data-monitor-transform={overlays.map((overlay) => overlay.elementId).join(' ')}
    >
      <svg
        className="monitor-transform-lines"
        width={viewportSize.width}
        height={viewportSize.height}
        aria-hidden="true"
      >
        {boxes.map((overlay) => {
          const rotate = overlay.handles.find((handle) => handle.id === 'rotate');
          const top = screen(overlay.topCenter);
          const knob = rotate === undefined ? undefined : screen(rotate.point);
          return (
            <g key={overlay.elementId} data-node-id={overlay.elementId}>
              <polygon
                className={`monitor-transform-outline${overlay.group === true ? ' group' : ''}`}
                points={overlay.corners
                  .map((corner) => {
                    const point = screen(corner);
                    return `${point.x},${point.y}`;
                  })
                  .join(' ')}
              />
              {knob !== undefined && (
                <line
                  className="monitor-transform-stem"
                  x1={top.x}
                  y1={top.y}
                  x2={knob.x}
                  y2={knob.y}
                />
              )}
            </g>
          );
        })}
      </svg>
      {boxes.flatMap((overlay) =>
        overlay.handles.map((handle) => {
          const point = screen(handle.point);
          const blocked = handle.blocked !== undefined;
          return (
            <div
              key={`${overlay.elementId}:${handle.id}`}
              role="button"
              tabIndex={-1}
              className={`monitor-transform-handle monitor-transform-handle-${handle.id}${
                blocked ? ' blocked' : ''
              }`}
              data-monitor-handle={handle.id}
              data-node-id={overlay.elementId}
              data-clip-id={overlay.clipId}
              aria-label={HANDLE_LABELS[handle.id]}
              aria-disabled={blocked ? 'true' : undefined}
              title={
                handle.blocked === undefined
                  ? HANDLE_LABELS[handle.id]
                  : TRANSFORM_BLOCK_MESSAGES[handle.blocked]
              }
              style={{ left: `${point.x}px`, top: `${point.y}px` }}
              onPointerDown={(event) =>
                onPointerDown(gestureFor(handle.id, overlay.group === true), handle.blocked, event)
              }
              onPointerMove={onPointerMove}
              onPointerUp={(event) => finish(event, true)}
              onPointerCancel={(event) => finish(event, false)}
              onLostPointerCapture={(event) => finish(event, false)}
            />
          );
        }),
      )}
      {boxes.flatMap((overlay) =>
        overlay.anchor === undefined ? [] : [anchorOf(overlay, overlay.anchor)],
      )}
    </div>
  );
}
