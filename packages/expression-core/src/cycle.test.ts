import { describe, expect, it } from 'vitest';
import { detectExpressionCycle } from './cycle.js';

describe('detectExpressionCycle', () => {
  it('returns undefined for an acyclic graph', () => {
    expect(
      detectExpressionCycle({
        a: [{ objectId: 'b', property: 'x' }],
        b: [{ objectId: 'c', property: 'x' }],
        c: [],
      }),
    ).toBeUndefined();
  });

  it('detects a direct self-reference', () => {
    const cycle = detectExpressionCycle({ a: [{ objectId: 'a', property: 'x' }] });
    expect(cycle).toEqual(['a', 'a']);
  });

  it('detects a multi-node cycle', () => {
    const cycle = detectExpressionCycle({
      a: [{ objectId: 'b', property: 'x' }],
      b: [{ objectId: 'c', property: 'x' }],
      c: [{ objectId: 'a', property: 'x' }],
    });
    expect(cycle).toEqual(['a', 'b', 'c', 'a']);
  });

  it('tolerates references to nodes with no expression of their own (not a cycle)', () => {
    expect(
      detectExpressionCycle({
        a: [{ objectId: 'no-expression-here', property: 'x' }],
      }),
    ).toBeUndefined();
  });

  it('finds a cycle reachable only through a diamond-shaped graph', () => {
    const cycle = detectExpressionCycle({
      a: [
        { objectId: 'b', property: 'x' },
        { objectId: 'c', property: 'x' },
      ],
      b: [{ objectId: 'd', property: 'x' }],
      c: [{ objectId: 'd', property: 'x' }],
      d: [{ objectId: 'a', property: 'x' }],
    });
    expect(cycle).toBeDefined();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });
});
