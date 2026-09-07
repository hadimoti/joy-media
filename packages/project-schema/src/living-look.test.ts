import { describe, expect, it } from 'vitest';
import {
  isLookBindingWritable,
  validateLookInstance,
  validateLookInstances,
  type LookInstance,
} from './living-look.js';

function baseInstance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-1',
    definitionId: 'editorial-clean',
    definitionVersion: 1,
    compositionId: 'root',
    entityBindings: { headline: 'title-1', deck: 'title-2' },
    controlValues: { energy: 0.5, contrast: 'high', showAccent: true },
    overriddenBindingIds: [],
    createdEntityIds: ['title-1', 'title-2'],
    ...overrides,
  };
}

describe('LookInstance validation', () => {
  it('accepts a well-formed instance', () => {
    expect(validateLookInstance(baseInstance())).toEqual([]);
  });

  it('rejects a non-object', () => {
    for (const value of [null, 42, 'look', [], undefined]) {
      const result = validateLookInstance(value);
      expect(result).toHaveLength(1);
      expect(result[0]!.code).toBe('PROJECT_SCHEMA_LOOK_INSTANCE_NOT_OBJECT');
    }
  });

  it('requires a positive integer definitionVersion — a pinned instance cannot float to "latest"', () => {
    for (const definitionVersion of [0, -1, 1.5, Number.NaN, '1' as unknown as number]) {
      const result = validateLookInstance(baseInstance({ definitionVersion }));
      expect(result.map((d) => d.code)).toContain(
        'PROJECT_SCHEMA_LOOK_INSTANCE_DEFINITION_VERSION',
      );
    }
    expect(validateLookInstance(baseInstance({ definitionVersion: 7 }))).toEqual([]);
  });

  it('rejects unsupported control value types', () => {
    for (const bad of [{ nested: true }, [1, 2], null, () => 1]) {
      const result = validateLookInstance(
        baseInstance({ controlValues: { energy: bad as never } }),
      );
      expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_CONTROL_TYPE');
    }
  });

  it('rejects a non-finite numeric control value', () => {
    const result = validateLookInstance(
      baseInstance({ controlValues: { energy: Number.POSITIVE_INFINITY } }),
    );
    expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_CONTROL_VALUE');
  });

  it('rejects external URLs, object-store refs and paths in binding targets', () => {
    for (const target of [
      'https://evil.example/pack',
      's3://bucket/key',
      'data:text/html,<script>',
      '../../etc/passwd',
      'C:\\Windows\\system32',
    ]) {
      const result = validateLookInstance(
        baseInstance({ entityBindings: { headline: target }, createdEntityIds: [] }),
      );
      expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_FORBIDDEN_VALUE');
    }
  });

  it('rejects executable payloads in string control values', () => {
    for (const value of [
      '<script>fetch(1)</script>',
      'javascript:alert(1)',
      '() => steal()',
      'function(){}',
      '${process.env.SECRET}',
    ]) {
      const result = validateLookInstance(baseInstance({ controlValues: { label: value } }));
      expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_FORBIDDEN_VALUE');
    }
  });

  it('rejects an override that does not name a known binding', () => {
    const result = validateLookInstance(
      baseInstance({ overriddenBindingIds: ['headline', 'not-a-binding'] }),
    );
    expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_OVERRIDE');
  });

  it('rejects a duplicated override or created entity id', () => {
    expect(
      validateLookInstance(baseInstance({ overriddenBindingIds: ['headline', 'headline'] })).map(
        (d) => d.code,
      ),
    ).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_OVERRIDE');
    expect(
      validateLookInstance(baseInstance({ createdEntityIds: ['title-1', 'title-1'] })).map(
        (d) => d.code,
      ),
    ).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_CREATED_ENTITY');
  });

  it('accepts an instance whose overrides all name real bindings', () => {
    expect(
      validateLookInstance(baseInstance({ overriddenBindingIds: ['headline'] })),
    ).toEqual([]);
  });
});

describe('validateLookInstances map', () => {
  it('treats an absent map as valid — never-applied is distinct from all-detached', () => {
    expect(validateLookInstances(undefined)).toEqual([]);
    expect(validateLookInstances({})).toEqual([]);
  });

  it('flags a key that disagrees with the instance id', () => {
    const result = validateLookInstances({ 'other-key': baseInstance({ id: 'look-1' }) });
    expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_KEY');
  });

  it('validates each instance in the map', () => {
    const result = validateLookInstances({
      'look-1': baseInstance(),
      'look-2': baseInstance({ id: 'look-2', definitionVersion: 0 }),
    });
    expect(result.map((d) => d.code)).toContain('PROJECT_SCHEMA_LOOK_INSTANCE_DEFINITION_VERSION');
  });
});

describe('isLookBindingWritable', () => {
  it('lets the compiler write a binding that has not been hand-edited', () => {
    expect(isLookBindingWritable('headline', baseInstance(), false)).toBe(true);
  });

  it('protects a hand-edited binding on reapplication', () => {
    const instance = baseInstance({ overriddenBindingIds: ['headline'] });
    expect(isLookBindingWritable('headline', instance, false)).toBe(false);
    expect(isLookBindingWritable('deck', instance, false)).toBe(true);
  });

  it('an explicit reset re-opens exactly the named binding', () => {
    const instance = baseInstance({ overriddenBindingIds: ['headline', 'deck'] });
    // reset is passed true only for the binding the operator named
    expect(isLookBindingWritable('headline', instance, true)).toBe(true);
    expect(isLookBindingWritable('deck', instance, false)).toBe(false);
  });
});
