import { describe, expect, it } from 'vitest';

import type { JoyWorkflow } from './definition.js';
import { WORKFLOW_FORMAT_VERSION } from './definition.js';
import { buildNodeLibrary } from './library.js';
import type { NodeHandler, RunCheckpoint } from './runtime.js';
import { executeWorkflow } from './runtime.js';

/**
 * §23.6 human-in-the-loop: approval nodes park the run as `waiting_for_input`
 * without holding Worker resources; resume with responses finishes the run
 * without duplicating completed work.
 */

const approvalWorkflow = (): { workflow: JoyWorkflow; handlers: Record<string, NodeHandler> } => {
  const { registry, handlers } = buildNodeLibrary({
    ports: {
      render: { render: ({ mode }) => ({ artifactId: `${mode}-artifact` }) },
    },
  });
  const workflow: JoyWorkflow = {
    formatVersion: WORKFLOW_FORMAT_VERSION,
    id: 'wf-approval',
    version: '1.0.0',
    name: 'Approval workflow',
    inputs: {},
    outputs: {},
    nodes: [
      registry.createNode('candidates', 'input.value', {
        value: [{ id: 'hook-1' }, { id: 'hook-2' }],
      }),
      registry.createNode('approve', 'decision.approval', {
        kind: 'choose-candidates',
        prompt: 'Pick the hook candidates to produce.',
        payloadFrom: { kind: 'upstream', node: 'candidates' },
      }),
      registry.createNode('project', 'input.project', { projectId: 'proj-1' }),
      registry.createNode('final', 'render.final', {
        source: { kind: 'upstream', node: 'approve' },
      }),
      // Independent branch: must keep running while the approval waits.
      registry.createNode('preview', 'render.preview', {
        source: { kind: 'upstream', node: 'project' },
      }),
    ],
    edges: [
      { from: 'candidates', to: 'approve' },
      { from: 'approve', to: 'final' },
      { from: 'project', to: 'preview' },
    ],
    permissions: [],
    policy: { concurrency: 1, failure: 'stop', defaultRetry: { maxAttempts: 1, backoffMs: 0 } },
  };
  return { workflow, handlers: { ...handlers } };
};

const baseOptions = (workflow: JoyWorkflow, handlers: Record<string, NodeHandler>) => ({
  workflow,
  runId: 'run-approval',
  projectRevision: 'rev-1',
  workflowInputs: null,
  handlers,
});

describe('§23.6 approval nodes', () => {
  it('parks as waiting_for_input, keeps independent branches running, and returns', () => {
    const { workflow, handlers } = approvalWorkflow();
    const result = executeWorkflow(baseOptions(workflow, handlers));

    expect(result.checkpoint.state).toBe('waiting_for_input');
    expect(result.checkpoint.nodes['approve']).toMatchObject({
      state: 'waiting_for_input',
      pendingRequest: {
        kind: 'choose-candidates',
        prompt: 'Pick the hook candidates to produce.',
        payload: [{ id: 'hook-1' }, { id: 'hook-2' }],
      },
    });
    // Dependent of the parked node stays pending (not skipped, not failed).
    expect(result.checkpoint.nodes['final']?.state).toBe('pending');
    // The independent branch was not blocked by the wait — no resources held hostage.
    expect(result.checkpoint.nodes['preview']).toMatchObject({
      state: 'succeeded',
      output: { artifactId: 'preview-artifact' },
    });
  });

  it('round-trips the parked checkpoint (with pendingRequest) through JSON', () => {
    const { workflow, handlers } = approvalWorkflow();
    const parked = executeWorkflow(baseOptions(workflow, handlers));
    const revived = JSON.parse(JSON.stringify(parked.checkpoint)) as RunCheckpoint;
    expect(revived.nodes['approve']?.pendingRequest?.kind).toBe('choose-candidates');

    const resumed = executeWorkflow({
      ...baseOptions(workflow, handlers),
      resumeFrom: revived,
      humanInputs: { approve: { chosen: ['hook-2'] } },
    });
    expect(resumed.checkpoint.state).toBe('succeeded');
  });

  it('resumes with a human response without duplicating completed work', () => {
    const { workflow, handlers } = approvalWorkflow();
    let candidateRuns = 0;
    const counted: Record<string, NodeHandler> = {
      ...handlers,
      'input.value': (ctx) => {
        candidateRuns += 1;
        const base = handlers['input.value'] as NodeHandler;
        return base(ctx);
      },
    };

    const parked = executeWorkflow(baseOptions(workflow, counted));
    expect(candidateRuns).toBe(1);

    const resumed = executeWorkflow({
      ...baseOptions(workflow, counted),
      resumeFrom: parked.checkpoint,
      humanInputs: { approve: { chosen: ['hook-2'] } },
    });
    expect(resumed.checkpoint.state).toBe('succeeded');
    // Upstream success was reused, the approval resolved, downstream ran.
    expect(resumed.reusedNodeIds).toContain('candidates');
    expect(resumed.reusedNodeIds).toContain('preview');
    expect(resumed.executedNodeIds).toEqual(['approve', 'final']);
    expect(candidateRuns).toBe(1);
    expect(resumed.checkpoint.nodes['approve']).toMatchObject({
      state: 'succeeded',
      output: { response: { chosen: ['hook-2'] } },
      resolvedInput: { chosen: ['hook-2'] },
    });
    expect(resumed.checkpoint.nodes['final']?.output).toEqual({ artifactId: 'final-artifact' });
  });

  it('keeps a recorded decision authoritative on later resumes (no re-asking)', () => {
    const { workflow, handlers } = approvalWorkflow();
    const parked = executeWorkflow(baseOptions(workflow, handlers));
    const resolved = executeWorkflow({
      ...baseOptions(workflow, handlers),
      resumeFrom: parked.checkpoint,
      humanInputs: { approve: { chosen: ['hook-1'] } },
    });
    expect(resolved.checkpoint.state).toBe('succeeded');

    // Resume again with NO humanInputs: the approval must not park or re-run.
    const again = executeWorkflow({
      ...baseOptions(workflow, handlers),
      resumeFrom: resolved.checkpoint,
    });
    expect(again.checkpoint.state).toBe('succeeded');
    expect(again.reusedNodeIds).toContain('approve');
    expect(again.checkpoint.nodes['approve']?.output).toEqual({
      response: { chosen: ['hook-1'] },
    });
  });

  it('re-runs the approval when a new response is supplied on resume', () => {
    const { workflow, handlers } = approvalWorkflow();
    const parked = executeWorkflow(baseOptions(workflow, handlers));
    const first = executeWorkflow({
      ...baseOptions(workflow, handlers),
      resumeFrom: parked.checkpoint,
      humanInputs: { approve: { chosen: ['hook-1'] } },
    });
    const changed = executeWorkflow({
      ...baseOptions(workflow, handlers),
      resumeFrom: first.checkpoint,
      humanInputs: { approve: { chosen: ['hook-2'] } },
    });
    expect(changed.executedNodeIds).toContain('approve');
    expect(changed.checkpoint.nodes['approve']?.output).toEqual({
      response: { chosen: ['hook-2'] },
    });
  });
});
