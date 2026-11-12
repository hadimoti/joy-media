import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  clampPan,
  fitView,
  nextZoomStep,
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
 * Ctrl+minus work while the pointer is over the Monitor or focus is inside it.
 */

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

  // Zoom shortcuts only while the pointer is over the Monitor or focus is in it.
  useEffect(() => {
    let pointerOver = false;
    const scope = () => scopeRef.current;
    const onEnter = () => {
      pointerOver = true;
    };
    const onLeave = () => {
      pointerOver = false;
    };
    const element = scope();
    element?.addEventListener('pointerenter', onEnter);
    element?.addEventListener('pointerleave', onLeave);
    const onKeyDown = (event: KeyboardEvent) => {
      const action = monitorZoomShortcut(event);
      if (action === undefined) return;
      const root = scope();
      if (root === null) return;
      const focused = document.activeElement;
      const focusInside = focused !== null && root.contains(focused);
      if (!pointerOver && !focusInside) return;
      event.preventDefault();
      if (action === 'fit') setFit();
      else if (action === 'actual') setZoom(1);
      else stepZoom(action === 'in' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      element?.removeEventListener('pointerenter', onEnter);
      element?.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [scopeRef, setFit, setZoom, stepZoom]);

  return { view, fit, viewportSize, viewportRef, setFit, setZoom, stepZoom };
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
  readonly children: ReactNode;
}

/** The clipping viewport. Children are positioned inside it. */
export function MonitorViewport({
  controller,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: MonitorViewportProps) {
  return (
    <div
      ref={controller.viewportRef}
      className={`monitor-canvas-wrap${dragOver ? ' drag-over' : ''}`}
      data-monitor-zoom={controller.view.zoom}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </div>
  );
}
