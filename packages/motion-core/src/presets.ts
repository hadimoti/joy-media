/**
 * Motion presets (§20.3): named, reusable animations that build keyframe curves
 * relative to an object's static transform over a chosen window. Presets are
 * pure builders — applying one means dispatching the resulting curves through
 * the normal `object.replaceAnimation` command, so presets inherit undo/redo and
 * persistence for free. These are original JOY presets.
 */

import type {
  AnimatablePropertyV1,
  AnimationCurveV1,
  TimeUs,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';

export interface MotionPresetOptions {
  /** Window start in object-local microseconds. */
  readonly startUs: TimeUs;
  /** Window length in microseconds; must be > 0. */
  readonly durationUs: number;
  /** The object's static transform — presets animate around these base values. */
  readonly base: VisualObjectTransformV1;
}

export type PresetChannels = Partial<Record<AnimatablePropertyV1, AnimationCurveV1>>;

export interface MotionPreset {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly channels: readonly AnimatablePropertyV1[];
  build(options: MotionPresetOptions): PresetChannels;
}

function assertWindow(options: MotionPresetOptions): { start: TimeUs; end: TimeUs } {
  if (!(options.durationUs > 0)) throw new RangeError('preset duration must be positive');
  const start = Math.round(options.startUs);
  return { start, end: start + Math.round(options.durationUs) };
}

/** Fade in from transparent to the object's base opacity. */
const fadeIn: MotionPreset = {
  id: 'joy-fade-in',
  name: 'Fade In',
  description: 'Opacity rises from 0 to the object value.',
  channels: ['opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: end, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Fade out from the base opacity to transparent. */
const fadeOut: MotionPreset = {
  id: 'joy-fade-out',
  name: 'Fade Out',
  description: 'Opacity falls from the object value to 0.',
  channels: ['opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      opacity: {
        keyframes: [
          { timeUs: start, value: options.base.opacity, interpolation: 'eased' },
          { timeUs: end, value: 0, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Scale-and-fade entrance with a subtle overshoot at 70% of the window. */
const popIn: MotionPreset = {
  id: 'joy-pop-in',
  name: 'Pop In',
  description: 'Scales up past 100% then settles, fading in.',
  channels: ['scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const overshootAt = start + Math.round((end - start) * 0.7);
    const scaleCurve = (target: number): AnimationCurveV1 => ({
      keyframes: [
        { timeUs: start, value: target * 0.6, interpolation: 'eased' },
        { timeUs: overshootAt, value: target * 1.08, interpolation: 'eased' },
        { timeUs: end, value: target, interpolation: 'linear' },
      ],
    });
    return {
      scaleX: scaleCurve(options.base.scaleX),
      scaleY: scaleCurve(options.base.scaleY),
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: overshootAt, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

/** Slide up into place from 80px below, fading in. */
const slideUp: MotionPreset = {
  id: 'joy-slide-up',
  name: 'Slide Up',
  description: 'Rises into place from below while fading in.',
  channels: ['y', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      y: {
        keyframes: [
          { timeUs: start, value: options.base.y + 80, interpolation: 'eased' },
          { timeUs: end, value: options.base.y, interpolation: 'linear' },
        ],
      },
      opacity: {
        keyframes: [
          { timeUs: start, value: 0, interpolation: 'eased' },
          { timeUs: end, value: options.base.opacity, interpolation: 'linear' },
        ],
      },
    };
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Intro / outro pack: 2D slides, bounces, spins, card flips and 2.5D depth.
 *
 * Every preset animates *around* the object's own transform, so applying one to
 * a moved or scaled object still lands it back on its authored values. Flips are
 * simulated with an axis squash — a V1 object is a flat quad with no per-layer
 * 3D tilt (ADR-0015) — and the depth presets drive `positionZ`, which only
 * projects while a composition has an active camera, so each one also carries a
 * scale ramp that reads on its own.
 * ────────────────────────────────────────────────────────────────────────── */

type PresetStop = readonly [timeUs: number, value: number];

/** Curve from `[timeUs, value]` stops: eased between, linear out of the last. */
function curveFrom(stops: readonly PresetStop[]): AnimationCurveV1 {
  return {
    keyframes: stops.map(([timeUs, value], index) => ({
      timeUs: Math.round(timeUs),
      value,
      interpolation: index === stops.length - 1 ? ('linear' as const) : ('eased' as const),
    })),
  };
}

/** Absolute time at fraction `f` of the preset window. */
function at(start: TimeUs, end: TimeUs, f: number): number {
  return start + (end - start) * f;
}

/** Fade 0 → base, complete at `f` so the move can settle behind it. */
function fadeInCurve(
  options: MotionPresetOptions,
  start: TimeUs,
  end: TimeUs,
  f = 0.7,
): AnimationCurveV1 {
  return curveFrom([
    [start, 0],
    [at(start, end, f), options.base.opacity],
  ]);
}

/** Fade base → 0, starting to drop at `f`. */
function fadeOutCurve(
  options: MotionPresetOptions,
  start: TimeUs,
  end: TimeUs,
  f = 0.3,
): AnimationCurveV1 {
  return curveFrom([
    [start, options.base.opacity],
    [at(start, end, f), options.base.opacity],
    [end, 0],
  ]);
}

/** Single-axis travel with a fade, in either direction. */
function slidePreset(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly axis: 'x' | 'y';
  readonly offset: number;
  readonly outro?: boolean;
}): MotionPreset {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    channels: [config.axis, 'opacity'],
    build(options) {
      const { start, end } = assertWindow(options);
      const home = options.base[config.axis];
      const away = home + config.offset;
      const travel = config.outro
        ? curveFrom([
            [start, home],
            [end, away],
          ])
        : curveFrom([
            [start, away],
            [end, home],
          ]);
      const channels: PresetChannels = {
        opacity: config.outro
          ? fadeOutCurve(options, start, end)
          : fadeInCurve(options, start, end),
      };
      if (config.axis === 'x') channels.x = travel;
      else channels.y = travel;
      return channels;
    },
  };
}

/** Uniform scale ramp with a fade — zoom/punch family. */
function scalePreset(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly from: number;
  readonly to?: number;
  readonly outro?: boolean;
}): MotionPreset {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    channels: ['scaleX', 'scaleY', 'opacity'],
    build(options) {
      const { start, end } = assertWindow(options);
      const ramp = (base: number): AnimationCurveV1 =>
        config.outro
          ? curveFrom([
              [start, base],
              [end, base * (config.to ?? config.from)],
            ])
          : curveFrom([
              [start, base * config.from],
              [end, base * (config.to ?? 1)],
            ]);
      return {
        scaleX: ramp(options.base.scaleX),
        scaleY: ramp(options.base.scaleY),
        opacity: config.outro
          ? fadeOutCurve(options, start, end, 0.45)
          : fadeInCurve(options, start, end, 0.55),
      };
    },
  };
}

/** Exit counterpart of Pop In: a last swell, then collapse. */
const popOut: MotionPreset = {
  id: 'joy-pop-out',
  name: 'Pop Out',
  description: 'Swells past 100% then collapses away, fading out.',
  channels: ['scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const swell = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base],
        [at(start, end, 0.3), base * 1.08],
        [end, base * 0.6],
      ]);
    return {
      scaleX: swell(options.base.scaleX),
      scaleY: swell(options.base.scaleY),
      opacity: fadeOutCurve(options, start, end, 0.35),
    };
  },
};

const zoomIn = scalePreset({
  id: 'joy-zoom-in',
  name: 'Zoom In',
  description: 'Grows from 20% to full size while fading in.',
  from: 0.2,
});

const zoomOut = scalePreset({
  id: 'joy-zoom-out',
  name: 'Zoom Out',
  description: 'Shrinks to 20% and fades away.',
  from: 0.2,
  outro: true,
});

const punchIn = scalePreset({
  id: 'joy-punch-in',
  name: 'Punch In',
  description: 'Slams down from 220% to full size — no overshoot.',
  from: 2.2,
});

const slideDown = slidePreset({
  id: 'joy-slide-down',
  name: 'Slide Down',
  description: 'Drops into place from above while fading in.',
  axis: 'y',
  offset: -220,
});

const slideInLeft = slidePreset({
  id: 'joy-slide-in-left',
  name: 'Slide In Left',
  description: 'Enters from off-frame left while fading in.',
  axis: 'x',
  offset: -280,
});

const slideInRight = slidePreset({
  id: 'joy-slide-in-right',
  name: 'Slide In Right',
  description: 'Enters from off-frame right while fading in.',
  axis: 'x',
  offset: 280,
});

const slideOutUp = slidePreset({
  id: 'joy-slide-out-up',
  name: 'Slide Out Up',
  description: 'Leaves upward while fading out.',
  axis: 'y',
  offset: -220,
  outro: true,
});

const slideOutLeft = slidePreset({
  id: 'joy-slide-out-left',
  name: 'Slide Out Left',
  description: 'Leaves toward frame left while fading out.',
  axis: 'x',
  offset: -280,
  outro: true,
});

const slideOutRight = slidePreset({
  id: 'joy-slide-out-right',
  name: 'Slide Out Right',
  description: 'Leaves toward frame right while fading out.',
  axis: 'x',
  offset: 280,
  outro: true,
});

/** Damped landing: four decaying hops onto the base position. */
const bounceIn: MotionPreset = {
  id: 'joy-bounce-in',
  name: 'Bounce In',
  description: 'Falls in and settles through four decaying hops.',
  channels: ['y', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.y;
    return {
      y: curveFrom([
        [start, home - 340],
        [at(start, end, 0.4), home],
        [at(start, end, 0.55), home - 96],
        [at(start, end, 0.68), home],
        [at(start, end, 0.79), home - 38],
        [at(start, end, 0.88), home],
        [at(start, end, 0.94), home - 13],
        [end, home],
      ]),
      opacity: fadeInCurve(options, start, end, 0.3),
    };
  },
};

/** Two teasing hops before the object drops out of frame. */
const bounceOut: MotionPreset = {
  id: 'joy-bounce-out',
  name: 'Bounce Out',
  description: 'Hops twice, then drops out of frame.',
  channels: ['y', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.y;
    return {
      y: curveFrom([
        [start, home],
        [at(start, end, 0.16), home - 54],
        [at(start, end, 0.34), home],
        [at(start, end, 0.48), home - 26],
        [at(start, end, 0.62), home],
        [end, home + 460],
      ]),
      opacity: fadeOutCurve(options, start, end, 0.68),
    };
  },
};

/** Gravity drop with a squash-and-stretch landing. */
const bounceDrop: MotionPreset = {
  id: 'joy-bounce-drop',
  name: 'Bounce Drop',
  description: 'Drops from above and squashes on impact before settling.',
  channels: ['y', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.y;
    const impact = at(start, end, 0.45);
    return {
      y: curveFrom([
        [start, home - 520],
        [impact, home + 18],
        [at(start, end, 0.6), home - 62],
        [at(start, end, 0.76), home],
        [at(start, end, 0.88), home - 18],
        [end, home],
      ]),
      scaleY: curveFrom([
        [start, options.base.scaleY],
        [impact, options.base.scaleY * 0.74],
        [at(start, end, 0.58), options.base.scaleY * 1.1],
        [end, options.base.scaleY],
      ]),
      scaleX: curveFrom([
        [start, options.base.scaleX],
        [impact, options.base.scaleX * 1.24],
        [at(start, end, 0.58), options.base.scaleX * 0.94],
        [end, options.base.scaleX],
      ]),
      opacity: fadeInCurve(options, start, end, 0.22),
    };
  },
};

/** Elastic wobble in place — an accent, not an entrance. */
const rubberBand: MotionPreset = {
  id: 'joy-rubber-band',
  name: 'Rubber Band',
  description: 'Stretches and squashes in place, then settles.',
  channels: ['scaleX', 'scaleY'],
  build(options) {
    const { start, end } = assertWindow(options);
    const wobble = (base: number, phase: readonly number[]): AnimationCurveV1 =>
      curveFrom([
        [start, base],
        [at(start, end, 0.25), base * phase[0]!],
        [at(start, end, 0.45), base * phase[1]!],
        [at(start, end, 0.65), base * phase[2]!],
        [at(start, end, 0.82), base * phase[3]!],
        [end, base],
      ]);
    return {
      scaleX: wobble(options.base.scaleX, [1.28, 0.8, 1.13, 0.95]),
      scaleY: wobble(options.base.scaleY, [0.76, 1.2, 0.89, 1.05]),
    };
  },
};

/** Half-turn entrance: rotation plus a scale ramp so it reads at any size. */
const spinIn: MotionPreset = {
  id: 'joy-spin-in',
  name: 'Spin In',
  description: 'Turns a half circle into place while growing and fading in.',
  channels: ['rotationDeg', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const ramp = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base * 0.4],
        [end, base],
      ]);
    return {
      rotationDeg: curveFrom([
        [start, options.base.rotationDeg - 180],
        [end, options.base.rotationDeg],
      ]),
      scaleX: ramp(options.base.scaleX),
      scaleY: ramp(options.base.scaleY),
      opacity: fadeInCurve(options, start, end, 0.6),
    };
  },
};

const spinOut: MotionPreset = {
  id: 'joy-spin-out',
  name: 'Spin Out',
  description: 'Turns a half circle away while shrinking and fading out.',
  channels: ['rotationDeg', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const ramp = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base],
        [end, base * 0.4],
      ]);
    return {
      rotationDeg: curveFrom([
        [start, options.base.rotationDeg],
        [end, options.base.rotationDeg + 180],
      ]),
      scaleX: ramp(options.base.scaleX),
      scaleY: ramp(options.base.scaleY),
      opacity: fadeOutCurve(options, start, end, 0.4),
    };
  },
};

/** Pendulum entrance: decaying tilt around the base angle. */
const swingIn: MotionPreset = {
  id: 'joy-swing-in',
  name: 'Swing In',
  description: 'Swings in on a decaying tilt, like a hinged sign.',
  channels: ['rotationDeg', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.rotationDeg;
    return {
      rotationDeg: curveFrom([
        [start, home + 22],
        [at(start, end, 0.3), home - 14],
        [at(start, end, 0.52), home + 8],
        [at(start, end, 0.72), home - 4],
        [at(start, end, 0.88), home + 1.6],
        [end, home],
      ]),
      opacity: fadeInCurve(options, start, end, 0.35),
    };
  },
};

/** Travel plus spin, in the direction of travel. */
function rollPreset(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly offset: number;
  readonly turns: number;
  readonly outro?: boolean;
}): MotionPreset {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    channels: ['x', 'rotationDeg', 'opacity'],
    build(options) {
      const { start, end } = assertWindow(options);
      const home = options.base.x;
      const angle = options.base.rotationDeg;
      return {
        x: config.outro
          ? curveFrom([
              [start, home],
              [end, home + config.offset],
            ])
          : curveFrom([
              [start, home + config.offset],
              [end, home],
            ]),
        rotationDeg: config.outro
          ? curveFrom([
              [start, angle],
              [end, angle + config.turns],
            ])
          : curveFrom([
              [start, angle - config.turns],
              [end, angle],
            ]),
        opacity: config.outro
          ? fadeOutCurve(options, start, end, 0.4)
          : fadeInCurve(options, start, end, 0.4),
      };
    },
  };
}

const rollIn = rollPreset({
  id: 'joy-roll-in',
  name: 'Roll In',
  description: 'Rolls in from frame left, turning as it travels.',
  offset: -340,
  turns: 240,
});

const rollOut = rollPreset({
  id: 'joy-roll-out',
  name: 'Roll Out',
  description: 'Rolls off toward frame right, turning as it travels.',
  offset: 340,
  turns: 240,
  outro: true,
});

/** Curved entrance: horizontal travel with a lifted apex and a settling tilt. */
const arcIn: MotionPreset = {
  id: 'joy-arc-in',
  name: 'Arc In',
  description: 'Travels in along a lifted arc and levels out.',
  channels: ['x', 'y', 'rotationDeg', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    return {
      x: curveFrom([
        [start, options.base.x - 300],
        [end, options.base.x],
      ]),
      y: curveFrom([
        [start, options.base.y + 40],
        [at(start, end, 0.55), options.base.y - 150],
        [end, options.base.y],
      ]),
      rotationDeg: curveFrom([
        [start, options.base.rotationDeg - 14],
        [at(start, end, 0.7), options.base.rotationDeg + 5],
        [end, options.base.rotationDeg],
      ]),
      opacity: fadeInCurve(options, start, end, 0.4),
    };
  },
};

/** Card flip simulated by squashing one axis through zero-width. */
function flipPreset(config: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly axis: 'scaleX' | 'scaleY';
  readonly outro?: boolean;
}): MotionPreset {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    channels: [config.axis, 'opacity'],
    build(options) {
      const { start, end } = assertWindow(options);
      const home = options.base[config.axis];
      const flip = config.outro
        ? curveFrom([
            [start, home],
            [at(start, end, 0.3), home * 1.06],
            [end, home * 0.02],
          ])
        : curveFrom([
            [start, home * 0.02],
            [at(start, end, 0.72), home * 1.06],
            [end, home],
          ]);
      const channels: PresetChannels = {
        opacity: config.outro
          ? fadeOutCurve(options, start, end, 0.5)
          : fadeInCurve(options, start, end, 0.3),
      };
      if (config.axis === 'scaleX') channels.scaleX = flip;
      else channels.scaleY = flip;
      return channels;
    },
  };
}

const flipInX = flipPreset({
  id: 'joy-flip-in-x',
  name: 'Flip In X',
  description: 'Opens out around the horizontal axis, like a turning card.',
  axis: 'scaleY',
});

const flipInY = flipPreset({
  id: 'joy-flip-in-y',
  name: 'Flip In Y',
  description: 'Opens out around the vertical axis, like a turning card.',
  axis: 'scaleX',
});

const flipOutY = flipPreset({
  id: 'joy-flip-out-y',
  name: 'Flip Out Y',
  description: 'Closes edge-on around the vertical axis and fades out.',
  axis: 'scaleX',
  outro: true,
});

/** Depth entrance: rises out of the background toward the camera. */
const depthPushIn: MotionPreset = {
  id: 'joy-depth-push-in',
  name: 'Depth Push In',
  description: 'Comes forward from deep in the scene (needs an active camera).',
  channels: ['positionZ', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.positionZ ?? 0;
    const ramp = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base * 0.55],
        [end, base],
      ]);
    return {
      positionZ: curveFrom([
        [start, home + 900],
        [end, home],
      ]),
      scaleX: ramp(options.base.scaleX),
      scaleY: ramp(options.base.scaleY),
      opacity: fadeInCurve(options, start, end, 0.5),
    };
  },
};

/** Depth exit: falls back into the scene and dissolves. */
const depthPullOut: MotionPreset = {
  id: 'joy-depth-pull-out',
  name: 'Depth Pull Out',
  description: 'Recedes into the background and fades (needs an active camera).',
  channels: ['positionZ', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.positionZ ?? 0;
    const ramp = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base],
        [end, base * 0.45],
      ]);
    return {
      positionZ: curveFrom([
        [start, home],
        [end, home + 1100],
      ]),
      scaleX: ramp(options.base.scaleX),
      scaleY: ramp(options.base.scaleY),
      opacity: fadeOutCurve(options, start, end, 0.35),
    };
  },
};

/** Depth exit toward the lens: overshoots the camera plane and blows past it. */
const flyThroughOut: MotionPreset = {
  id: 'joy-fly-through-out',
  name: 'Fly Through',
  description: 'Rushes past the lens — depth toward camera plus a scale blowout.',
  channels: ['positionZ', 'scaleX', 'scaleY', 'opacity'],
  build(options) {
    const { start, end } = assertWindow(options);
    const home = options.base.positionZ ?? 0;
    const ramp = (base: number): AnimationCurveV1 =>
      curveFrom([
        [start, base],
        [at(start, end, 0.45), base * 1.25],
        [end, base * 3.4],
      ]);
    return {
      positionZ: curveFrom([
        [start, home],
        [at(start, end, 0.45), home - 240],
        [end, home - 760],
      ]),
      scaleX: ramp(options.base.scaleX),
      scaleY: ramp(options.base.scaleY),
      opacity: fadeOutCurve(options, start, end, 0.55),
    };
  },
};

export const JOY_MOTION_PRESETS: readonly MotionPreset[] = [
  fadeIn,
  fadeOut,
  popIn,
  popOut,
  zoomIn,
  zoomOut,
  punchIn,
  slideUp,
  slideDown,
  slideInLeft,
  slideInRight,
  slideOutUp,
  slideOutLeft,
  slideOutRight,
  bounceIn,
  bounceOut,
  bounceDrop,
  rubberBand,
  spinIn,
  spinOut,
  swingIn,
  rollIn,
  rollOut,
  arcIn,
  flipInX,
  flipInY,
  flipOutY,
  depthPushIn,
  depthPullOut,
  flyThroughOut,
];

/** Looks up a preset by id, or `undefined` when unknown. */
export function resolveMotionPreset(id: string): MotionPreset | undefined {
  return JOY_MOTION_PRESETS.find((preset) => preset.id === id);
}

/** Builds a preset's channel curves, throwing on an unknown id. */
export function buildPresetChannels(id: string, options: MotionPresetOptions): PresetChannels {
  const preset = resolveMotionPreset(id);
  if (preset === undefined) throw new RangeError(`unknown motion preset "${id}"`);
  return preset.build(options);
}
