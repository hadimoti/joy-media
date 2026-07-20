/**
 * §20.3 expression policy compliance: proves the interpreter cannot reach
 * DOM/network/filesystem/process/wall-clock, never uses `eval`/`Function`,
 * and fails fast (never hangs or crashes) on runaway or cyclic input.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileExpression } from './compile.js';
import { detectExpressionCycle } from './cycle.js';
import { evaluateExpression } from './interpreter.js';
import { parseExpression } from './parser.js';

const SOURCE_FILES = [
  'ast.ts',
  'lexer.ts',
  'parser.ts',
  'functions.ts',
  'interpreter.ts',
  'compile.ts',
  'cycle.ts',
  'diagnostics.ts',
  'index.ts',
] as const;

function readSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

const noRefs = {
  variables: { time: 1 },
  resolveReference: () => {
    throw new Error('no references expected');
  },
};

describe('§20.3 forbidden-capability compliance', () => {
  it('never contains eval(), new Function, or `with` anywhere in the package source', () => {
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      expect(source, `${file} must not call eval()`).not.toMatch(/\beval\s*\(/);
      expect(source, `${file} must not construct a Function`).not.toMatch(/new\s+Function\s*\(/);
      expect(source, `${file} must not use the "with" statement`).not.toMatch(/\bwith\s*\(/);
    }
  });

  it('resolves identifiers only through the injected context, never through globalThis', () => {
    // `document`/`window`/`process` are real globals in this Node test runner,
    // but the interpreter must never fall through to them — only `variables`.
    for (const name of ['document', 'window', 'process', 'globalThis', 'require', 'module']) {
      expect(() => evaluateExpression(parseExpression(name), noRefs)).toThrow(/unknown identifier/);
    }
  });

  it('has no path to network, filesystem, or wall-clock APIs as callable functions', () => {
    for (const name of [
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'require',
      'readFileSync',
      'Date',
    ]) {
      const result = compileExpression(`${name}()`);
      expect(result.compiled, `${name}() must not compile`).toBeUndefined();
      expect(result.diagnostics[0]!.code).toBe('EXPRESSION_UNKNOWN_FUNCTION');
    }
  });

  it('has no wall-clock identifier bound by default (only what the caller explicitly injects)', () => {
    expect(() => evaluateExpression(parseExpression('now'), noRefs)).toThrow(/unknown identifier/);
  });

  it('random() is seed-derived, never Math.random()-backed (no hidden nondeterminism)', () => {
    const context = { variables: {}, resolveReference: noRefs.resolveReference };
    const a = evaluateExpression(parseExpression('random(7)'), context);
    const b = evaluateExpression(parseExpression('random(7)'), context);
    expect(a).toBe(b); // a real Math.random() call could never guarantee this
  });

  it('rejects a runaway (oversized) expression as a diagnostic, synchronously, never hanging', () => {
    const huge = Array.from({ length: 500 }, () => '1').join(' + ');
    const result = compileExpression(huge);
    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('EXPRESSION_TOO_LARGE');
  });

  it('rejects adversarially deep nesting as a diagnostic instead of overflowing the stack', () => {
    const deep = '('.repeat(5_000) + '1' + ')'.repeat(5_000);
    const result = compileExpression(deep);
    expect(result.compiled).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('EXPRESSION_PARSE_ERROR');
  });

  it('end-to-end: a self-referential expression is caught by cycle detection before evaluation', () => {
    const compiled = compileExpression('ref("self", "x") + 1');
    expect(compiled.compiled).toBeDefined();
    const cycle = detectExpressionCycle({ self: compiled.compiled!.references });
    expect(cycle).toEqual(['self', 'self']);
  });

  it('end-to-end: a three-node reference cycle across compiled expressions is caught', () => {
    const a = compileExpression('ref("b", "x") + 1');
    const b = compileExpression('ref("c", "x") + 1');
    const c = compileExpression('ref("a", "x") + 1');
    const cycle = detectExpressionCycle({
      a: a.compiled!.references,
      b: b.compiled!.references,
      c: c.compiled!.references,
    });
    expect(cycle).toBeDefined();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });
});
