import { describe, expect, it } from 'vitest';
import { resolveSceneInputs, validateSceneInputAccess } from './scene-inputs.js';
import type { SceneInputSchemaV1 } from './manifest.js';

const schema: SceneInputSchemaV1 = {
  amount: { kind: 'number', default: 10, animation: 'hold', constraints: { min: 0, max: 20 } },
  offset: { kind: 'vector2', default: [0, 1], animation: 'hold' },
  accent: { kind: 'color', default: '#e9b949', animation: 'hold' },
};

describe('scene inputs', () => {
  it('resolves bounded typed inputs and defaults invalid values', () => {
    const result = resolveSceneInputs(schema, { amount: 99, offset: [2, 3], ghost: true });
    expect(result.values).toEqual({ amount: 10, offset: [2, 3], accent: '#e9b949' });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'SCENE_INPUT_VALUE',
      'SCENE_INPUT_UNKNOWN',
    ]);
  });

  it('only allows declared context inputs and rejects DOM access', () => {
    const diagnostics = validateSceneInputAccess(
      'function(ctx){ return React.createElement("div", {style: {color: ctx.inputs.accent}, x: ctx.inputs.ghost, node: document.body}); }',
      schema,
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'SCENE_INPUT_UNKNOWN',
      'SCENE_INPUT_DOM_DENIED',
    ]);
  });
});
