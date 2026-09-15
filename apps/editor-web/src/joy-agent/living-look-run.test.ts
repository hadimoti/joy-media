import { describe, expect, it } from 'vitest';
import { editorialClean } from '@joy-media/motion-core';
import { emptyLookInstancesDocument, type LookInstancesDocument } from '@joy-media/project-schema';
import type { EditorSession } from '../editor-session.js';
import type { LivingLooksRunInput } from '../LivingLooksPanel.js';
import { buildLookInstanceRecord } from './look-instance-operations.js';
import { resolveLivingLookRun, type LivingLookRunContext } from './living-look-run.js';

const SLOT_IDS = editorialClean.slots.map((s) => s.id);
const CONTROL_DEFAULTS = Object.fromEntries(editorialClean.controls.map((c) => [c.id, c.default]));

function fakeSession(lookInstances: LookInstancesDocument): EditorSession {
  return {
    visualProject: {
      id: 'doc-1',
      rootCompositionId: 'root',
      compositions: { root: { id: 'root', width: 1080, height: 1920, durationUs: 12_000_000 } },
      visualObjects: {},
    },
    lookInstances,
  } as unknown as EditorSession;
}

const CONTEXT: LivingLookRunContext = {
  resolvedFonts: {},
  availableFonts: [],
  makeInstanceId: () => 'look-00000000-1111-2222-3333-444444444444',
};

const applyRequest: LivingLooksRunInput = {
  kind: 'apply',
  definitionId: editorialClean.id,
  definitionVersion: editorialClean.version,
  entityBindings: Object.fromEntries(SLOT_IDS.map((id) => [id, `vo-${id}`])),
  controlValues: CONTROL_DEFAULTS,
};

describe('resolveLivingLookRun (GAP 5)', () => {
  it('resolves an apply into a run with the compiled instance upserted', () => {
    const resolution = resolveLivingLookRun(
      fakeSession(emptyLookInstancesDocument('root')),
      applyRequest,
      CONTEXT,
    );
    expect(resolution.kind).toBe('run');
    if (resolution.kind !== 'run') return;
    expect(resolution.verb).toBe('Apply');
    expect(resolution.definition.id).toBe(editorialClean.id);
    expect(resolution.instanceId).toBe('look-00000000-1111-2222-3333-444444444444');
    expect(resolution.compileInput.definitionVersion).toBe(editorialClean.version);
    expect(resolution.compileInput.format).toBe('portrait');
    expect(resolution.lookInstancesWrite.instances[resolution.instanceId]).toBeDefined();
  });

  it('resolves update / reset against a stored instance', () => {
    const instanceId = 'look-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const record = buildLookInstanceRecord(instanceId, {
      definition: editorialClean,
      definitionVersion: editorialClean.version,
      compositionId: 'root',
      compositionDurationUs: 12_000_000,
      format: 'portrait',
      entityBindings: Object.fromEntries(SLOT_IDS.map((id) => [id, `vo-${id}`])),
      controlValues: CONTROL_DEFAULTS,
      overriddenBindingIds: ['b-1'],
      resolvedFonts: {},
    });
    const doc: LookInstancesDocument = {
      ...emptyLookInstancesDocument('root'),
      instances: { [instanceId]: record },
    };
    const updated = resolveLivingLookRun(
      fakeSession(doc),
      { kind: 'update', instanceId, nextControlValues: { energy: 0.9 } },
      CONTEXT,
    );
    expect(updated.kind).toBe('run');
    if (updated.kind !== 'run') return;
    expect(updated.verb).toBe('Adjust');
    expect(updated.compileInput.controlValues.energy).toBe(0.9);

    const reset = resolveLivingLookRun(
      fakeSession(doc),
      { kind: 'reset', instanceId, bindingIds: ['b-1'] },
      CONTEXT,
    );
    expect(reset.kind).toBe('run');
    if (reset.kind !== 'run') return;
    expect(reset.verb).toBe('Reset overrides on');
    expect(reset.compileInput.resetBindingIds).toEqual(['b-1']);
  });

  it('resolves a detach into a document with the instance removed', () => {
    const instanceId = 'look-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const record = buildLookInstanceRecord(instanceId, {
      definition: editorialClean,
      definitionVersion: editorialClean.version,
      compositionId: 'root',
      compositionDurationUs: 12_000_000,
      format: 'portrait',
      entityBindings: Object.fromEntries(SLOT_IDS.map((id) => [id, `vo-${id}`])),
      controlValues: CONTROL_DEFAULTS,
      overriddenBindingIds: [],
      resolvedFonts: {},
    });
    const doc: LookInstancesDocument = {
      ...emptyLookInstancesDocument('root'),
      instances: { [instanceId]: record },
    };
    const resolution = resolveLivingLookRun(
      fakeSession(doc),
      { kind: 'detach', instanceId },
      CONTEXT,
    );
    expect(resolution.kind).toBe('detach');
    if (resolution.kind !== 'detach') return;
    expect(resolution.lookInstancesWrite.instances[instanceId]).toBeUndefined();
    expect(resolution.definition?.id).toBe(editorialClean.id);
  });

  it('blocks an unknown instance and an unknown pack', () => {
    expect(
      resolveLivingLookRun(
        fakeSession(emptyLookInstancesDocument('root')),
        { kind: 'detach', instanceId: 'look-does-not-exist-0000-0000-000000000000' },
        CONTEXT,
      ),
    ).toEqual({ kind: 'blocked', reason: 'unknown-instance' });
    expect(
      resolveLivingLookRun(
        fakeSession(emptyLookInstancesDocument('root')),
        { ...applyRequest, definitionId: 'not-a-real-pack' },
        CONTEXT,
      ).kind,
    ).toBe('blocked');
  });
});
