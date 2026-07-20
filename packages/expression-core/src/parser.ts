/**
 * Recursive-descent parser. Grammar (lowest to highest precedence):
 *   expr := ternary
 *   ternary := logicalOr ('?' expr ':' expr)?
 *   logicalOr := logicalAnd ('||' logicalAnd)*
 *   logicalAnd := equality ('&&' equality)*
 *   equality := comparison (('=='|'!=') comparison)*
 *   comparison := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary := ('-'|'!')? unary | primary
 *   primary := number | true | false | string | identifier ['(' args ')'] | '(' expr ')'
 *
 * There is no loop or function-definition production — the grammar cannot
 * express unbounded iteration. `depth` tracks recursion into `parseExpr` (the
 * re-entry point for parens, ternary branches, and call args) and `parseUnary`
 * (its own recursion for chained `!`/`-`) as a stack-overflow mitigation
 * against adversarially deep input like `((((...))))`.
 */

import type { BinaryOperator, ExpressionNode } from './ast.js';
import { tokenize } from './lexer.js';
import type { Token, TokenKind } from './lexer.js';

export class ParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

export const MAX_PARSE_DEPTH = 64;

class Parser {
  #tokens: readonly Token[];
  #index = 0;
  #depth = 0;

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token {
    return this.#tokens[this.#index]!;
  }

  #advance(): Token {
    const token = this.#peek();
    if (token.kind !== 'eof') this.#index += 1;
    return token;
  }

  #expect(kind: TokenKind): Token {
    const token = this.#peek();
    if (token.kind !== kind)
      throw new ParseError(
        `expected "${kind}" but found "${token.text || 'end of input'}"`,
        token.position,
      );
    return this.#advance();
  }

  #enter(): void {
    this.#depth += 1;
    if (this.#depth > MAX_PARSE_DEPTH)
      throw new ParseError(
        `expression nesting exceeds the limit of ${MAX_PARSE_DEPTH}`,
        this.#peek().position,
      );
  }

  #exit(): void {
    this.#depth -= 1;
  }

  parseProgram(): ExpressionNode {
    const node = this.parseExpr();
    this.#expect('eof');
    return node;
  }

  parseExpr(): ExpressionNode {
    this.#enter();
    try {
      return this.#parseTernary();
    } finally {
      this.#exit();
    }
  }

  #parseTernary(): ExpressionNode {
    const condition = this.#parseLogicalOr();
    if (this.#peek().kind !== '?') return condition;
    this.#advance();
    const whenTrue = this.parseExpr();
    this.#expect(':');
    const whenFalse = this.parseExpr();
    return { kind: 'ternary', condition, whenTrue, whenFalse };
  }

  #parseLogicalOr(): ExpressionNode {
    let node = this.#parseLogicalAnd();
    while (this.#peek().kind === '||') {
      this.#advance();
      node = { kind: 'binary', op: '||', left: node, right: this.#parseLogicalAnd() };
    }
    return node;
  }

  #parseLogicalAnd(): ExpressionNode {
    let node = this.#parseEquality();
    while (this.#peek().kind === '&&') {
      this.#advance();
      node = { kind: 'binary', op: '&&', left: node, right: this.#parseEquality() };
    }
    return node;
  }

  #parseEquality(): ExpressionNode {
    let node = this.#parseComparison();
    while (this.#peek().kind === '==' || this.#peek().kind === '!=') {
      const op = this.#advance().kind as BinaryOperator;
      node = { kind: 'binary', op, left: node, right: this.#parseComparison() };
    }
    return node;
  }

  #parseComparison(): ExpressionNode {
    let node = this.#parseAdditive();
    while (['<', '<=', '>', '>='].includes(this.#peek().kind)) {
      const op = this.#advance().kind as BinaryOperator;
      node = { kind: 'binary', op, left: node, right: this.#parseAdditive() };
    }
    return node;
  }

  #parseAdditive(): ExpressionNode {
    let node = this.#parseMultiplicative();
    while (this.#peek().kind === '+' || this.#peek().kind === '-') {
      const op = this.#advance().kind as BinaryOperator;
      node = { kind: 'binary', op, left: node, right: this.#parseMultiplicative() };
    }
    return node;
  }

  #parseMultiplicative(): ExpressionNode {
    let node = this.#parseUnary();
    while (['*', '/', '%'].includes(this.#peek().kind)) {
      const op = this.#advance().kind as BinaryOperator;
      node = { kind: 'binary', op, left: node, right: this.#parseUnary() };
    }
    return node;
  }

  #parseUnary(): ExpressionNode {
    const token = this.#peek();
    if (token.kind === '-' || token.kind === '!') {
      this.#enter();
      try {
        this.#advance();
        return { kind: 'unary', op: token.kind, operand: this.#parseUnary() };
      } finally {
        this.#exit();
      }
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): ExpressionNode {
    const token = this.#peek();
    switch (token.kind) {
      case 'number':
        this.#advance();
        return { kind: 'number', value: token.value as number };
      case 'string':
        this.#advance();
        return { kind: 'string', value: token.value as string };
      case 'true':
        this.#advance();
        return { kind: 'boolean', value: true };
      case 'false':
        this.#advance();
        return { kind: 'boolean', value: false };
      case 'identifier': {
        this.#advance();
        if (this.#peek().kind !== '(') return { kind: 'identifier', name: token.text };
        this.#advance();
        const args: ExpressionNode[] = [];
        if (this.#peek().kind !== ')') {
          args.push(this.parseExpr());
          while (this.#peek().kind === ',') {
            this.#advance();
            args.push(this.parseExpr());
          }
        }
        this.#expect(')');
        return { kind: 'call', callee: token.text, args };
      }
      case '(': {
        this.#advance();
        const inner = this.parseExpr();
        this.#expect(')');
        return inner;
      }
      default:
        throw new ParseError(`unexpected token "${token.text || 'end of input'}"`, token.position);
    }
  }
}

/** Parses `source` into an AST. Throws `LexError`/`ParseError` on malformed or oversized input. */
export function parseExpression(source: string): ExpressionNode {
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}
