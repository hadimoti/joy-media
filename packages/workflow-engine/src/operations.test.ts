import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import {
  RunRecorder,
  buildRunDashboard,
  instrumentHandlers,
  isRunArtifactDeclaration,
  renderRunDashboardText,
} from './operations.js';
import type { NodeHandler } from './runtime.js';
import { executeWorkflow } from './runtime.js';

const node = (id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  category: 'transform',
  type: `t.${id}`,
  params: {},
  deterministic: true,
  ...overrides,
});

const workflow = (
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  overrides: Partial<JoyWorkflow> = {},
): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-ops',
  version: '1.0.0',
  name: 'Operations test workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

describe('RunRecorder', () => {
  it('orders entries by a monotonic sequence, not wall-clock time', () => {
    const recorder = new RunRecorder();
    recorder.log('a', 'info', 'first');
    recorder.log('b', 'warn', 'second', 2, { detail: true });
    const entries = recorder.logEntries();
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries[1]).toMatchObject({
      nodeId: 'b',
      level: 'warn',
      attempt: 2,
      data: { detail: true },
    });
    expect(Object.keys(entries[0] ?? {})).not.toContain('data');
  });
});

describe('isRunArtifactDeclaration', () => {
  it('accepts valid declarations and rejects malformed ones', () => {
    expect(isRunArtifactDeclaration({ name: 'reel', kind: 'render', ref: 'asset:1' })).toBe(true);
    expect(
      isRunArtifactDeclaration({ name: 'log', kind: 'file', ref: 'x', mediaType: 'text/plain' }),
    ).toBe(true);
    expect(isRunArtifactDeclaration({ name: 'reel', kind: 'blob', ref: 'asset:1' })).toBe(false);
    expect(isRunArtifactDeclaration({ kind: 'file', ref: 'x' })).toBe(false);
    expect(isRunArtifactDeclaration(null)).toBe(false);
  });
});

describe('instrumentHandlers + buildRunDashboard', () => {
  it('records per-node attempt logs, outcomes, and declared artifacts', () => {
    const wf = workflow(
      [
        node('flaky', { retry: { maxAttempts: 2, backoffMs: 0 } }),
        node('renderer'),
        node('broken'),
      ],
      [
        { from: 'flaky', to: 'renderer' },
        { from: 'renderer', to: 'broken' },
      ],
      {
        policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
      },
    );
    let calls = 0;
    const handlers: Record<string, NodeHandler> = {
      't.flaky': () => {
        calls += 1;
        return calls < 2
          ? { ok: false, failureCode: 'flaky', retryable: true }
          : { ok: true, output: 'ready' };
      },
      't.renderer': () => ({
        ok: true,
        output: {
          artifacts: [
            { name: 'proxy', kind: 'render', ref: 'asset:proxy-1', mediaType: 'video/mp4' },
            { name: 'bad', kind: 'nope', ref: 'x' }, // malformed: ignored
          ],
        },
      }),
      't.broken': () => ({ ok: false, failureCode: 'transform/failed', retryable: false }),
    };

    const recorder = new RunRecorder();
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-ops-1',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: instrumentHandlers(handlers, recorder),
    });

    const dashboard = buildRunDashboard({ workflow: wf, result, recorder });
    expect(dashboard.state).toBe('failed');
    expect(dashboard.counts).toEqual({ succeeded: 2, failed: 1 });

    const flaky = dashboard.nodes[0];
    expect(flaky?.state).toBe('succeeded');
    expect(flaky?.attempts).toBe(2);
    expect(flaky?.logs.map((entry) => entry.message)).toEqual([
      'attempt 1 started',
      'failed: flaky (retryable)',
      'attempt 2 started',
      'succeeded',
    ]);

    const renderer = dashboard.nodes[1];
    expect(renderer?.artifacts).toEqual([
      {
        nodeId: 'renderer',
        name: 'proxy',
        kind: 'render',
        ref: 'asset:proxy-1',
        mediaType: 'video/mp4',
      },
    ]);

    const broken = dashboard.nodes[2];
    expect(broken?.state).toBe('failed');
    expect(broken?.failureCode).toBe('transform/failed');
    expect(broken?.logs.at(-1)?.message).toBe('failed: transform/failed (non-retryable)');
  });

  it('records waiting nodes with their pending request and marks reused nodes on resume', () => {
    const wf = workflow(
      [node('work'), node('gate', { category: 'decision', type: 'd.gate' })],
      [{ from: 'work', to: 'gate' }],
    );
    const handlers: Record<string, NodeHandler> = {
      't.work': () => ({ ok: true, output: 42 }),
      'd.gate': (ctx) =>
        ctx.humanInput === undefined
          ? { waiting: true, request: { kind: 'approve-render', prompt: 'Ship it?' } }
          : { ok: true, output: ctx.humanInput },
    };

    const firstRecorder = new RunRecorder();
    const first = executeWorkflow({
      workflow: wf,
      runId: 'run-ops-2',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: instrumentHandlers(handlers, firstRecorder),
    });
    const firstDashboard = buildRunDashboard({
      workflow: wf,
      result: first,
      recorder: firstRecorder,
    });
    expect(firstDashboard.state).toBe('waiting_for_input');
    expect(firstDashboard.nodes[1]?.pendingRequest?.kind).toBe('approve-render');
    expect(firstDashboard.nodes[1]?.logs.at(-1)?.level).toBe('warn');

    const secondRecorder = new RunRecorder();
    const second = executeWorkflow({
      workflow: wf,
      runId: 'run-ops-2',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: instrumentHandlers(handlers, secondRecorder),
      resumeFrom: first.checkpoint,
      humanInputs: { gate: true },
    });
    const secondDashboard = buildRunDashboard({
      workflow: wf,
      result: second,
      recorder: secondRecorder,
    });
    expect(secondDashboard.state).toBe('succeeded');
    expect(secondDashboard.nodes[0]?.reused).toBe(true);
    expect(secondDashboard.nodes[0]?.logs).toEqual([]);
    expect(secondDashboard.reusedNodeIds).toEqual(['work']);
    expect(secondDashboard.executedNodeIds).toEqual(['gate']);
  });

  it('dashboards are JSON-round-trippable and render to a stable text view', () => {
    const wf = workflow([node('only')], []);
    const recorder = new RunRecorder();
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-ops-3',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: instrumentHandlers(
        {
          't.only': () => ({
            ok: true,
            output: { artifacts: [{ name: 'meta', kind: 'json', ref: 'meta.json' }] },
          }),
        },
        recorder,
      ),
    });
    const dashboard = buildRunDashboard({ workflow: wf, result, recorder });
    expect(JSON.parse(JSON.stringify(dashboard))).toEqual(dashboard);

    const text = renderRunDashboardText(dashboard);
    expect(text).toContain('run run-ops-3 — wf-ops@1.0.0 — succeeded');
    expect(text).toContain('nodes: succeeded=1');
    expect(text).toContain('only (t.only) succeeded attempts=1');
    expect(text).toContain('artifact json meta -> meta.json');
  });

  it('rethrows and logs handler exceptions without changing runtime semantics', () => {
    const wf = workflow([node('boom')], []);
    const recorder = new RunRecorder();
    expect(() =>
      executeWorkflow({
        workflow: wf,
        runId: 'run-ops-4',
        projectRevision: 'rev-1',
        workflowInputs: null,
        handlers: instrumentHandlers(
          {
            't.boom': () => {
              throw new Error('kaboom');
            },
          },
          recorder,
        ),
      }),
    ).toThrowError('kaboom');
    expect(recorder.logEntries().at(-1)?.message).toBe('attempt 1 threw: kaboom');
  });
});
