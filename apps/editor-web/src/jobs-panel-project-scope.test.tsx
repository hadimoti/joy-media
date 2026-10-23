// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import appSource from './App.tsx?raw';

const controlPlane = vi.hoisted(() => ({
  workers: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  ensureProject: vi.fn(() => Promise.resolve(undefined)),
  jobs: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
}));

vi.mock('./control-plane-client.js', () => ({
  BrowserControlPlaneClient: class {
    readonly workers = controlPlane.workers;
    readonly ensureProject = controlPlane.ensureProject;
    readonly jobs = controlPlane.jobs;
  },
  invalidateWorkerReadCache: () => undefined,
}));

import { JobsPanel } from './JobsPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let visibility: DocumentVisibilityState = 'visible';

// JobsPanel reads only the readiness flag from the context, so the rest of the
// context value is deliberately absent.
function editorContext(controlPlaneReady: boolean): EditorPanelContextValue {
  return { controlPlaneReady } as EditorPanelContextValue;
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
  });

  afterEach(async () => {
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
    await vi.waitFor(() => expect(controlPlane.jobs).toHaveBeenCalledWith('project-1'));
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
    await vi.waitFor(() => expect(controlPlane.jobs).toHaveBeenCalledWith('project-1'));

    await render(panel(true, 'project-2'));
    await vi.waitFor(() => expect(controlPlane.jobs).toHaveBeenLastCalledWith('project-2'));
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
    await vi.waitFor(() => expect(controlPlane.jobs).toHaveBeenCalledWith('project-1'));

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

  it('fails closed when no session context is provided', async () => {
    await render(<JobsPanel projectId="project-1" projectTitle="Campaign cut" />);
    await vi.waitFor(() => expect(controlPlane.workers).toHaveBeenCalled());

    expect(controlPlane.ensureProject).not.toHaveBeenCalled();
    expect(controlPlane.jobs).not.toHaveBeenCalled();
    expect(initializeButton()).toBeNull();
  });
});

describe('editor dock wiring', () => {
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
    expect(panelContent).toContain('mediaResolverRef.current.resolve(selectedAudioClip.assetId)');
    expect(panelContent).toContain('mediaResolverRef.current.resolve(targetAssetId)');
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
