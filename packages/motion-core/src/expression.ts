/**
 * Wires `@joy-media/expression-core` onto visual objects (§20.3, ADR-0015,
 * WP-10.4/WP-10.5). A channel's expression, when present, overrides its
 * keyframe curve/static value — but only when it compiles and evaluates
 * cleanly; any failure falls back to the curve/static value and reports a
 * diagnostic instead of ever breaking the render. Compilation is memoized by
 * source text ("cache pure results", §20.3) since the same expression is
 * evaluated once per frame.
 *
 * `resolveWorldTransformWithExpressions` (WP-10.5) composes the parent chain
 * using this expression-aware local resolution, so `camera-core` can project
 * an expression-driven rig/camera/layer chain — see its own
 * `resolveObjectTransformThroughCameraWithExpressions`.
 */

import type {
  AnimatablePropertyV1,
  TimeUs,
  VisualObjectTransformV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';
import type {
  CompiledExpression,
  ExpressionDiagnostic,
  ExpressionReference,
} from '@joy-media/expression-core';
import {
  compileExpression,
  evaluateExpression,
  ExpressionEvalError,
} from '@joy-media/expression-core';
import { resolveAnimatedTransform } from './transform.js';
import { resolveWorldTransform } from './parenting.js';

interface CompileCacheEntry {
  readonly compiled?: CompiledExpression;
  readonly diagnostics: readonly ExpressionDiagnostic[];
}

/** Pure function of source text — safe to memoize process-wide (§20.3 "cache pure results"). */
const compileCache = new Map<string, CompileCacheEntry>();

function compileCached(source: string): CompileCacheEntry {
  const cached = compileCache.get(source);
  if (cached !== undefined) return cached;
  const result = compileExpression(source);
  const entry: CompileCacheEntry = {
    ...(result.compiled === undefined ? {} : { compiled: result.compiled }),
    diagnostics: result.diagnostics,
  };
  compileCache.set(source, entry);
  return entry;
}

export interface ExpressionChannelDiagnostic {
  readonly objectId: string;
  readonly property: AnimatablePropertyV1;
  readonly message: string;
}

export interface ObjectExpressionResolution {
  readonly transform: VisualObjectTransformV1;
  readonly diagnostics: readonly ExpressionChannelDiagnostic[];
}

const MIN_SCALE = 0.001;

function clampTransform(transform: VisualObjectTransformV1): VisualObjectTransformV1 {
  return {
    ...transform,
    scaleX: Math.max(MIN_SCALE, transform.scaleX),
    scaleY: Math.max(MIN_SCALE, transform.scaleY),
    opacity: Math.min(1, Math.max(0, transform.opacity)),
  };
}

/**
 * An object's transform at `timeUs`, honoring per-channel expressions ahead of
 * curves/static values. `resolving` guards runtime recursion for `ref()`
 * chains — cycles are meant to be rejected at authoring time
 * (`object.setExpression`), but this makes evaluation itself safe even if a
 * cyclic project is ever reached (e.g. a hand-edited file).
 */
export function resolveObjectTransformWithExpressions(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
  resolving: ReadonlySet<string> = new Set(),
): ObjectExpressionResolution {
  const object = objectsById[objectId];
  if (object === undefined) throw new RangeError(`unknown visual object ${objectId}`);
  const base = resolveAnimatedTransform(object.transform, object.animations, timeUs);
  const expressions = object.expressions;
  if (expressions === undefined) return { transform: base, diagnostics: [] };

  if (resolving.has(objectId)) {
    // Should already be rejected at authoring time (object.setExpression); degrade safely if
    // a cyclic project is ever reached anyway, flagging every expression channel involved.
    return {
      transform: base,
      diagnostics: ANIMATABLE_PROPERTIES.filter(
        (property) => expressions[property] !== undefined,
      ).map((property) => ({
        objectId,
        property,
        message: `reference cycle involving "${objectId}"`,
      })),
    };
  }
  const nextResolving = new Set(resolving);
  nextResolving.add(objectId);

  // Declared before `resolveReference` so a referenced object's own diagnostics
  // (including a cycle-guard hit several `ref()` calls deep) surface here too,
  // rather than being silently absorbed as "just a number" by the interpreter.
  const diagnostics: ExpressionChannelDiagnostic[] = [];

  const resolveReference = (refObjectId: string, property: string): number => {
    const resolved = resolveObjectTransformWithExpressions(
      refObjectId,
      objectsById,
      timeUs,
      nextResolving,
    );
    diagnostics.push(...resolved.diagnostics);
    const value = (resolved.transform as unknown as Record<string, number | undefined>)[property];
    if (value === undefined)
      throw new ExpressionEvalError(`"${refObjectId}" has no property "${property}"`);
    return value;
  };

  const sampled: Record<string, number> = { ...(base as unknown as Record<string, number>) };
  const timeSeconds = timeUs / 1_000_000;

  for (const property of ANIMATABLE_PROPERTIES) {
    const source = expressions[property];
    if (source === undefined) continue;
    const { compiled, diagnostics: compileDiagnostics } = compileCached(source);
    if (compiled === undefined) {
      diagnostics.push({
        objectId,
        property,
        message: compileDiagnostics[0]?.message ?? 'expression failed to compile',
      });
      continue;
    }
    try {
      sampled[property] = evaluateExpression(compiled.ast, {
        variables: { time: timeSeconds },
        resolveReference,
      });
    } catch (error) {
      diagnostics.push({
        objectId,
        property,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { transform: clampTransform(sampled as unknown as VisualObjectTransformV1), diagnostics };
}

/** A synthetic per-channel graph node id — cycles matter at object+property granularity. */
export function expressionNodeKey(objectId: string, property: string): string {
  return `${objectId}::${property}`;
}

/**
 * Builds the static reference graph across every object's expressions, keyed
 * by `expressionNodeKey`. `override` lets a caller ask "would setting this one
 * channel's source create a cycle?" before committing it. Uncompilable
 * expressions contribute no edges — a broken expression can't reference
 * anything, and it already gets its own diagnostic at evaluation time.
 */
export function buildExpressionReferenceGraph(
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  override?: {
    readonly objectId: string;
    readonly property: AnimatablePropertyV1;
    readonly source?: string;
  },
): Readonly<Record<string, readonly ExpressionReference[]>> {
  const graph: Record<string, readonly ExpressionReference[]> = {};
  const objectIds = new Set(Object.keys(objectsById));
  if (override !== undefined) objectIds.add(override.objectId);

  for (const objectId of objectIds) {
    const object = objectsById[objectId];
    for (const property of ANIMATABLE_PROPERTIES) {
      const isOverrideTarget =
        override !== undefined && override.objectId === objectId && override.property === property;
      const source = isOverrideTarget ? override.source : object?.expressions?.[property];
      if (source === undefined) continue;
      const { compiled } = compileCached(source);
      if (compiled === undefined) continue;
      graph[expressionNodeKey(objectId, property)] = compiled.references.map((reference) => ({
        objectId: expressionNodeKey(reference.objectId, reference.property),
        property: reference.property,
      }));
    }
  }
  return graph;
}

export interface WorldExpressionResolution {
  readonly transform: VisualObjectTransformV1;
  readonly diagnostics: readonly ExpressionChannelDiagnostic[];
}

/**
 * An object's *world* transform at `timeUs` (WP-10.5): each ancestor's local
 * transform is resolved expression-first (`resolveObjectTransformWithExpressions`)
 * before composing up the parent chain, so an expression anywhere in the
 * chain — including on a camera or its rig — is honored. `ref()` cross-object
 * references still resolve the referenced object's *local* value, unchanged
 * from `resolveObjectTransformWithExpressions`.
 */
export function resolveWorldTransformWithExpressions(
  objectId: string,
  objectsById: Readonly<Record<string, VisualObjectV1>>,
  timeUs: TimeUs,
): WorldExpressionResolution {
  const diagnostics: ExpressionChannelDiagnostic[] = [];
  const transform = resolveWorldTransform(objectId, objectsById, timeUs, (object, t) => {
    const resolved = resolveObjectTransformWithExpressions(object.id, objectsById, t);
    diagnostics.push(...resolved.diagnostics);
    return resolved.transform;
  });
  return { transform, diagnostics };
}
