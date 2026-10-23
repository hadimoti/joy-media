// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserControlPlaneClient } from './control-plane-client.js';
import { SESSION_LEFT_PROJECT_MESSAGE } from './control-plane-scope.js';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';
import { EnhanceInspector } from './EnhanceInspector.js';
import { defaultUpscaleSettings, type UpscaleSettings } from './upscaling.js';

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
    workers: vi.fn(async () => []),
    jobs: vi.fn(async (): Promise<unknown[]> => []),
    ensureProject: vi.fn(async () => undefined),
    enqueueUpscale: vi.fn(),
    cancel: vi.fn(),
  };
}

const target = {
  targetId: 'clip-1',
  clipId: 'clip-1',
  assetId: 'video-1',
  kind: 'video' as const,
  durationUs: 5_000_000,
};

const queuedSettings: UpscaleSettings = {
  ...defaultUpscaleSettings(),
  lastJob: { id: 'job-1', state: 'queued', progress: 0 },
};

function completedJob(): unknown {
  return {
    id: 'job-1',
    projectId: 'project-1',
    type: 'upscale.video',
    state: 'completed',
    progress: 1,
    cancelRequested: false,
    derivative: { sha256: 'a'.repeat(64) },
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
      <EnhanceInspector
        projectId="project-1"
        projectTitle="Campaign cut"
        target={target}
        settings={queuedSettings}
        onChange={() => undefined}
        onApplyResult={onApplyResult}
        client={client as unknown as BrowserControlPlaneClient}
      />
    </EditorPanelContext.Provider>
  );
}

describe('EnhanceInspector session scope', () => {
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
    const onApplyResult = vi.fn(async () => 'result-asset');
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
    const onApplyResult = vi.fn(async () => 'result-asset');
    await render(mountInspector(client, onApplyResult));

    await vi.waitFor(() => expect(onApplyResult).toHaveBeenCalledTimes(1));
  });
});
