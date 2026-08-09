import { describe, expect, it } from 'vitest';
import type { HumanInputRequest } from '@joy-media/workflow-engine';
import { humanInputsForApproval } from './WorkflowsPanel.js';

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
