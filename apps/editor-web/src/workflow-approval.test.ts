import { describe, expect, it } from 'vitest';
import type { HumanInputRequest } from '@joy-media/workflow-engine';
import {
  humanInputsForApproval,
  parametersFromSchema,
  summarizeWorkflowOutcome,
} from './WorkflowsPanel.js';

describe('humanInputsForApproval', () => {
  it('preserves the workflow field for speaker candidate approvals', () => {
    const request = {
      kind: 'choose-candidates',
      prompt: 'Confirm speakers',
      payload: { speakers: [{ id: 'spk-1' }, { id: 'spk-2' }] },
    } as HumanInputRequest;
    expect(humanInputsForApproval(request, 'confirm-speakers', new Set(['spk-1']))).toEqual({
      'confirm-speakers': { speakers: [{ id: 'spk-1' }] },
    });
  });

  it('passes approved silence ranges to the trim node', () => {
    const ranges = [{ startUs: 10, endUs: 20 }];
    const request = {
      kind: 'accept-edit-diff',
      prompt: 'Approve edits',
      payload: { ranges },
    } as HumanInputRequest;
    expect(humanInputsForApproval(request, 'approve-edit-list', new Set())).toEqual({
      'approve-edit-list': { ranges },
    });
  });

  it('uses render items for render approvals', () => {
    const items = [{ id: 'draft-1' }];
    const request = {
      kind: 'approve-render',
      prompt: 'Approve render',
      payload: { items },
    } as HumanInputRequest;
    expect(humanInputsForApproval(request, 'approve-drafts', new Set())).toEqual({
      'approve-drafts': { approved: items },
    });
  });
});

describe('parametersFromSchema', () => {
  it('does not prefill first-party asset inputs with the demo fixture id', () => {
    expect(
      parametersFromSchema(
        {
          type: 'object',
          required: ['asset'],
          properties: {
            asset: { type: 'object', description: 'Opaque source video asset reference.' },
          },
        },
        undefined,
      ),
    ).toEqual([
      {
        name: 'assetId',
        type: 'string',
        description: 'Opaque source video asset reference.',
        default: undefined,
      },
    ]);
  });
});

describe('summarizeWorkflowOutcome', () => {
  it('does not promise reload recovery when browser storage rejected the checkpoint', () => {
    expect(
      summarizeWorkflowOutcome({
        status: 'waiting_for_input',
        workflowId: 'workflow',
        runId: 'run',
        nodeId: 'approval',
        request: { kind: 'approve-render', prompt: 'Review' },
        checkpoint: {
          checkpointVersion: 1,
          runId: 'run',
          workflowId: 'workflow',
          workflowVersion: '1',
          projectRevision: 'revision',
          state: 'waiting_for_input',
          nodes: {},
        },
        recovery: 'session-only',
      }),
    ).toContain('this approval may be lost on reload');
  });
  it('marks deferred workflow outputs as not yet finished', () => {
    expect(
      summarizeWorkflowOutcome({
        status: 'succeeded',
        workflowId: 'joy.first-party.long-video-draft-reels',
        runId: 'run-1',
        outputs: {
          deferred: true,
          reason: 'Use Export',
        },
      }),
    ).toBe(
      'Workflow joy.first-party.long-video-draft-reels completed with deferred outputs. Inspect the result before treating it as finished.',
    );
  });

  it('marks fixture-backed workflow outputs as not yet finished', () => {
    expect(
      summarizeWorkflowOutcome({
        status: 'succeeded',
        workflowId: 'joy.first-party.podcast-cleanup',
        runId: 'run-2',
        outputs: {
          method: 'fixture',
          note: 'Fixture transcript',
        },
      }),
    ).toBe(
      'Workflow joy.first-party.podcast-cleanup completed with fixture-backed outputs. Inspect the result before treating it as finished.',
    );
  });

  it('detects deferred signals nested inside manifest outputs', () => {
    expect(
      summarizeWorkflowOutcome({
        status: 'succeeded',
        workflowId: 'joy.first-party.multilingual-promo',
        runId: 'run-3',
        outputs: {
          metadata: {
            items: [
              {
                deferredEndpoint: '/v1/providers/speech/synthesize',
              },
            ],
          },
        },
      }),
    ).toBe(
      'Workflow joy.first-party.multilingual-promo completed with deferred outputs. Inspect the result before treating it as finished.',
    );
  });

  it('keeps durable recorded workflows marked as finished', () => {
    expect(
      summarizeWorkflowOutcome({
        status: 'succeeded',
        workflowId: 'workflow-recorded-1',
        runId: 'run-4',
        outputs: {
          written: true,
        },
      }),
    ).toBe('Workflow workflow-recorded-1 finished.');
  });
});
