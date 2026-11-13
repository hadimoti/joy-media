/**
 * The colour wheels' maths (T-K02).
 *
 * A wheel pushes colour: the puck's angle is the hue being pushed and its
 * distance from the centre is the amount. The three channel values follow the
 * hue circle, so the puck and the channel values are two views of the same
 * thing and either one can be read back from the other.
 *
 * The maths lives here, away from the DOM, so it can be checked without a
 * browser.
 */

/** The four wheels, in the order the panel shows them. */
export const COLOR_WHEEL_IDS = ['lift', 'gamma', 'gain', 'offset'] as const;

export type ColorWheelId = (typeof COLOR_WHEEL_IDS)[number];

export interface ColorWheelMeta {
  readonly id: ColorWheelId;
  /** The wheel's name, with a capital letter. */
  readonly label: string;
  /** What the wheel is for, in the renderer's terms. */
  readonly hint: string;
}

export const COLOR_WHEELS: readonly ColorWheelMeta[] = [
  { id: 'lift', label: 'Lift', hint: 'shadows' },
  { id: 'gamma', label: 'Gamma', hint: 'midtones' },
  { id: 'gain', label: 'Gain', hint: 'highlights' },
  { id: 'offset', label: 'Offset', hint: 'everything' },
];

/** The coloured part of a wheel: the channels the puck pushes. */
export interface WheelColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A puck position on the wheel: -1..1 on both axes, inside the unit disc. */
export interface WheelPuck {
  readonly x: number;
  readonly y: number;
}

export const IDENTITY_WHEEL_COLOR: WheelColor = Object.freeze({ r: 0, g: 0, b: 0 });

/** The largest channel amount a puck can ask for. */
export const MAX_WHEEL_AMOUNT = 1;

/** How far one arrow key moves the puck, and how far Shift+arrow moves it. */
export const WHEEL_KEYBOARD_STEP = 0.02;
export const WHEEL_KEYBOARD_STEP_FINE = 0.1;

/** A drag with Shift held moves the puck this much of the pointer's travel. */
export const WHEEL_FINE_DRAG_FACTOR = 0.25;

/** The angle between two neighbouring channels of the hue circle (120°). */
const HUE_STEP = (2 * Math.PI) / 3;

/**
 * The wheel is turned so that red sits at the top: the six hues then fall on
 * the clock positions of a colour wheel — red at 12 o'clock, yellow at 2,
 * green at 4, cyan at 6, blue at 8 and magenta at 10.
 */
const WHEEL_ROTATION = Math.PI / 2;

/** One named hue on the wheel face. */
export interface WheelHueStop {
  readonly name: string;
  readonly hex: string;
  /** The middle of the wedge, in radians, on the screen's angle (y grows down). */
  readonly angle: number;
}

export const WHEEL_FACE_HUES: readonly WheelHueStop[] = [
  { name: 'red', hex: '#d9553f', angle: -Math.PI / 2 },
  { name: 'yellow', hex: '#d3b13f', angle: -Math.PI / 6 },
  { name: 'green', hex: '#55b06a', angle: Math.PI / 6 },
  { name: 'cyan', hex: '#4fb0b6', angle: Math.PI / 2 },
  { name: 'blue', hex: '#4f74c4', angle: (5 * Math.PI) / 6 },
  { name: 'magenta', hex: '#a65b0', angle: (7 * Math.PI) / 6 },
];

/** Keeps a puck inside the unit disc. */
export function clampWheelPuck(puck: WheelPuck): WheelPuck {
  const distance = Math.hypot(puck.x, puck.y);
  if (distance <= MAX_WHEEL_AMOUNT || distance === 0) return { x: puck.x, y: puck.y };
  const scale = MAX_WHEEL_AMOUNT / distance;
  return { x: puck.x * scale, y: puck.y * scale };
}

/**
 * The hue circle: the channel values for an angle. The three channels sum to
 * zero, so the push is a colour and not a brightness change.
 *
 * The angle is the screen's angle (y grows downwards), so the puck at the top
 * of the wheel pushes red.
 */
export function wheelHueVector(angle: number): WheelColor {
  const rotated = angle + WHEEL_ROTATION;
  return {
    r: Math.cos(rotated),
    g: Math.cos(rotated - HUE_STEP),
    b: Math.cos(rotated - 2 * HUE_STEP),
  };
}

/**
 * The channel values a puck asks for: the hue at its angle, at the strength of
 * its distance from the centre.
 */
export function wheelPuckToColor(puck: WheelPuck): WheelColor {
  const distance = Math.min(MAX_WHEEL_AMOUNT, Math.hypot(puck.x, puck.y));
  if (distance === 0) return IDENTITY_WHEEL_COLOR;
  const angle = Math.atan2(puck.y, puck.x);
  const hue = wheelHueVector(angle);
  return {
    r: hue.r * distance,
    g: hue.g * distance,
    b: hue.b * distance,
  };
}

/**
 * The puck a set of channel values sits at. The exact inverse of
 * `wheelPuckToColor`: the same values always give the same puck.
 *
 * With the hue circle above, the red channel is the puck's height (the top of
 * the wheel is red) and the difference between green and blue is its width.
 */
export function wheelColorToPuck(color: WheelColor): WheelPuck {
  return clampWheelPuck({
    x: (color.g - color.b) / Math.sqrt(3),
    // The top of the wheel is red, so the red channel is the height. Written
    // this way to keep a neutral wheel at +0 rather than -0.
    y: color.r === 0 ? 0 : -color.r,
  });
}

/** The strength of a wheel's push: how far its puck sits from the centre. */
export function wheelColorAmount(color: WheelColor): number {
  return Math.sqrt(((color.r * color.r + color.g * color.g + color.b * color.b) * 2) / 3);
}

/**
 * The puck a pointer is over, relative to the wheel's centre. `radius` is the
 * wheel's radius in the same units as the pointer's offset.
 */
export function wheelPuckFromPointer(offsetX: number, offsetY: number, radius: number): WheelPuck {
  if (radius <= 0) return { x: 0, y: 0 };
  return clampWheelPuck({ x: offsetX / radius, y: offsetY / radius });
}

/** Moves a puck by one keyboard step. */
export function nudgeWheelPuck(puck: WheelPuck, dx: number, dy: number): WheelPuck {
  return clampWheelPuck({ x: puck.x + dx, y: puck.y + dy });
}

/** A wheel with no colour push: the puck sits in the middle. */
export function resetWheelColor(): WheelColor {
  return IDENTITY_WHEEL_COLOR;
}

/** The hue a puck pushes, named after the nearest of the wheel's six hues. */
export function wheelHueName(puck: WheelPuck): string {
  if (Math.hypot(puck.x, puck.y) < 1e-6) return 'neutral';
  const angle = Math.atan2(puck.y, puck.x);
  let nearest = WHEEL_FACE_HUES[0]!;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const stop of WHEEL_FACE_HUES) {
    let delta = Math.abs(angle - stop.angle);
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    if (delta < nearestDistance) {
      nearestDistance = delta;
      nearest = stop;
    }
  }
  return nearest.name;
}
