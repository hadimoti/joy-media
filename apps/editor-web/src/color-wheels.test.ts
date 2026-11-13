import { describe, expect, it } from 'vitest';
import {
  clampWheelPuck,
  COLOR_WHEELS,
  MAX_WHEEL_AMOUNT,
  nudgeWheelPuck,
  resetWheelColor,
  WHEEL_KEYBOARD_STEP,
  WHEEL_KEYBOARD_STEP_FINE,
  wheelColorAmount,
  wheelColorToPuck,
  wheelHueName,
  wheelHueVector,
  wheelPuckFromPointer,
  wheelPuckToColor,
  type WheelPuck,
} from './color-wheels-math.js';

/** The six hues of the wheel face, on the clock positions of a colour wheel. */
const CLOCK_HUES: readonly (readonly [string, WheelPuck])[] = [
  ['red', { x: 0, y: -1 }],
  ['yellow', { x: 0.866, y: -0.5 }],
  ['green', { x: 0.866, y: 0.5 }],
  ['cyan', { x: 0, y: 1 }],
  ['blue', { x: -0.866, y: 0.5 }],
  ['magenta', { x: -0.866, y: -0.5 }],
];

describe('the colour wheels (T-K02)', () => {
  it('shows the four wheels in the order the panel shows them', () => {
    expect(COLOR_WHEELS.map((wheel) => wheel.id)).toEqual(['lift', 'gamma', 'gain', 'offset']);
    expect(COLOR_WHEELS.map((wheel) => wheel.label)).toEqual(['Lift', 'Gamma', 'Gain', 'Offset']);
    expect(COLOR_WHEELS.map((wheel) => wheel.hint)).toEqual([
      'shadows',
      'midtones',
      'highlights',
      'everything',
    ]);
  });

  it('reads the same wheel from the puck and from the channels', () => {
    for (const puck of [
      { x: 0, y: 0 },
      { x: 0.3, y: -0.4 },
      { x: -0.7, y: 0.2 },
      { x: 0.6, y: 0.6 },
      { x: -0.15, y: -0.95 },
    ]) {
      const color = wheelPuckToColor(puck);
      const back = wheelColorToPuck(color);
      expect(back.x).toBeCloseTo(puck.x, 10);
      expect(back.y).toBeCloseTo(puck.y, 10);
    }
  });

  it('puts red at the top of the wheel and the six named hues on their clock positions', () => {
    const top = wheelPuckToColor({ x: 0, y: -1 });
    expect(top.r).toBeCloseTo(1, 10);
    expect(top.g).toBeCloseTo(top.b, 10);
    expect(top.g).toBeLessThan(0);

    for (const [name, puck] of CLOCK_HUES) expect(wheelHueName(puck)).toBe(name);
    expect(wheelHueName({ x: 0, y: 0 })).toBe('neutral');
  });

  it('pushes colour without changing brightness', () => {
    for (const puck of [
      { x: 0.4, y: 0.2 },
      { x: -0.6, y: -0.3 },
      { x: 0.9, y: -0.4 },
    ]) {
      const color = wheelPuckToColor(puck);
      expect(color.r + color.g + color.b).toBeCloseTo(0, 10);
    }
  });

  it('measures the amount as the distance from the centre', () => {
    expect(wheelColorAmount(wheelPuckToColor({ x: 0, y: 0 }))).toBeCloseTo(0, 10);
    expect(wheelColorAmount(wheelPuckToColor({ x: 0, y: -0.5 }))).toBeCloseTo(0.5, 10);
    expect(wheelColorAmount(wheelPuckToColor({ x: 1, y: 0 }))).toBeCloseTo(1, 10);
  });

  it('keeps the puck inside the wheel', () => {
    expect(clampWheelPuck({ x: 2, y: 0 })).toEqual({ x: 1, y: 0 });
    expect(clampWheelPuck({ x: 0, y: -3 })).toEqual({ x: 0, y: -1 });
    const outside = clampWheelPuck({ x: 0.9, y: 0.9 });
    expect(Math.hypot(outside.x, outside.y)).toBeCloseTo(MAX_WHEEL_AMOUNT, 10);
  });

  it('reads a pointer position as a puck position', () => {
    expect(wheelPuckFromPointer(0, -50, 50)).toEqual({ x: 0, y: -1 });
    expect(wheelPuckFromPointer(25, 0, 50)).toEqual({ x: 0.5, y: 0 });
    expect(wheelPuckFromPointer(10, 10, 0)).toEqual({ x: 0, y: 0 });
    // A pointer outside the wheel lands on its edge, not beyond it.
    expect(wheelPuckFromPointer(100, 100, 50).x).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('moves the puck with the keyboard, and further with Shift', () => {
    const moved = nudgeWheelPuck({ x: 0, y: 0 }, WHEEL_KEYBOARD_STEP, 0);
    expect(moved).toEqual({ x: WHEEL_KEYBOARD_STEP, y: 0 });
    expect(WHEEL_KEYBOARD_STEP_FINE).toBeGreaterThan(WHEEL_KEYBOARD_STEP);
    const fine = nudgeWheelPuck({ x: 0, y: 0 }, WHEEL_KEYBOARD_STEP_FINE, 0);
    expect(fine.x).toBeCloseTo(WHEEL_KEYBOARD_STEP_FINE, 10);
    // The puck never leaves the wheel.
    expect(nudgeWheelPuck({ x: 1, y: 0 }, WHEEL_KEYBOARD_STEP_FINE, 0)).toEqual({ x: 1, y: 0 });
  });

  it('resets a wheel to no colour at all', () => {
    expect(resetWheelColor()).toEqual({ r: 0, g: 0, b: 0 });
    expect(wheelColorToPuck(resetWheelColor())).toEqual({ x: 0, y: 0 });
    expect(wheelPuckToColor({ x: 0, y: 0 })).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('keeps the hue circle centred on a colour push', () => {
    for (const angle of [0, 0.7, 1.9, -2.4]) {
      const hue = wheelHueVector(angle);
      expect(hue.r + hue.g + hue.b).toBeCloseTo(0, 10);
    }
    // The top of the wheel is the red end of the circle.
    const top = wheelHueVector(-Math.PI / 2);
    expect(top.r).toBeCloseTo(1, 10);
    expect(top.g).toBeCloseTo(-0.5, 10);
  });
});
