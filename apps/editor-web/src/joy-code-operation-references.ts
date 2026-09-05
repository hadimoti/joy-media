import type {
  JoyCodePlanOperationV1,
  JoyCodeVisualObjectBindingRefV1,
} from '@joy-media/agent-tools';
import { joyCodeInsertedTextObjectId } from './text-template-transaction.js';

export interface ResolvedJoyCodeOperations {
  readonly ok: true;
  readonly operations: readonly JoyCodePlanOperationV1[];
  /** Resolver-owned bindings; model-supplied owner IDs are never trusted. */
  readonly trustedGeneratedBindings: readonly {
    readonly operationId: string;
    readonly ownerId: string;
  }[];
}

export interface UnresolvedJoyCodeReference {
  readonly ok: false;
  readonly error: {
    readonly code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF' | 'JOY_AGENT_OUTPUT_REF_NOT_DEPENDENCY';
    readonly message: string;
    readonly operationId?: string;
  };
}

export type JoyCodeOperationReferenceResult =
  ResolvedJoyCodeOperations | UnresolvedJoyCodeReference;

interface CreatedOutput {
  readonly operationId: string;
  readonly objectId: string;
  readonly kind: 'visual-object';
}

function dependencyOrder(operations: readonly JoyCodePlanOperationV1[]):
  | {
      readonly ordered: readonly JoyCodePlanOperationV1[];
      readonly closure: ReadonlyMap<string, ReadonlySet<string>>;
    }
  | UnresolvedJoyCodeReference {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: JoyCodePlanOperationV1[] = [];
  const closure = new Map<string, ReadonlySet<string>>();
  const visit = (id: string): Set<string> | undefined => {
    if (visited.has(id)) return new Set(closure.get(id));
    if (visiting.has(id)) return undefined;
    const operation = byId.get(id);
    if (operation === undefined) return undefined;
    visiting.add(id);
    const dependencies = new Set<string>();
    for (const dependency of operation.dependsOn) {
      const dependencyClosure = visit(dependency);
      if (dependencyClosure === undefined) return undefined;
      dependencies.add(dependency);
      for (const ancestor of dependencyClosure) dependencies.add(ancestor);
    }
    visiting.delete(id);
    visited.add(id);
    closure.set(id, dependencies);
    ordered.push(operation);
    return dependencies;
  };
  for (const operation of operations) {
    if (visit(operation.id) === undefined)
      return {
        ok: false,
        error: {
          code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF',
          message: 'operation dependencies are invalid',
        },
      };
  }
  return { ordered, closure };
}

function ownerRef(binding: unknown): JoyCodeVisualObjectBindingRefV1 | undefined {
  if (!binding || typeof binding !== 'object') return undefined;
  const value = binding as { ownerRef?: unknown };
  if (!value.ownerRef || typeof value.ownerRef !== 'object') return undefined;
  const ref = value.ownerRef as { kind?: unknown; ref?: unknown };
  return ref.kind === 'visual-object' && typeof ref.ref === 'string'
    ? (ref as JoyCodeVisualObjectBindingRefV1)
    : undefined;
}

/** Resolve typed created outputs after dependency ordering and before any compiler checks. */
export function resolveJoyCodeOperationReferences(
  planId: string,
  operations: readonly JoyCodePlanOperationV1[],
): JoyCodeOperationReferenceResult {
  const ordering = dependencyOrder(operations);
  if (!('ordered' in ordering)) return ordering;
  const operationIndex = new Map(operations.map((operation, index) => [operation.id, index]));
  const outputs = new Map<string, CreatedOutput>();
  const resolved = new Map<string, JoyCodePlanOperationV1>();
  const trustedGeneratedBindings: { operationId: string; ownerId: string }[] = [];
  for (const operation of ordering.ordered) {
    if (operation.kind === 'text.insertTemplate' && operation.outputRef !== undefined) {
      const ref = operation.outputRef.ref;
      if (outputs.has(ref))
        return {
          ok: false,
          error: {
            code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF',
            message: `created output reference "${ref}" is declared more than once`,
            operationId: operation.id,
          },
        };
      outputs.set(ref, {
        operationId: operation.id,
        objectId: joyCodeInsertedTextObjectId(
          operation.templateId,
          planId,
          operationIndex.get(operation.id) ?? 0,
        ),
        kind: 'visual-object',
      });
    }
    const ref = ownerRef('binding' in operation ? operation.binding : undefined);
    if (ref !== undefined) {
      const output = outputs.get(ref.ref);
      if (output === undefined || output.kind !== ref.kind)
        return {
          ok: false,
          error: {
            code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF',
            message: `created output reference "${ref.ref}" is not available`,
            operationId: operation.id,
          },
        };
      if (!ordering.closure.get(operation.id)?.has(output.operationId))
        return {
          ok: false,
          error: {
            code: 'JOY_AGENT_OUTPUT_REF_NOT_DEPENDENCY',
            message: `operation "${operation.id}" must depend on output producer "${output.operationId}"`,
            operationId: operation.id,
          },
        };
      if (operation.kind !== 'motion.setKeyframe' && operation.kind !== 'motion.removeKeyframe')
        return {
          ok: false,
          error: {
            code: 'JOY_AGENT_UNKNOWN_OUTPUT_REF',
            message: 'created output references are supported only by motion operations',
            operationId: operation.id,
          },
        };
      resolved.set(operation.id, {
        ...operation,
        binding: {
          ownerKind: operation.binding.ownerKind,
          ownerId: output.objectId,
          propertyId: operation.binding.propertyId,
          timeDomain: operation.binding.timeDomain,
        },
      } as JoyCodePlanOperationV1);
      trustedGeneratedBindings.push({ operationId: operation.id, ownerId: output.objectId });
    }
    if (!resolved.has(operation.id)) resolved.set(operation.id, operation);
  }
  return {
    ok: true,
    operations: operations.map((operation) => resolved.get(operation.id) ?? operation),
    trustedGeneratedBindings,
  };
}
