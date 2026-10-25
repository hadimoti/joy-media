// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserControlPlaneClient, BrowserWorker } from './control-plane-client.js';
import { SESSION_LEFT_PROJECT_MESSAGE } from './control-plane-scope.js';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import { MaskInspector } from './MaskInspector.js';
import { defaultMaskSettings, type MaskSettings } from './masking.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The session the editor holds. A test drops it while the inspector stays mounted, which is what happens when
// the session moves on and the panel is not re-rendered.
const liveScope = { held: true };

function editorContext(): EditorPanelContextValue {
  return {
    controlPlaneReady: true,
    captureControlPlaneProjectScope: (_projectId: string) => () => {
      if (!liveScope.held) throw new Error(SESSION_LEFT_PROJECT_MESSAGE);
    },
  } as EditorPanelContextValue;
}

function fakeClient() {
  return {
    workers: vi.fn(async (): Promise<BrowserWorker[]> => []),
    jobs: vi.fn(async (): Promise<unknown[]> => []),
    ensureProject: vi.fn(async () => undefined),
    enqueueMask: vi.fn(),
    cancel: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readyWorker(): BrowserWorker {
  return {
    id: 'worker-1',
    paired: true,
    revoked: false,
    capabilities: ['mask.video'],
    localAssetIds: [target.assetId],
    lastSeenAt: Date.now(),
  };
}

const target = {
  targetId: 'clip-1',
  clipId: 'clip-1',
  assetId: 'video-1',
  kind: 'video' as const,
  durationUs: 5_000_000,
};

const queuedSettings: MaskSettings = {
  ...defaultMaskSettings('video'),
  lastJob: { id: 'job-1', state: 'queued', progress: 0 },
};

function completedJob(): unknown {
  return {
    id: 'job-1',
    projectId: 'project-1',
    type: 'mask.video',
    state: 'completed',
    progress: 1,
    cancelRequested: false,
    derivative: { sha256: 'b'.repeat(64) },
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(element: ReactElement): Promise<void> {
  if (container === undefined || root === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  const mounted = root;
  await act(async () => mounted.render(element));
}

function mountInspector(
  client: ReturnType<typeof fakeClient>,
  onApplyResult: () => Promise<string>,
) {
  return (
    <EditorPanelContext.Provider value={editorContext()}>
      <MaskInspector
        projectId="project-1"
        projectTitle="Masking"
        target={target}
        settings={queuedSettings}
        onChange={() => undefined}
        onApplyResult={onApplyResult}
        onClear={() => undefined}
        client={client as unknown as BrowserControlPlaneClient}
      />
    </EditorPanelContext.Provider>
  );
}

describe('MaskInspector session scope', () => {
  beforeEach(() => {
    liveScope.held = true;
  });

  afterEach(async () => {
    liveScope.held = true;
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('reads the job with its scope check, and applies nothing once the session has left the project', async () => {
    const client = fakeClient();
    let finishJobs: (jobs: unknown[]) => void = () => undefined;
    client.jobs.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          finishJobs = resolve;
        }),
    );
    const onApplyResult = vi.fn(async () => 'mask-result');
    await render(mountInspector(client, onApplyResult));
    await vi.waitFor(() =>
      expect(client.jobs).toHaveBeenCalledWith('project-1', expect.any(Function)),
    );

    liveScope.held = false;
    await act(async () => {
      finishJobs([completedJob()]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(onApplyResult).not.toHaveBeenCalled();
  });

  it('applies a completed job result while the session holds the project', async () => {
    const client = fakeClient();
    client.jobs.mockResolvedValueOnce([completedJob()]);
    const onApplyResult = vi.fn(async () => 'mask-result');
    await render(mountInspector(client, onApplyResult));

    await vi.waitFor(() => expect(onApplyResult).toHaveBeenCalledTimes(1));
  });

  it('does not enqueue when the session leaves while project setup is pending', async () => {
    const client = fakeClient();
    client.workers.mockResolvedValue([readyWorker()]);
    const ensureProject = deferred<undefined>();
    client.ensureProject.mockImplementationOnce(() => ensureProject.promise);
    await render(
      mountInspector(
        client,
        vi.fn(async () => 'mask-result'),
      ),
    );

    const queueButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Create Mask',
    );
    expect(queueButton).toBeDefined();
    await vi.waitFor(() => expect((queueButton as HTMLButtonElement).disabled).toBe(false));
    await act(async () => (queueButton as HTMLButtonElement).click());
    expect(client.ensureProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      liveScope.held = false;
      ensureProject.resolve(undefined);
      await ensureProject.promise;
    });

    expect(client.enqueueMask).not.toHaveBeenCalled();
  });

  it('does not cancel when the session has left the project', async () => {
    const client = fakeClient();
    await render(
      mountInspector(
        client,
        vi.fn(async () => 'mask-result'),
      ),
    );
    const cancelButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel mask job"]',
    );
    expect(cancelButton).not.toBeNull();

    liveScope.held = false;
    await act(async () => cancelButton!.click());

    expect(client.cancel).not.toHaveBeenCalled();
  });
});
