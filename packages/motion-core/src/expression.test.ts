import { describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import {
  buildExpressionReferenceGraph,
  expressionNodeKey,
  resolveObjectTransformWithExpressions,
} from './expression.js';

const baseTransform = {
  x: 10,
  y: 20,
  scaleX: 1,
  scaleY: 1,
  rotationDeg: 0,
  opacity: 1,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};

describe('resolveObjectTransformWithExpressions', () => {
  it('returns the base (curve/static) transform when no expressions are present', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.transform.x).toBe(10);
    expect(result.diagnostics).toEqual([]);
  });

  it('overrides a channel with its expression result', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: '100 + 1' } },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.transform.x).toBe(101);
    expect(result.transform.y).toBe(20); // untouched channel keeps its static value
    expect(result.diagnostics).toEqual([]);
  });

  it('binds `time` in seconds from timeUs', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: 'time * 100' } },
    };
    expect(resolveObjectTransformWithExpressions('a', objects, 2_500_000).transform.x).toBeCloseTo(
      250,
      6,
    );
  });

  it('resolves ref() against another object at the same time', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      cam: {
        id: 'cam',
        kind: 'camera',
        transform: { ...baseTransform, x: 50 },
        camera: { fieldOfViewDeg: 54 },
      },
      a: {
        id: 'a',
        kind: 'text',
        transform: baseTransform,
        expressions: { x: 'ref("cam", "x") + 1' },
      },
    };
    expect(resolveObjectTransformWithExpressions('a', objects, 0).transform.x).toBe(51);
  });

  it('falls back to the base value and reports a diagnostic on a compile failure', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: '1 +' } },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.transform.x).toBe(10); // falls back to the static value
    expect(result.diagnostics).toEqual([
      { objectId: 'a', property: 'x', message: expect.any(String) },
    ]);
  });

  it('falls back to the base value and reports a diagnostic on a runtime evaluation failure', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: 'mystery' } },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.transform.x).toBe(10);
    expect(result.diagnostics[0]!.message).toMatch(/unknown identifier/);
  });

  it('clamps scale/opacity produced by an expression to their durable invariants', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: {
        id: 'a',
        kind: 'text',
        transform: baseTransform,
        expressions: { scaleX: '-5', opacity: '5' },
      },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.transform.scaleX).toBeGreaterThan(0);
    expect(result.transform.opacity).toBe(1);
  });

  it('degrades safely instead of infinitely recursing if a cyclic project is reached at evaluation time', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: 'ref("b", "x")' } },
      b: { id: 'b', kind: 'text', transform: baseTransform, expressions: { x: 'ref("a", "x")' } },
    };
    const result = resolveObjectTransformWithExpressions('a', objects, 0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]!.message).toMatch(/cycle/);
  });
});

describe('buildExpressionReferenceGraph', () => {
  it('extracts a graph keyed by object+property', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: 'ref("b", "y")' } },
      b: { id: 'b', kind: 'text', transform: baseTransform },
    };
    const graph = buildExpressionReferenceGraph(objects);
    expect(graph[expressionNodeKey('a', 'x')]).toEqual([
      { objectId: expressionNodeKey('b', 'y'), property: 'y' },
    ]);
  });

  it('applies an override without mutating the stored project', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform },
    };
    const graph = buildExpressionReferenceGraph(objects, {
      objectId: 'a',
      property: 'x',
      source: 'ref("b", "x")',
    });
    expect(graph[expressionNodeKey('a', 'x')]).toEqual([
      { objectId: expressionNodeKey('b', 'x'), property: 'x' },
    ]);
    expect(objects['a']!.expressions).toBeUndefined();
  });

  it('contributes no edges for an uncompilable expression', () => {
    const objects: Readonly<Record<string, VisualObjectV1>> = {
      a: { id: 'a', kind: 'text', transform: baseTransform, expressions: { x: '1 +' } },
    };
    const graph = buildExpressionReferenceGraph(objects);
    expect(graph[expressionNodeKey('a', 'x')]).toBeUndefined();
  });
});
