import { describe, expect, it } from 'vitest';
import type {
  WorkflowEdgeV2,
  WorkflowGraphV2,
  WorkflowNodeV2,
} from '@joy-media/project-schema';
import { validateWorkflowGraph } from '@joy-media/project-schema';
import { applyGraphCommand, GraphCommandError } from './graph-commands.js';
import type { WorkflowGraphCommand } from './graph-commands.js';
import {
  applyGraphTransaction,
  revertGraphTransaction,
  dryRunGraphTransaction,
} from './graph-history.js';
import {
  computeNodeCacheKey,
  downstreamNodeIds,
  invalidateDownstream,
  reportStaleness,
} from './graph-cache.js';

function node(
  id: string,
  overrides: Partial<WorkflowNodeV2> = {},
  outType = 'VideoArtifact',
  inType = 'VideoArtifact',
): WorkflowNodeV2 {
  return {
    id,
    type: 'transform.trim',
    schemaVersion: 1,
    label: id,
    inputs: [{ id: 'in', label: 'Source', dataType: inType, required: true }],
    outputs: [{ id: 'out', label: 'Result', dataType: outType, required: true }],
    config: {},
    executionPolicy: { requiredCapabilities: ['timeline.write'], requiresApproval: false },
    ...overrides,
  };
}

function edge(id: string, from: string, to: string): WorkflowEdgeV2 {
  return { id, fromNodeId: from, fromPortId: 'out', toNodeId: to, toPortId: 'in' };
}

const EMPTY: WorkflowGraphV2 = { schemaVersion: 1, nodes: [], edges: [] };

function graphOf(nodes: WorkflowNodeV2[], edges: WorkflowEdgeV2[] = []): WorkflowGraphV2 {
  return { schemaVersion: 1, nodes, edges };
}

describe('graph commands', () => {
  describe('every mutation goes through a command and is invertible', () => {
    const roundTrip = (graph: WorkflowGraphV2, command: WorkflowGraphCommand) => {
      const applied = applyGraphCommand(graph, command);
      const reverted = applyGraphCommand(applied.graph, applied.inverse);
      return { applied, reverted };
    };

    it('creates a node and inverts to removing it', () => {
      const { applied, reverted } = roundTrip(EMPTY, {
        type: 'graph.node.create',
        payload: { node: node('a') },
      });

      expect(applied.graph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(reverted.graph).toEqual(EMPTY);
    });

    it('restores a deleted node together with the edges it took with it', () => {
      // A single-command inverse has to put back both, or undo leaves the node
      // orphaned and the graph is missing connections the user never removed.
      const before = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);

      const { applied, reverted } = roundTrip(before, {
        type: 'graph.node.delete',
        payload: { nodeId: 'b' },
      });

      expect(applied.graph.nodes.map((n) => n.id)).toEqual(['a']);
      expect(applied.graph.edges).toEqual([]);
      expect(reverted.graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
      expect(reverted.graph.edges).toEqual([edge('e1', 'a', 'b')]);
    });

    it('inverts a partial update by restoring every field it could have touched', () => {
      const before = graphOf([node('a', { label: 'Original', config: { keep: 1 } })]);

      const { applied, reverted } = roundTrip(before, {
        type: 'graph.node.update',
        payload: { nodeId: 'a', label: 'Renamed' },
      });

      expect(applied.graph.nodes[0]!.label).toBe('Renamed');
      expect(applied.graph.nodes[0]!.config).toEqual({ keep: 1 });
      expect(reverted.graph).toEqual(before);
    });

    it('inverts binding back to absent, not to undefined', () => {
      // "unbound" must round trip as the key being gone; a present-but-undefined
      // key is a different value under exactOptionalPropertyTypes and would
      // survive JSON round trips differently.
      const before = graphOf([node('a')]);

      const { applied, reverted } = roundTrip(before, {
        type: 'graph.node.bindTime',
        payload: { nodeId: 'a', binding: { type: 'range', startUs: 0, durationUs: 1_000_000 } },
      });

      expect(applied.graph.nodes[0]!.binding).toEqual({
        type: 'range',
        startUs: 0,
        durationUs: 1_000_000,
      });
      expect('binding' in reverted.graph.nodes[0]!).toBe(false);
      expect(reverted.graph).toEqual(before);
    });

    it('inverts connect and disconnect', () => {
      const connected = applyGraphCommand(graphOf([node('a'), node('b')]), {
        type: 'graph.edge.connect',
        payload: { edge: edge('e1', 'a', 'b') },
      });
      expect(connected.graph.edges).toHaveLength(1);

      const { reverted } = roundTrip(connected.graph, {
        type: 'graph.edge.disconnect',
        payload: { edgeId: 'e1' },
      });
      expect(reverted.graph.edges).toEqual([edge('e1', 'a', 'b')]);
    });

    it('refuses to touch a node that does not exist', () => {
      expect(() =>
        applyGraphCommand(EMPTY, { type: 'graph.node.delete', payload: { nodeId: 'ghost' } }),
      ).toThrow(GraphCommandError);
    });

    it('refuses to create a duplicate node id', () => {
      expect(() =>
        applyGraphCommand(graphOf([node('a')]), {
          type: 'graph.node.create',
          payload: { node: node('a') },
        }),
      ).toThrow(/already exists/);
    });
  });

  describe('cycles and invalid ports are rejected', () => {
    it('rejects an edge that would close a cycle', () => {
      const graph = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);

      expect(() =>
        applyGraphCommand(graph, {
          type: 'graph.edge.connect',
          payload: { edge: edge('e2', 'b', 'a') },
        }),
      ).toThrow(/GRAPH_CYCLE/);
    });

    it('rejects a self-edge', () => {
      expect(() =>
        applyGraphCommand(graphOf([node('a')]), {
          type: 'graph.edge.connect',
          payload: { edge: edge('e1', 'a', 'a') },
        }),
      ).toThrow(/GRAPH_CYCLE/);
    });

    it('rejects incompatible port types with a message naming what is accepted', () => {
      const transcript = node('t', {}, 'Transcript', 'AudioArtifact');
      const video = node('v');

      expect(() =>
        applyGraphCommand(graphOf([transcript, video]), {
          type: 'graph.edge.connect',
          payload: { edge: edge('e1', 't', 'v') },
        }),
      ).toThrow(/cannot connect Transcript to VideoArtifact/);
    });

    it('accepts a connection an input explicitly declares', () => {
      const transcript = node('t', {}, 'Transcript');
      const captions = node('c', {
        inputs: [
          {
            id: 'in',
            label: 'Source',
            dataType: 'CaptionDocument',
            required: true,
            accepts: ['Transcript'],
          },
        ],
      });

      const applied = applyGraphCommand(graphOf([transcript, captions]), {
        type: 'graph.edge.connect',
        payload: { edge: edge('e1', 't', 'c') },
      });

      expect(applied.graph.edges).toHaveLength(1);
    });

    it('rejects a port that does not exist', () => {
      expect(() =>
        applyGraphCommand(graphOf([node('a'), node('b')]), {
          type: 'graph.edge.connect',
          payload: { edge: { ...edge('e1', 'a', 'b'), toPortId: 'nope' } },
        }),
      ).toThrow(/no input port/);
    });

    it('refuses a second connection to a single-value input', () => {
      // Otherwise which upstream value the port receives depends on edge order.
      const graph = graphOf([node('a'), node('b'), node('c')], [edge('e1', 'a', 'c')]);

      expect(() =>
        applyGraphCommand(graph, {
          type: 'graph.edge.connect',
          payload: { edge: edge('e2', 'b', 'c') },
        }),
      ).toThrow(/does not accept multiple/);
    });

    it('allows fan-in on a port marked multiple', () => {
      const merge = node('c', {
        inputs: [
          { id: 'in', label: 'Sources', dataType: 'VideoArtifact', required: true, multiple: true },
        ],
      });
      const graph = graphOf([node('a'), node('b'), merge], [edge('e1', 'a', 'c')]);

      const applied = applyGraphCommand(graph, {
        type: 'graph.edge.connect',
        payload: { edge: edge('e2', 'b', 'c') },
      });

      expect(applied.graph.edges).toHaveLength(2);
    });

    it('leaves the graph untouched when a command is rejected', () => {
      const before = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);
      const snapshot = JSON.parse(JSON.stringify(before));

      expect(() =>
        applyGraphCommand(before, {
          type: 'graph.edge.connect',
          payload: { edge: edge('e2', 'b', 'a') },
        }),
      ).toThrow();
      expect(before).toEqual(snapshot);
    });
  });

  describe('transactions are one undo step', () => {
    it('reverts a multi-command transaction in a single revert', () => {
      const before = EMPTY;
      const { graph, record } = applyGraphTransaction(before, {
        label: 'Add captions branch',
        commands: [
          { type: 'graph.node.create', payload: { node: node('a') } },
          { type: 'graph.node.create', payload: { node: node('b') } },
          { type: 'graph.edge.connect', payload: { edge: edge('e1', 'a', 'b') } },
        ],
      });

      expect(graph.nodes).toHaveLength(2);
      expect(graph.edges).toHaveLength(1);
      expect(record.inverses).toHaveLength(3);
      expect(revertGraphTransaction(graph, record)).toEqual(before);
    });

    it('discards everything when a later command fails', () => {
      const before = graphOf([node('a')]);

      expect(() =>
        applyGraphTransaction(before, {
          label: 'Half-valid',
          commands: [
            { type: 'graph.node.create', payload: { node: node('b') } },
            { type: 'graph.node.create', payload: { node: node('a') } },
          ],
        }),
      ).toThrow(/already exists/);
      expect(before.nodes).toHaveLength(1);
    });

    it('rejects an empty transaction rather than recording a no-op undo entry', () => {
      expect(() => applyGraphTransaction(EMPTY, { label: 'Nothing', commands: [] })).toThrow(
        /needs commands/,
      );
    });

    it('produces a graph the document validator accepts', () => {
      const { graph } = applyGraphTransaction(EMPTY, {
        label: 'Build',
        commands: [
          { type: 'graph.node.create', payload: { node: node('a') } },
          { type: 'graph.node.create', payload: { node: node('b') } },
          { type: 'graph.edge.connect', payload: { edge: edge('e1', 'a', 'b') } },
        ],
      });

      expect(validateWorkflowGraph(graph, 'workflow')).toEqual([]);
    });
  });

  describe('dry run', () => {
    it('reports knock-on effects, not just the command that was asked for', () => {
      // Deleting a node also drops its edges. A summary predicted from the
      // command list would claim one change and hide the other.
      const before = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);

      const result = dryRunGraphTransaction(before, {
        label: 'Drop b',
        commands: [{ type: 'graph.node.delete', payload: { nodeId: 'b' } }],
      });

      expect(result.ok).toBe(true);
      expect(result.summary.nodesRemoved).toEqual(['b']);
      expect(result.summary.edgesRemoved).toEqual(['e1']);
    });

    it('does not touch the input graph', () => {
      const before = graphOf([node('a')]);
      dryRunGraphTransaction(before, {
        label: 'Add',
        commands: [{ type: 'graph.node.create', payload: { node: node('b') } }],
      });

      expect(before.nodes).toHaveLength(1);
    });

    it('reports why an invalid transaction would fail instead of throwing', () => {
      const result = dryRunGraphTransaction(graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]), {
        label: 'Close the loop',
        commands: [{ type: 'graph.edge.connect', payload: { edge: edge('e2', 'b', 'a') } }],
      });

      expect(result.ok).toBe(false);
      expect(result.preview).toBeUndefined();
      expect(result.errors[0]).toMatch(/GRAPH_CYCLE/);
    });
  });

  describe('cache keys and staleness', () => {
    it('changes when config changes', () => {
      const before = graphOf([node('a')]);
      const after = graphOf([node('a', { config: { threshold: 2 } })]);

      expect(computeNodeCacheKey(before, 'a')).not.toBe(computeNodeCacheKey(after, 'a'));
    });

    it('ignores property order in config', () => {
      const left = graphOf([node('a', { config: { x: 1, y: 2 } })]);
      const right = graphOf([node('a', { config: { y: 2, x: 1 } })]);

      expect(computeNodeCacheKey(left, 'a')).toBe(computeNodeCacheKey(right, 'a'));
    });

    it('ignores canvas position, so moving a node costs no recomputation', () => {
      const left = graphOf([node('a')]);
      const right = graphOf([node('a', { ui: { position: { x: 900, y: 40 }, collapsed: true } })]);

      expect(computeNodeCacheKey(left, 'a')).toBe(computeNodeCacheKey(right, 'a'));
    });

    it('changes downstream when an upstream node changes', () => {
      const before = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);
      const after = graphOf(
        [node('a', { config: { changed: true } }), node('b')],
        [edge('e1', 'a', 'b')],
      );

      expect(computeNodeCacheKey(before, 'b')).not.toBe(computeNodeCacheKey(after, 'b'));
    });

    it('leaves an unrelated branch cached', () => {
      const before = graphOf([node('a'), node('b'), node('x')], [edge('e1', 'a', 'b')]);
      const after = graphOf(
        [node('a', { config: { changed: true } }), node('b'), node('x')],
        [edge('e1', 'a', 'b')],
      );

      expect(computeNodeCacheKey(before, 'x')).toBe(computeNodeCacheKey(after, 'x'));
    });

    it('walks the whole downstream closure', () => {
      const graph = graphOf(
        [node('a'), node('b'), node('c')],
        [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      );

      expect([...downstreamNodeIds(graph, 'a')].sort()).toEqual(['b', 'c']);
      expect(downstreamNodeIds(graph, 'c')).toEqual([]);
    });

    it('invalidates downstream as commands, not as a mutation', () => {
      const graph = graphOf(
        [node('a'), node('b'), node('c')],
        [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
      );

      const commands = invalidateDownstream(graph, 'a');

      expect(commands).toHaveLength(2);
      expect(commands.every((c) => c.type === 'graph.node.setStatus')).toBe(true);
      // Applying them is a normal transaction, so it undoes like anything else.
      const { graph: next, record } = applyGraphTransaction(graph, {
        label: 'Invalidate',
        commands: [...commands],
      });
      expect(next.nodes.filter((n) => n.status === 'stale').map((n) => n.id)).toEqual(['b', 'c']);
      expect(revertGraphTransaction(next, record)).toEqual(graph);
    });

    it('does not re-mark an already stale node, so no empty transaction is produced', () => {
      const graph = graphOf([node('a'), node('b', { status: 'stale' })], [edge('e1', 'a', 'b')]);

      expect(invalidateDownstream(graph, 'a')).toEqual([]);
    });

    it('protects pinned nodes from invalidation', () => {
      const graph = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);

      expect(invalidateDownstream(graph, 'a', { pinnedNodeIds: ['b'] })).toEqual([]);
    });

    it('treats a node that never ran as stale', () => {
      const graph = graphOf([node('a')]);

      expect(reportStaleness(graph, {})).toEqual([
        { nodeId: 'a', cacheKey: expect.any(String), stale: true },
      ]);
    });

    it('treats a node whose recorded key still matches as fresh', () => {
      const graph = graphOf([node('a')]);
      const recorded = { a: computeNodeCacheKey(graph, 'a') };

      expect(reportStaleness(graph, recorded)[0]!.stale).toBe(false);
    });
  });

  describe('graph UI serialization is separate from the domain schema', () => {
    it('moves a node without changing anything the graph means', () => {
      const before = graphOf([node('a'), node('b')], [edge('e1', 'a', 'b')]);

      const { graph } = applyGraphTransaction(before, {
        label: 'Move node',
        commands: [
          {
            type: 'graph.node.setUi',
            payload: { nodeId: 'a', ui: { position: { x: 42, y: 7 } } },
          },
        ],
        coalesceKey: 'drag:a',
      });

      const stripUi = (g: typeof graph) => ({
        ...g,
        nodes: g.nodes.map(({ ui, ...rest }) => {
          void ui;
          return rest;
        }),
      });

      expect(stripUi(graph)).toEqual(stripUi(before));
      expect(computeNodeCacheKey(graph, 'b')).toBe(computeNodeCacheKey(before, 'b'));
    });

    it('carries a coalesce key so a drag is one undo entry, not one per frame', () => {
      const { record } = applyGraphTransaction(graphOf([node('a')]), {
        label: 'Move node',
        commands: [
          { type: 'graph.node.setUi', payload: { nodeId: 'a', ui: { position: { x: 1, y: 1 } } } },
        ],
        coalesceKey: 'drag:a',
      });

      expect(record.coalesceKey).toBe('drag:a');
    });
  });
});
