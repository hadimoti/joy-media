import { describe, expect, it } from 'vitest';
import { isTraversalKey, traverseGraph, type TraversalGraph } from './graph-traversal.js';

/**
 * A fork and a join, the shape Reel Finish produces: one source into two
 * parallel reviews, both into one gate.
 */
function forkGraph(): TraversalGraph {
  return {
    nodes: [
      { id: 'source' },
      { id: 'colour' },
      { id: 'audio' },
      { id: 'gate' },
    ],
    edges: [
      { from: 'source', to: 'colour' },
      { from: 'source', to: 'audio' },
      { from: 'colour', to: 'gate' },
      { from: 'audio', to: 'gate' },
    ],
    positions: new Map([
      ['source', { x: 0, y: 0 }],
      ['colour', { x: 230, y: 0 }],
      ['audio', { x: 230, y: 78 }],
      ['gate', { x: 460, y: 39 }],
    ]),
  };
}

describe('keyboard traversal through the flow graph', () => {
  it('follows an outgoing edge to the right', () => {
    expect(traverseGraph(forkGraph(), 'source', 'ArrowRight')).toBe('colour');
  });

  it('follows an incoming edge to the left', () => {
    expect(traverseGraph(forkGraph(), 'gate', 'ArrowLeft')).toBe('colour');
  });

  it('reaches the second branch of a fork by moving down the column', () => {
    // Right lands on the first branch; down is what makes the other reachable.
    expect(traverseGraph(forkGraph(), 'colour', 'ArrowDown')).toBe('audio');
    expect(traverseGraph(forkGraph(), 'audio', 'ArrowUp')).toBe('colour');
  });

  it('stays put at the end of a chain rather than wrapping', () => {
    // Wrapping would claim a connection the graph does not have.
    expect(traverseGraph(forkGraph(), 'gate', 'ArrowRight')).toBeUndefined();
    expect(traverseGraph(forkGraph(), 'source', 'ArrowLeft')).toBeUndefined();
    expect(traverseGraph(forkGraph(), 'source', 'ArrowUp')).toBeUndefined();
    expect(traverseGraph(forkGraph(), 'gate', 'ArrowDown')).toBeUndefined();
  });

  it('jumps to the first and last node in layout order', () => {
    expect(traverseGraph(forkGraph(), 'colour', 'Home')).toBe('source');
    expect(traverseGraph(forkGraph(), 'colour', 'End')).toBe('gate');
  });

  it('follows edges in declaration order, so the same graph traverses the same way', () => {
    const graph = forkGraph();
    const reversed: TraversalGraph = {
      ...graph,
      edges: [
        { from: 'source', to: 'audio' },
        { from: 'source', to: 'colour' },
        ...graph.edges.slice(2),
      ],
    };

    expect(traverseGraph(reversed, 'source', 'ArrowRight')).toBe('audio');
  });

  it('ignores an edge pointing at a node that has no position', () => {
    const graph = forkGraph();
    const dangling: TraversalGraph = {
      ...graph,
      edges: [{ from: 'source', to: 'ghost' }, ...graph.edges],
    };

    expect(traverseGraph(dangling, 'source', 'ArrowRight')).toBe('colour');
  });

  it('recognises only the keys it handles', () => {
    expect(isTraversalKey('ArrowRight')).toBe(true);
    expect(isTraversalKey('Enter')).toBe(false);
    expect(isTraversalKey('a')).toBe(false);
  });
});
