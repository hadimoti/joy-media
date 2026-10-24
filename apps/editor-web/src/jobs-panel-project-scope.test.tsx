// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import { SESSION_LEFT_PROJECT_MESSAGE } from './control-plane-scope.js';
import appSource from './App.tsx?raw';

const controlPlane = vi.hoisted(() => ({
  workers: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  ensureProject: vi.fn(() => Promise.resolve(undefined)),
  jobs: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  associateAsset: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
  enqueueWorkerGeneration: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
  derivatives: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  derivativeBytes: vi.fn((): Promise<Blob> => Promise.resolve(new Blob())),
  assets: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
}));

vi.mock('./control-plane-client.js', () => ({
  BrowserControlPlaneClient: class {
    readonly workers = controlPlane.workers;
    readonly ensureProject = controlPlane.ensureProject;
    readonly jobs = controlPlane.jobs;
    readonly associateAsset = controlPlane.associateAsset;
    readonly enqueueWorkerGeneration = controlPlane.enqueueWorkerGeneration;
    readonly derivatives = controlPlane.derivatives;
    readonly derivativeBytes = controlPlane.derivativeBytes;
    readonly assets = controlPlane.assets;
  },
  invalidateWorkerReadCache: () => undefined,
}));

import { JobsPanel } from './JobsPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let visibility: DocumentVisibilityState = 'visible';

// The session the editor holds. A test drops it without re-rendering the panel. That is how an editor
// that has unmounted, or a token that has changed, looks from the panel: its readiness and project
// props are the same as before, so only the context's live check sees the change.
const liveScope = { held: true };

// JobsPanel reads only the readiness flag and the live scope check from the context, so the rest of
// the context value is deliberately absent.
function editorContext(controlPlaneReady: boolean): EditorPanelContextValue {
  return {
    controlPlaneReady,
    captureControlPlaneProjectScope: (_projectId: string) => () => {
      if (!liveScope.held) throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
    },
  } as EditorPanelContextValue;
}

function panel(
  controlPlaneReady: boolean,
  projectId = 'project-1',
  audioAssetId?: string,
): ReactElement {
  return (
    <EditorPanelContext.Provider value={editorContext(controlPlaneReady)}>
      <JobsPanel
        projectId={projectId}
        projectTitle="Campaign cut"
        {...(audioAssetId === undefined ? {} : { audioAssetId })}
      />
    </EditorPanelContext.Provider>
  );
}

async function render(element: ReactElement): Promise<void> {
  if (container === undefined || root === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  const mounted = root;
  await act(async () => mounted.render(element));
}

function runButton(): HTMLButtonElement | null {
  return (
    container?.querySelector<HTMLButtonElement>('button[aria-label="Run audio denoise"]') ?? null
  );
}

function initializeButton(): Element | null {
  return container?.querySelector('button[aria-label="Initialize project"]') ?? null;
}

function connectedAudioWorker() {
  return {
    id: 'worker-1',
    paired: true,
    revoked: false,
    capabilities: ['audio.ml-denoise'],
    localAssetIds: ['asset-1'],
    lastSeenAt: Date.now(),
  };
}

describe('JobsPanel project scope', () => {
  beforeEach(() => {
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    controlPlane.workers.mockClear();
    controlPlane.workers.mockResolvedValue([]);
    controlPlane.ensureProject.mockClear();
    controlPlane.jobs.mockClear();
    controlPlane.jobs.mockResolvedValue([]);
    controlPlane.associateAsset.mockClear();
    controlPlane.enqueueWorkerGeneration.mockClear();
    controlPlane.derivatives.mockClear();
    controlPlane.derivatives.mockResolvedValue([]);
    controlPlane.derivativeBytes.mockClear();
    controlPlane.assets.mockClear();
    controlPlane.assets.mockResolvedValue([]);
    liveScope.held = true;
  });

  afterEach(async () => {
    liveScope.held = true;
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it('reads no project-scoped data before the session is ready, including once the tab is shown', async () => {
    visibility = 'hidden';
    await render(panel(false));

    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
    expect(controlPlane.jobs).not.toHaveBeenCalled();
  });

  it('binds and polls the project when the context turns ready, without remounting', async () => {
    await render(panel(false));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());
    const mountedPanel = container?.firstElementChild;
    expect(controlPlane.jobs).not.toHaveBeenCalled();

    await render(panel(true));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );
    expect(controlPlane.ensureProject).toHaveBeenCalledWith('project-1', 'Campaign cut');
    expect(container?.firstElementChild).toBe(mountedPanel);
  });

  it('enables Run only after the bound project initializes for a connected Worker', async () => {
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(false, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());
    expect(runButton()?.disabled).toBe(true);

    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));
    expect(controlPlane.ensureProject).toHaveBeenCalledWith('project-1', 'Campaign cut');
  });

  it('disables Run as soon as the session leaves its bound project', async () => {
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));

    await render(panel(false, 'project-1', 'asset-1'));
    expect(runButton()?.disabled).toBe(true);
  });

  it('never reads, binds or enables Run for a project the session does not own', async () => {
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(true, 'unbound-project-1', 'asset-1'));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
    expect(controlPlane.jobs).not.toHaveBeenCalled();
    expect(runButton()?.disabled).toBe(true);
    expect(initializeButton()).toBeNull();
  });

  it('polls a switched project only after binding it', async () => {
    await render(panel(true, 'project-1'));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );

    await render(panel(true, 'project-2'));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenLastCalledWith('project-2', expect.any(Function)),
    );
    expect(controlPlane.ensureProject).toHaveBeenLastCalledWith('project-2', 'Campaign cut');
  });

  it('bootstraps a project again after the session leaves it and returns to the same id', async () => {
    await render(panel(true));
    await vi.waitFor(() => expect(controlPlane.ensureProject).toHaveBeenCalled());
    const bootstrapsBeforeLeaving = controlPlane.ensureProject.mock.calls.length;

    await render(panel(false));
    await render(panel(true));
    await vi.waitFor(() =>
      expect(controlPlane.ensureProject.mock.calls.length).toBeGreaterThan(bootstrapsBeforeLeaving),
    );
  });

  it('sends no project-scoped request for a load the session left while the Worker list was in flight', async () => {
    let releaseWorkers: (workers: unknown[]) => void = () => undefined;
    controlPlane.workers.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseWorkers = resolve;
        }),
    );
    await render(panel(true));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    await render(panel(false));
    await act(async () => {
      releaseWorkers([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
    expect(controlPlane.jobs).not.toHaveBeenCalled();
  });

  it('sends no jobs request for a project whose ensure resolved after the session left it', async () => {
    let finishEnsure: () => void = () => undefined;
    controlPlane.ensureProject.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishEnsure = () => resolve(undefined);
        }),
    );
    await render(panel(true));
    await vi.waitFor(() => expect(controlPlane.ensureProject).toHaveBeenCalled());

    await render(panel(false));
    await act(async () => {
      finishEnsure();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.jobs).not.toHaveBeenCalled();
  });

  it('publishes no rows when the scope is lost while the jobs read is in flight', async () => {
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );

    // Rows render only on the Queue tab, so the stale publication is visible only from there.
    const tabButton = (label: string) =>
      Array.from(container?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent?.trim() === label,
      );
    await act(async () => tabButton('Queue')?.click());

    let finishJobs: (jobs: unknown[]) => void = () => undefined;
    controlPlane.jobs.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          finishJobs = resolve;
        }),
    );
    const jobsCallsBeforeRefresh = controlPlane.jobs.mock.calls.length;
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="Refresh jobs"]')?.click();
    });
    await vi.waitFor(() =>
      expect(controlPlane.jobs.mock.calls.length).toBeGreaterThan(jobsCallsBeforeRefresh),
    );

    // Record every job row added while the read is in flight. A publication that a later cleanup
    // would clear still fails here, so the result does not depend on when that cleanup runs.
    const mounted = container;
    if (mounted === undefined) throw new Error('JobsPanel is not mounted');
    const staleRowAdded = vi.fn();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const isStaleRow =
            node instanceof Element &&
            (node.matches('[data-job-id="job-1"]') ||
              node.querySelector('[data-job-id="job-1"]') !== null);
          if (isStaleRow) staleRowAdded();
        }
      }
    });
    observer.observe(mounted, { childList: true, subtree: true });

    liveScope.held = false;
    await act(async () => {
      finishJobs([
        {
          id: 'job-1',
          projectId: 'project-1',
          type: 'export.video',
          state: 'queued',
          progress: 0,
          cancelRequested: false,
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    observer.disconnect();

    expect(staleRowAdded).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-job-id="job-1"]')).toBeNull();
    await act(async () => tabButton('Workers')?.click());
    expect(runButton()?.disabled).toBe(true);
  });

  it('queues no job for a project the session left while its asset was associated', async () => {
    let finishAssociation: () => void = () => undefined;
    controlPlane.associateAsset.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishAssociation = () => resolve(undefined);
        }),
    );
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));

    await act(async () => {
      runButton()?.click();
    });
    await vi.waitFor(() =>
      expect(controlPlane.associateAsset).toHaveBeenCalledWith('project-1', 'asset-1'),
    );

    await render(panel(false, 'project-1', 'asset-1'));
    await act(async () => {
      finishAssociation();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.enqueueWorkerGeneration).not.toHaveBeenCalled();
  });

  it('sends no jobs request once the editor has left its project, though readiness did not change', async () => {
    let finishEnsure: () => void = () => undefined;
    controlPlane.ensureProject.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishEnsure = () => resolve(undefined);
        }),
    );
    await render(panel(true));
    await vi.waitFor(() => expect(controlPlane.ensureProject).toHaveBeenCalled());

    liveScope.held = false;
    await act(async () => {
      finishEnsure();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.jobs).not.toHaveBeenCalled();
  });

  it('queues no job once the editor has left its project, though readiness did not change', async () => {
    let finishAssociation: () => void = () => undefined;
    controlPlane.associateAsset.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishAssociation = () => resolve(undefined);
        }),
    );
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));

    await act(async () => {
      runButton()?.click();
    });
    await vi.waitFor(() =>
      expect(controlPlane.associateAsset).toHaveBeenCalledWith('project-1', 'asset-1'),
    );

    liveScope.held = false;
    await act(async () => {
      finishAssociation();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.enqueueWorkerGeneration).not.toHaveBeenCalled();
  });

  it('reads no derivative bytes or asset list for a Worker review the editor left mid-way', async () => {
    controlPlane.jobs.mockResolvedValue([
      {
        id: 'job-1',
        projectId: 'project-1',
        type: 'audio.ml-denoise',
        state: 'completed',
        progress: 100,
        cancelRequested: false,
        assetId: 'asset-1',
        derivative: { id: 'derivative-1', sha256: 'sha-1' },
      },
    ]);
    // The derivative list is in flight when the editor leaves, so the next read must not start.
    let finishDerivatives: () => void = () => undefined;
    controlPlane.derivatives.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          finishDerivatives = () =>
            resolve([{ id: 'derivative-1', kind: 'audio', sha256: 'sha-1' }]);
        }),
    );
    await render(panel(true));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );
    const queueTab = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Queue',
    );
    await act(async () => queueTab?.click());
    await vi.waitFor(() => expect(container?.querySelector('.jobs-review-button')).not.toBeNull());

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('.jobs-review-button')?.click();
    });
    await vi.waitFor(() =>
      expect(controlPlane.derivatives).toHaveBeenCalledWith('project-1', 'asset-1'),
    );

    liveScope.held = false;
    await act(async () => {
      finishDerivatives();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.derivativeBytes).not.toHaveBeenCalled();
    expect(controlPlane.assets).not.toHaveBeenCalled();
    expect(container?.textContent).toContain('Could not verify Worker result');
  });

  it('never offers Initialize for an unbound project, even after a failed connection', async () => {
    controlPlane.workers.mockRejectedValueOnce(new Error('offline'));
    await render(panel(true, 'unbound-project-1'));
    await vi.waitFor(() =>
      expect(container?.textContent).toContain('Not connected or not signed in'),
    );

    expect(initializeButton()).toBeNull();
    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
  });

  it('offers Initialize to a bound project whose ready session failed to connect', async () => {
    controlPlane.workers.mockRejectedValueOnce(new Error('offline'));
    await render(panel(true));
    await vi.waitFor(() =>
      expect(container?.textContent).toContain('Not connected or not signed in'),
    );

    expect(initializeButton()).not.toBeNull();
  });

  it('sends no ensure request when Initialize is clicked after the scope is lost', async () => {
    controlPlane.workers.mockRejectedValueOnce(new Error('offline'));
    await render(panel(true));
    await vi.waitFor(() => expect(initializeButton()).not.toBeNull());

    liveScope.held = false;
    await act(async () => {
      (initializeButton() as HTMLButtonElement | null)?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
  });

  it('offers no Initialize action to a session that is not ready', async () => {
    await render(panel(false));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(initializeButton()).toBeNull();
    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
  });

  it('clears the queue when the session leaves its project', async () => {
    controlPlane.jobs.mockResolvedValue([
      {
        id: 'job-1',
        projectId: 'project-1',
        type: 'export.video',
        state: 'queued',
        progress: 0,
        cancelRequested: false,
      },
    ]);
    await render(panel(true));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );

    const queueTab = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Queue',
    );
    await act(async () => queueTab?.click());
    await vi.waitFor(() =>
      expect(container?.querySelector('button[aria-label="Cancel job job-1"]')).not.toBeNull(),
    );

    await render(panel(false, 'unbound-project-1'));
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(container?.querySelector('[data-job-id="job-1"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Cancel job job-1"]')).toBeNull();
  });

  it('clears rows when the latest load loses scope while Workers are in flight', async () => {
    controlPlane.workers.mockResolvedValue([connectedAudioWorker()]);
    controlPlane.jobs.mockResolvedValue([
      {
        id: 'job-1',
        projectId: 'project-1',
        type: 'export.video',
        state: 'queued',
        progress: 0,
        cancelRequested: false,
      },
    ]);
    await render(panel(true, 'project-1', 'asset-1'));
    await vi.waitFor(() => expect(runButton()?.disabled).toBe(false));
    await vi.waitFor(() =>
      expect(controlPlane.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );

    const tabButton = (label: string) =>
      Array.from(container?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent?.trim() === label,
      );
    await act(async () => tabButton('Queue')?.click());
    await vi.waitFor(() =>
      expect(container?.querySelector('[data-job-id="job-1"]')).not.toBeNull(),
    );

    let finishWorkers: (workers: unknown[]) => void = () => undefined;
    controlPlane.workers.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          finishWorkers = resolve;
        }),
    );
    const workersCallsBeforeRefresh = controlPlane.workers.mock.calls.length;
    const refreshButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh jobs"]',
    );
    await act(async () => refreshButton?.click());
    await vi.waitFor(() =>
      expect(controlPlane.workers.mock.calls.length).toBeGreaterThan(workersCallsBeforeRefresh),
    );

    liveScope.held = false;
    await act(async () => {
      finishWorkers([connectedAudioWorker()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container?.querySelector('[data-job-id="job-1"]')).toBeNull();
    await act(async () => tabButton('Workers')?.click());
    expect(runButton()?.disabled).toBe(true);
  });

  it('fails closed when no session context is provided', async () => {
    await render(<JobsPanel projectId="project-1" projectTitle="Campaign cut" />);
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
    expect(controlPlane.jobs).not.toHaveBeenCalled();
    expect(initializeButton()).toBeNull();
  });
});

describe('editor dock wiring', () => {
  it('passes the scope check to the Local Worker job poll, so a session that left stops it', () => {
    expect(appSource).toMatch(
      /mediaControlPlaneClient\.jobs\(\s*controlPlaneProject\.controlPlaneProjectId,\s*assertScope,?\s*\)/u,
    );
  });

  it('reads the live media resolver and resync callback, not the first render', () => {
    // Dockview keeps the first render's PanelContent, so the panel reaches the
    // current resolver and resync callback through refs.
    const panelContent = appSource.slice(
      appSource.indexOf('function PanelContent('),
      appSource.indexOf('// Dockview forces a grid layout'),
    );
    const resolveAudioAssetUrl = appSource.slice(
      appSource.indexOf('const resolveAudioAssetUrl = useCallback('),
      appSource.indexOf('const exportEditableProject = useCallback('),
    );

    expect(resolveAudioAssetUrl).toContain('mediaResolverRef.current.resolve(assetId)');
    expect(resolveAudioAssetUrl.includes('mediaResolver.resolve(')).toBe(false);
    expect(panelContent).toMatch(
      /assertScope\(\);\s*const source = await mediaResolverRef\.current\.resolve\(\s*selectedAudioClip\.assetId,\s*assertScope,?\s*\);/,
    );
    expect(panelContent).toMatch(
      /mediaResolverRef\.current\.resolve\(\s*targetAssetId,\s*assertScope,?\s*\)/,
    );
    expect(panelContent).toContain('resyncTimelineMediaRef.current();');
    expect(panelContent.includes('mediaResolver.resolve(')).toBe(false);
    expect(panelContent.includes('resyncTimelineMedia();')).toBe(false);
  });

  it('reads the Jobs panel operation revision from the panel context, like the other panel reads', () => {
    // The panel context carries the live session, which PanelContent reads through useContext. The
    // bare `session` is the same mutable object, so both reads agree. This pins the Jobs panel to the
    // context so that it does not depend on that object identity.
    const jobsPanel = appSource.slice(
      appSource.indexOf('<JobsPanel'),
      appSource.indexOf('/>', appSource.indexOf('<JobsPanel')),
    );

    expect(jobsPanel).toContain('operationRevision={context.session.historyCursorSequence}');
    expect(jobsPanel.includes('operationRevision={session.historyCursorSequence}')).toBe(false);
  });
});
