/**
 * Keyboard-only transforms on the Monitor (T-M12). Alt+arrows scale the selected
 * elements, [ and ] rotate them ({ and } turn 15 degrees), and Tab cycles through
 * the elements. Each press is one undo step, written through the same host as a
 * mouse gesture.
 */
import { MIN_SCALE, cleanNumber, wrapDegrees } from './monitor-transform-maths.js';
import type { TransformPatches } from './monitor-transform-drag.js';
import type { MonitorTransformTarget } from './monitor-transform-targets.js';
import type { TransformPatch } from './monitor-transform-keyframes.js';

/** Percent one Alt+arrow press changes the size by; Shift makes it ten times larger. */
export const KEY_SCALE_PERCENT = 1;
export const KEY_SCALE_SHIFT_PERCENT = 10;
/** Degrees one [ or ] press turns; { and } turn the larger step. */
export const KEY_ROTATE_DEGREES = 1;
export const KEY_ROTATE_SHIFT_DEGREES = 15;

/** The size factor one Alt+arrow press applies: Up and Right grow, Down and Left shrink. */
export function keyboardScaleFactor(key: string, shift: boolean): number | undefined {
  const percent = shift ? KEY_SCALE_SHIFT_PERCENT : KEY_SCALE_PERCENT;
  if (key === 'ArrowUp' || key === 'ArrowRight') return 1 + percent / 100;
  if (key === 'ArrowDown' || key === 'ArrowLeft') return 1 - percent / 100;
  return undefined;
}

/** The degrees one [ ] { } press turns (negative is anticlockwise), or undefined. */
export function keyboardRotateDegrees(key: string): number | undefined {
  switch (key) {
    case ']':
      return KEY_ROTATE_DEGREES;
    case '[':
      return -KEY_ROTATE_DEGREES;
    case '}':
      return KEY_ROTATE_SHIFT_DEGREES;
    case '{':
      return -KEY_ROTATE_SHIFT_DEGREES;
    default:
      return undefined;
  }
}

/**
 * The next element for Tab (or the previous one for Shift+Tab), in the order
 * given. It wraps at both ends; with nothing selected Tab takes the first element
 * and Shift+Tab the last. `undefined` when there are no elements.
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
  const next = backwards ? (index - 1 + count) % count : (index + 1) % count;
  return orderedClipIds[next];
}

export type KeyboardChange =
  | { readonly kind: 'scale'; readonly factor: number }
  | { readonly kind: 'rotate'; readonly degrees: number };

/** A size that keeps its sign and never falls below the smallest allowed scale. */
function resized(value: number, factor: number): number | undefined {
  if (value === 0) return 0;
  const magnitude = Math.max(MIN_SCALE, Math.abs(value * factor));
  const next = cleanNumber(Math.sign(value) * magnitude);
  return Number.isFinite(next) ? next : undefined;
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
      const scaleX = resized(local.scaleX, change.factor);
      const scaleY = resized(local.scaleY, change.factor);
      if (scaleX === undefined || scaleY === undefined) return undefined;
      patches.set(objectId, { ...local, scaleX, scaleY });
    } else {
      const rotationDeg = cleanNumber(wrapDegrees(local.rotationDeg + change.degrees));
      patches.set(objectId, { ...local, rotationDeg });
    }
  }
  return patches;
}
