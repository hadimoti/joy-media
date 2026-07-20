/** AST for the restricted expression grammar (§20.3). No loop/function-definition node exists. */

export type BinaryOperator =
  '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export type UnaryOperator = '-' | '!';

export type ExpressionNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'unary'; readonly op: UnaryOperator; readonly operand: ExpressionNode }
  | {
      readonly kind: 'binary';
      readonly op: BinaryOperator;
      readonly left: ExpressionNode;
      readonly right: ExpressionNode;
    }
  | {
      readonly kind: 'ternary';
      readonly condition: ExpressionNode;
      readonly whenTrue: ExpressionNode;
      readonly whenFalse: ExpressionNode;
    }
  | { readonly kind: 'call'; readonly callee: string; readonly args: readonly ExpressionNode[] };

/** Total node count in the tree (used for the size limit). */
export function countNodes(node: ExpressionNode): number {
  switch (node.kind) {
    case 'number':
    case 'boolean':
    case 'string':
    case 'identifier':
      return 1;
    case 'unary':
      return 1 + countNodes(node.operand);
    case 'binary':
      return 1 + countNodes(node.left) + countNodes(node.right);
    case 'ternary':
      return (
        1 + countNodes(node.condition) + countNodes(node.whenTrue) + countNodes(node.whenFalse)
      );
    case 'call':
      return 1 + node.args.reduce((sum, arg) => sum + countNodes(arg), 0);
  }
}
