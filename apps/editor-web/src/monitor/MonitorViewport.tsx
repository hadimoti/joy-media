import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { isEditableTarget, isInteractiveTarget, scopedKeyTable } from '../keyboard-shortcuts.js';
import {
  doubleClickReturnsToFit,
  effectiveMonitorTool,
  monitorCursor,
  monitorSpaceGesture,
  type MonitorTool,
} from './monitor-tools.js';
import { panByDrag } from './monitor-hand.js';
import type { MonitorBackground } from './monitor-view-options.js';
import { MonitorNavigation, type MonitorThumbnailReader } from './MonitorNavigator.js';
import {
  clampPan,
  fitView,
  nextZoomStep,
  screenToCanvasPoint,
  wheelZoomFactor,
  zoomViewAt,
  type MonitorPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';

/**
 * The Monitor viewport (ADR-0046 sections 1 and 8): the clipping frame that
 * hosts the panel-sized canvas, plus the zoom and pan controller. The view is
 * drawn by the renderer (`setView`), never by a CSS scale. Wheel zooms toward the
 * cursor (Ctrl + wheel is a trackpad pinch); Ctrl+0, Ctrl+1, Ctrl+plus and
 * Ctrl+minus work while the pointer is over the Monitor or focus is inside it
 * (through the scoped key table, scope `monitor`). The viewport is also the
 * pointer router for the tools (ADR-0046 section 3): the Hand pans, a Space
 * hold lends the Hand, the middle button always pans. With Select, a primary
 * click selects through {@link MonitorViewportSelection}, a drag that
 * starts on empty canvas draws a marquee (ADR-0046 section 4, T-M04) and a
 * drag that starts on an element moves it (`dragElement`, T-M05a).
 */

/** The key-table scope of the Monitor: pointer over it or focus inside it. */
export const MONITOR_KEY_SCOPE = 'monitor';

export interface MonitorViewController {
  /** The view the Monitor shows now (Fit already resolved to numbers). */
  readonly view: MonitorViewState;
  /** True while the view follows the panel size (the control shows "Fit"). */
  readonly fit: boolean;
  /** The viewport size in CSS px, as last measured. */
  readonly viewportSize: MonitorSize;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  /** Back to Fit. */
  readonly setFit: () => void;
  /** Sets a zoom, keeping `anchor` (screen point) still; default anchor is the viewport centre. */
  readonly setZoom: (zoom: number, anchor?: MonitorPoint) => void;
  /** One step along the Ctrl+plus / Ctrl+minus ladder, around the viewport centre. */
  readonly stepZoom: (direction: 1 | -1) => void;
  /** Shows exactly this view (pan clamped); leaves Fit. Used by the Hand. */
  readonly setView: (view: MonitorViewState) => void;
  /** The chosen tool (Select by default). A Space hold lends the Hand on top of it. */
  readonly tool: MonitorTool;
  readonly setTool: (tool: MonitorTool) => void;
  /** The frame size in authored px. */
  readonly frame: MonitorSize;
}

const EMPTY_SIZE: MonitorSize = { width: 0, height: 0 };

function sameSize(a: MonitorSize, b: MonitorSize): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Which zoom shortcut a key press is, if any. Exported for tests. */
export function monitorZoomShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
): 'fit' | 'actual' | 'in' | 'out' | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return undefined;
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') return 'fit';
  if (event.key === '1' || event.code === 'Digit1' || event.code === 'Numpad1') return 'actual';
  if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') return 'in';
  if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') return 'out';
  return undefined;
}

export function useMonitorView(
  frame: MonitorSize,
  scopeRef: RefObject<HTMLElement | null>,
): MonitorViewController {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<MonitorSize>(EMPTY_SIZE);
  const [fit, setFitMode] = useState(true);
  const [manualView, setManualView] = useState<MonitorViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [tool, setTool] = useState<MonitorTool>('select');

  const view = useMemo(
    () => (fit ? fitView(viewportSize, frame) : clampPan(manualView, viewportSize, frame)),
    [fit, frame, manualView, viewportSize],
  );
  const latest = useRef({ view, viewportSize, frame });
  latest.current = { view, viewportSize, frame };

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setViewportSize((current) => (sameSize(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const setZoom = useCallback((zoom: number, anchor?: MonitorPoint) => {
    const { view: current, viewportSize: size, frame: frameSize } = latest.current;
    const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
    setManualView(zoomViewAt(current, zoom, point, size, frameSize));
    setFitMode(false);
  }, []);

  const setFit = useCallback(() => setFitMode(true), []);

  const setView = useCallback((next: MonitorViewState) => {
    const { viewportSize: size, frame: frameSize } = latest.current;
    const clamped = clampPan(next, size, frameSize);
    // Several pointer moves can land before the next render.
    latest.current = { ...latest.current, view: clamped };
    setManualView(clamped);
    setFitMode(false);
  }, []);

  const stepZoom = useCallback(
    (direction: 1 | -1) => setZoom(nextZoomStep(latest.current.view.zoom, direction)),
    [setZoom],
  );

  // React's onWheel is passive, so the page would scroll too; a native
  // listener with passive: false can claim the wheel for the zoom.
  useEffect(() => {
    const element = viewportRef.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const factor = wheelZoomFactor(
        event.deltaY,
        event.deltaMode,
        event.ctrlKey,
        element.clientHeight,
      );
      setZoom(latest.current.view.zoom * factor, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // Zoom shortcuts only while the pointer is over the Monitor or focus is in
  // it: the Monitor scope of the shared key table. Outside it the global keys apply.
  useEffect(() => {
    let pointerOver = false;
    const element = scopeRef.current;
    const onEnter = () => {
      pointerOver = true;
    };
    const onLeave = () => {
      pointerOver = false;
    };
    element?.addEventListener('pointerenter', onEnter);
    element?.addEventListener('pointerleave', onLeave);
    const removeScope = scopedKeyTable.setScope(MONITOR_KEY_SCOPE, () => {
      const root = scopeRef.current;
      if (root === null) return false;
      const focused = document.activeElement;
      return pointerOver || (focused !== null && root.contains(focused));
    });
    const removeZoomKeys = scopedKeyTable.register({
      scope: MONITOR_KEY_SCOPE,
      // The zoom box and other fields in the Monitor keep these keys, as before.
      inTextFields: true,
      match: (event) => monitorZoomShortcut({ ...event, code: event.code ?? '' }) !== undefined,
      run: (event) => {
        const action = monitorZoomShortcut({ ...event, code: event.code ?? '' });
        if (action === 'fit') setFit();
        else if (action === 'actual') setZoom(1);
        else if (action !== undefined) stepZoom(action === 'in' ? 1 : -1);
      },
    });
    return () => {
      element?.removeEventListener('pointerenter', onEnter);
      element?.removeEventListener('pointerleave', onLeave);
      removeScope();
      removeZoomKeys();
    };
  }, [scopeRef, setFit, setZoom, stepZoom]);

  return {
    view,
    fit,
    viewportSize,
    viewportRef,
    setFit,
    setZoom,
    stepZoom,
    setView,
    tool,
    setTool,
    frame,
  };
}

/** The screen's device pixel ratio, updated when the window moves to another screen. */
export function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() =>
    typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList | undefined;
    const update = () => {
      query?.removeEventListener('change', update);
      const next = window.devicePixelRatio || 1;
      setRatio(next);
      query = window.matchMedia(`(resolution: ${next}dppx)`);
      query.addEventListener('change', update);
    };
    update();
    return () => query?.removeEventListener('change', update);
  }, []);
  return ratio;
}

/** Where the authored frame sits inside the viewport, in CSS px. */
export function monitorFrameRect(view: MonitorViewState, frame: MonitorSize): CSSProperties {
  return {
    left: `${view.panX}px`,
    top: `${view.panY}px`,
    width: `${frame.width * view.zoom}px`,
    height: `${frame.height * view.zoom}px`,
  };
}

export interface MonitorViewportProps {
  readonly controller: MonitorViewController;
  readonly dragOver: boolean;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDragLeave: () => void;
  readonly onDrop: (event: DragEvent) => void;
  /** Reads a small Fit picture of the frame for the navigator. */
  readonly readThumbnail?: MonitorThumbnailReader | undefined;
  /** Click and marquee selection with the Select tool (T-M04). */
  readonly selection?: MonitorViewportSelection | undefined;
  /** The Monitor background (View menu): checkerboard by default. */
  readonly background?: MonitorBackground | undefined;
  readonly children: ReactNode;
}

/**
 * What the Monitor selects with (T-M04). Points are canvas points in authored
 * frame pixels. The viewport only routes the pointer; the hit test and the
 * shared selection live in the panel.
 */
export interface MonitorViewportSelection {
  /** True when a selectable element is under the point. */
  readonly isElementAt: (canvasPoint: MonitorPoint) => boolean;
  /** A plain press and release (no drag). */
  readonly click: (canvasPoint: MonitorPoint, modifiers: { shift: boolean; alt: boolean }) => void;
  /** A drag that started on empty canvas, released at `end`. */
  readonly marquee: (start: MonitorPoint, end: MonitorPoint, modifiers: { shift: boolean }) => void;
  /**
   * A drag that started on an element moves it (T-M05a). Called once when the
   * press becomes a drag; the result follows the pointer and ends on release.
   */
  readonly dragElement?: (
    start: MonitorPoint,
    modifiers: { shift: boolean; alt: boolean },
  ) => MonitorElementDrag | undefined;
}

/** A move that follows the pointer (canvas points) and ends once. */
export interface MonitorElementDrag {
  readonly update: (canvasPoint: MonitorPoint, modifiers: { shift: boolean; alt: boolean }) => void;
  readonly end: (commit: boolean) => void;
}

/** A press that moves less than this (CSS px) is still a click. */
export const MONITOR_CLICK_SLOP_PX = 3;

/** True once a press has moved far enough to be a drag. Exported for tests. */
export function movedPastClickSlop(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > MONITOR_CLICK_SLOP_PX;
}

/** The marquee rectangle in viewport CSS px, from two screen points. */
export function marqueeScreenRect(start: MonitorPoint, end: MonitorPoint): CSSProperties {
  return {
    left: `${Math.min(start.x, end.x)}px`,
    top: `${Math.min(start.y, end.y)}px`,
    width: `${Math.abs(end.x - start.x)}px`,
    height: `${Math.abs(end.y - start.y)}px`,
  };
}

/** True while Space is held long enough (or with a pointer down) to lend the Hand. */
export function useSpaceHold(): boolean {
  return useSyncExternalStore(
    monitorSpaceGesture.subscribe,
    monitorSpaceGesture.isHolding,
    monitorSpaceGesture.isHolding,
  );
}

const MIDDLE_BUTTON = 1;
const PRIMARY_BUTTON = 0;

interface PanDrag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startView: MonitorViewState;
}

interface SelectPress {
  readonly pointerId: number;
  /** Press point in viewport CSS px. */
  readonly start: MonitorPoint;
  /** True when the press landed on an element (a drag there is not a marquee). */
  readonly onElement: boolean;
  moved: boolean;
  /** The element move this press started (T-M05a); asked for once per press. */
  drag?: MonitorElementDrag | undefined;
  dragAsked?: boolean;
}

function viewportPoint(
  event: { clientX: number; clientY: number },
  element: Element,
): MonitorPoint {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** The clipping viewport and pointer router. Children are positioned inside it. */
export function MonitorViewport({
  controller,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  readThumbnail,
  selection,
  background,
  children,
}: MonitorViewportProps) {
  const spaceHeld = useSpaceHold();
  const tool = effectiveMonitorTool(controller.tool, spaceHeld);
  const panRef = useRef<PanDrag | null>(null);
  const [panning, setPanning] = useState(false);
  const { setView, setFit } = controller;
  const latest = useRef(controller);
  latest.current = controller;
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const pressRef = useRef<SelectPress | null>(null);
  const [marquee, setMarquee] = useState<{ start: MonitorPoint; end: MonitorPoint } | null>(null);

  const endSelectPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
      const press = pressRef.current;
      if (press === null || press.pointerId !== event.pointerId) return;
      pressRef.current = null;
      setMarquee(null);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      const handler = latestSelection.current;
      const view = latest.current.view;
      const end = viewportPoint(event, event.currentTarget);
      if (press.drag !== undefined) {
        if (commit && !monitorSpaceGesture.isHolding())
          press.drag.update(screenToCanvasPoint(view, end), {
            shift: event.shiftKey,
            alt: event.altKey,
          });
        press.drag.end(commit && !monitorSpaceGesture.isHolding());
        return;
      }
      // A Space hold that began during the press turns it into the Hand: no selection.
      if (!commit || handler === undefined || monitorSpaceGesture.isHolding()) return;
      if (press.moved) {
        if (press.onElement) return; // no mover was given: nothing to do
        handler.marquee(screenToCanvasPoint(view, press.start), screenToCanvasPoint(view, end), {
          shift: event.shiftKey,
        });
        return;
      }
      handler.click(screenToCanvasPoint(view, press.start), {
        shift: event.shiftKey,
        alt: event.altKey,
      });
    },
    [],
  );

  const endPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = panRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const middle = event.button === MIDDLE_BUTTON;
    if (middle) event.preventDefault();
    // Read the gesture directly: the window listener has just marked the hold,
    // before React re-renders with the open hand.
    const handNow = effectiveMonitorTool(latest.current.tool, monitorSpaceGesture.isHolding());
    const primaryHand = event.button === PRIMARY_BUTTON && handNow === 'hand';
    if (!middle && !primaryHand) {
      const handler = latestSelection.current;
      if (
        event.button !== PRIMARY_BUTTON ||
        handler === undefined ||
        isEditableTarget(event.target) ||
        isInteractiveTarget(event.target)
      )
        return;
      const start = viewportPoint(event, event.currentTarget);
      pressRef.current = {
        pointerId: event.pointerId,
        start,
        onElement: handler.isElementAt(screenToCanvasPoint(latest.current.view, start)),
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!middle && (isEditableTarget(event.target) || isInteractiveTarget(event.target))) return;
    event.preventDefault();
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: latest.current.view,
    };
    setPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (press !== null && press.pointerId === event.pointerId) {
        const point = viewportPoint(event, event.currentTarget);
        if (!press.moved && movedPastClickSlop(point.x - press.start.x, point.y - press.start.y))
          press.moved = true;
        if (press.moved && !press.onElement) setMarquee({ start: press.start, end: point });
        if (press.moved && press.onElement) {
          const view = latest.current.view;
          const modifiers = { shift: event.shiftKey, alt: event.altKey };
          if (press.dragAsked !== true && !monitorSpaceGesture.isHolding()) {
            press.dragAsked = true;
            press.drag = latestSelection.current?.dragElement?.(
              screenToCanvasPoint(view, press.start),
              modifiers,
            );
          }
          press.drag?.update(screenToCanvasPoint(view, point), modifiers);
        }
        return;
      }
      const drag = panRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const { viewportSize, frame } = latest.current;
      setView(
        panByDrag(
          drag.startView,
          event.clientX - drag.startX,
          event.clientY - drag.startY,
          viewportSize,
          frame,
        ),
      );
    },
    [setView],
  );

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const fit = doubleClickReturnsToFit({
        tool: effectiveMonitorTool(latest.current.tool, monitorSpaceGesture.isHolding()),
        // A double-click on an element keeps its own meaning (T-M04 hit test).
        onElement:
          latestSelection.current?.isElementAt(
            screenToCanvasPoint(latest.current.view, viewportPoint(event, event.currentTarget)),
          ) ?? false,
        onControl: isEditableTarget(event.target) || isInteractiveTarget(event.target),
      });
      if (fit) setFit();
    },
    [setFit],
  );

  const cursor = monitorCursor(tool, panning);
  return (
    <div
      ref={controller.viewportRef}
      className={`monitor-canvas-wrap${dragOver ? ' drag-over' : ''}`}
      data-editor-pointer-dnd-target="monitor"
      data-monitor-zoom={controller.view.zoom}
      data-monitor-pan-x={Math.round(controller.view.panX)}
      data-monitor-pan-y={Math.round(controller.view.panY)}
      data-monitor-tool={tool}
      data-monitor-background={background ?? 'checkerboard'}
      data-monitor-cursor={cursor}
      style={cursor === 'default' ? undefined : { cursor }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => {
        endSelectPress(event, true);
        endPan(event);
      }}
      onPointerCancel={(event) => {
        endSelectPress(event, false);
        endPan(event);
      }}
      onLostPointerCapture={(event) => {
        endSelectPress(event, false);
        endPan(event);
      }}
      onMouseDown={(event) => {
        // No autoscroll and no paste on the middle button.
        if (event.button === MIDDLE_BUTTON) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === MIDDLE_BUTTON) event.preventDefault();
      }}
      onDoubleClick={onDoubleClick}
    >
      {children}
      {marquee !== null && (
        <div
          className="monitor-marquee"
          data-monitor-marquee=""
          style={marqueeScreenRect(marquee.start, marquee.end)}
        />
      )}
      <MonitorNavigation controller={controller} readThumbnail={readThumbnail} />
    </div>
  );
}
