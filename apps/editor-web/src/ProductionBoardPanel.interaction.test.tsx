// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactStore } from '@joy-media/commands';
import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
import {
  ProductionBoardPanel,
  ProductionBoardPanelView,
  type ProductionBoardRunStore,
} from './ProductionBoardPanel.js';
import { buildProductionBoardModel } from './production-board-model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyArtifacts: ArtifactStore = { artifacts: {}, versions: {} };
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

describe('ProductionBoardPanel keyboard interaction', () => {
  afterEach(async () => {
    const entries = mounted.splice(0);
    await act(async () => {
      for (const { root } of entries) root.unmount();
    });
    for (const { container } of entries) container.remove();
  });

  it('moves the active run with arrows and Home/End while keeping action state truthful', async () => {
    const model = buildProductionBoardModel({
      records: [record('failed', 3), record('running', 2), record('canceled', 1)],
      currentProjectRevision: 'rev-1',
      artifacts: emptyArtifacts,
      dataLanes: [],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(<ProductionBoardPanelView loadState="loaded" model={model} retryAvailable />);
    });

    const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-activedescendant')).toBe('production-run-run-failed');
    expect(action(container, 'Retry')).toBe(true);
    expect(action(container, 'Cancel')).toBe(false);

    await press(listbox, 'ArrowDown');
    expect(listbox.getAttribute('aria-activedescendant')).toBe('production-run-run-running');
    expect(action(container, 'Retry')).toBe(false);
    expect(action(container, 'Cancel')).toBe(true);

    await press(listbox, 'ArrowUp');
    expect(listbox.getAttribute('aria-activedescendant')).toBe('production-run-run-failed');
    await press(listbox, 'End');
    expect(listbox.getAttribute('aria-activedescendant')).toBe('production-run-run-canceled');
    expect(action(container, 'Retry')).toBe(true);
    expect(action(container, 'Cancel')).toBe(false);
    await press(listbox, 'Home');
    expect(listbox.getAttribute('aria-activedescendant')).toBe('production-run-run-failed');
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.id).toBe(
      'production-run-run-failed',
    );
  });

  it('ignores an older load result that resolves after a newer refresh', async () => {
    type Page = { readonly runs: readonly ProductionRunRecordV1[]; readonly nextCursor?: string };
    const requests: Array<{ resolve: (page: Page) => void }> = [];
    const store: ProductionBoardRunStore = {
      list: () =>
        new Promise<Page>((resolve) => {
          requests.push({ resolve });
        }),
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => {
      root.render(
        <ProductionBoardPanel
          store={store}
          authority={{ principalId: 'owner-1', role: 'owner' }}
          currentProjectRevision="rev-1"
          artifacts={emptyArtifacts}
          dataLanes={[]}
        />,
      );
    });
    expect(requests).toHaveLength(1);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Refresh Production Board"]')
        ?.click();
    });
    expect(requests).toHaveLength(2);

    await act(async () => {
      requests[1]?.resolve({ runs: [] });
      await settle();
    });
    expect(container.textContent).toContain('Start a Workflow');

    await act(async () => {
      requests[0]?.resolve({ runs: [record('running', 1)] });
      await settle();
    });
    expect(container.textContent).toContain('Start a Workflow');
    expect(container.querySelector('[role="option"]')).toBeNull();
  });
});

async function press(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function action(container: HTMLElement, label: 'Retry' | 'Cancel'): boolean {
  return !container.querySelector<HTMLButtonElement>(
    `button[aria-label^="${label} production run"]`,
  )?.disabled;
}

function record(
  state: 'failed' | 'running' | 'canceled',
  updatedSeq: number,
): ProductionRunRecordV1 {
  return {
    recordVersion: 1,
    runId: `run-${state}`,
    workflowId: 'joy.workflow.production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state,
    checkpointRevision: 1,
    workflowInputs: { brief: 'make a short' },
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: updatedSeq,
        type: `run.${state}`,
        state,
        checkpointRevision: 1,
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: updatedSeq,
    updatedSeq,
  } as ProductionRunRecordV1;
}
