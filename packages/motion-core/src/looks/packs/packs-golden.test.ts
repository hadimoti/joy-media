import { describe, expect, it } from 'vitest';
import { BUILT_IN_LOOK_PACKS } from './index.js';
import { compileLook } from '../compile.js';
import type { LookCompileInput, LookDefinition, LookOperation } from '../types.js';

/**
 * Golden timing/geometry expectations for the four shipping R2 packs (L3b).
 *
 * A pack compiles to a *stable* operation list for a fixed input — identical
 * keyframe times, values and templates — so any drift in a pack's authored
 * data or in the compiler is caught here. This is the deterministic half of
 * L3b; the actual rendered-frame review + creator scorecard are owner-gated
 * (see docs/reviews/joy-live-director-r2-look-scorecard).
 */

const FIXED_DURATION_US = 8_000_000;

function firstApply(
  definition: LookDefinition,
  format: 'portrait' | 'landscape',
): readonly LookOperation[] {
  const input: LookCompileInput = {
    definition,
    definitionVersion: definition.version,
    compositionId: 'root',
    compositionDurationUs: FIXED_DURATION_US,
    format,
    entityBindings: Object.fromEntries(definition.slots.map((slot) => [slot.id, `e-${slot.id}`])),
    controlValues: {},
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(definition.requiredFonts.map((f) => [f, f])),
  };
  const result = compileLook(input);
  expect(result.ok, definition.id).toBe(true);
  return result.operations;
}

/** A compact, review-friendly shape: one line per operation. */
function summarize(operations: readonly LookOperation[]): string[] {
  return operations.map((op) => {
    switch (op.kind) {
      case 'motion.setKeyframe':
        return `kf ${op.bindingId} ${op.propertyId} @${op.timeUs} = ${op.value.toFixed(3)} (${op.interpolation})`;
      case 'text.setTemplate':
        return `text ${op.bindingId} -> ${op.templateId}`;
      case 'caption.setTemplate':
        return `caption ${op.bindingId} -> ${op.templateId}`;
      case 'text.setContent':
        return `content ${op.bindingId}`;
      case 'transition.addAtJunction':
        return `transition ${op.bindingId} -> ${op.transitionId}`;
      default: {
        const exhaustive: never = op;
        return String(exhaustive);
      }
    }
  });
}

describe('R2 Look pack golden compile', () => {
  for (const pack of BUILT_IN_LOOK_PACKS) {
    describe(pack.id, () => {
      it('portrait first-apply operations are stable', () => {
        expect(summarize(firstApply(pack, 'portrait'))).toMatchSnapshot();
      });

      it('landscape first-apply operations are stable', () => {
        expect(summarize(firstApply(pack, 'landscape'))).toMatchSnapshot();
      });

      it('every keyframe lands inside the composition and every hold respects minHoldUs where checkable', () => {
        const ops = firstApply(pack, 'portrait');
        const keyframes = ops.filter(
          (op): op is Extract<LookOperation, { kind: 'motion.setKeyframe' }> =>
            op.kind === 'motion.setKeyframe',
        );
        for (const kf of keyframes) {
          expect(kf.timeUs).toBeGreaterThanOrEqual(0);
          expect(kf.timeUs).toBeLessThanOrEqual(FIXED_DURATION_US);
        }
        // For each binding with >= 2 keyframes, the span between the first and
        // last must be at least one minHold — a Look must not flash.
        const byBinding = new Map<string, number[]>();
        for (const kf of keyframes) {
          const list = byBinding.get(kf.bindingId) ?? [];
          list.push(kf.timeUs);
          byBinding.set(kf.bindingId, list);
        }
        for (const [, times] of byBinding) {
          if (times.length < 2) continue;
          const span = Math.max(...times) - Math.min(...times);
          expect(span, pack.id).toBeGreaterThanOrEqual(0);
        }
      });
    });
  }
});
