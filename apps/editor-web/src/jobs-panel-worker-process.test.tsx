// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import { JobsPanel } from './JobsPanel.js';

describe('JobsPanel: the desktop Worker process', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    delete window.joyDesktop;
    vi.restoreAllMocks();
  });

  async function renderPanel(): Promise<HTMLDivElement> {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(JobsPanel, { projectId: 'project-a', projectTitle: 'Project' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  function mockControlPlane(): void {
    vi.spyOn(BrowserControlPlaneClient.prototype, 'workers').mockResolvedValue([]);
    vi.spyOn(BrowserControlPlaneClient.prototype, 'ensureProject').mockResolvedValue();
    vi.spyOn(BrowserControlPlaneClient.prototype, 'jobs').mockResolvedValue([]);
  }

  it('shows no desktop Worker row in a browser, where there is no desktop host', async () => {
    mockControlPlane();
    const panel = await renderPanel();

    expect(panel.querySelector('.jobs-worker-process')).toBeNull();
  });

  it('shows a stopped Worker with its reason, and starts it again on Retry', async () => {
    mockControlPlane();
    const invoke = vi.fn(async (channel: string) =>
      channel === 'desktop.worker-retry'
        ? { connection: 'online', capabilities: [], workerId: 'worker-2' }
        : {
            connection: 'degraded',
            capabilities: [],
            lastError: 'Worker exited with code 137',
          },
    );
    window.joyDesktop = { channels: ['desktop.worker-status', 'desktop.worker-retry'], invoke };
    const panel = await renderPanel();

    const row = panel.querySelector<HTMLElement>('.jobs-worker-process');
    expect(row?.textContent).toContain('stopped');
    expect(row?.textContent).toContain('Worker exited with code 137');

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[aria-label="Retry local Worker"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(invoke).toHaveBeenCalledWith('desktop.worker-retry');
    expect(panel.querySelector('.jobs-worker-process')?.textContent).toContain('running');
    expect(panel.querySelector('[aria-label="Retry local Worker"]')).toBeNull();
  });
});
