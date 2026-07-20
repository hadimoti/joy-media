import { describe, expect, it } from 'vitest';
import { compileExpression, MAX_EXPRESSION_NODES } from './compile.js';

describe('compileExpression', () => {
  it('compiles a valid expression and reports no diagnostics', () => {
    const result = compileExpression('clamp(sin(time) * amp, -1, 1)');
    expect(result.diagnostics).toEqual([]);
    expect(result.compiled?.source).toBe('clamp(sin(time) * amp, -1, 1)');
    expect(result.compiled?.references).toEqual([]);
  });

  it('statically extracts ref() calls as dependency references, without evaluating anything', () => {
    const result = compileExpression('ref("cam-1", "positionZ") + ref("rig", "rotationDeg") * 2');
    expect(result.diagnostics).toEqual([]);
    expect(result.compiled?.references).toEqual([
      { objectId: 'cam-1', property: 'positionZ' },
      { objectId: 'rig', property: 'rotationDeg' },
    ]);
  });

  it('reports a coded diagnostic for malformed source instead of throwing', () => {
    const result = compileExpression('1 +');
    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('EXPRESSION_PARSE_ERROR');
  });

  it('reports EXPRESSION_TOO_LARGE for an oversized expression instead of compiling it', () => {
    const chain = Array.from({ length: 101 }, () => '1').join(' + ');
    const result = compileExpression(chain);
    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('EXPRESSION_TOO_LARGE');
  });

  it('reports EXPRESSION_UNKNOWN_FUNCTION for a call outside the allowlist', () => {
    const result = compileExpression('fetch(1)');
    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('EXPRESSION_UNKNOWN_FUNCTION');
  });

  it('reports EXPRESSION_REF_ARGS for a ref() call with non-literal or wrong-arity arguments', () => {
    const dynamic = compileExpression('ref(objectId, "x")');
    expect(dynamic.diagnostics[0]!.code).toBe('EXPRESSION_REF_ARGS');
    const wrongArity = compileExpression('ref("only-one")');
    expect(wrongArity.diagnostics[0]!.code).toBe('EXPRESSION_REF_ARGS');
  });

  it(`MAX_EXPRESSION_NODES is a small, sane constant`, () => {
    expect(MAX_EXPRESSION_NODES).toBeGreaterThan(0);
    expect(MAX_EXPRESSION_NODES).toBeLessThan(10_000);
  });
});
