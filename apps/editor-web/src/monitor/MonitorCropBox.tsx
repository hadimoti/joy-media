import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MonitorOverlay } from './monitor-overlay-model.js';
import {
  canvasToScreenPoint,
  screenToCanvasPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';
import { cropWithEdge, type CropEdge, type CropInsets } from '../media-fit-transform.js';

const EDGES: readonly CropEdge[] = ['left', 'top', 'right', 'bottom'];

interface CropDrag {
  readonly edge: CropEdge;
  readonly start: { readonly x: number; readonly y: number };
  readonly crop: CropInsets;
}

function cropBoxCorners(
  overlay: MonitorOverlay,
  original: CropInsets,
  crop: CropInsets,
): readonly { readonly x: number; readonly y: number }[] {
  const visibleWidth = Math.max(0.02, 1 - original.left - original.right);
  const visibleHeight = Math.max(0.02, 1 - original.top - original.bottom);
  const left = (crop.left - original.left) / visibleWidth;
  const right = 1 - (crop.right - original.right) / visibleWidth;
  const top = (crop.top - original.top) / visibleHeight;
  const bottom = 1 - (crop.bottom - original.bottom) / visibleHeight;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = overlay.localToCanvas;
  return [
    { x: a * left + c * top + e, y: b * left + d * top + f },
    { x: a * right + c * top + e, y: b * right + d * top + f },
    { x: a * right + c * bottom + e, y: b * right + d * bottom + f },
    { x: a * left + c * bottom + e, y: b * left + d * bottom + f },
  ];
}

function edgePoint(
  corners: readonly { readonly x: number; readonly y: number }[],
  edge: CropEdge,
): { readonly x: number; readonly y: number } {
  const pair =
    edge === 'left'
      ? [corners[0]!, corners[3]!]
      : edge === 'top'
        ? [corners[0]!, corners[1]!]
        : edge === 'right'
          ? [corners[1]!, corners[2]!]
          : [corners[3]!, corners[2]!];
  const first = pair[0]!;
  const second = pair[1]!;
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

export function MonitorCropBox({
  crop,
  overlay,
  view,
  viewportSize,
  onCommit,
  onClose,
}: {
  readonly crop: CropInsets;
  readonly overlay: MonitorOverlay;
  readonly view: MonitorViewState;
  readonly viewportSize: MonitorSize;
  readonly onCommit: (crop: CropInsets) => void;
  readonly onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<CropDrag | null>(null);
  const [previewCrop, setPreviewCrop] = useState(crop);
  useEffect(() => {
    if (dragRef.current === null) setPreviewCrop(crop);
  }, [crop]);
  const corners = cropBoxCorners(overlay, crop, previewCrop).map((point) =>
    canvasToScreenPoint(view, point),
  );
  const polygon = corners.map((point) => `${point.x},${point.y}`).join(' ');
  const handles = EDGES.map((edge) => ({
    edge,
    point: canvasToScreenPoint(view, edgePoint(cropBoxCorners(overlay, crop, previewCrop), edge)),
  }));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const canvasPoint = (event: { readonly clientX: number; readonly clientY: number }) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return screenToCanvasPoint(view, {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    });
  };

  const onPointerDown = (edge: CropEdge, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { edge, start: canvasPoint(event), crop: previewCrop };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is not available in all test and embedded browsers.
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event);
    const delta = { x: point.x - drag.start.x, y: point.y - drag.start.y };
    const [a = 0, b = 0, c = 0, d = 0] = overlay.localToCanvas;
    const width = Math.hypot(a, b);
    const height = Math.hypot(c, d);
    const visibleWidth = Math.max(0.02, 1 - drag.crop.left - drag.crop.right);
    const visibleHeight = Math.max(0.02, 1 - drag.crop.top - drag.crop.bottom);
    const localX = width === 0 ? 0 : (delta.x * a + delta.y * b) / width;
    const localY = height === 0 ? 0 : (delta.x * c + delta.y * d) / height;
    const horizontal = drag.edge === 'left' || drag.edge === 'right';
    const amount = horizontal ? (localX / width) * visibleWidth : (localY / height) * visibleHeight;
    const sign = drag.edge === 'left' || drag.edge === 'top' ? 1 : -1;
    const next = cropWithEdge(drag.crop, drag.edge, drag.crop[drag.edge] + sign * amount);
    setPreviewCrop(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    if (JSON.stringify(previewCrop) !== JSON.stringify(crop)) onCommit(previewCrop);
  };

  return (
    <div
      ref={rootRef}
      className="monitor-crop-box"
      data-monitor-crop-box=""
      style={{ width: viewportSize.width, height: viewportSize.height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
        setPreviewCrop(crop);
      }}
    >
      <svg
        className="monitor-crop-shade"
        width={viewportSize.width}
        height={viewportSize.height}
        aria-hidden="true"
      >
        <path
          d={`M0 0 H${viewportSize.width} V${viewportSize.height} H0 Z M${polygon} Z`}
          fill="rgb(0 0 0 / 38%)"
          fillRule="evenodd"
        />
        <polygon points={polygon} fill="none" stroke="var(--joy-accent)" strokeWidth="2" />
      </svg>
      {handles.map(({ edge, point }) => (
        <button
          key={edge}
          type="button"
          className="monitor-crop-handle"
          data-crop-handle={edge}
          aria-label={`Crop ${edge} edge`}
          title={`Crop ${edge} edge`}
          style={{ left: point.x, top: point.y }}
          onPointerDown={(event) => onPointerDown(edge, event)}
        />
      ))}
      <button
        type="button"
        className="monitor-crop-done"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={onClose}
      >
        Done
      </button>
    </div>
  );
}
