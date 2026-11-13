/**
 * Keyboard-only transforms on the Monitor (T-M12). Alt+arrows scale the selected
 * elements about their centre, the [ and ] keys rotate them ({ and } turn 15
 * degrees), and Tab steps through the elements. Each press is one undo step,
 * written through the same host as a mouse gesture.
 */
import {
  applyWorldChange,
  cleanNumber,
  smallestRatio,
  turn,
  wrapDegrees,
  type DrawnTransform,
} from './monitor-transform-maths.js';
import type { TransformPatches } from './monitor-transform-drag.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';
import type { TransformPatch } from './monitor-transform-keyframes.js';

/** Percent one Alt+arrow press changes the size by; Shift makes it ten times larger. */
export const KEY_SCALE_PERCENT = 1;
export const KEY_SCALE_SHIFT_PERCENT = 10;
/** Degrees one [ or ] press turns; Shift with the same keys turns the larger step. */
export const KEY_ROTATE_DEGREES = 1;
export const KEY_ROTATE_SHIFT_DEGREES = 15;

/** The size factor one Alt+arrow press applies: Up and Right grow, Down and Left shrink. */
export function keyboardScaleFactor(key: string, shift: boolean): number | undefined {
  const percent = shift ? KEY_SCALE_SHIFT_PERCENT : KEY_SCALE_PERCENT;
  if (key === 'ArrowUp' || key === 'ArrowRight') return 1 + percent / 100;
  if (key === 'ArrowDown' || key === 'ArrowLeft') return 1 - percent / 100;
  return undefined;
}

/**
 * The degrees one bracket press turns (negative is anticlockwise), or undefined. It
 * matches the physical key (`code`, so a non-Latin layout works), and Shift selects
 * the larger step.
 */
export function keyboardRotateDegrees(code: string, shift: boolean): number | undefined {
  const step = shift ? KEY_ROTATE_SHIFT_DEGREES : KEY_ROTATE_DEGREES;
  if (code === 'BracketRight') return step;
  if (code === 'BracketLeft') return -step;
  return undefined;
}

/**
 * The element Tab (or Shift+Tab, `backwards`) moves to, in the order given. It does not
 * wrap: at the last element Tab returns `undefined`, and so does Shift+Tab at the first,
 * so the caller lets the browser move focus out of the Monitor. With nothing selected Tab
 * takes the first element and Shift+Tab the last. `undefined` when there are no elements.
 */
export function nextElementClipId(
  orderedClipIds: readonly string[],
  selectedClipIds: readonly string[],
  backwards: boolean,
): string | undefined {
  const count = orderedClipIds.length;
  if (count === 0) return undefined;
  const index = orderedClipIds.findIndex((id) => selectedClipIds.includes(id));
  if (index < 0) return backwards ? orderedClipIds[count - 1] : orderedClipIds[0];
  const next = backwards ? index - 1 : index + 1;
  return next < 0 || next >= count ? undefined : orderedClipIds[next];
}

export type KeyboardChange =
  | { readonly kind: 'scale'; readonly factor: number }
  | { readonly kind: 'rotate'; readonly degrees: number };

/**
 * The drawn values after a scale by `factor` about the element's centre (the same pivot the
 * mouse handles keep fixed): the centre stays where it was. A scale never goes below the
 * smallest allowed size, and a scale already smaller than that is not raised when shrinking.
 */
function scaledAboutCentre(target: MonitorTransformTarget, factor: number): DrawnTransform {
  const { transform, origin, center } = target.geometry;
  const kx = Math.max(factor, smallestRatio(transform.scaleX));
  const ky = Math.max(factor, smallestRatio(transform.scaleY));
  const offset = turn({ x: center.x - origin.x, y: center.y - origin.y }, -transform.rotationDeg);
  const shifted = turn({ x: kx * offset.x, y: ky * offset.y }, transform.rotationDeg);
  const nextOrigin = { x: center.x - shifted.x, y: center.y - shifted.y };
  return {
    ...transform,
    scaleX: transform.scaleX * kx,
    scaleY: transform.scaleY * ky,
    x: nextOrigin.x - kx * (origin.x - transform.x),
    y: nextOrigin.y - ky * (origin.y - transform.y),
  };
}

/**
 * The values one key press writes. A selected object whose parent or ancestor is
 * also selected is not written on its own: the topmost selected ancestor takes the
 * change and the element follows it, as for a mouse gesture. `undefined` when a
 * value cannot be written.
 */
export function keyboardChangePatches(
  targets: readonly MonitorTransformTarget[],
  change: KeyboardChange,
): TransformPatches | undefined {
  const selectedObjects = new Set(
    targets.flatMap((target) => (target.objectId === undefined ? [] : [target.objectId])),
  );
  const patches = new Map<string, TransformPatch>();
  for (const target of targets) {
    const objectId = target.objectId;
    if (objectId === undefined || patches.has(objectId)) continue;
    if (target.ancestorObjectIds?.some((id) => selectedObjects.has(id)) === true) continue;
    const local = target.local;
    if (change.kind === 'scale') {
      const after = scaledAboutCentre(target, change.factor);
      const changed = applyWorldChange(local, target.geometry.transform, after, target.parent);
      if (changed === undefined) return undefined;
      patches.set(objectId, {
        ...local,
        x: changed.x,
        y: changed.y,
        scaleX: changed.scaleX,
        scaleY: changed.scaleY,
      });
    } else {
      const rotationDeg = cleanNumber(wrapDegrees(local.rotationDeg + change.degrees));
      patches.set(objectId, { ...local, rotationDeg });
    }
  }
  return patches;
}
