import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HumanInputRequest } from '@joy-media/workflow-engine';
import {
  ContactSheetApproval,
  contactSheetApprovalDecisionFor,
  contactSheetApprovalItemsFor,
  contactSheetResponseIdFor,
  initialContactSheetSelectedKeys,
  nextContactSheetActiveIndex,
  readContactSheetPersistedState,
  toggleContactSheetSelection,
} from './ContactSheetApproval.js';

describe('ContactSheetApproval', () => {
  it('renders thumbnail-backed candidates with extracted time ranges and selection count', () => {
    const request = chooseCandidatesRequest();
    const items = contactSheetApprovalItemsFor(request);
    const markup = renderToStaticMarkup(
      <ContactSheetApproval request={request} onSubmit={() => undefined} />,
    );

    expect(items.slice(0, 2)).toMatchObject([
      {
        key: 'candidate-a',
        title: 'Hook A',
        assetId: 'asset-a',
        thumbnailRef: 'thumb-a.jpg',
        startUs: 1_000_000,
        endUs: 3_500_000,
      },
      {
        key: 'candidate-b',
        title: 'Hook B',
        assetId: 'asset-b',
        thumbnailRef: 'thumb-b.jpg',
        startUs: 4_000_000,
        endUs: 5_500_000,
      },
    ]);
    expect(markup).toContain('Choose your hook shots');
    expect(markup).toContain('2 of 3 selected');
    expect(markup).toContain('thumb-a.jpg');
    expect(markup).toContain('0:01-0:04');
    expect(markup).toContain('0:04-0:06');
  });

  it('renders approve-render reviews with compare affordance and diff-backed items', () => {
    const request: HumanInputRequest = {
      kind: 'approve-render',
      prompt: 'Review final render candidates',
      payload: {
        items: [
          {
            id: 'render-a',
            title: 'Render A',
            assetId: 'render-asset-a',
            thumbnailRef: 'render-a.jpg',
            startUs: 12_000_000,
            endUs: 14_500_000,
            diff: { changedPixels: 42 },
          },
        ],
      },
    };

    const items = contactSheetApprovalItemsFor(request);
    const markup = renderToStaticMarkup(
      <ContactSheetApproval request={request} onSubmit={() => undefined} />,
    );

    expect(items[0]?.diff).toEqual({ changedPixels: 42 });
    expect(markup).toContain('Compare');
    expect(markup).toContain('Review final render candidates');
    expect(markup).toContain('render-a.jpg');
    expect(markup).toContain('0:12-0:15');
  });

  it('defaults selections from response data and persisted reload state', () => {
    const request = chooseCandidatesRequest();
    const items = contactSheetApprovalItemsFor(request);
    const responseSelected = initialContactSheetSelectedKeys(
      request,
      items,
      { candidates: [rawCandidate('candidate-c', 'Hook C', 7_000_000, 8_000_000)] },
      undefined,
    );
    expect(responseSelected).toEqual(['candidate-c']);

    const storage = memoryStorage({
      'joy-media.contact-sheet-approval:approval-1': JSON.stringify({
        selectedKeys: ['candidate-b'],
        activeIndex: 1,
        compareKey: 'candidate-c',
        rejectionReason: 'Need safer opening',
      }),
    });
    expect(readContactSheetPersistedState(storage, 'approval-1')).toEqual({
      selectedKeys: ['candidate-b'],
      activeIndex: 1,
      compareKey: 'candidate-c',
      rejectionReason: 'Need safer opening',
    });
    expect(
      initialContactSheetSelectedKeys(request, items, undefined, {
        selectedKeys: ['candidate-b'],
      }),
    ).toEqual(['candidate-b']);
  });

  it('validates approve-none and reject-without-reason decisions', () => {
    expect(
      contactSheetApprovalDecisionFor('approve', {
        kind: 'choose-candidates',
        approvalId: 'approval-1',
        selectedItems: [],
      }),
    ).toEqual({
      ok: false,
      validation: 'Select at least one item to approve, or reject with a reason.',
    });

    expect(
      contactSheetApprovalDecisionFor('reject', {
        kind: 'choose-candidates',
        approvalId: 'approval-1',
        selectedItems: [],
        rejectionReason: '   ',
      }),
    ).toEqual({
      ok: false,
      validation: 'Add a rejection reason before rejecting.',
    });
  });

  it('allows non-visual approvals to approve with no selected items', () => {
    expect(
      contactSheetApprovalDecisionFor('approve', {
        kind: 'confirm-cost',
        approvalId: 'approval-2',
        selectedItems: [],
      }),
    ).toEqual({
      ok: true,
      decision: {
        approved: true,
        response: { approved: true },
        responseId: contactSheetResponseIdFor('approval-2', { approved: true }),
      },
    });
  });

  it('binds response ids to exact approved and rejected payloads', () => {
    const selectedItems = contactSheetApprovalItemsFor(chooseCandidatesRequest()).slice(0, 2);
    const approved = contactSheetApprovalDecisionFor('approve', {
      kind: 'choose-candidates',
      approvalId: 'approval-42',
      selectedItems,
    });
    expect(approved).toMatchObject({
      ok: true,
      decision: {
        approved: true,
        response: { candidates: selectedItems.map((item) => item.raw) },
      },
    });
    if (!approved.ok) expect.unreachable('approved decision should succeed');
    expect(approved.decision.responseId).toBe(
      contactSheetResponseIdFor('approval-42', approved.decision.response),
    );

    const rejected = contactSheetApprovalDecisionFor('reject', {
      kind: 'approve-render',
      approvalId: 'approval-42',
      selectedItems: selectedItems.slice(0, 1),
      rejectionReason: 'Timing still feels abrupt',
    });
    expect(rejected).toMatchObject({
      ok: true,
      decision: {
        approved: false,
        rejectionReason: 'Timing still feels abrupt',
        response: {
          approved: false,
          rejected: true,
          rejectionReason: 'Timing still feels abrupt',
          selectedRefs: [
            {
              key: 'candidate-a',
              title: 'Hook A',
              assetId: 'asset-a',
              thumbnailRef: 'thumb-a.jpg',
              startUs: 1_000_000,
              endUs: 3_500_000,
            },
          ],
        },
      },
    });
    if (!rejected.ok) expect.unreachable('rejected decision should succeed');
    expect(rejected.decision.responseId).toBe(
      contactSheetResponseIdFor('approval-42', rejected.decision.response),
    );
  });

  it('supports keyboard-style active-index movement and selection toggles', () => {
    expect(nextContactSheetActiveIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextContactSheetActiveIndex('ArrowDown', 1, 3)).toBe(2);
    expect(nextContactSheetActiveIndex('End', 0, 3)).toBe(2);
    expect(nextContactSheetActiveIndex('ArrowLeft', 0, 3)).toBe(0);
    expect(nextContactSheetActiveIndex('Home', 2, 3)).toBe(0);
    expect(toggleContactSheetSelection(['candidate-a'], 'candidate-b')).toEqual([
      'candidate-a',
      'candidate-b',
    ]);
    expect(toggleContactSheetSelection(['candidate-a', 'candidate-b'], 'candidate-a')).toEqual([
      'candidate-b',
    ]);
  });
});

function chooseCandidatesRequest(): HumanInputRequest {
  return {
    kind: 'choose-candidates',
    prompt: 'Choose your hook shots',
    payload: {
      candidates: [
        rawCandidate('candidate-a', 'Hook A', 1_000_000, 3_500_000),
        rawCandidate('candidate-b', 'Hook B', 4_000_000, 5_500_000),
        rawCandidate('candidate-c', 'Hook C', 7_000_000, 8_000_000),
      ],
    },
  };
}

function rawCandidate(id: string, title: string, startUs: number, endUs: number) {
  return {
    id,
    title,
    assetId: id.replace('candidate', 'asset'),
    thumbnailRef: id.replace('candidate', 'thumb') + '.jpg',
    startUs,
    endUs,
  };
}

function memoryStorage(seed: Record<string, string>): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
