import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { MonitorViewController } from './MonitorViewport.js';
import {
  monitorScrollThumbs,
  monitorShowsNavigation,
  navigatorGeometry,
  panDeltaForThumbDrag,
  viewCentredOnNavigatorPoint,
  type ScrollThumb,
} from './monitor-hand.js';
import type { MonitorViewState } from './monitor-view-state.js';

/** A small Fit picture of the frame (RGBA), or undefined when none is ready. */
export type MonitorThumbnailReader = (
  maxWidth: number,
  maxHeight: number,
) =>
  { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray } | undefined;

/** How often the navigator picture is refreshed while it shows. */
const THUMBNAIL_REFRESH_MS = 500;

interface MonitorNavigationProps {
  readonly controller: MonitorViewController;
  readonly readThumbnail?: MonitorThumbnailReader | undefined;
}

/**
 * Thin scrollbars and the navigator (ADR-0046 section 3.4). They show only when
 * zoomed in past 100 per cent. Dragging a thumb or the navigator frame pans;
 * the pan stays clamped by the view controller.
 */
export function MonitorNavigation({ controller, readThumbnail }: MonitorNavigationProps) {
  if (!monitorShowsNavigation(controller.view)) return null;
  const thumbs = monitorScrollThumbs(controller.view, controller.viewportSize, controller.frame);
  return (
    <>
      {thumbs.horizontal !== undefined && (
        <MonitorScrollbar axis="x" thumb={thumbs.horizontal} controller={controller} />
      )}
      {thumbs.vertical !== undefined && (
        <MonitorScrollbar axis="y" thumb={thumbs.vertical} controller={controller} />
      )}
      <MonitorNavigator controller={controller} readThumbnail={readThumbnail} />
    </>
  );
}

function stop(event: ReactPointerEvent) {
  // The viewport's pointer router must not also pan or select.
  event.stopPropagation();
  event.preventDefault();
}

function MonitorScrollbar({
  axis,
  thumb,
  controller,
}: {
  readonly axis: 'x' | 'y';
  readonly thumb: ScrollThumb;
  readonly controller: MonitorViewController;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: number; start: number; view: MonitorViewState } | null>(null);
  const horizontal = axis === 'x';
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    stop(event);
    dragRef.current = {
      id: event.pointerId,
      start: horizontal ? event.clientX : event.clientY,
      view: controller.view,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (drag === null || drag.id !== event.pointerId || track === null) return;
    const delta = (horizontal ? event.clientX : event.clientY) - drag.start;
    const trackLength = horizontal ? track.clientWidth : track.clientHeight;
    const content = horizontal
      ? controller.frame.width * drag.view.zoom
      : controller.frame.height * drag.view.zoom;
    const pan = panDeltaForThumbDrag(delta, trackLength, content);
    controller.setView(
      horizontal
        ? { ...drag.view, panX: drag.view.panX + pan }
        : { ...drag.view, panY: drag.view.panY + pan },
    );
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };
  const position = `${thumb.start * 100}%`;
  const size = `${Math.max(thumb.size * 100, 2)}%`;
  return (
    <div
      ref={trackRef}
      className={`monitor-scrollbar monitor-scrollbar-${axis}`}
      aria-hidden="true"
    >
      <div
        className="monitor-scrollbar-thumb"
        style={horizontal ? { left: position, width: size } : { top: position, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
}

function MonitorNavigator({ controller, readThumbnail }: MonitorNavigationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ id: number; offsetX: number; offsetY: number } | null>(null);
  const geometry = navigatorGeometry(controller.view, controller.viewportSize, controller.frame);
  const width = Math.round(geometry.width);
  const height = Math.round(geometry.height);

  useEffect(() => {
    if (readThumbnail === undefined) return;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const pixels = readThumbnail(canvas.width, canvas.height);
      const context = canvas.getContext('2d');
      if (pixels === undefined || context === null || typeof ImageData === 'undefined') return;
      const image = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (pixels.width === canvas.width && pixels.height === canvas.height) {
        context.putImageData(image, 0, 0);
        return;
      }
      void createImageBitmap(image)
        .then((bitmap) => {
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
        })
        .catch(() => undefined);
    };
    draw();
    const timer = window.setInterval(draw, THUMBNAIL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [readThumbnail, width, height]);

  const pointInNavigator = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const centreOn = (x: number, y: number) =>
    controller.setView(
      viewCentredOnNavigatorPoint(
        controller.view,
        controller.viewportSize,
        controller.frame,
        { x, y },
        geometry.scale,
      ),
    );
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    stop(event);
    const point = pointInNavigator(event);
    const { visible } = geometry;
    const inside =
      point.x >= visible.x &&
      point.x <= visible.x + visible.width &&
      point.y >= visible.y &&
      point.y <= visible.y + visible.height;
    const centreX = visible.x + visible.width / 2;
    const centreY = visible.y + visible.height / 2;
    // Grab the frame where it was clicked; a click outside it jumps there first.
    const offsetX = inside ? point.x - centreX : 0;
    const offsetY = inside ? point.y - centreY : 0;
    dragRef.current = { id: event.pointerId, offsetX, offsetY };
    if (!inside) centreOn(point.x, point.y);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.id !== event.pointerId) return;
    const point = pointInNavigator(event);
    centreOn(point.x - drag.offsetX, point.y - drag.offsetY);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id === event.pointerId) dragRef.current = null;
  };

  return (
    <div
      className="monitor-navigator"
      style={{ width: `${width}px`, height: `${height}px` }}
      title="Navigator: drag the frame to move around"
      data-monitor-navigator=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <canvas ref={canvasRef} width={Math.max(1, width)} height={Math.max(1, height)} />
      <div
        className="monitor-navigator-frame"
        style={{
          left: `${geometry.visible.x}px`,
          top: `${geometry.visible.y}px`,
          width: `${geometry.visible.width}px`,
          height: `${geometry.visible.height}px`,
        }}
      />
    </div>
  );
}
