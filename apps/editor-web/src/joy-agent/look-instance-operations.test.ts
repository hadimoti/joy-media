import { describe, expect, it } from 'vitest';
import { editorialClean } from '@joy-media/motion-core';
import { canonicalBindingKey } from '@joy-media/project-schema';
import type { LookInstance, LookInstancesDocument } from '@joy-media/project-schema';
import {
  buildLookInstanceRecord,
  detachLookInstance,
  lookBindingKeyIndex,
  lookInstanceUpdateCompileInput,
  markLookBindingOverridden,
  markOverridesFromCommittedKeys,
  orphanedLookInstanceIds,
  upsertLookInstance,
} from './look-instance-operations.js';

const slotIds = editorialClean.slots.map((s) => s.id);
const controlDefaults = Object.fromEntries(editorialClean.controls.map((c) => [c.id, c.default]));

function compileInput(overrides: Record<string, unknown> = {}) {
  return {
    definition: editorialClean,
    definitionVersion: editorialClean.version,
    compositionId: 'root',
    compositionDurationUs: 12_000_000,
    format: 'portrait' as const,
    entityBindings: Object.fromEntries(slotIds.map((id, i) => [id, `obj-${i}`])),
    controlValues: { ...controlDefaults },
    overriddenBindingIds: [] as readonly string[],
    resolvedFonts: {},
    ...overrides,
  };
}

function doc(instances: readonly LookInstance[] = []): LookInstancesDocument {
  return {
    id: 'project-1',
    schemaVersion: 1,
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

describe('look-instance-operations (GAP 1b + 5)', () => {
  it('buildLookInstanceRecord captures the compiled intent', () => {
    const record = buildLookInstanceRecord('look-1', compileInput());
    expect(record).toMatchObject({
      id: 'look-1',
      definitionId: editorialClean.id,
      definitionVersion: editorialClean.version,
      compositionId: 'root',
      overriddenBindingIds: [],
      createdEntityIds: [],
    });
    expect(Object.keys(record.entityBindings)).toEqual(slotIds);
  });

  it('a reset removes exactly the reset bindings from overriddenBindingIds', () => {
    const record = buildLookInstanceRecord(
      'look-1',
      compileInput({ overriddenBindingIds: ['b1', 'b2', 'b3'], resetBindingIds: ['b2'] }),
    );
    expect(record.overriddenBindingIds).toEqual(['b1', 'b3']);
  });

  it('upsert then detach round-trips the document', () => {
    const record = buildLookInstanceRecord('look-1', compileInput());
    const withLook = upsertLookInstance(doc(), record);
    expect(withLook.instances['look-1']).toEqual(record);

    const detached = detachLookInstance(withLook, 'look-1');
    expect(detached.instances).toEqual({});
    // detach of an unknown id is a no-op (same reference)
    expect(detachLookInstance(detached, 'look-1')).toBe(detached);
  });

  it('lookInstanceUpdateCompileInput recompiles the pinned definition with new values', () => {
    const instance = buildLookInstanceRecord(
      'look-1',
      compileInput({
        controlValues: { ...controlDefaults, [editorialClean.controls[0]!.id]: 0.9 },
        overriddenBindingIds: ['b1'],
      }),
    );
    const next = lookInstanceUpdateCompileInput(
      instance,
      { nextControlValues: { [editorialClean.controls[0]!.id]: 0.2 }, resetBindingIds: ['b1'] },
      {
        definition: editorialClean,
        compositionDurationUs: 12_000_000,
        format: 'portrait',
        resolvedFonts: {},
      },
    );
    expect(next.definitionVersion).toBe(instance.definitionVersion);
    expect(next.controlValues[editorialClean.controls[0]!.id]).toBe(0.2);
    // overriddenBindingIds carried through unchanged; reset is separate
    expect(next.overriddenBindingIds).toEqual(['b1']);
    expect(next.resetBindingIds).toEqual(['b1']);
    expect(next.entityBindings).toEqual(instance.entityBindings);
  });

  it('markLookBindingOverridden adds a binding once, canonically sorted', () => {
    const instance = buildLookInstanceRecord(
      'look-1',
      compileInput({ overriddenBindingIds: ['zz'] }),
    );
    const d0 = upsertLookInstance(doc(), instance);
    const d1 = markLookBindingOverridden(d0, 'look-1', ['aa']);
    expect(d1.instances['look-1']!.overriddenBindingIds).toEqual(['aa', 'zz']);
    // idempotent — already listed -> same document reference
    expect(markLookBindingOverridden(d1, 'look-1', ['aa'])).toBe(d1);
    // unknown instance -> no-op
    expect(markLookBindingOverridden(d1, 'look-404', ['aa'])).toBe(d1);
  });

  it('markOverridesFromCommittedKeys marks a hand-edited linked binding (manual == agent)', () => {
    const inst = buildLookInstanceRecord('look-1', compileInput());
    const d = upsertLookInstance(doc(), inst);
    const defs = new Map([[editorialClean.id, editorialClean]]);

    const kfTarget = editorialClean.bindingTargets.find((t) => t.channel === 'keyframe')!;
    const committedKey = canonicalBindingKey({
      ownerKind: kfTarget.ownerKind,
      ownerId: inst.entityBindings[kfTarget.ownerSlotId]!,
      propertyId: kfTarget.propertyId,
      timeDomain: kfTarget.timeDomain,
    });
    expect([...lookBindingKeyIndex(inst, editorialClean).keys()]).toContain(committedKey);

    const marked = markOverridesFromCommittedKeys(d, defs, [committedKey]);
    expect(marked.instances['look-1']!.overriddenBindingIds).toContain(kfTarget.bindingId);
    // idempotent + no-op when nothing matches
    expect(markOverridesFromCommittedKeys(marked, defs, [committedKey])).toBe(marked);
    expect(markOverridesFromCommittedKeys(d, defs, ['not-a-binding-key'])).toBe(d);
  });

  it('orphanedLookInstanceIds flags an instance bound to a missing object', () => {
    const live = buildLookInstanceRecord(
      'look-live',
      compileInput({ entityBindings: { [slotIds[0]!]: 'obj-a' } }),
    );
    const dead = buildLookInstanceRecord(
      'look-dead',
      compileInput({ entityBindings: { [slotIds[0]!]: 'obj-gone' } }),
    );
    const d = doc([live, dead]);
    expect(orphanedLookInstanceIds(d, new Set(['obj-a']))).toEqual(['look-dead']);
    expect(orphanedLookInstanceIds(d, new Set(['obj-a', 'obj-gone']))).toEqual([]);
  });
});
