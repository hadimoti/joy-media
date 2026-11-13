// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeInspectorTabRequest,
  InspectorPanel,
  type InspectorTabRequest,
} from './InspectorPanel.js';

// Stands in for App: App owns the pending request and the Inspector clears it through
// the callback. `open` mounts and unmounts the panel, like a view switch or a reopened panel.
interface HostProps {
  readonly open: boolean;
  readonly initialRequest: InspectorTabRequest | null;
  readonly applied: number[];
}

function Host({ open, initialRequest, applied }: HostProps) {
  const [request, setRequest] = useState<InspectorTabRequest | null>(initialRequest);
  if (!open) return null;
  return (
    <InspectorPanel
      object={undefined}
      selectedClipId="clip-video-1"
      clipSpeed={{ rate: 1, supportsReverse: true }}
      onSpeedChange={() => undefined}
      allObjects={{}}
      playheadUs={0}
      onSetStatic={() => undefined}
      onDispatch={() => undefined}
      tabRequest={request}
      onTabRequestApplied={(serial) => {
        applied.push(serial);
        setRequest((current) => consumeInspectorTabRequest(current, serial));
      }}
    />
  );
}

describe('consumeInspectorTabRequest', () => {
  const speed: InspectorTabRequest = { tab: 'speed', serial: 2 };

  it('clears the request that was applied', () => {
    expect(consumeInspectorTabRequest(speed, 2)).toBeNull();
  });

  it('keeps a newer request that arrived before the older one was applied', () => {
    expect(consumeInspectorTabRequest({ tab: 'speed', serial: 3 }, 2)).toEqual({
      tab: 'speed',
      serial: 3,
    });
  });

  it('leaves an empty request empty', () => {
    expect(consumeInspectorTabRequest(null, 2)).toBeNull();
  });
});

describe('Inspector tabRequest (Clip > Speed)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(props: HostProps): Promise<void> {
    await act(async () => root.render(<Host {...props} />));
  }

  function selectedTab(): string | null {
    return (
      container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.textContent ??
      null
    );
  }

  function tabButton(label: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent?.trim() === label,
    );
    if (found === undefined) throw new Error(`missing tab ${label}`);
    return found;
  }

  it('shows the Speed tab for the request and reports it applied exactly once', async () => {
    const applied: number[] = [];
    await render({ open: true, initialRequest: { tab: 'speed', serial: 1 }, applied });

    expect(selectedTab()).toBe('Speed');
    expect(applied).toEqual([1]);
  });

  it('does not show the requested tab again after the user moves on and the panel remounts', async () => {
    const applied: number[] = [];
    await render({ open: true, initialRequest: { tab: 'speed', serial: 1 }, applied });
    expect(selectedTab()).toBe('Speed');

    await act(async () => tabButton('Visual').click());
    expect(selectedTab()).toBe('Visual');

    // Panel closed, then reopened: the request was cleared when it was applied.
    await render({ open: false, initialRequest: null, applied });
    await render({ open: true, initialRequest: null, applied });

    expect(selectedTab()).toBe('Visual');
    expect(applied).toEqual([1]);
  });

  it('does not re-apply the same request when the panel is re-rendered', async () => {
    const applied: number[] = [];
    await render({ open: true, initialRequest: { tab: 'speed', serial: 4 }, applied });
    await act(async () => tabButton('Visual').click());

    // Same host, same request: a re-render alone must not switch the tab back.
    await render({ open: true, initialRequest: null, applied });

    expect(selectedTab()).toBe('Visual');
    expect(applied).toEqual([4]);
  });
});
