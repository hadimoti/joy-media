// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMonitorSceneSyncEffect } from './monitor-scene-sync.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(async () => {
  const entries = mounted.splice(0);
  await act(async () => {
    for (const { root } of entries) root.unmount();
  });
  for (const { container } of entries) container.remove();
  vi.restoreAllMocks();
});

describe('useMonitorSceneSyncEffect', () => {
  it('does not self-trigger when an immediately-resolving no-target sync requests a repaint', async () => {
    const sync = vi.fn(async () => true);
    const view = mount(<Harness input={0} sync={sync} />);

    await act(async () => {
      await settleEffects();
    });

    expect(sync).toHaveBeenCalledOnce();
    expect(view.container.textContent).toBe('0:1');
  });

  it('reruns when a real scene input changes', async () => {
    const sync = vi.fn(async () => true);
    const view = mount(<Harness input={0} sync={sync} />);
    await act(async () => {
      await settleEffects();
    });

    await act(async () => {
      view.root.render(<Harness input={1} sync={sync} />);
      await settleEffects();
    });

    expect(sync).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toBe('1:2');
  });
});

function Harness({ input, sync }: { input: number; sync: () => Promise<boolean> }) {
  const [repaints, setRepaints] = useState(0);
  useMonitorSceneSyncEffect({
    dependencies: [input],
    sync,
    onComplete: () => setRepaints((value) => value + 1),
  });
  return (
    <output>
      {input}:{repaints}
    </output>
  );
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(element));
  return { root, container };
}

async function settleEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
