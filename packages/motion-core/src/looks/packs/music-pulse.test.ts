import { describe, expect, it } from 'vitest';
import { musicPulse } from './music-pulse.js';
import { validateLookDefinition } from '../validate.js';
import { compileLook } from '../compile.js';
import type { LookCompileInput } from '../types.js';

/**
 * `music-pulse` is authored but held out of `BUILT_IN_LOOK_PACKS` for R2.1
 * (its "Accent cuts" toggle compiles to a permanent-on track and the
 * slider-only pulse is rate-less). These checks keep the definition from
 * rotting before the compiler grows a real rate control.
 */
function firstApplyInput(): LookCompileInput {
  return {
    definition: musicPulse,
    definitionVersion: musicPulse.version,
    compositionId: 'root',
    compositionDurationUs: 8_000_000,
    format: 'portrait',
    entityBindings: Object.fromEntries(
      musicPulse.slots.map((slot) => [slot.id, `entity-${slot.id}`]),
    ),
    controlValues: {},
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(musicPulse.requiredFonts.map((f) => [f, f])),
  };
}

describe('music-pulse (held for R2.1)', () => {
  it('still passes definition validation', () => {
    expect(validateLookDefinition(musicPulse)).toEqual([]);
  });

  it('still compiles to real operations on a full first apply', () => {
    const result = compileLook(firstApplyInput());
    expect(result.ok).toBe(true);
    expect(result.operations.length).toBeGreaterThan(0);
  });
});
