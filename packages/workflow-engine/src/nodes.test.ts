import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION, WORKFLOW_NODE_CATEGORIES } from './definition.js';
import { buildNodeLibrary } from './library.js';
import { NodeRegistryError } from './nodes.js';
import type { NodeHandler } from './runtime.js';
import { executeWorkflow } from './runtime.js';

const wf = (nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[] = []): JoyWorkflow => ({
  formatVersion: WORKFLOW_FORMAT_VERSION,
  id: 'wf-nodes',
  version: '1.0.0',
  name: 'Node library test workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
});

const run = (
  workflow: JoyWorkflow,
  handlers: Readonly<Record<string, NodeHandler>>,
  workflowInputs: unknown = null,
) =>
  executeWorkflow({
    workflow,
    runId: 'run-nodes',
    projectRevision: 'rev-1',
    workflowInputs,
    handlers,
  });

describe('NodeRegistry', () => {
  it('covers every §23.2 category with at least one v1 node type', () => {
    const { registry } = buildNodeLibrary();
    for (const category of WORKFLOW_NODE_CATEGORIES) {
      expect(
        registry.listByCategory(category).length,
        `category "${category}" must have at least one node type`,
      ).toBeGreaterThan(0);
    }
  });

  it('createNode fills category and determinism from the spec and validates params', () => {
    const { registry } = buildNodeLibrary();
    const node = registry.createNode('a1', 'input.asset', { assetId: 'asset-1' });
    expect(node).toMatchObject({
      id: 'a1',
      category: 'input',
      type: 'input.asset',
      deterministic: true,
    });

    expect(() => registry.createNode('a2', 'input.asset', {})).toThrowError(NodeRegistryError);
    expect(() => registry.createNode('a3', 'no.such-type', {})).toThrowError(
      /node-library\/unknown-type|not registered/,
    );
  });

  it('rejects declaring a generation node deterministic (§23.5)', () => {
    const { registry } = buildNodeLibrary();
    expect(() =>
      registry.createNode('g1', 'generation.image', { prompt: 'sunrise' }, { deterministic: true }),
    ).toThrow(/§23\.5|deterministic/);
  });

  it('validateWorkflowNodes flags unknown types, category mismatch, and bad params', () => {
    const { registry } = buildNodeLibrary();
    const workflow = wf([
      { id: 'u', category: 'input', type: 'no.such-type', params: {}, deterministic: true },
      {
        id: 'm',
        category: 'analysis', // wrong: input.asset is an input node
        type: 'input.asset',
        params: { assetId: 'asset-1' },
        deterministic: true,
      },
      { id: 'p', category: 'input', type: 'input.asset', params: {}, deterministic: true },
      {
        id: 'g',
        category: 'generation',
        type: 'generation.image',
        params: { prompt: 'x' },
        deterministic: true, // wrong: generation cannot be deterministic
      },
    ]);
    const issues = registry.validateWorkflowNodes(workflow);
    const codes = issues.map((issue) => issue.code).sort();
    expect(codes).toEqual([
      'node-library/category-mismatch',
      'node-library/determinism-mismatch',
      'node-library/invalid-params',
      'node-library/unknown-type',
    ]);
  });
});

describe('pure nodes', () => {
  it('input.value / input.item / input.rows produce their configured payloads', () => {
    const { registry, handlers } = buildNodeLibrary();
    const workflow = wf([
      registry.createNode('v', 'input.value', { value: { title: 'JOY' } }),
      registry.createNode('i', 'input.item', { path: 'row.name' }),
      registry.createNode('r', 'input.rows', { rows: [1, 2, 3] }),
    ]);
    const result = run(workflow, handlers, { row: { name: 'menu-item' } });
    expect(result.checkpoint.state).toBe('succeeded');
    expect(result.checkpoint.nodes['v']?.output).toEqual({ title: 'JOY' });
    expect(result.checkpoint.nodes['i']?.output).toBe('menu-item');
    expect(result.checkpoint.nodes['r']?.output).toEqual([1, 2, 3]);
  });

  it('control.delay and control.checkpoint pass their upstream through', () => {
    const { registry, handlers } = buildNodeLibrary();
    const workflow = wf(
      [
        registry.createNode('v', 'input.value', { value: 'payload' }),
        registry.createNode('d', 'control.delay', { delayMs: 250 }),
        registry.createNode('c', 'control.checkpoint', {}),
      ],
      [
        { from: 'v', to: 'd' },
        { from: 'd', to: 'c' },
      ],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['d']?.output).toEqual({ delayMs: 250, passthrough: 'payload' });
    expect(result.checkpoint.nodes['c']?.output).toEqual({
      passthrough: { delayMs: 250, passthrough: 'payload' },
    });
  });
});

describe('decision.condition', () => {
  const conditionRun = (condition: unknown, workflowInputs: unknown) => {
    const { registry, handlers } = buildNodeLibrary();
    const workflow = wf(
      [
        registry.createNode('v', 'input.value', { value: { score: 10, tag: 'reel' } }),
        registry.createNode('cond', 'decision.condition', { condition }),
      ],
      [{ from: 'v', to: 'cond' }],
    );
    return run(workflow, handlers, workflowInputs);
  };

  it('evaluates comparison, boolean, and defined operators over refs', () => {
    const passed = conditionRun(
      {
        op: 'and',
        conditions: [
          {
            op: 'gte',
            left: { kind: 'upstream', node: 'v', path: 'score' },
            right: { kind: 'literal', value: 5 },
          },
          {
            op: 'eq',
            left: { kind: 'upstream', node: 'v', path: 'tag' },
            right: { kind: 'input', path: 'wanted' },
          },
          { op: 'not', condition: { op: 'defined', value: { kind: 'input', path: 'missing' } } },
          {
            op: 'or',
            conditions: [
              {
                op: 'lt',
                left: { kind: 'literal', value: 'a' },
                right: { kind: 'literal', value: 'b' },
              },
              {
                op: 'neq',
                left: { kind: 'literal', value: 1 },
                right: { kind: 'literal', value: 1 },
              },
            ],
          },
        ],
      },
      { wanted: 'reel' },
    );
    expect(passed.checkpoint.nodes['cond']?.output).toEqual({ passed: true });

    const failed = conditionRun(
      {
        op: 'eq',
        left: { kind: 'upstream', node: 'v', path: 'tag' },
        right: { kind: 'literal', value: 'promo' },
      },
      null,
    );
    expect(failed.checkpoint.nodes['cond']?.output).toEqual({ passed: false });
  });

  it('deep-equals arrays and objects for eq', () => {
    const result = conditionRun(
      {
        op: 'eq',
        left: { kind: 'literal', value: { a: [1, 2], b: 'x' } },
        right: { kind: 'literal', value: { b: 'x', a: [1, 2] } },
      },
      null,
    );
    expect(result.checkpoint.nodes['cond']?.output).toEqual({ passed: true });
  });

  it('fails with a coded, non-retryable error on comparison type mismatches', () => {
    const result = conditionRun(
      {
        op: 'lt',
        left: { kind: 'literal', value: 'text' },
        right: { kind: 'literal', value: 3 },
      },
      null,
    );
    expect(result.checkpoint.state).toBe('failed');
    expect(result.checkpoint.nodes['cond']).toMatchObject({
      state: 'failed',
      attempts: 1,
      failureCode: 'workflow/condition-type-error',
    });
  });

  it('rejects malformed conditions at authoring time', () => {
    const { registry } = buildNodeLibrary();
    expect(() =>
      registry.createNode('c', 'decision.condition', { condition: { op: 'between' } }),
    ).toThrowError(NodeRegistryError);
  });
});

describe('port-backed nodes', () => {
  it('fails non-retryably with a coded error when the port is not provided', () => {
    const { registry, handlers } = buildNodeLibrary(); // no ports at all
    const workflow = wf(
      [
        registry.createNode('a', 'input.asset', { assetId: 'asset-1' }),
        registry.createNode('t', 'analysis.transcribe', { language: 'fa' }),
      ],
      [{ from: 'a', to: 't' }],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['t']).toMatchObject({
      state: 'failed',
      attempts: 1, // non-retryable: one attempt even under retry policies
      failureCode: 'workflow/port-unavailable:analysis.transcribe',
    });
  });

  it('adapts ports into node outputs and classifies thrown port errors as retryable', () => {
    let attempts = 0;
    const { registry, handlers } = buildNodeLibrary({
      ports: {
        analysis: {
          transcribe: ({ source, language }) => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error('transient adapter failure');
            }
            return { text: 'salaam', language, source };
          },
        },
      },
    });
    const workflow = wf(
      [
        registry.createNode('a', 'input.asset', { assetId: 'asset-1' }),
        registry.createNode(
          't',
          'analysis.transcribe',
          { language: 'fa' },
          {
            retry: { maxAttempts: 2, backoffMs: 0 },
          },
        ),
      ],
      [{ from: 'a', to: 't' }],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['t']).toMatchObject({ state: 'succeeded', attempts: 2 });
    expect(result.checkpoint.nodes['t']?.output).toEqual({
      text: 'salaam',
      language: 'fa',
      source: { assetId: 'asset-1' },
    });
  });

  it('editor.commandTransaction resolves commands from upstream and returns the transaction id', () => {
    const executed: unknown[] = [];
    const { registry, handlers } = buildNodeLibrary({
      ports: {
        editor: {
          executeCommandTransaction: ({ label, commands }) => {
            executed.push({ label, commands });
            return { transactionId: 'txn-1' };
          },
        },
      },
    });
    const workflow = wf(
      [
        registry.createNode('plan', 'input.value', {
          value: [{ type: 'timeline.insertClip' }, { type: 'audioClip.setGain' }],
        }),
        registry.createNode('edit', 'editor.commandTransaction', {
          label: 'workflow: apply edits',
          commandsFrom: { kind: 'upstream', node: 'plan' },
        }),
      ],
      [{ from: 'plan', to: 'edit' }],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['edit']?.output).toEqual({ transactionId: 'txn-1' });
    expect(executed).toEqual([
      {
        label: 'workflow: apply edits',
        commands: [{ type: 'timeline.insertClip' }, { type: 'audioClip.setGain' }],
      },
    ]);
  });

  it('render nodes pass mode and profile through the render port', () => {
    const calls: unknown[] = [];
    const { registry, handlers } = buildNodeLibrary({
      ports: {
        render: {
          render: (args) => {
            calls.push(args);
            return { artifactId: `${args.mode}-artifact` };
          },
        },
      },
    });
    const workflow = wf(
      [
        registry.createNode('p', 'input.project', { projectId: 'proj-1' }),
        registry.createNode('rp', 'render.preview', { profile: 'proxy-540p' }),
        registry.createNode('rf', 'render.final', {
          source: { kind: 'upstream', node: 'p' },
        }),
      ],
      [
        { from: 'p', to: 'rp' },
        { from: 'p', to: 'rf' },
      ],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['rp']?.output).toEqual({ artifactId: 'preview-artifact' });
    expect(result.checkpoint.nodes['rf']?.output).toEqual({ artifactId: 'final-artifact' });
    expect(calls).toEqual([
      {
        mode: 'preview',
        source: { projectId: 'proj-1', revision: 'rev-1' },
        profile: 'proxy-540p',
      },
      { mode: 'final', source: { projectId: 'proj-1', revision: 'rev-1' } },
    ]);
  });

  it('requires an explicit source ref when a node has multiple upstream parents', () => {
    const { registry, handlers } = buildNodeLibrary({
      ports: { analysis: { measureLoudness: ({ source }) => ({ lufs: -14, source }) } },
    });
    const workflow = wf(
      [
        registry.createNode('a', 'input.asset', { assetId: 'asset-1' }),
        registry.createNode('b', 'input.asset', { assetId: 'asset-2' }),
        registry.createNode('l', 'analysis.loudness', {}),
      ],
      [
        { from: 'a', to: 'l' },
        { from: 'b', to: 'l' },
      ],
    );
    const result = run(workflow, handlers);
    expect(result.checkpoint.nodes['l']).toMatchObject({
      state: 'failed',
      failureCode: 'workflow/ambiguous-source',
    });
  });
});
