import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ACTION_SAFE_INSET,
  TITLE_SAFE_INSET,
  commitUserGuideDrag,
  gridPositions,
  isPixelGridShown,
  previewAspectRect,
  RULER_THICKNESS_PX,
  rulerTicks,
  safeAreaRect,
  type MonitorFrameRect,
  type MonitorUserGuide,
  type MonitorViewOptions,
} from './monitor-view-options.js';
import {
  canvasToScreenPoint,
  screenToCanvasPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';
import { monitorFrameRect } from './MonitorViewport.js';

/**
 * The editor-only overlays of the Monitor (T-M08, ADR-0046 section 7): safe
 * areas, grid, centre marks, the canvas border, the pixel grid, the Preview
 * overlay (aspect mask) and the rulers with draggable user guides. They are
 * HTML and SVG above the canvas, in the frame's own pixels through the Monitor
 * view. They are never painted into the frame, the export or `readPixels`.
 */

export interface MonitorOverlaysProps {
  readonly view: MonitorViewState;
  readonly frame: MonitorSize;
  /** The viewport size in CSS px. */
  readonly viewportSize: MonitorSize;
  readonly options: MonitorViewOptions;
  readonly onGuidesChange: (guides: readonly MonitorUserGuide[]) => void;
}

/** A guide being dragged: `index` is the guide, undefined a new one from a ruler. */
interface GuideDrag {
  readonly pointerId: number;
  readonly axis: 'x' | 'y';
  readonly index: number | undefined;
  readonly position: number;
}

/** A frame-sized SVG in the frame's own pixels, placed where the frame sits. */
function FrameSvg({
  name,
  frame,
  frameRect,
  className,
  children,
}: {
  readonly name: string;
  readonly frame: MonitorSize;
  readonly frameRect: CSSProperties;
  readonly className: string;
  readonly children: ReactNode;
}) {
  return (
    <svg
      className={`monitor-overlay-svg ${className}`}
      style={frameRect}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-monitor-overlay={name}
    >
      {children}
    </svg>
  );
}

function rectProps(rect: MonitorFrameRect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function MonitorOverlays({
  view,
  frame,
  viewportSize,
  options,
  onGuidesChange,
}: MonitorOverlaysProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<GuideDrag | null>(null);
  const [drag, setDrag] = useState<GuideDrag | null>(null);
  if (!(frame.width > 0) || !(frame.height > 0)) return null;

  const frameRect = monitorFrameRect(view, frame);
  const { zoom, panX, panY } = view;

  /** Canvas coordinate along the axis of a pointer event. */
  const canvasCoordinate = (
    event: ReactPointerEvent<HTMLElement>,
    axis: 'x' | 'y',
  ): number | undefined => {
    const rect = layerRef.current?.getBoundingClientRect();
    if (rect === undefined) return undefined;
    const point = screenToCanvasPoint(view, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    return axis === 'x' ? point.x : point.y;
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    axis: 'x' | 'y',
    index: number | undefined,
  ) => {
    if (event.button !== 0) return;
    // A ruler or guide owns this press: the viewport must not select or pan.
    event.stopPropagation();
    const position = canvasCoordinate(event, axis);
    if (position === undefined) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const next: GuideDrag = { pointerId: event.pointerId, axis, index, position };
    dragRef.current = next;
    setDrag(next);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const position = canvasCoordinate(event, current.axis);
    if (position === undefined) return;
    const next = { ...current, position };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = dragRef.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!commit) return;
    onGuidesChange(
      commitUserGuideDrag(options.guides, current.index, current.axis, current.position, frame),
    );
  };

  const safe = (inset: number) => safeAreaRect(frame, inset);
  const aspect = previewAspectRect(frame, options.previewAspect);
  const pixelGrid = isPixelGridShown(options, zoom);

  // The visible part of the frame, for the pixel grid (kept small at 800 per cent).
  const visibleLeft = Math.max(0, panX);
  const visibleTop = Math.max(0, panY);
  const visibleRight = Math.min(viewportSize.width, panX + frame.width * zoom);
  const visibleBottom = Math.min(viewportSize.height, panY + frame.height * zoom);

  // Rulers sit at the viewport edges; their ticks cover the visible canvas range.
  const canvasLeft = screenToCanvasPoint(view, { x: 0, y: 0 }).x;
  const canvasRight = screenToCanvasPoint(view, { x: viewportSize.width, y: 0 }).x;
  const canvasTop = screenToCanvasPoint(view, { x: 0, y: 0 }).y;
  const canvasBottom = screenToCanvasPoint(view, { x: 0, y: viewportSize.height }).y;
  const topTicks = options.rulers ? rulerTicks(frame.width, zoom, canvasLeft, canvasRight) : [];
  const leftTicks = options.rulers ? rulerTicks(frame.height, zoom, canvasTop, canvasBottom) : [];

  // Guides: the saved ones, with the one being dragged shown where the pointer is.
  const guideItems = options.rulers
    ? options.guides.map((guide, index) =>
        drag?.index === index
          ? { guide: { axis: guide.axis, position: drag.position }, index, dragging: true }
          : { guide, index, dragging: false },
      )
    : [];
  const newGuidePreview =
    options.rulers && drag !== null && drag.index === undefined
      ? { axis: drag.axis, position: drag.position }
      : undefined;

  const guideScreenPosition = (guide: MonitorUserGuide): number =>
    guide.axis === 'x'
      ? canvasToScreenPoint(view, { x: guide.position, y: 0 }).x
      : canvasToScreenPoint(view, { x: 0, y: guide.position }).y;

  const renderGuide = (
    guide: MonitorUserGuide,
    key: string,
    index: number | undefined,
    dragging: boolean,
  ) => {
    const screen = guideScreenPosition(guide);
    const label = `${guide.axis === 'x' ? 'Vertical' : 'Horizontal'} guide at ${Math.round(guide.position)} px`;
    const style: CSSProperties =
      guide.axis === 'x'
        ? { left: `${screen - 3}px`, top: 0, bottom: 0 }
        : { top: `${screen - 3}px`, left: 0, right: 0 };
    return (
      <div
        key={key}
        className={`monitor-guide monitor-guide-${guide.axis}${dragging ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation={guide.axis === 'x' ? 'vertical' : 'horizontal'}
        aria-label={label}
        data-monitor-guide={guide.axis}
        data-monitor-guide-position={Math.round(guide.position)}
        style={style}
        onPointerDown={(event) => beginDrag(event, guide.axis, index)}
      />
    );
  };

  return (
    <div
      ref={layerRef}
      className="monitor-overlay-layer"
      data-monitor-overlays=""
      onPointerMove={moveDrag}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onLostPointerCapture={(event) => endDrag(event, false)}
    >
      {options.canvasBorder && (
        <FrameSvg name="canvas-border" frame={frame} frameRect={frameRect} className="is-border">
          <rect {...rectProps({ x: 0, y: 0, width: frame.width, height: frame.height })} />
        </FrameSvg>
      )}
      {options.grid && (
        <FrameSvg name="grid" frame={frame} frameRect={frameRect} className="is-grid">
          {gridPositions(frame.width).map((x) => (
            <line key={`gx-${x}`} x1={x} y1={0} x2={x} y2={frame.height} />
          ))}
          {gridPositions(frame.height).map((y) => (
            <line key={`gy-${y}`} x1={0} y1={y} x2={frame.width} y2={y} />
          ))}
        </FrameSvg>
      )}
      {options.centreMarks && (
        <FrameSvg name="centre-marks" frame={frame} frameRect={frameRect} className="is-centre">
          {(() => {
            const cx = frame.width / 2;
            const cy = frame.height / 2;
            const arm = Math.min(frame.width, frame.height) * 0.03;
            return (
              <>
                <line x1={cx - arm} y1={cy} x2={cx + arm} y2={cy} />
                <line x1={cx} y1={cy - arm} x2={cx} y2={cy + arm} />
              </>
            );
          })()}
        </FrameSvg>
      )}
      {options.titleSafe && (
        <FrameSvg name="title-safe" frame={frame} frameRect={frameRect} className="is-title-safe">
          <rect {...rectProps(safe(TITLE_SAFE_INSET))} />
        </FrameSvg>
      )}
      {options.actionSafe && (
        <FrameSvg name="action-safe" frame={frame} frameRect={frameRect} className="is-action-safe">
          <rect {...rectProps(safe(ACTION_SAFE_INSET))} />
        </FrameSvg>
      )}
      {aspect !== undefined && (
        <FrameSvg name="preview-aspect" frame={frame} frameRect={frameRect} className="is-aspect">
          <path
            className="monitor-overlay-mask"
            fillRule="evenodd"
            d={`M0 0H${frame.width}V${frame.height}H0Z M${aspect.x} ${aspect.y}H${aspect.x + aspect.width}V${aspect.y + aspect.height}H${aspect.x}Z`}
          />
          <rect className="monitor-overlay-aspect-line" {...rectProps(aspect)} />
        </FrameSvg>
      )}
      {pixelGrid && visibleRight > visibleLeft && visibleBottom > visibleTop && (
        <div
          className="monitor-pixel-grid"
          data-monitor-overlay="pixel-grid"
          aria-hidden="true"
          style={{
            left: `${visibleLeft}px`,
            top: `${visibleTop}px`,
            width: `${visibleRight - visibleLeft}px`,
            height: `${visibleBottom - visibleTop}px`,
            backgroundSize: `${zoom}px ${zoom}px`,
            backgroundPosition: `${panX - visibleLeft}px ${panY - visibleTop}px`,
          }}
        />
      )}
      {options.rulers && (
        <>
          <div
            className="monitor-ruler monitor-ruler-x"
            role="presentation"
            data-monitor-ruler="top"
            style={{ left: RULER_THICKNESS_PX, top: 0, right: 0, height: RULER_THICKNESS_PX }}
            onPointerDown={(event) => beginDrag(event, 'y', undefined)}
          >
            {topTicks.map((value) => (
              <span
                key={`t-${value}`}
                className="monitor-ruler-tick"
                style={{ left: `${panX + value * zoom - RULER_THICKNESS_PX}px` }}
              >
                {Math.round(value)}
              </span>
            ))}
          </div>
          <div
            className="monitor-ruler monitor-ruler-y"
            role="presentation"
            data-monitor-ruler="left"
            style={{ left: 0, top: RULER_THICKNESS_PX, bottom: 0, width: RULER_THICKNESS_PX }}
            onPointerDown={(event) => beginDrag(event, 'x', undefined)}
          >
            {leftTicks.map((value) => (
              <span
                key={`l-${value}`}
                className="monitor-ruler-tick"
                style={{ top: `${panY + value * zoom - RULER_THICKNESS_PX}px` }}
              />
            ))}
          </div>
          {guideItems.map((item) =>
            renderGuide(item.guide, `g-${item.index}`, item.index, item.dragging),
          )}
          {newGuidePreview !== undefined && renderGuide(newGuidePreview, 'g-new', undefined, true)}
        </>
      )}
    </div>
  );
}
