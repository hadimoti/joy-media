import { describe, expect, it } from 'vitest';
import type { LookInstance } from './living-look.js';
import {
  LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION,
  emptyLookInstancesDocument,
  validateLookInstancesDocument,
  type LookInstancesDocument,
} from './look-instances-document.js';

function instance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-1',
    definitionId: 'editorial-clean',
    definitionVersion: 1,
    compositionId: 'root',
    entityBindings: { headline: 'title-1' },
    controlValues: { energy: 0.5 },
    overriddenBindingIds: [],
    createdEntityIds: ['title-1'],
    ...overrides,
  };
}

function doc(overrides: Partial<LookInstancesDocument> = {}): LookInstancesDocument {
  return { id: 'project-1', schemaVersion: 1, instances: { 'look-1': instance() }, ...overrides };
}

describe('LookInstancesDocument', () => {
  it('emptyLookInstancesDocument is a valid empty document', () => {
    const empty = emptyLookInstancesDocument('project-1');
    expect(empty).toEqual({ id: 'project-1', schemaVersion: 1, instances: {} });
    expect(validateLookInstancesDocument(empty)).toEqual([]);
  });

  it('accepts a populated document', () => {
    expect(validateLookInstancesDocument(doc())).toEqual([]);
  });

  it('rejects a non-object', () => {
    for (const value of [null, 7, 'x', [], undefined]) {
      const result = validateLookInstancesDocument(value);
      expect(result).toHaveLength(1);
      expect(result[0]!.code).toBe('LOOK_INSTANCES_DOC_NOT_OBJECT');
    }
  });

  it('rejects an unsupported schemaVersion instead of downgrading it', () => {
    for (const bad of [0, 2, 99, '1', undefined]) {
      const result = validateLookInstancesDocument({ ...doc(), schemaVersion: bad });
      expect(result.some((d) => d.code === 'LOOK_INSTANCES_DOC_VERSION')).toBe(true);
    }
    // The current constant is 1 — a guard so a future bump updates the tests.
    expect(LOOK_INSTANCES_DOCUMENT_SCHEMA_VERSION).toBe(1);
  });

  it('rejects a missing or empty id', () => {
    for (const bad of ['', 3, undefined]) {
      const result = validateLookInstancesDocument({ ...doc(), id: bad });
      expect(result.some((d) => d.code === 'LOOK_INSTANCES_DOC_ID')).toBe(true);
    }
  });

  it('rejects a non-object instances map', () => {
    for (const bad of [null, [], 'nope', 5]) {
      const result = validateLookInstancesDocument({ ...doc(), instances: bad });
      expect(result.some((d) => d.code === 'LOOK_INSTANCES_DOC_INSTANCES')).toBe(true);
    }
  });

  it('surfaces a malformed instance and a key/id mismatch', () => {
    const malformed = validateLookInstancesDocument({
      ...doc(),
      instances: { 'look-1': { ...instance(), definitionVersion: -1 } },
    });
    expect(
      malformed.some((d) => d.code === 'PROJECT_SCHEMA_LOOK_INSTANCE_DEFINITION_VERSION'),
    ).toBe(true);

    const mismatch = validateLookInstancesDocument({
      ...doc(),
      instances: { 'other-key': instance({ id: 'look-1' }) },
    });
    expect(mismatch.some((d) => d.code === 'PROJECT_SCHEMA_LOOK_INSTANCE_KEY')).toBe(true);
  });

  it('does NOT fail on a dangling entity reference (resolved at use, not at load)', () => {
    const dangling = validateLookInstancesDocument(
      doc({
        instances: {
          'look-1': instance({
            entityBindings: { headline: 'deleted-object-id' },
            createdEntityIds: ['also-deleted'],
          }),
        },
      }),
    );
    expect(dangling).toEqual([]);
  });
});
