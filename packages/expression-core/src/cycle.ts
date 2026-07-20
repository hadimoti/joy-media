/**
 * Pure dependency-cycle detection over a static reference graph. Schema-agnostic
 * on purpose — this only knows "node id -> the node ids/properties it
 * references," not what a `VisualObjectV1` is (that wiring is WP-10.4's job).
 * Because `ref()` arguments must be string literals (`compile.ts`), the whole
 * graph is knowable before any expression is ever evaluated, so a cycle can be
 * rejected instead of discovered as an infinite evaluation loop at runtime.
 */

import type { ExpressionReference } from './compile.js';

/** Depth-first cycle search; returns the cycle path (repeating its start at the end) if found. */
export function detectExpressionCycle(
  referencesByNode: Readonly<Record<string, readonly ExpressionReference[]>>,
): readonly string[] | undefined {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const path: string[] = [];

  function visit(nodeId: string): readonly string[] | undefined {
    if (onStack.has(nodeId)) {
      const start = path.indexOf(nodeId);
      return [...path.slice(start), nodeId];
    }
    if (visited.has(nodeId)) return undefined;
    visited.add(nodeId);
    onStack.add(nodeId);
    path.push(nodeId);
    for (const reference of referencesByNode[nodeId] ?? []) {
      const found = visit(reference.objectId);
      if (found !== undefined) return found;
    }
    path.pop();
    onStack.delete(nodeId);
    return undefined;
  }

  for (const nodeId of Object.keys(referencesByNode)) {
    const found = visit(nodeId);
    if (found !== undefined) return found;
  }
  return undefined;
}
