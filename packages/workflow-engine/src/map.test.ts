import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import { InMemoryMapStateStore, buildNodeLibrary } from './library.js';
import { runMapBatch } from './map.js';
import type { NodeHandler } from './runtime.js';
import { WorkflowEngineError, executeWorkflow } from './runtime.js';

const subWorkflow = (nodes: readonly WorkflowNode[], edges: JoyWorkflow['edges']): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-sub',
  version: '1.0.0',
  name: 'Per-item sub-workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
});

/** Plain sub-workflow: read → double, using raw handlers (no library needed). */
const doubling = subWorkflow(
  [
    { id: 'read', category: 'input', type: 't.read', params: {}, deterministic: true },
    { id: 'double', category: 'transform', type: 't.double', params: {}, deterministic: true },
  ],
  [{ from: 'read', to: 'double' }],
);

const doublingHandlers = (
  onDouble?: (n: number) => void,
  failFor?: (n: number) => boolean,
): Record<string, NodeHandler> => ({
  't.read': (ctx) => ({ ok: true, output: (ctx.workflowInputs as { n: number }).n }),
  't.double': (ctx) => {
    const n = ctx.upstream['read'] as number;
    onDouble?.(n);
    if (failFor?.(n) === true) {
      return { ok: false, failureCode: 'item-broken', retryable: false };
    }
    return { ok: true, output: n * 2 };
  },
});

const batchBase = {
  workflow: doubling,
  runId: 'batch-run',
  projectRevision: 'rev-1',
};

describe('runMapBatch', () => {
  it('runs the sub-workflow once per item and collects sink outputs in item order', () => {
    const result = runMapBatch({
      ...batchBase,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
      handlers: doublingHandlers(),
    });
    expect(result.succeeded).toBe(true);
    expect(result.executedItemIndexes).toEqual([0, 1, 2]);
    expect(result.outputs).toEqual([{ double: 2 }, { double: 4 }, { double: 6 }]);
    expect(JSON.parse(JSON.stringify(result.state))).toEqual(result.state);
  });

  it('stops at the first failed item by default and keeps partial progress', () => {
    const result = runMapBatch({
      ...batchBase,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
      handlers: doublingHandlers(undefined, (n) => n === 2),
    });
    expect(result.succeeded).toBe(false);
    expect(result.executedItemIndexes).toEqual([0, 1]);
    expect(result.state.items).toHaveLength(2);
    expect(result.state.items[1]?.state).toBe('failed');
    expect(result.outputs).toEqual([{ double: 2 }, null, null]);
  });

  it('continues past failed items when continueOnItemFailure is set', () => {
    const result = runMapBatch({
      ...batchBase,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
      handlers: doublingHandlers(undefined, (n) => n === 2),
      continueOnItemFailure: true,
    });
    expect(result.succeeded).toBe(false);
    expect(result.executedItemIndexes).toEqual([0, 1, 2]);
    expect(result.outputs).toEqual([{ double: 2 }, null, { double: 6 }]);
  });

  it('resumes a batch re-running only unfinished items (§23.5, no duplicated work)', () => {
    const doubled: number[] = [];
    let broken = true;
    const handlers = doublingHandlers(
      (n) => doubled.push(n),
      (n) => broken && n === 2,
    );
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];

    const first = runMapBatch({ ...batchBase, items, handlers, continueOnItemFailure: true });
    expect(doubled).toEqual([1, 2, 3]);

    broken = false;
    const second = runMapBatch({
      ...batchBase,
      items,
      handlers,
      continueOnItemFailure: true,
      priorState: first.state,
    });
    expect(second.succeeded).toBe(true);
    expect(second.reusedItemIndexes).toEqual([0, 2]);
    expect(second.executedItemIndexes).toEqual([1]);
    // Items 1 and 3 ran exactly once across both batches.
    expect(doubled).toEqual([1, 2, 3, 2]);
    expect(second.outputs).toEqual([{ double: 2 }, { double: 4 }, { double: 6 }]);
  });

  it('re-runs only items whose content changed', () => {
    const doubled: number[] = [];
    const handlers = doublingHandlers((n) => doubled.push(n));
    const first = runMapBatch({ ...batchBase, items: [{ n: 1 }, { n: 2 }], handlers });
    const second = runMapBatch({
      ...batchBase,
      items: [{ n: 1 }, { n: 20 }],
      handlers,
      priorState: first.state,
    });
    expect(second.reusedItemIndexes).toEqual([0]);
    expect(second.executedItemIndexes).toEqual([1]);
    expect(doubled).toEqual([1, 2, 20]);
  });

  it('rejects an invalid sub-workflow with a coded error', () => {
    const cyclic = subWorkflow(
      [
        { id: 'a', category: 'input', type: 't.a', params: {}, deterministic: true },
        { id: 'b', category: 'input', type: 't.b', params: {}, deterministic: true },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(() =>
      runMapBatch({ ...batchBase, workflow: cyclic, items: [1], handlers: {} }),
    ).toThrowError(WorkflowEngineError);
  });
});

describe('control.map node', () => {
  /**
   * One input batch → one sub-workflow run per row → one editable branch per row,
   * with partial batch progress surviving a parent-run retry via the state store.
   */
  it('maps rows to editable branches and resumes without duplicating branch creation', () => {
    const store = new InMemoryMapStateStore();
    const created: string[] = [];
    let failFor: string | undefined = 'promo-fa';
    const build = () =>
      buildNodeLibrary({
        mapStateStore: store,
        ports: {
          editor: {
            createBranch: ({ name, source }) => {
              const row = source as { slug: string };
              if (failFor === row.slug) {
                throw new Error('branch service hiccup');
              }
              created.push(row.slug);
              return { branchId: `branch-${row.slug}-${name}` };
            },
          },
        },
      });

    const { registry, handlers } = build();
    const perRow = subWorkflow(
      [
        registry.createNode('row', 'input.item', {}),
        registry.createNode('branch', 'editor.createBranch', { name: 'variant' }),
      ],
      [{ from: 'row', to: 'branch' }],
    );
    const rows = [{ slug: 'promo-en' }, { slug: 'promo-fa' }, { slug: 'promo-sv' }];
    const parent: JoyWorkflow = {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      id: 'wf-map-parent',
      version: '1.0.0',
      name: 'Batch to variants',
      inputs: {},
      outputs: {},
      nodes: [
        registry.createNode('rows', 'input.rows', { rows }),
        registry.createNode('map', 'control.map', {
          workflow: perRow,
          continueOnItemFailure: true,
        }),
      ],
      edges: [{ from: 'rows', to: 'map' }],
      permissions: [],
      policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
    };
    const base = {
      workflow: parent,
      runId: 'parent-run',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    };

    const first = executeWorkflow(base);
    expect(first.checkpoint.state).toBe('failed');
    expect(first.checkpoint.nodes['map']).toMatchObject({
      state: 'failed',
      failureCode: 'workflow/map-item-failed',
    });
    expect(created).toEqual(['promo-en', 'promo-sv']);

    // Branch service recovers; retry the parent run resuming from its checkpoint.
    failFor = undefined;
    const second = executeWorkflow({ ...base, resumeFrom: first.checkpoint });
    expect(second.checkpoint.state).toBe('succeeded');
    // Only the failed row created a branch on retry — items 1 and 3 were reused.
    expect(created).toEqual(['promo-en', 'promo-sv', 'promo-fa']);
    expect(second.checkpoint.nodes['map']?.output).toEqual({
      count: 3,
      items: [
        { branch: { branchId: 'branch-promo-en-variant' } },
        { branch: { branchId: 'branch-promo-fa-variant' } },
        { branch: { branchId: 'branch-promo-sv-variant' } },
      ],
    });
  });

  it('reports a waiting item inside a map as a distinct non-retryable failure (v1 limit)', () => {
    const store = new InMemoryMapStateStore();
    const { registry, handlers } = buildNodeLibrary({ mapStateStore: store });
    const perRow = subWorkflow(
      [
        registry.createNode('row', 'input.item', {}),
        registry.createNode('approve', 'decision.approval', {
          kind: 'select-variant',
          prompt: 'Pick one',
        }),
      ],
      [{ from: 'row', to: 'approve' }],
    );
    const parent: JoyWorkflow = {
      formatVersion: WORKFLOW_FORMAT_VERSION,
      id: 'wf-map-waiting',
      version: '1.0.0',
      name: 'Waiting inside map',
      inputs: {},
      outputs: {},
      nodes: [
        registry.createNode('rows', 'input.rows', { rows: [{ a: 1 }] }),
        registry.createNode('map', 'control.map', { workflow: perRow }),
      ],
      edges: [{ from: 'rows', to: 'map' }],
      permissions: [],
      policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
    };
    const result = executeWorkflow({
      workflow: parent,
      runId: 'parent-waiting',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    });
    expect(result.checkpoint.nodes['map']).toMatchObject({
      state: 'failed',
      failureCode: 'workflow/map-item-waiting',
    });
  });
});
