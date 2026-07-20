import { describe, expect, it } from 'vitest';
import { LexError, tokenize } from './lexer.js';

describe('tokenize', () => {
  it('tokenizes numbers, identifiers, strings, and operators', () => {
    const tokens = tokenize('time * 2 + sin(x, "a") - 1.5');
    expect(tokens.map((t) => t.kind)).toEqual([
      'identifier',
      '*',
      'number',
      '+',
      'identifier',
      '(',
      'identifier',
      ',',
      'string',
      ')',
      '-',
      'number',
      'eof',
    ]);
  });

  it('tokenizes true/false as their own kinds, not identifiers', () => {
    expect(tokenize('true && false').map((t) => t.kind)).toEqual(['true', '&&', 'false', 'eof']);
  });

  it('tokenizes two-character operators without conflating them with one-character ones', () => {
    expect(tokenize('a == b != c <= d >= e && f || g').map((t) => t.kind)).toEqual([
      'identifier',
      '==',
      'identifier',
      '!=',
      'identifier',
      '<=',
      'identifier',
      '>=',
      'identifier',
      '&&',
      'identifier',
      '||',
      'identifier',
      'eof',
    ]);
  });

  it('skips whitespace', () => {
    expect(tokenize('  1   +\t2\n').map((t) => t.kind)).toEqual(['number', '+', 'number', 'eof']);
  });

  it('throws LexError with a position on an unterminated string', () => {
    expect(() => tokenize('"unterminated')).toThrow(LexError);
  });

  it('throws LexError on an unexpected character', () => {
    try {
      tokenize('1 @ 2');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LexError);
      expect((error as LexError).position).toBe(2);
    }
  });
});
