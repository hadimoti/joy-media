/**
 * @joy-media/expression-core — restricted, sandboxed expression language (WP-10.3, §20.3).
 *
 * No `eval`/`Function`/`with`. No loop or user-defined-function grammar. The
 * interpreter only ever reads from an explicitly injected context. See the
 * package README for the full safety argument.
 */

export const PACKAGE_NAME = '@joy-media/expression-core' as const;

export type { BinaryOperator, ExpressionNode, UnaryOperator } from './ast.js';
export { countNodes } from './ast.js';

export type { Token, TokenKind } from './lexer.js';
export { LexError, tokenize } from './lexer.js';

export { MAX_PARSE_DEPTH, ParseError, parseExpression } from './parser.js';

export type { ExpressionDiagnostic } from './diagnostics.js';
export { expressionDiagnostic } from './diagnostics.js';

export type { ExpressionFunction } from './functions.js';
export { ALLOWED_FUNCTIONS, seededUnitRandom } from './functions.js';

export type { ExpressionEvalContext } from './interpreter.js';
export { evaluateExpression, ExpressionEvalError, MAX_EVAL_STEPS } from './interpreter.js';

export type {
  CompiledExpression,
  CompileExpressionResult,
  ExpressionReference,
} from './compile.js';
export { compileExpression, MAX_EXPRESSION_NODES } from './compile.js';

export { detectExpressionCycle } from './cycle.js';
