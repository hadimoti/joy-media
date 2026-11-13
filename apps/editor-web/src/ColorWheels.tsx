import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ColorGradeV2, ColorWheels } from '@joy-media/project-schema';
import { PropertyRow, type PropertyAnimationState } from './components/PropertyRow.js';
import { colorGradePreview } from './color-grade-preview.js';
import {
  COLOR_WHEELS,
  clampWheelPuck,
  MAX_WHEEL_AMOUNT,
  nudgeWheelPuck,
  resetWheelColor,
  WHEEL_FACE_HUES,
  WHEEL_FINE_DRAG_FACTOR,
  WHEEL_KEYBOARD_STEP,
  WHEEL_KEYBOARD_STEP_FINE,
  wheelColorToPuck,
  wheelHueName,
  wheelPuckFromPointer,
  wheelPuckToColor,
  type ColorWheelId,
  type WheelColor,
  type WheelPuck,
} from './color-wheels-math.js';
import './color-wheels.css';

/** The wheel face is drawn in a 100 × 100 box; the puck never leaves the disc. */
const FACE_SIZE = 100;
const FACE_RADIUS = 44;
const WHEEL_SIZE = 132;

/** How close the pointer has to be to the puck to grab it instead of jumping to it. */
const GRAB_RADIUS_PX = 14;

export interface ColorWheelsProps {
  readonly draft: ColorGradeV2;
  /** The live value: the panel shows it straight away. */
  readonly onChange: (next: ColorGradeV2) => void;
  /** The durable value: the document is written once, when the gesture ends. */
  readonly onCommit: (next: ColorGradeV2) => void;
  readonly animationStateFor: (propertyId: string) => PropertyAnimationState;
  readonly onToggleAnimation: (propertyId: string, value: number, kind?: 'scalar' | 'hue') => void;
  readonly canAnimate: boolean;
  /** Which grade the wheels change: the output grade or one clip's grade. */
  readonly scope: 'output' | 'clip';
  readonly clipId?: string | undefined;
}

interface WheelDrag {
  readonly wheel: ColorWheelId;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startPuck: WheelPuck;
}

function wheelColorOf(wheels: ColorWheels, id: ColorWheelId): WheelColor {
  const wheel = wheels[id];
  return { r: wheel.r, g: wheel.g, b: wheel.b };
}

function withWheelColor(
  wheels: ColorWheels,
  id: ColorWheelId,
  color: WheelColor,
  master: number,
): ColorWheels {
  return { ...wheels, [id]: { r: color.r, g: color.g, b: color.b, master } };
}

/** A signed number, so a push to the left of the decimal is easy to read. */
function formatWheelValue(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

/** The six hue wedges of the wheel face, drawn from the centre outwards. */
function hueWedges(): { readonly path: string; readonly fill: string }[] {
  const half = Math.PI / 6;
  return WHEEL_FACE_HUES.map((stop) => {
    const start = stop.angle - half;
    const end = stop.angle + half;
    const point = (angle: number): string =>
      `${(FACE_SIZE / 2 + FACE_RADIUS * Math.cos(angle)).toFixed(2)} ${(
        FACE_SIZE / 2 +
        FACE_RADIUS * Math.sin(angle)
      ).toFixed(2)}`;
    const path = [
      `M ${FACE_SIZE / 2} ${FACE_SIZE / 2}`,
      `L ${point(start)}`,
      `A ${FACE_RADIUS} ${FACE_RADIUS} 0 0 1 ${point(end)}`,
      'Z',
    ].join(' ');
    return { path, fill: stop.hex };
  });
}

function WheelFace({
  id,
  label,
  puck,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onDoubleClick,
  onKeyDown,
}: {
  readonly id: ColorWheelId;
  readonly label: string;
  readonly puck: WheelPuck;
  readonly onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onDoubleClick: (event: React.MouseEvent<SVGSVGElement>) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<SVGSVGElement>) => void;
}) {
  const x = FACE_SIZE / 2 + (puck.x * FACE_RADIUS) / MAX_WHEEL_AMOUNT;
  const y = FACE_SIZE / 2 + (puck.y * FACE_RADIUS) / MAX_WHEEL_AMOUNT;
  return (
    <svg
      className="cw-face"
      viewBox={`0 0 ${FACE_SIZE} ${FACE_SIZE}`}
      width={WHEEL_SIZE}
      height={WHEEL_SIZE}
      role="application"
      aria-label={`${label} colour wheel. Arrow keys move the puck, double-click clears the colour.`}
      tabIndex={0}
      data-color-wheel={id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      {hueWedges().map((wedge) => (
        <path key={wedge.path} d={wedge.path} fill={wedge.fill} opacity={0.34} />
      ))}
      <circle
        cx={FACE_SIZE / 2}
        cy={FACE_SIZE / 2}
        r={FACE_RADIUS}
        fill="none"
        stroke="#4a4b52"
        strokeWidth={1}
      />
      <circle
        cx={FACE_SIZE / 2}
        cy={FACE_SIZE / 2}
        r={FACE_RADIUS / 2}
        fill="none"
        stroke="#3c3d42"
        strokeWidth={0.6}
      />
      <circle cx={FACE_SIZE / 2} cy={FACE_SIZE / 2} r={2} fill="#8f919a" />
      <circle cx={x} cy={y} r={5.5} fill="#f0bd2d" stroke="#1a1b1e" strokeWidth={1.5} />
    </svg>
  );
}

/**
 * The four colour wheels (T-K02).
 *
 * The puck pushes colour: its angle is the hue, its distance is the amount.
 * The gesture previews live in the Monitor and is written to the document once,
 * when the pointer is released, so one Undo puts the whole drag back.
 */
export function ColorWheels({
  draft,
  onChange,
  onCommit,
  animationStateFor,
  onToggleAnimation,
  canAnimate,
  scope,
  clipId,
}: ColorWheelsProps) {
  const wheels: ColorWheels = {
    lift: draft.wheels?.lift ?? { r: 0, g: 0, b: 0, master: 0 },
    gamma: draft.wheels?.gamma ?? { r: 0, g: 0, b: 0, master: 0 },
    gain: draft.wheels?.gain ?? { r: 0, g: 0, b: 0, master: 0 },
    offset: draft.wheels?.offset ?? { r: 0, g: 0, b: 0, master: 0 },
  };
  const dragRef = useRef<WheelDrag | undefined>(undefined);
  const [dragging, setDragging] = useState<ColorWheelId | undefined>(undefined);

  // The live grade stops when the panel goes away, whatever happened to the drag.
  useEffect(
    () => () => {
      colorGradePreview.set(undefined);
    },
    [],
  );

  // A live grade belongs to the grade it was started on: it stops when the
  // panel starts changing the other one.
  useEffect(() => {
    colorGradePreview.set(undefined);
  }, [scope, clipId]);

  const publishPreview = (next: ColorGradeV2) => {
    onChange(next);
    colorGradePreview.set({ scope, ...(clipId === undefined ? {} : { clipId }), grade: next });
  };

  const setWheel = (id: ColorWheelId, color: WheelColor, master: number, durable: boolean) => {
    const next: ColorGradeV2 = { ...draft, wheels: withWheelColor(wheels, id, color, master) };
    if (durable) {
      // The document is written first, so the Monitor never shows the old grade
      // for a frame between the release and the write.
      onChange(next);
      onCommit(next);
      colorGradePreview.set(undefined);
      return;
    }
    publishPreview(next);
  };

  const onPointerDown = (id: ColorWheelId) => (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const radius = rect.width / 2;
    const pointerPuck = wheelPuckFromPointer(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
      radius,
    );
    const currentPuck = wheelColorToPuck(wheelColorOf(wheels, id));
    // A click away from the puck puts the puck where the pointer landed; a
    // click on the puck keeps it there and drags it from where it was.
    const grabRadius = GRAB_RADIUS_PX / Math.max(radius, 1);
    const jumped =
      Math.hypot(pointerPuck.x - currentPuck.x, pointerPuck.y - currentPuck.y) > grabRadius;
    const startPuck = jumped ? pointerPuck : currentPuck;
    dragRef.current = {
      wheel: id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPuck,
    };
    target.setPointerCapture(event.pointerId);
    if (typeof target.focus === 'function') target.focus();
    setDragging(id);
    if (jumped) setWheel(id, wheelPuckToColor(pointerPuck), wheels[id].master, false);
    event.preventDefault();
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const radius = rect.width / 2;
    // Shift is the fine control: the puck follows the pointer at a quarter of
    // the speed, so the same hand movement asks for a smaller change.
    const factor = event.shiftKey ? WHEEL_FINE_DRAG_FACTOR : 1;
    const deltaX = ((event.clientX - drag.startX) / radius) * factor;
    const deltaY = ((event.clientY - drag.startY) / radius) * factor;
    const puck = clampWheelPuck({
      x: drag.startPuck.x + deltaX,
      y: drag.startPuck.y + deltaY,
    });
    setWheel(drag.wheel, wheelPuckToColor(puck), wheels[drag.wheel].master, false);
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    dragRef.current = undefined;
    setDragging(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // One write for the whole drag: one Undo puts it back.
    setWheel(drag.wheel, wheelColorOf(wheels, drag.wheel), wheels[drag.wheel].master, true);
  };

  const onPointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag === undefined || event.pointerId !== drag.pointerId) return;
    dragRef.current = undefined;
    setDragging(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setWheel(drag.wheel, wheelColorOf(wheels, drag.wheel), wheels[drag.wheel].master, true);
  };

  const onKeyDown = (id: ColorWheelId) => (event: React.KeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? WHEEL_KEYBOARD_STEP_FINE : WHEEL_KEYBOARD_STEP;
    const moves: Record<string, readonly [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    const puck = nudgeWheelPuck(wheelColorToPuck(wheelColorOf(wheels, id)), move[0], move[1]);
    // Every arrow press is its own change, so it is its own undo step.
    setWheel(id, wheelPuckToColor(puck), wheels[id].master, true);
  };

  /** The wheel's colour is cleared; its master keeps its value. */
  const clearWheelColor = (id: ColorWheelId) => {
    setWheel(id, resetWheelColor(), wheels[id].master, true);
  };

  /** The whole wheel goes back to the neutral wheel. */
  const resetWheel = (id: ColorWheelId) => {
    setWheel(id, resetWheelColor(), 0, true);
  };

  return (
    <section className="color-section cw-section">
      <h3>Wheels</h3>
      <div className="cw-grid">
        {COLOR_WHEELS.map((meta) => {
          const wheel = wheels[meta.id];
          const color = wheelColorOf(wheels, meta.id);
          const puck = wheelColorToPuck(color);
          return (
            <div className={`cw-card${dragging === meta.id ? ' is-dragging' : ''}`} key={meta.id}>
              <div className="cw-heading">
                <strong className="cw-title">{meta.label}</strong>
                <span className="cw-hint">{meta.hint}</span>
              </div>
              <WheelFace
                id={meta.id}
                label={meta.label}
                puck={puck}
                onPointerDown={onPointerDown(meta.id)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                onDoubleClick={() => clearWheelColor(meta.id)}
                onKeyDown={onKeyDown(meta.id)}
              />
              <p className="cw-hue">{wheelHueName(puck)}</p>
              <PropertyRow
                label="Master"
                controlId={`color-wheel-${meta.id}-master`}
                value={wheel.master.toFixed(2)}
                onReset={() => setWheel(meta.id, color, 0, true)}
                {...(!canAnimate
                  ? {}
                  : {
                      animationState: animationStateFor(`wheels.${meta.id}.master`),
                      onToggleAnimation: () =>
                        onToggleAnimation(`wheels.${meta.id}.master`, wheel.master),
                    })}
              >
                <input
                  id={`color-wheel-${meta.id}-master`}
                  className="cw-master"
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={wheel.master}
                  aria-label={`${meta.label} master`}
                  onChange={(event) =>
                    setWheel(meta.id, color, event.currentTarget.valueAsNumber, false)
                  }
                  onPointerUp={(event) =>
                    setWheel(meta.id, color, event.currentTarget.valueAsNumber, true)
                  }
                  onBlur={(event) =>
                    setWheel(meta.id, color, event.currentTarget.valueAsNumber, true)
                  }
                  onKeyUp={(event) => {
                    if (
                      event.key.startsWith('Arrow') ||
                      event.key === 'Home' ||
                      event.key === 'End'
                    )
                      setWheel(meta.id, color, event.currentTarget.valueAsNumber, true);
                  }}
                />
              </PropertyRow>
              <div className="cw-numbers" data-color-wheel-numbers={meta.id}>
                <span>
                  <span className="cw-number-label">R</span>
                  <output data-color-wheel-value="r">{formatWheelValue(color.r)}</output>
                </span>
                <span>
                  <span className="cw-number-label">G</span>
                  <output data-color-wheel-value="g">{formatWheelValue(color.g)}</output>
                </span>
                <span>
                  <span className="cw-number-label">B</span>
                  <output data-color-wheel-value="b">{formatWheelValue(color.b)}</output>
                </span>
                <span>
                  <span className="cw-number-label">Master</span>
                  <output data-color-wheel-value="master">{wheel.master.toFixed(2)}</output>
                </span>
              </div>
              <button
                type="button"
                className="section-reset cw-reset"
                onClick={() => resetWheel(meta.id)}
                title={`Reset the ${meta.label} wheel`}
              >
                Reset {meta.label}
              </button>
            </div>
          );
        })}
      </div>
      <p className="cw-note">
        Drag the puck to push colour: the angle is the hue, the distance is the amount. Hold Shift
        for fine control, double-click a wheel to clear its colour, and use the arrow keys to move
        the puck.
      </p>
    </section>
  );
}
