import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import type { NodeHandler, RunCheckpoint } from './runtime.js';
import { WorkflowEngineError, executeWorkflow } from './runtime.js';

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
  id: 'wf-run',
  version: '1.0.0',
  name: 'Runtime test workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

const ok =
  (value: (upstream: Readonly<Record<string, unknown>>) => unknown): NodeHandler =>
  (ctx) => ({ ok: true, output: value(ctx.upstream) });

describe('executeWorkflow', () => {
  it('runs nodes in topological order and flows outputs downstream', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-1',
      projectRevision: 'rev-1',
      workflowInputs: { seed: 2 },
      handlers: {
        't.a': (ctx) => ({ ok: true, output: (ctx.workflowInputs as { seed: number }).seed * 10 }),
        't.b': ok((up) => (up['a'] as number) + 1),
        't.c': ok((up) => (up['b'] as number) + 1),
      },
    });
    expect(result.executedNodeIds).toEqual(['a', 'b', 'c']);
    expect(result.checkpoint.state).toBe('succeeded');
    expect(result.checkpoint.nodes['c']?.output).toBe(22);
  });

  it('retries retryable failures up to the effective policy and records attempts', () => {
    let calls = 0;
    const wf = workflow([node('a', { retry: { maxAttempts: 3, backoffMs: 0 } })], []);
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-retry',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: {
        't.a': () => {
          calls += 1;
          return calls < 3
            ? { ok: false, failureCode: 'flaky', retryable: true }
            : { ok: true, output: 'done' };
        },
      },
    });
    expect(calls).toBe(3);
    expect(result.checkpoint.nodes['a']).toMatchObject({ state: 'succeeded', attempts: 3 });
  });

  it('does not retry non-retryable failures and skips dependents under stop policy', () => {
    let downstreamRan = false;
    const wf = workflow(
      [node('a', { retry: { maxAttempts: 3, backoffMs: 0 } }), node('b'), node('solo')],
      [{ from: 'a', to: 'b' }],
    );
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-fail',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: {
        't.a': () => ({ ok: false, failureCode: 'bad-input', retryable: false }),
        't.b': () => {
          downstreamRan = true;
          return { ok: true, output: null };
        },
        't.solo': ok(() => 'independent'),
      },
    });
    expect(downstreamRan).toBe(false);
    expect(result.checkpoint.state).toBe('failed');
    expect(result.checkpoint.nodes['a']).toMatchObject({
      state: 'failed',
      attempts: 1,
      failureCode: 'bad-input',
    });
    expect(result.checkpoint.nodes['b']?.state).toBe('skipped');
    // stop policy halts the run: the independent node never started.
    expect(result.checkpoint.nodes['solo']?.state).toBe('pending');
  });

  it('keeps independent branches running under continue-independent and fails overall', () => {
    const wf = workflow([node('a'), node('b'), node('solo')], [{ from: 'a', to: 'b' }], {
      policy: {
        concurrency: 1,
        failure: 'continue-independent',
        defaultRetry: { maxAttempts: 1, backoffMs: 0 },
      },
    });
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-ci',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: {
        't.a': () => ({ ok: false, failureCode: 'boom', retryable: false }),
        't.b': ok(() => null),
        't.solo': ok(() => 'independent'),
      },
    });
    expect(result.checkpoint.nodes['solo']).toMatchObject({
      state: 'succeeded',
      output: 'independent',
    });
    expect(result.checkpoint.nodes['b']?.state).toBe('skipped');
    expect(result.checkpoint.state).toBe('failed');
  });

  it('parks as waiting_for_manual_intervention under manual policy', () => {
    const wf = workflow([node('a'), node('b')], [{ from: 'a', to: 'b' }], {
      policy: {
        concurrency: 1,
        failure: 'manual',
        defaultRetry: { maxAttempts: 1, backoffMs: 0 },
      },
    });
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-manual',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: {
        't.a': () => ({ ok: false, failureCode: 'needs-human', retryable: false }),
        't.b': ok(() => null),
      },
    });
    expect(result.checkpoint.state).toBe('waiting_for_manual_intervention');
    expect(result.checkpoint.nodes['b']?.state).toBe('skipped');
  });

  it('cancels cooperatively: finished nodes keep results, unstarted nodes stay pending', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    let finished = 0;
    const result = executeWorkflow({
      workflow: wf,
      runId: 'run-cancel',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers: {
        't.a': () => {
          finished += 1;
          return { ok: true, output: 'a-out' };
        },
        't.b': ok(() => null),
        't.c': ok(() => null),
      },
      shouldCancel: () => finished >= 1,
    });
    expect(result.checkpoint.state).toBe('canceled');
    expect(result.executedNodeIds).toEqual(['a']);
    expect(result.checkpoint.nodes['a']).toMatchObject({ state: 'succeeded', output: 'a-out' });
    expect(result.checkpoint.nodes['b']?.state).toBe('pending');
    expect(result.checkpoint.nodes['c']?.state).toBe('pending');
  });

  it('resumes from a checkpoint without duplicating completed work', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    );
    const invocations: Record<string, number> = { a: 0, b: 0, c: 0 };
    const count = (id: string) => {
      invocations[id] = (invocations[id] ?? 0) + 1;
    };
    let bWorks = false;
    const handlers: Record<string, NodeHandler> = {
      't.a': () => {
        count('a');
        return { ok: true, output: 1 };
      },
      't.b': () => {
        count('b');
        return bWorks
          ? { ok: true, output: 2 }
          : { ok: false, failureCode: 'not-yet', retryable: false };
      },
      't.c': () => {
        count('c');
        return { ok: true, output: 3 };
      },
    };
    const base = {
      workflow: wf,
      runId: 'run-resume',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    };

    const first = executeWorkflow(base);
    expect(first.checkpoint.state).toBe('failed');
    expect(invocations).toEqual({ a: 1, b: 1, c: 0 });

    bWorks = true;
    const second = executeWorkflow({ ...base, resumeFrom: first.checkpoint });
    expect(second.checkpoint.state).toBe('succeeded');
    expect(second.reusedNodeIds).toEqual(['a']);
    expect(second.executedNodeIds).toEqual(['b', 'c']);
    // a ran exactly once across both calls — no duplicated completed work.
    expect(invocations).toEqual({ a: 1, b: 2, c: 1 });
  });

  it('reuses nondeterministic outputs on resume only when policy allows (§23.5)', () => {
    const wf = workflow([node('gen', { category: 'generation', deterministic: false })], []);
    let calls = 0;
    const handlers: Record<string, NodeHandler> = {
      't.gen': () => {
        calls += 1;
        return { ok: true, output: `take-${calls}` };
      },
    };
    const base = {
      workflow: wf,
      runId: 'run-nondet',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    };
    const first = executeWorkflow(base);
    const rerun = executeWorkflow({ ...base, resumeFrom: first.checkpoint });
    expect(rerun.executedNodeIds).toEqual(['gen']);
    expect(rerun.checkpoint.nodes['gen']?.output).toBe('take-2');

    const reused = executeWorkflow({
      ...base,
      resumeFrom: first.checkpoint,
      reuseNondeterministic: true,
    });
    expect(reused.reusedNodeIds).toEqual(['gen']);
    expect(reused.checkpoint.nodes['gen']?.output).toBe('take-1');
  });

  it('re-executes checkpointed nodes whose run key no longer matches', () => {
    const make = (language: string) => workflow([node('a', { params: { language } })], []);
    let calls = 0;
    const handlers: Record<string, NodeHandler> = {
      't.a': () => {
        calls += 1;
        return { ok: true, output: calls };
      },
    };
    const first = executeWorkflow({
      workflow: make('fa'),
      runId: 'r',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    });
    const changed = executeWorkflow({
      workflow: make('en'),
      runId: 'r',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
      resumeFrom: first.checkpoint,
    });
    expect(changed.reusedNodeIds).toEqual([]);
    expect(changed.executedNodeIds).toEqual(['a']);
  });

  it('rejects checkpoints from another workflow version or project revision', () => {
    const wf = workflow([node('a')], []);
    const handlers = { 't.a': ok(() => null) };
    const first = executeWorkflow({
      workflow: wf,
      runId: 'r',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    });
    const otherVersion = { ...wf, version: '2.0.0' };
    expect(() =>
      executeWorkflow({
        workflow: otherVersion,
        runId: 'r',
        projectRevision: 'rev-1',
        workflowInputs: null,
        handlers,
        resumeFrom: first.checkpoint,
      }),
    ).toThrow(WorkflowEngineError);
    expect(() =>
      executeWorkflow({
        workflow: wf,
        runId: 'r',
        projectRevision: 'rev-2',
        workflowInputs: null,
        handlers,
        resumeFrom: first.checkpoint,
      }),
    ).toThrow(WorkflowEngineError);
  });

  it('rejects invalid workflows and missing handlers with coded errors', () => {
    const cyclic = workflow(
      [node('a'), node('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    );
    expect(() =>
      executeWorkflow({
        workflow: cyclic,
        runId: 'r',
        projectRevision: 'rev-1',
        workflowInputs: null,
        handlers: {},
      }),
    ).toThrow(/workflow\/cycle/);

    const wf = workflow([node('a')], []);
    try {
      executeWorkflow({
        workflow: wf,
        runId: 'r',
        projectRevision: 'rev-1',
        workflowInputs: null,
        handlers: {},
      });
      expect.unreachable('missing handler must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowEngineError);
      expect((error as WorkflowEngineError).code).toBe('workflow/missing-handler');
    }
  });

  it('round-trips checkpoints through JSON serialization', () => {
    const wf = workflow([node('a'), node('b')], [{ from: 'a', to: 'b' }]);
    let bWorks = false;
    const handlers: Record<string, NodeHandler> = {
      't.a': ok(() => 'a-out'),
      't.b': () =>
        bWorks
          ? { ok: true, output: 'b-out' }
          : { ok: false, failureCode: 'later', retryable: false },
    };
    const first = executeWorkflow({
      workflow: wf,
      runId: 'r',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
    });
    const revived = JSON.parse(JSON.stringify(first.checkpoint)) as RunCheckpoint;
    bWorks = true;
    const resumed = executeWorkflow({
      workflow: wf,
      runId: 'r',
      projectRevision: 'rev-1',
      workflowInputs: null,
      handlers,
      resumeFrom: revived,
    });
    expect(resumed.checkpoint.state).toBe('succeeded');
    expect(resumed.reusedNodeIds).toEqual(['a']);
  });
});
