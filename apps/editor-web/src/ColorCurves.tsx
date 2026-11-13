import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ColorCurveChannel, ColorGradeV2 } from '@joy-media/project-schema';
import { IDENTITY_COLOR_CURVES } from '@joy-media/project-schema';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';
import { colorGradePreview } from './color-grade-preview.js';
import {
  addCurvePoint,
  CURVE_CHANNEL_LABELS,
  CURVE_CHANNELS,
  curvePath,
  curveReadout,
  editableCurve,
  hitCurvePoint,
  isCurveEndPoint,
  isCurveNudgeKey,
  isDraggedOut,
  isIdentityCurve,
  isOnCurveLine,
  moveCurvePoint,
  nextCurvePointIndex,
  nudgeCurvePoint,
  removeCurvePoint,
  sameCurve,
  type CurvePoints,
} from './color-curves-math.js';
import './ColorCurvesHsl.css';

/** The graph is drawn in a 256 × 256 box: one box unit is one 8-bit level. */
const GRAPH = 256;
/** How close (CSS px) the pointer has to be to grab a point. */
const GRAB_RADIUS_PX = 9;
/** How close (CSS px) the pointer has to be to the line to add a point. */
const LINE_TOLERANCE_PX = 10;
/** The quarter lines of the grid. */
const GRID_STEPS = [0.25, 0.5, 0.75];

const CHANNEL_STROKE: Readonly<Record<ColorCurveChannel, string>> = {
  rgb: '#e6e7ea',
  red: '#e66b70',
  green: '#65c988',
  blue: '#6e9fe8',
};

export interface ColorCurvesProps {
  readonly draft: ColorGradeV2;
  /** The live value: the panel shows it straight away. */
  readonly onChange: (next: ColorGradeV2) => void;
  /** The durable value: the document is written once, when the gesture ends. */
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly animationStateFor: (propertyId: string) => PropertyAnimationState;
  readonly onToggleAnimation: (channel: ColorCurveChannel, curves: ColorGradeV2['curves']) => void;
  readonly canAnimate: boolean;
  /** Which grade the curves change: the output grade or one clip's grade. */
  readonly scope: 'output' | 'clip';
  readonly clipId?: string | undefined;
}

interface CurveDrag {
  readonly channel: ColorCurveChannel;
  readonly pointerId: number;
  readonly index: number;
  /** The curve when the gesture started (the point may have just been added). */
  readonly base: CurvePoints;
  /** The curve the document had before the gesture. */
  readonly before: CurvePoints;
  /** The live curve. */
  points: CurvePoints;
  /** The point is out of the graph and goes away on release. */
  out: boolean;
  /** The latest pointer position not shown yet (moves are drawn once per frame). */
  pending: { readonly x: number; readonly y: number } | undefined;
  /** The animation frame that draws the pending move. */
  frame: number | undefined;
}

/** Runs `callback` on the next animation frame (or soon, where there are no frames). */
function nextFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/** Stops a drag's pending frame: nothing is drawn after the drag is over. */
function dropPendingFrame(drag: CurveDrag | undefined): void {
  if (drag === undefined) return;
  if (drag.frame !== undefined) cancelFrame(drag.frame);
  drag.frame = undefined;
  drag.pending = undefined;
}

/** The pointer in the unit square of the graph (y up). */
function unitPoint(
  element: Element,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number; readonly width: number } {
  const rect = element.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : GRAPH;
  const height = rect.height > 0 ? rect.height : GRAPH;
  return {
    x: (clientX - rect.left) / width,
    y: 1 - (clientY - rect.top) / height,
    width,
  };
}

/**
 * The curves editor (T-K03).
 *
 * A square graph with one curve per channel. Click on the line to add a
 * point, drag a point to bend the curve, drag it out of the graph,
 * double-click it or press Delete to remove it. The drag previews live in the
 * Monitor and is written to the document once, on release, so one Undo puts
 * the whole drag back. Tab moves between the points, the arrow keys nudge the
 * focused point one level (Shift: ten), and each press is its own undo step.
 */
export function ColorCurves({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
  scope,
  clipId,
}: ColorCurvesProps) {
  const [channel, setChannel] = useState<ColorCurveChannel>('rgb');
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<CurveDrag | undefined>(undefined);
  const curves = { ...IDENTITY_COLOR_CURVES, ...(draft.curves ?? {}) };
  const stored = curves[channel];
  // Worked out once per change of the curve, not on every render.
  const points = useMemo(() => editableCurve(stored), [stored]);
  const linePath = useMemo(() => curvePath(points, GRAPH), [points]);
  const label = CURVE_CHANNEL_LABELS[channel];

  // The live grade stops when the panel goes away, whatever happened to the drag.
  useEffect(
    () => () => {
      dropPendingFrame(dragRef.current);
      colorGradePreview.set(undefined);
    },
    [],
  );

  // A live grade belongs to the grade it was started on.
  useEffect(() => {
    dropPendingFrame(dragRef.current);
    colorGradePreview.set(undefined);
    dragRef.current = undefined;
    setDragging(false);
  }, [scope, clipId]);

  const withCurve = (target: ColorCurveChannel, next: CurvePoints): ColorGradeV2 => ({
    ...draft,
    curves: { ...curves, [target]: next },
  });

  const preview = (target: ColorCurveChannel, next: CurvePoints) => {
    const grade = withCurve(target, next);
    onChange(grade);
    colorGradePreview.set({ scope, ...(clipId === undefined ? {} : { clipId }), grade });
  };

  const write = (target: ColorCurveChannel, next: CurvePoints) => {
    const grade = withCurve(target, next);
    // The document is written first, so the Monitor never shows the old grade
    // for a frame between the release and the write.
    onChange(grade);
    onCommit(grade);
    colorGradePreview.set(undefined);
  };

  const selectChannel = (next: ColorCurveChannel) => {
    setChannel(next);
    setSelected(undefined);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    const pointer = unitPoint(target, event.clientX, event.clientY);
    const grab = GRAB_RADIUS_PX / pointer.width;
    let index = hitCurvePoint(points, pointer.x, pointer.y, grab);
    let base = points;
    if (index === undefined) {
      if (!isOnCurveLine(points, pointer.x, pointer.y, LINE_TOLERANCE_PX / pointer.width)) {
        setSelected(undefined);
        return;
      }
      const added = addCurvePoint(points, pointer.x);
      if (added === undefined) return;
      index = added.index;
      base = added.points;
      preview(channel, base);
    }
    dragRef.current = {
      channel,
      pointerId: event.pointerId,
      index,
      base,
      before: points,
      points: base,
      out: false,
      pending: undefined,
      frame: undefined,
    };
    target.setPointerCapture(event.pointerId);
    if (typeof target.focus === 'function') target.focus();
    setSelected(index);
    setDragging(true);
    event.preventDefault();
  };

  /** Moves the dragged point to a pointer position and previews the result. */
  const applyMove = (drag: CurveDrag, x: number, y: number) => {
    const out = isDraggedOut(drag.base, drag.index, x, y);
    const next = out
      ? removeCurvePoint(drag.base, drag.index)
      : moveCurvePoint(drag.base, drag.index, x, y);
    // A move that lands on the same curve changes nothing: no new grade.
    if (out === drag.out && sameCurve(next, drag.points)) return;
    drag.out = out;
    drag.points = next;
    preview(drag.channel, drag.points);
  };

  /** Draws the latest pointer position not drawn yet, if any. */
  const flushMove = (drag: CurveDrag) => {
    const pending = drag.pending;
    drag.pending = undefined;
    if (pending !== undefined) applyMove(drag, pending.x, pending.y);
  };
  // The frame callback draws with the latest render's grade, not the one it was scheduled in.
  const flushMoveRef = useRef(flushMove);
  flushMoveRef.current = flushMove;

  // The first move of a frame is drawn at once; the moves after it in the same
  // frame are folded into one update when the frame comes (or on release).
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    const pointer = unitPoint(event.currentTarget, event.clientX, event.clientY);
    if (drag.frame !== undefined) {
      drag.pending = { x: pointer.x, y: pointer.y };
      return;
    }
    applyMove(drag, pointer.x, pointer.y);
    drag.frame = nextFrame(() => {
      drag.frame = undefined;
      if (dragRef.current === drag) flushMoveRef.current(drag);
    });
  };

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    // The last position counts even when its frame has not come yet.
    if (drag.frame !== undefined) cancelFrame(drag.frame);
    drag.frame = undefined;
    flushMove(drag);
    dragRef.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.out) setSelected(undefined);
    if (JSON.stringify(drag.points) === JSON.stringify(drag.before)) {
      colorGradePreview.set(undefined);
      return;
    }
    // One write for the whole drag: one Undo puts it back.
    write(drag.channel, drag.points);
  };

  const removeAt = (index: number) => {
    if (isCurveEndPoint(points, index)) return;
    write(channel, removeCurvePoint(points, index));
    setSelected(index - 1);
  };

  const onDoubleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    const pointer = unitPoint(event.currentTarget, event.clientX, event.clientY);
    const index = hitCurvePoint(points, pointer.x, pointer.y, GRAB_RADIUS_PX / pointer.width);
    if (index !== undefined) removeAt(index);
  };

  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Tab') {
      const next =
        selected === undefined
          ? event.shiftKey
            ? points.length - 1
            : 0
          : nextCurvePointIndex(points, selected, event.shiftKey);
      // Past the first or the last point, Tab leaves the graph as usual.
      if (next === undefined) {
        setSelected(undefined);
        return;
      }
      event.preventDefault();
      setSelected(next);
      return;
    }
    if (event.key === 'Escape' && dragRef.current !== undefined) {
      const drag = dragRef.current;
      dropPendingFrame(drag);
      dragRef.current = undefined;
      setDragging(false);
      onChange(withCurve(drag.channel, drag.before));
      colorGradePreview.set(undefined);
      event.preventDefault();
      return;
    }
    if (selected === undefined || points[selected] === undefined) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeAt(selected);
      return;
    }
    if (!isCurveNudgeKey(event.key)) return;
    event.preventDefault();
    const next = nudgeCurvePoint(points, selected, event.key, event.shiftKey);
    // Every arrow press is its own change, so it is its own undo step.
    if (JSON.stringify(next) !== JSON.stringify(points)) write(channel, next);
  };

  const resetChannel = (target: ColorCurveChannel) => {
    write(target, IDENTITY_COLOR_CURVES[target]);
    if (target === channel) setSelected(undefined);
  };

  const active = selected === undefined ? undefined : points[selected];
  const readout = active === undefined ? undefined : curveReadout(active);
  const stroke = CHANNEL_STROKE[channel];

  return (
    <section className="color-section ccv-section">
      <h3>Curves</h3>
      <div className="ccv-tabs" role="tablist" aria-label="Curve channel">
        {CURVE_CHANNELS.map((id) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={channel === id}
            className={channel === id ? 'is-active' : ''}
            data-curve-channel={id}
            data-curve-modified={isIdentityCurve(curves[id]) ? undefined : 'true'}
            onClick={() => selectChannel(id)}
          >
            {CURVE_CHANNEL_LABELS[id]}
          </button>
        ))}
      </div>
      <PropertyRow
        label={`${label} curve`}
        layout="two-line"
        value={isIdentityCurve(points) ? 'Straight' : `${points.length} points`}
        onReset={() => resetChannel(channel)}
        {...(!canAnimate
          ? {}
          : {
              animationState: animationStateFor(`curves.${channel}`),
              onToggleAnimation: () => onToggleAnimation(channel, curves),
            })}
      >
        <div className={`ccv-graph${dragging ? ' is-dragging' : ''}`}>
          <svg
            viewBox={`0 0 ${GRAPH} ${GRAPH}`}
            role="application"
            tabIndex={0}
            aria-label={`${label} curve. Click the line to add a point, drag a point to move it. Tab moves between points, arrow keys nudge (Shift for 10), Delete removes.`}
            data-curve-graph={channel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (dragRef.current === undefined) setSelected(undefined);
            }}
          >
            <rect className="ccv-bg" x={0} y={0} width={GRAPH} height={GRAPH} />
            {GRID_STEPS.map((step) => (
              <g key={step} className="ccv-grid">
                <line x1={step * GRAPH} y1={0} x2={step * GRAPH} y2={GRAPH} />
                <line x1={0} y1={step * GRAPH} x2={GRAPH} y2={step * GRAPH} />
              </g>
            ))}
            <line className="ccv-diagonal" x1={0} y1={GRAPH} x2={GRAPH} y2={0} />
            <path className="ccv-line" d={linePath} stroke={stroke} data-curve-line={channel} />
            {points.map((point, index) => (
              <circle
                key={index}
                className={`ccv-point${selected === index ? ' is-selected' : ''}${
                  isCurveEndPoint(points, index) ? ' is-end' : ''
                }`}
                cx={point.x * GRAPH}
                cy={(1 - point.y) * GRAPH}
                r={selected === index ? 7 : 5.5}
                data-curve-point={index}
              />
            ))}
          </svg>
        </div>
        <output className="ccv-readout" data-curve-readout aria-live="polite">
          {readout ?? 'Click the line to add a point.'}
        </output>
      </PropertyRow>
      <div className="ccv-actions">
        <button
          type="button"
          className="section-reset"
          disabled={isIdentityCurve(points)}
          onClick={() => resetChannel(channel)}
        >
          Reset {label} curve
        </button>
        <button
          type="button"
          className="section-reset"
          onClick={() => {
            const grade = { ...draft, curves: IDENTITY_COLOR_CURVES };
            onChange(grade);
            onCommit(grade);
            colorGradePreview.set(undefined);
            setSelected(undefined);
          }}
        >
          Reset curves
        </button>
      </div>
    </section>
  );
}
