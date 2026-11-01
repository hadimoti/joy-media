// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserControlPlaneClient,
  type BrowserJob,
  type BrowserWorker,
} from './control-plane-client.js';
import { JobsPanel } from './JobsPanel.js';

// jsdom runs transform the module URL to http, so the source is read through Vite instead.
const panelSource = import.meta.glob('./JobsPanel.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
})['./JobsPanel.tsx'] as string;

describe('JobsPanel in the local build', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  async function renderPanel(projectId: string): Promise<HTMLDivElement> {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(JobsPanel, { projectId, projectTitle: 'Project' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  it('registers each project once, then polls its jobs on every refresh', async () => {
    const ensureProject = vi
      .spyOn(BrowserControlPlaneClient.prototype, 'ensureProject')
      .mockResolvedValue();
    const jobs = vi.spyOn(BrowserControlPlaneClient.prototype, 'jobs').mockResolvedValue([]);
    vi.spyOn(BrowserControlPlaneClient.prototype, 'workers').mockResolvedValue([]);
    const panel = await renderPanel('project-a');

    await act(async () => {
      panel.querySelector<HTMLButtonElement>('[aria-label="Refresh jobs"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(ensureProject).toHaveBeenCalledTimes(1);
    expect(ensureProject).toHaveBeenCalledWith('project-a', 'Project');
    expect(jobs.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(jobs.mock.calls.every(([projectId]) => projectId === 'project-a')).toBe(true);
  });

  it('keeps the action feedback that the panel shows across refreshes', () => {
    expect(panelSource).toContain('const [connectionStatus, setConnectionStatus]');
    expect(panelSource).toContain('note={status ?? connectionStatus}');
  });

  it('keeps local Worker status and Queue, and omits pairing and revocation controls', async () => {
    vi.spyOn(BrowserControlPlaneClient.prototype, 'workers').mockResolvedValue([
      worker({ lastSeenAt: Date.now() }),
    ]);
    vi.spyOn(BrowserControlPlaneClient.prototype, 'ensureProject').mockResolvedValue();
    vi.spyOn(BrowserControlPlaneClient.prototype, 'jobs').mockResolvedValue([]);
    const panel = await renderPanel('project-a');

    const tabs = Array.from(panel.querySelectorAll('[role="tab"]')).map((tab) =>
      tab.textContent?.trim(),
    );
    expect(tabs).toEqual(['Workers', 'Queue']);
    expect(panel.querySelector('[aria-label="One-time pairing code"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Revoke Worker worker-1"]')).toBeNull();
    expect(panel.textContent).toContain('worker-1');
    expect(panel.textContent).toContain('connected');
  });

  it('offers no denoise, thumbnail or retry action for a failed render job', async () => {
    vi.spyOn(BrowserControlPlaneClient.prototype, 'workers').mockResolvedValue([]);
    vi.spyOn(BrowserControlPlaneClient.prototype, 'ensureProject').mockResolvedValue();
    const failed: BrowserJob = {
      id: 'job-1',
      projectId: 'project-a',
      type: 'render.export',
      state: 'failed',
      progress: 0,
      cancelRequested: false,
      error: 'render failed',
    };
    vi.spyOn(BrowserControlPlaneClient.prototype, 'jobs').mockResolvedValue([failed]);
    const panel = await renderPanel('project-a');

    const queueTab = Array.from(panel.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (tab) => tab.textContent?.trim() === 'Queue',
    );
    await act(async () => {
      queueTab?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(panel.querySelector('[data-job-id="job-1"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="Retry job job-1"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Run audio denoise"]')).toBeNull();
    expect(panel.querySelector('[aria-label="Queue thumbnail derivative"]')).toBeNull();
  });
});

function worker(input: Partial<BrowserWorker>): BrowserWorker {
  return {
    id: 'worker-1',
    paired: true,
    revoked: false,
    capabilities: ['render.export'],
    lastSeenAt: Date.now(),
    ...input,
  };
}
