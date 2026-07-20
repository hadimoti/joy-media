/**
 * Compiles source text into a checked, ready-to-evaluate expression. Never
 * throws for untrusted input — parse/limit/reference violations come back as
 * coded diagnostics (matching the project's diagnostic-not-exception
 * convention, e.g. `html-scene-runtime`'s `SceneDiagnostic`).
 */

import { countNodes, type ExpressionNode } from './ast.js';
import type { ExpressionDiagnostic } from './diagnostics.js';
import { expressionDiagnostic } from './diagnostics.js';
import { ALLOWED_FUNCTIONS } from './functions.js';
import { LexError } from './lexer.js';
import { ParseError, parseExpression } from './parser.js';

/** An explicit, statically-known cross-channel/cross-object dependency (§20.3). */
export interface ExpressionReference {
  readonly objectId: string;
  readonly property: string;
}

export interface CompiledExpression {
  readonly source: string;
  readonly ast: ExpressionNode;
  readonly nodeCount: number;
  /** Every `ref("objectId", "property")` call in the expression, statically extracted. */
  readonly references: readonly ExpressionReference[];
}

export interface CompileExpressionResult {
  readonly compiled?: CompiledExpression;
  readonly diagnostics: readonly ExpressionDiagnostic[];
}

/** Matches the parser's own depth guard (`MAX_PARSE_DEPTH`) as a total-size sanity check. */
export const MAX_EXPRESSION_NODES = 200;

export function compileExpression(source: string): CompileExpressionResult {
  let ast: ExpressionNode;
  try {
    ast = parseExpression(source);
  } catch (error) {
    if (error instanceof LexError || error instanceof ParseError) {
      return {
        diagnostics: [
          expressionDiagnostic(
            'EXPRESSION_PARSE_ERROR',
            `${error.message} (at character ${error.position})`,
          ),
        ],
      };
    }
    throw error;
  }

  const nodeCount = countNodes(ast);
  if (nodeCount > MAX_EXPRESSION_NODES) {
    return {
      diagnostics: [
        expressionDiagnostic(
          'EXPRESSION_TOO_LARGE',
          `expression has ${nodeCount} nodes, exceeding the limit of ${MAX_EXPRESSION_NODES}`,
        ),
      ],
    };
  }

  const diagnostics: ExpressionDiagnostic[] = [];
  const references: ExpressionReference[] = [];
  walk(ast, diagnostics, references);
  if (diagnostics.length > 0) return { diagnostics };

  return { compiled: { source, ast, nodeCount, references }, diagnostics: [] };
}

function walk(
  node: ExpressionNode,
  diagnostics: ExpressionDiagnostic[],
  references: ExpressionReference[],
): void {
  switch (node.kind) {
    case 'number':
    case 'boolean':
    case 'string':
    case 'identifier':
      return;
    case 'unary':
      walk(node.operand, diagnostics, references);
      return;
    case 'binary':
      walk(node.left, diagnostics, references);
      walk(node.right, diagnostics, references);
      return;
    case 'ternary':
      walk(node.condition, diagnostics, references);
      walk(node.whenTrue, diagnostics, references);
      walk(node.whenFalse, diagnostics, references);
      return;
    case 'call':
      walkCall(node, diagnostics, references);
      return;
  }
}

function walkCall(
  node: Extract<ExpressionNode, { kind: 'call' }>,
  diagnostics: ExpressionDiagnostic[],
  references: ExpressionReference[],
): void {
  if (node.callee === 'ref') {
    const [objectIdNode, propertyNode] = node.args;
    if (
      node.args.length !== 2 ||
      objectIdNode?.kind !== 'string' ||
      propertyNode?.kind !== 'string'
    ) {
      diagnostics.push(
        expressionDiagnostic(
          'EXPRESSION_REF_ARGS',
          'ref() requires exactly two string-literal arguments so its dependency is statically known',
        ),
      );
      return;
    }
    references.push({ objectId: objectIdNode.value, property: propertyNode.value });
    return;
  }
  if (ALLOWED_FUNCTIONS[node.callee] === undefined) {
    diagnostics.push(
      expressionDiagnostic(
        'EXPRESSION_UNKNOWN_FUNCTION',
        `"${node.callee}" is not an allowed function`,
      ),
    );
    return;
  }
  for (const arg of node.args) walk(arg, diagnostics, references);
}
