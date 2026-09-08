import { describe, expect, it } from 'vitest';
import { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';
import { BUILT_IN_LOOK_PACKS } from './index.js';
import { validateLookDefinition } from '../validate.js';
import { compileLook } from '../compile.js';
import type { LookCompileInput, LookDefinition } from '../types.js';

function firstApplyInput(definition: LookDefinition): LookCompileInput {
  // Bind every slot to a synthetic id and take every control default.
  const entityBindings = Object.fromEntries(
    definition.slots.map((slot) => [slot.id, `entity-${slot.id}`]),
  );
  return {
    definition,
    definitionVersion: definition.version,
    compositionId: 'root',
    compositionDurationUs: 8_000_000,
    format: 'portrait',
    entityBindings,
    controlValues: {},
    overriddenBindingIds: [],
    resolvedFonts: Object.fromEntries(definition.requiredFonts.map((f) => [f, f])),
  };
}

describe('built-in Look packs', () => {
  it('ships exactly five packs with unique ids', () => {
    expect(BUILT_IN_LOOK_PACKS).toHaveLength(5);
    expect(new Set(BUILT_IN_LOOK_PACKS.map((p) => p.id)).size).toBe(5);
    expect(BUILT_IN_LOOK_PACKS.map((p) => p.id)).toEqual([
      'editorial-clean',
      'product-precision',
      'kinetic-type',
      'quiet-documentary',
      'music-pulse',
    ]);
  });

  it('retires persian-editorial (English-only app)', () => {
    expect(BUILT_IN_LOOK_PACKS.map((p) => p.id)).not.toContain('persian-editorial');
  });

  for (const pack of BUILT_IN_LOOK_PACKS) {
    describe(pack.id, () => {
      it('passes definition validation', () => {
        expect(validateLookDefinition(pack)).toEqual([]);
      });

      it('every keyframe binding targets a real animatable property', () => {
        for (const target of pack.bindingTargets) {
          if (target.channel === 'keyframe') {
            expect(ANIMATABLE_PROPERTIES as readonly string[]).toContain(target.propertyId);
          }
        }
      });

      it('declares portrait and landscape constraints explicitly', () => {
        expect(pack.constraints.portrait).not.toEqual(pack.constraints.landscape);
        for (const format of ['portrait', 'landscape'] as const) {
          expect(pack.constraints[format].safeMarginPx).toBeGreaterThan(0);
          expect(pack.constraints[format].minHoldUs).toBeGreaterThan(0);
        }
      });

      it('compiles to real operations on a full first apply', () => {
        const result = compileLook(firstApplyInput(pack));
        expect(result.ok).toBe(true);
        expect(result.operations.length).toBeGreaterThan(0);
      });

      it('every control names only declared bindings and can produce an operation', () => {
        // Not a defaults check (a boolean toggle off by default writes nothing);
        // this verifies each control's drives reference real bindings so no
        // control is a fake slider.
        const bindingIds = new Set(pack.bindingTargets.map((b) => b.bindingId));
        for (const control of pack.controls) {
          const referenced: string[] = [];
          if (control.kind === 'scalar' || control.kind === 'enum' || control.kind === 'boolean') {
            for (const drive of control.drives) referenced.push(drive.bindingId);
          }
          if (control.kind === 'color' || control.kind === 'font') {
            for (const drive of control.drives) referenced.push(drive.bindingId);
          }
          if (control.kind === 'enum') {
            for (const drive of control.templateDrives ?? []) referenced.push(drive.bindingId);
          }
          expect(referenced.length, `control "${control.id}" drives nothing`).toBeGreaterThan(0);
          for (const b of referenced) {
            expect(bindingIds.has(b), `control "${control.id}" -> unknown binding "${b}"`).toBe(
              true,
            );
          }
        }
      });

      it('compiles deterministically — identical input, identical digest', () => {
        expect(compileLook(firstApplyInput(pack)).operationDigest).toBe(
          compileLook(firstApplyInput(pack)).operationDigest,
        );
      });

      it('declared and emitted operation kinds agree on a full first apply', () => {
        const result = compileLook(firstApplyInput(pack));
        // Nothing emitted that was not declared …
        for (const kind of result.dependencies.operationKinds) {
          expect(pack.requiredOperationKinds as readonly string[]).toContain(kind);
        }
        // … and nothing declared that a full apply never emits.
        for (const kind of pack.requiredOperationKinds) {
          expect(result.dependencies.operationKinds as readonly string[]).toContain(kind);
        }
      });
    });
  }
});
