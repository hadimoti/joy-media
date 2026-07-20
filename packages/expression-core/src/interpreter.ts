/**
 * Tree-walking evaluator. The only inputs it ever reads are the AST and the
 * caller-supplied `ExpressionEvalContext` — never `globalThis`, `window`,
 * `process`, `Date`, or any ambient global; there is no `eval`/`Function`
 * anywhere in this file. `MAX_EVAL_STEPS` is redundant with the parser's node
 * count/depth limits for anything produced by `parseExpression`, but the
 * interpreter enforces its own bound so it is safe even against a
 * hand-constructed AST that skipped `compileExpression`.
 */

import type { BinaryOperator, ExpressionNode } from './ast.js';
import { ALLOWED_FUNCTIONS } from './functions.js';

export interface ExpressionEvalContext {
  /** Bound scalars such as `time` or `PI`; identifiers resolve only here. */
  readonly variables: Readonly<Record<string, number>>;
  /** Backs explicit `ref("objectId", "property")` calls (§20.3 dependency references). */
  readonly resolveReference: (objectId: string, property: string) => number;
}

export class ExpressionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionEvalError';
  }
}

export const MAX_EVAL_STEPS = 10_000;

type Value = number | boolean;

function toNumber(value: Value): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function toBoolean(value: Value): boolean {
  return typeof value === 'boolean' ? value : value !== 0;
}

function evalBinary(op: BinaryOperator, left: Value, right: Value): Value {
  switch (op) {
    case '+':
      return toNumber(left) + toNumber(right);
    case '-':
      return toNumber(left) - toNumber(right);
    case '*':
      return toNumber(left) * toNumber(right);
    case '/':
      return toNumber(left) / toNumber(right);
    case '%':
      return toNumber(left) % toNumber(right);
    case '==':
      return toNumber(left) === toNumber(right);
    case '!=':
      return toNumber(left) !== toNumber(right);
    case '<':
      return toNumber(left) < toNumber(right);
    case '<=':
      return toNumber(left) <= toNumber(right);
    case '>':
      return toNumber(left) > toNumber(right);
    case '>=':
      return toNumber(left) >= toNumber(right);
    case '&&':
      return toBoolean(left) && toBoolean(right);
    case '||':
      return toBoolean(left) || toBoolean(right);
  }
}

/** Evaluates `node` against `context`, coercing the final result to a number. */
export function evaluateExpression(node: ExpressionNode, context: ExpressionEvalContext): number {
  let steps = 0;
  const step = (): void => {
    steps += 1;
    if (steps > MAX_EVAL_STEPS)
      throw new ExpressionEvalError(
        `expression exceeded the evaluation step limit of ${MAX_EVAL_STEPS}`,
      );
  };

  const evalNode = (current: ExpressionNode): Value => {
    step();
    switch (current.kind) {
      case 'number':
        return current.value;
      case 'boolean':
        return current.value;
      case 'string':
        throw new ExpressionEvalError('string literals may only appear as ref() arguments');
      case 'identifier': {
        const value = context.variables[current.name];
        if (value === undefined)
          throw new ExpressionEvalError(`unknown identifier "${current.name}"`);
        return value;
      }
      case 'unary': {
        const operand = evalNode(current.operand);
        return current.op === '-' ? -toNumber(operand) : !toBoolean(operand);
      }
      case 'binary':
        return evalBinary(current.op, evalNode(current.left), evalNode(current.right));
      case 'ternary':
        return toBoolean(evalNode(current.condition))
          ? evalNode(current.whenTrue)
          : evalNode(current.whenFalse);
      case 'call':
        return evalCall(current);
    }
  };

  const evalCall = (current: Extract<ExpressionNode, { kind: 'call' }>): number => {
    if (current.callee === 'ref') {
      const [objectIdNode, propertyNode] = current.args;
      if (
        current.args.length !== 2 ||
        objectIdNode?.kind !== 'string' ||
        propertyNode?.kind !== 'string'
      )
        throw new ExpressionEvalError('ref() requires exactly two string-literal arguments');
      return context.resolveReference(objectIdNode.value, propertyNode.value);
    }
    const fn = ALLOWED_FUNCTIONS[current.callee];
    if (fn === undefined) throw new ExpressionEvalError(`unknown function "${current.callee}"`);
    const args = current.args.map((arg) => toNumber(evalNode(arg)));
    return fn(args);
  };

  return toNumber(evalNode(node));
}
