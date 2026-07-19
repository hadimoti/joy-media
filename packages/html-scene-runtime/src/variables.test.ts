import { describe, expect, it } from 'vitest';
import { resolveSceneVariables, validateVariableSchema } from './variables.js';
import type { SceneVariableSchema } from './variables.js';

const schema: SceneVariableSchema = {
  title: { type: 'string', default: 'Untitled' },
  accent: { type: 'color', default: '#e9b949' },
  fontSize: { type: 'number', default: 48, min: 8, max: 200 },
  uppercase: { type: 'boolean', default: false },
  align: { type: 'enum', default: 'center', options: ['start', 'center', 'end'] },
};

describe('validateVariableSchema', () => {
  it('accepts a well-formed schema', () => {
    expect(validateVariableSchema(schema)).toEqual([]);
  });

  it('reports a default that violates its own type and a bad enum', () => {
    const codes = validateVariableSchema({
      bad: { type: 'color', default: 'not-a-color' },
      empty: { type: 'enum', default: 'x', options: [] },
    }).map((diagnostic) => diagnostic.code);
    expect(codes).toContain('SCENE_VARIABLES_SCHEMA');
  });
});

describe('resolveSceneVariables', () => {
  it('fills defaults for omitted variables', () => {
    const { values, diagnostics } = resolveSceneVariables(schema, {});
    expect(diagnostics).toEqual([]);
    expect(values).toEqual({
      title: 'Untitled',
      accent: '#e9b949',
      fontSize: 48,
      uppercase: false,
      align: 'center',
    });
  });

  it('accepts valid overrides', () => {
    const { values, diagnostics } = resolveSceneVariables(schema, {
      title: 'Sale',
      fontSize: 72,
      align: 'start',
    });
    expect(diagnostics).toEqual([]);
    expect(values.title).toBe('Sale');
    expect(values.fontSize).toBe(72);
    expect(values.align).toBe('start');
  });

  it('falls back to the default and reports a bad override', () => {
    const { values, diagnostics } = resolveSceneVariables(schema, {
      fontSize: 5, // below min
      accent: 'blue', // not hex
      align: 'middle', // not an option
    });
    expect(values.fontSize).toBe(48);
    expect(values.accent).toBe('#e9b949');
    expect(values.align).toBe('center');
    expect(diagnostics.map((d) => d.code)).toEqual([
      'SCENE_VARIABLES_VALUE',
      'SCENE_VARIABLES_VALUE',
      'SCENE_VARIABLES_VALUE',
    ]);
  });

  it('flags unknown provided variables', () => {
    const { diagnostics } = resolveSceneVariables(schema, { ghost: 1 });
    expect(diagnostics.some((d) => d.code === 'SCENE_VARIABLES_UNKNOWN')).toBe(true);
  });
});
