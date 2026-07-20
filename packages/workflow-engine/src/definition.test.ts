import { describe, expect, it } from 'vitest';

import type { JoyWorkflow, WorkflowEdge, WorkflowNode } from './definition.js';
import { WORKFLOW_FORMAT_VERSION, upstreamOf, validateWorkflow } from './definition.js';

const node = (id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  category: 'transform',
  type: `transform.${id}`,
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
  id: 'wf-test',
  version: '1.0.0',
  name: 'Test workflow',
  inputs: {},
  outputs: {},
  nodes,
  edges,
  permissions: [],
  policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  ...overrides,
});

describe('validateWorkflow', () => {
  it('accepts a valid DAG and returns a deterministic definition-order topological order', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c'), node('d')],
      [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    );
    const result = validateWorkflow(wf);
    expect(result).toEqual({ ok: true, order: ['a', 'b', 'c', 'd'] });
    // Same graph, same order — repeat to prove determinism.
    expect(validateWorkflow(wf)).toEqual(result);
  });

  it('rejects cycles with a coded issue naming the stuck nodes', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'b' },
      ],
    );
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe('workflow/cycle');
      expect(result.issues[0]?.message).toContain('b');
      expect(result.issues[0]?.message).toContain('c');
    }
  });

  it('rejects unsupported format versions', () => {
    const wf = workflow([node('a')], []);
    const broken = { ...wf, formatVersion: 2 } as unknown as JoyWorkflow;
    const result = validateWorkflow(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('workflow/unsupported-format-version');
    }
  });

  it('rejects duplicate node ids, self-edges, duplicate edges, and unknown endpoints', () => {
    const wf = workflow(
      [node('a'), node('a'), node('b')],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'b' },
        { from: 'ghost', to: 'a' },
      ],
    );
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('workflow/duplicate-node-id');
      expect(codes).toContain('workflow/duplicate-edge');
      expect(codes).toContain('workflow/self-edge');
      expect(codes).toContain('workflow/unknown-edge-endpoint');
    }
  });

  it('rejects invalid policy and retry values', () => {
    const wf = workflow([node('a', { retry: { maxAttempts: 0, backoffMs: -1 } })], [], {
      policy: {
        concurrency: 0,
        failure: 'stop',
        defaultRetry: { maxAttempts: 1.5, backoffMs: 0 },
      },
    });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('workflow/invalid-policy');
      expect(codes.filter((c) => c === 'workflow/invalid-retry')).toHaveLength(2);
    }
  });

  it('rejects empty identity, node ids, and node types', () => {
    const wf = workflow([node(''), node('b', { type: ' ' })], [], { name: '' });
    const result = validateWorkflow(wf);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((i) => i.code);
      expect(codes).toContain('workflow/empty-identity');
      expect(codes).toContain('workflow/empty-node-id');
      expect(codes).toContain('workflow/empty-node-type');
    }
  });
});

describe('upstreamOf', () => {
  it('maps each node to its direct upstream ids in definition order', () => {
    const wf = workflow(
      [node('a'), node('b'), node('c')],
      [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
      ],
    );
    const map = upstreamOf(wf);
    expect(map.get('a')).toEqual([]);
    expect(map.get('c')).toEqual(['a', 'b']);
  });
});
