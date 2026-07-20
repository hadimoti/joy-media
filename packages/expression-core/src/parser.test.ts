import { describe, expect, it } from 'vitest';
import { countNodes } from './ast.js';
import { ParseError, parseExpression } from './parser.js';

describe('parseExpression', () => {
  it('parses arithmetic with the usual precedence', () => {
    expect(parseExpression('1 + 2 * 3')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    });
  });

  it('parses parens overriding precedence', () => {
    expect(parseExpression('(1 + 2) * 3')).toEqual({
      kind: 'binary',
      op: '*',
      left: {
        kind: 'binary',
        op: '+',
        left: { kind: 'number', value: 1 },
        right: { kind: 'number', value: 2 },
      },
      right: { kind: 'number', value: 3 },
    });
  });

  it('parses comparisons, logical operators, and ternary', () => {
    const ast = parseExpression('x > 5 && y < 10 ? 1 : 0');
    expect(ast.kind).toBe('ternary');
  });

  it('parses unary negation and not, including chained unary', () => {
    expect(parseExpression('- - 1')).toEqual({
      kind: 'unary',
      op: '-',
      operand: { kind: 'unary', op: '-', operand: { kind: 'number', value: 1 } },
    });
    expect(parseExpression('!true').kind).toBe('unary');
  });

  it('parses function calls with multiple arguments, including nested calls', () => {
    const ast = parseExpression('clamp(sin(time), 0, 1)');
    expect(ast).toEqual({
      kind: 'call',
      callee: 'clamp',
      args: [
        { kind: 'call', callee: 'sin', args: [{ kind: 'identifier', name: 'time' }] },
        { kind: 'number', value: 0 },
        { kind: 'number', value: 1 },
      ],
    });
  });

  it('parses a zero-argument call and string-literal arguments', () => {
    expect(parseExpression('now()')).toEqual({ kind: 'call', callee: 'now', args: [] });
    expect(parseExpression('ref("cam-1", "positionZ")')).toEqual({
      kind: 'call',
      callee: 'ref',
      args: [
        { kind: 'string', value: 'cam-1' },
        { kind: 'string', value: 'positionZ' },
      ],
    });
  });

  it('rejects malformed input with a positioned ParseError', () => {
    expect(() => parseExpression('1 +')).toThrow(ParseError);
    expect(() => parseExpression('(1 + 2')).toThrow(ParseError);
    expect(() => parseExpression('1 2')).toThrow(ParseError);
  });

  it('rejects expressions nested past the depth limit instead of overflowing the stack', () => {
    const deeplyNested = '('.repeat(200) + '1' + ')'.repeat(200);
    expect(() => parseExpression(deeplyNested)).toThrow(ParseError);
    const chainedUnary = '!'.repeat(200) + 'true';
    expect(() => parseExpression(chainedUnary)).toThrow(ParseError);
  });

  it('countNodes reflects the tree shape', () => {
    expect(countNodes(parseExpression('1'))).toBe(1);
    expect(countNodes(parseExpression('1 + 2'))).toBe(3);
    expect(countNodes(parseExpression('a ? b : c'))).toBe(4);
    expect(countNodes(parseExpression('f(1, 2, 3)'))).toBe(4);
  });
});
