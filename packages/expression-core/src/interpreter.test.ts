import { describe, expect, it } from 'vitest';
import type { ExpressionNode } from './ast.js';
import { ExpressionEvalError, evaluateExpression, MAX_EVAL_STEPS } from './interpreter.js';
import { parseExpression } from './parser.js';

const noRefs = {
  variables: {},
  resolveReference: () => {
    throw new Error('no references expected in this test');
  },
};

describe('evaluateExpression', () => {
  it('evaluates arithmetic with standard precedence', () => {
    expect(evaluateExpression(parseExpression('1 + 2 * 3'), noRefs)).toBe(7);
    expect(evaluateExpression(parseExpression('(1 + 2) * 3'), noRefs)).toBe(9);
    expect(evaluateExpression(parseExpression('10 % 3'), noRefs)).toBe(1);
  });

  it('resolves identifiers from the context variables map only', () => {
    const context = {
      variables: { time: 2.5, PI: Math.PI },
      resolveReference: noRefs.resolveReference,
    };
    expect(evaluateExpression(parseExpression('time * 2'), context)).toBeCloseTo(5, 6);
    expect(evaluateExpression(parseExpression('sin(PI)'), context)).toBeCloseTo(0, 6);
  });

  it('evaluates comparisons, logical operators, and ternary, coercing booleans to 1/0', () => {
    expect(evaluateExpression(parseExpression('5 > 3'), noRefs)).toBe(1);
    expect(evaluateExpression(parseExpression('5 < 3'), noRefs)).toBe(0);
    expect(evaluateExpression(parseExpression('true && false'), noRefs)).toBe(0);
    expect(evaluateExpression(parseExpression('1 == 1 ? 100 : 200'), noRefs)).toBe(100);
  });

  it('evaluates unary negation and not', () => {
    expect(evaluateExpression(parseExpression('-5 + 2'), noRefs)).toBe(-3);
    expect(evaluateExpression(parseExpression('!false'), noRefs)).toBe(1);
  });

  it('calls allowlisted functions with evaluated numeric arguments', () => {
    expect(evaluateExpression(parseExpression('clamp(15, 0, 10)'), noRefs)).toBe(10);
    expect(evaluateExpression(parseExpression('lerp(0, 100, 0.5)'), noRefs)).toBe(50);
  });

  it('resolves ref() calls through the injected resolver, never evaluating its args as expressions', () => {
    const seen: Array<[string, string]> = [];
    const context = {
      variables: {},
      resolveReference: (objectId: string, property: string) => {
        seen.push([objectId, property]);
        return 42;
      },
    };
    expect(evaluateExpression(parseExpression('ref("cam-1", "positionZ") + 8'), context)).toBe(50);
    expect(seen).toEqual([['cam-1', 'positionZ']]);
  });

  it('rejects ref() with non-string-literal or wrong-arity arguments', () => {
    const context = { variables: { x: 1 }, resolveReference: () => 0 };
    expect(() => evaluateExpression(parseExpression('ref(x, "y")'), context)).toThrow(
      ExpressionEvalError,
    );
    expect(() => evaluateExpression(parseExpression('ref("x")'), context)).toThrow(
      ExpressionEvalError,
    );
  });

  it('rejects unknown identifiers and unknown functions with a clear error, never a silent NaN', () => {
    expect(() => evaluateExpression(parseExpression('mystery'), noRefs)).toThrow(
      /unknown identifier/,
    );
    expect(() => evaluateExpression(parseExpression('doTheThing(1)'), noRefs)).toThrow(
      /unknown function/,
    );
  });

  it('rejects a bare string literal outside of ref()', () => {
    expect(() => evaluateExpression(parseExpression('"hello"'), noRefs)).toThrow(
      /string literals may only appear as ref/,
    );
  });

  it('enforces an evaluation step limit even against a hand-built AST bypassing the parser depth limit', () => {
    // A flat (not deeply nested) call with more arguments than MAX_EVAL_STEPS,
    // so this exercises the step counter without risking a real JS stack
    // overflow from a deep recursive chain — width, not depth.
    const args: ExpressionNode[] = [];
    for (let i = 0; i < MAX_EVAL_STEPS + 10; i += 1) args.push({ kind: 'number', value: 1 });
    const node: ExpressionNode = { kind: 'call', callee: 'min', args };
    expect(() => evaluateExpression(node, noRefs)).toThrow(/evaluation step limit/);
  });
});
