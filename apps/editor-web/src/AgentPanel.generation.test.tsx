// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditorContext } from '@joy-media/agent-tools';
import { createDesktopGenerationHost } from './joy-agent/desktop-generation-host.js';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { EditorSession } from './editor-session.js';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { audioStateFromProject } from './timeline-presentation.js';
import { AgentPanel } from './AgentPanel.js';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import {
  createJoyCodeConversation,
  loadJoyCodeConversation,
  saveJoyCodeConversation,
} from './joy-code-conversation.js';
import type { JoyAgentEngineClient, JoyAgentRunHost } from './joy-agent/engine-client.js';
import type { HostRpcHandlerContext, HostRpcMethod } from './joy-agent/host-rpc.js';
import type { JoyAgentGenerationToolAdapter } from './joy-agent/tool-bridge.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderInto(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function context(runId = 'generation-run'): HostRpcHandlerContext {
  return {
    run: { runId, epoch: 1 },
    requestId: 'generation-rpc',
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
}

function generationAdapter(overrides: Partial<JoyAgentGenerationToolAdapter> = {}) {
  let requestCount = 0;
  return {
    enqueue: vi.fn(() => `generation-request-${++requestCount}`),
    canAttachCompletedJob: vi.fn(async () => true),
    requestApproval: vi.fn(async () => false),
    start: vi.fn(async () => 'job-1'),
    awaitJob: vi.fn(async (jobId: string) => ({
      jobId,
      kind: 'image' as const,
      status: 'completed' as const,
    })),
    attach: vi.fn(async () => ({ assetId: 'generated-asset', placed: false })),
    ...overrides,
  } satisfies JoyAgentGenerationToolAdapter;
}

function componentHarness(options: {
  readonly adapter: JoyAgentGenerationToolAdapter;
  readonly capability?: ByokSessionStatus['capability'];
  readonly request?: {
    kind: 'image' | 'video';
    prompt: string;
    aspect: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
    seconds?: number;
  };
  readonly storage?: ReturnType<typeof memoryStorage>;
  readonly project?: ReturnType<typeof buildReferenceSpikeProject>;
  readonly readMedia?: (jobId: string) => Promise<{ bytes: Uint8Array; mimeType: string }>;
}) {
  const project = options.project ?? buildReferenceSpikeProject();
  const session = new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT);
  const storage = options.storage ?? memoryStorage();
  const hosts: JoyAgentRunHost[] = [];
  const request = options.request ?? {
    kind: 'image' as const,
    prompt: 'soft sunrise over quiet water',
    aspect: '16:9' as const,
  };
  const startRun = vi.fn((_runRequest: unknown, host?: JoyAgentRunHost) => {
    if (host !== undefined) hosts.push(host);
    const index = hosts.length;
    const iterator = (async function* () {
      if (index === 1 && host?.methods.generate_media !== undefined) {
        const generate = host.methods.generate_media as HostRpcMethod<
          Record<string, unknown>,
          Record<string, unknown>
        >;
        const result = await generate.execute(request, context());
        yield {
          protocolVersion: 1,
          runId: 'generation-run',
          runEpoch: 1,
          seq: 1,
          at: '2026-11-21T00:00:00.000Z',
          phase: 'completed',
          result: { kind: 'generation', requestId: result.requestId, mediaKind: request.kind },
        } as never;
      } else {
        yield {
          protocolVersion: 1,
          runId: `generation-run-${index}`,
          runEpoch: 1,
          seq: 1,
          at: '2026-11-21T00:00:00.000Z',
          phase: 'completed',
          result: { kind: 'answer', text: 'Done.' },
        } as never;
      }
    })();
    return Object.assign(iterator, { run: { runId: `generation-run-${index}`, epoch: 1 } });
  });
  const client = {
    getStatus: () => ({
      provider: 'openai-compatible',
      modelId: 'gpt-test',
      capability: options.capability ?? 'tool-loop',
    }),
    getMediaCapabilities: () => undefined,
    cancel: vi.fn(async () => undefined),
    startRun,
  } as unknown as JoyAgentEngineClient;
  const view = renderInto(
    <AgentPanel
      project={project}
      selectedClipIds={[]}
      playheadUs={0}
      agentContext={buildEditorContext(project)}
      onUndo={() => undefined}
      session={session}
      settings={DEFAULT_AGENT_POLICY}
      storage={storage as never}
      joyAgentEngineClient={client}
      generationAdapter={options.adapter as never}
      generatedMedia={{
        readMedia:
          options.readMedia ??
          (async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' })),
      }}
      creativeBriefOptedIn
      creativeBriefRunner={() => new Promise(() => undefined)}
    />,
  );
  return { view, hosts, startRun, request, storage, project };
}

async function sendPrompt(view: HTMLElement, prompt = 'Create a picture of a quiet sunrise') {
  const textarea = view.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message Joy Code"]',
  )!;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(textarea, prompt);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    view
      .querySelector<HTMLButtonElement>('button.joy-code-send[aria-label="Send message"]')!
      .click(),
  );
}

describe('desktop generation host', () => {
  beforeEach(() => {
    if (Blob.prototype.arrayBuffer === undefined) {
      Object.defineProperty(Blob.prototype, 'arrayBuffer', {
        configurable: true,
        value: async function (this: Blob) {
          return await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(this);
          });
        },
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads generated bytes by job id and only authorizes completed jobs', async () => {
    const job = { id: 'job-1', kind: 'image', state: 'completed' };
    const bytes = new Uint8Array([1, 2, 3]);
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.generation.bytes')
        return { bytes, mimeType: 'image/png', fileName: 'result.png', job };
      if (channel === 'desktop.generation.status') return job;
      throw new Error(`unexpected ${channel}`);
    });
    window.joyDesktop = { channels: [], invoke };
    const project = buildReferenceSpikeProject();
    const host = createDesktopGenerationHost({
      projectId: 'project-1',
      projectTitle: 'Test project',
      session: new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT),
      audioState: audioStateFromProject(
        new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT).visualProject,
      ),
      client: {
        ensureProject: vi.fn(),
        registerAsset: vi.fn(),
        assets: vi.fn(),
        uploadAssetOriginal: vi.fn(),
      } as never,
      getPlayheadUs: () => 321,
      onAudioState: vi.fn(),
    });

    await expect(host.generatedMedia.readMedia?.('job-1')).resolves.toEqual({
      bytes,
      mimeType: 'image/png',
    });
    await expect(host.adapter.canAttachCompletedJob?.('job-1', {} as never)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('desktop.generation.bytes', { jobId: 'job-1' });
    expect(invoke).toHaveBeenCalledWith('desktop.generation.status', { jobId: 'job-1' });
  });

  it('starts only with the saved Workhorse profile and attaches at the requested position', async () => {
    const fileBytes = new Uint8Array([1, 2, 3]);
    const completed = {
      id: 'job-2',
      kind: 'image',
      state: 'completed',
      provider: 'provider',
      model: 'model',
      prompt: 'soft sunrise',
      createdAt: '2026-11-21T00:00:00.000Z',
      sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.agent-slots.list')
        return [{ id: 'workhorse', profileId: 'profile-1', ready: true }];
      if (channel === 'desktop.generation.start') return { ...completed, state: 'queued' };
      if (channel === 'desktop.generation.status') return completed;
      if (channel === 'desktop.generation.bytes')
        return { bytes: fileBytes, mimeType: 'image/png', fileName: 'sunrise.png', job: completed };
      throw new Error(`unexpected ${channel}`);
    });
    window.joyDesktop = { channels: [], invoke };
    const project = buildReferenceSpikeProject();
    const client = {
      ensureProject: vi.fn(),
      registerAsset: vi.fn(
        async (
          _projectId: string,
          registration: {
            id: string;
            kind: 'image';
            displayName: string;
            sha256: string;
            bytes: number;
            descriptor: { mimeType: string };
          },
        ) => ({
          ...registration,
          projectId: 'project-1',
          cloudBacked: false,
          createdAt: 0,
        }),
      ),
      assets: vi.fn(async () => []),
      uploadAssetOriginal: vi.fn(async (_projectId: string, asset: unknown) => asset),
    };
    const onAudioState = vi.fn();
    const host = createDesktopGenerationHost({
      projectId: 'project-1',
      projectTitle: 'Test project',
      session: new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT),
      audioState: audioStateFromProject(
        new EditorSession(memoryStorage(), project, INITIAL_EDITOR_PROJECT).visualProject,
      ),
      client: client as never,
      getPlayheadUs: () => 321,
      onAudioState,
      originalAssetCache: { put: vi.fn() },
      describeMedia: async () => ({ width: 1, height: 1, mimeType: 'image/png' }),
    });

    await expect(
      host.adapter.start({ kind: 'image', prompt: 'soft sunrise', aspect: '1:1' }, {} as never),
    ).resolves.toBe('job-2');
    expect(invoke).toHaveBeenCalledWith('desktop.generation.start', {
      profileId: 'profile-1',
      kind: 'image',
      prompt: 'soft sunrise',
    });
    const attached = await host.adapter.attach(
      { jobId: 'job-2', target: 'timeline', atSeconds: 2 },
      {} as never,
    );
    expect(attached).toMatchObject({ assetId: expect.stringMatching(/^generated-/), placed: true });
    expect(client.ensureProject).toHaveBeenCalled();
    expect(onAudioState).toHaveBeenCalled();
  });
});

beforeEach(() => {
  if (URL.createObjectURL === undefined) URL.createObjectURL = () => 'blob:test-generation';
  if (URL.revokeObjectURL === undefined) URL.revokeObjectURL = () => undefined;
});

describe('AgentPanel generation approval and jobs', () => {
  it.each(['plan-only', 'tool-loop'] as const)(
    'waits for Allow after a %s generation handoff',
    async (capability) => {
      const adapter = generationAdapter();
      const { view } = componentHarness({ adapter, capability });
      await sendPrompt(view);

      await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
      expect(view.textContent).toContain('Picture');
      expect(view.textContent).not.toContain('16:9');
      expect(view.textContent).toContain(
        'Provider pricing applies; JOY Media does not estimate the charge.',
      );
      expect(adapter.start).not.toHaveBeenCalled();
    },
  );

  it('shows the full prompt without unsent generation settings on the cost card', async () => {
    const adapter = generationAdapter();
    const prompt = 'a'.repeat(240);
    const { view } = componentHarness({
      adapter,
      request: {
        kind: 'video',
        prompt,
        aspect: '9:16',
        seconds: 7,
      },
    });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    expect(view.textContent).toContain('Video');
    expect(view.textContent).toContain(prompt);
    expect(view.textContent).not.toContain('9:16');
    expect(view.textContent).not.toContain('7 seconds');
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('keeps ordinary plan-only edit prompts blocked even when desktop generation is available', async () => {
    const adapter = generationAdapter();
    const { view, startRun } = componentHarness({ adapter, capability: 'plan-only' });
    await sendPrompt(view, 'Trim the first clip by two seconds');
    expect(startRun).not.toHaveBeenCalled();
    expect(adapter.start).not.toHaveBeenCalled();
    expect(view.textContent).toContain('This model supports Creative Brief only.');
  });

  it('declines without starting and adds the refusal to the conversation', async () => {
    const adapter = generationAdapter();
    const { view } = componentHarness({ adapter });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Decline generation"]')!.click(),
    );
    expect(adapter.start).not.toHaveBeenCalled();
    expect(view.textContent).toContain('Generation declined. Nothing was sent to your provider.');
  });

  it('retries up to three consecutive transient status errors', async () => {
    let attempts = 0;
    const adapter = generationAdapter({
      status: vi.fn(async (jobId: string) => {
        attempts += 1;
        if (attempts <= 3) return undefined;
        return { id: jobId, kind: 'image', state: 'completed' };
      }),
      list: vi.fn(async () => []),
    } as never);
    const { view, storage, project } = componentHarness({ adapter });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );

    await act(async () =>
      vi.waitFor(() => expect(adapter.status).toHaveBeenCalledTimes(4), { timeout: 4000 }),
    );
    expect(loadJoyCodeConversation(storage, project.id)?.messages.at(-1)?.parts).toContainEqual({
      kind: 'image',
      jobId: 'job-1',
    });
    expect(adapter.status).toHaveBeenCalledTimes(4);
  });

  it('starts after Allow, polls the job, renders media and reads its bytes', async () => {
    let reads = 0;
    const adapter = generationAdapter({
      status: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'completed' })),
      list: vi.fn(async () => []),
    } as never);
    const { view } = componentHarness({
      adapter,
      readMedia: async () => {
        reads += 1;
        return { bytes: new Uint8Array([1]), mimeType: 'image/png' };
      },
    });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(view.querySelector('.joy-code-media-card.is-image')).not.toBeNull(),
    );
    expect(adapter.start).toHaveBeenCalledWith(
      { kind: 'image', prompt: 'soft sunrise over quiet water', aspect: '16:9' },
      expect.anything(),
    );
    await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
  });

  it('cancels a running job from its message card', async () => {
    const adapter = generationAdapter({
      status: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'running' })),
      cancel: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'cancelled' })),
      list: vi.fn(async () => []),
    } as never);
    const { view } = componentHarness({ adapter, readMedia: () => new Promise(() => undefined) });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(
        [...view.querySelectorAll('button')].some((button) =>
          button.textContent?.includes('Cancel'),
        ),
      ).toBe(true),
    );
    await act(async () =>
      [...view.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Cancel'))!
        .click(),
    );
    expect(adapter.cancel).toHaveBeenCalledWith('job-1');
    await vi.waitFor(() => expect(view.textContent).toContain('Cancelled'));
  });

  it('does not let an in-flight status response overwrite cancellation', async () => {
    let resolveStatus!: (job: { id: string; kind: string; state: string }) => void;
    const statusPending = new Promise<{ id: string; kind: string; state: string }>((resolve) => {
      resolveStatus = resolve;
    });
    const adapter = generationAdapter({
      status: vi.fn(() => statusPending),
      cancel: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'cancelled' })),
      list: vi.fn(async () => []),
    } as never);
    const { view } = componentHarness({ adapter });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );
    await vi.waitFor(() => expect(adapter.status).toHaveBeenCalledWith('job-1'));
    await act(async () =>
      [...view.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Cancel'))!
        .click(),
    );
    expect(view.textContent).toContain('Cancelled');

    await act(async () => resolveStatus({ id: 'job-1', kind: 'image', state: 'running' }));
    expect(view.querySelector('.joy-code-job-card')?.classList.contains('is-cancelled')).toBe(true);
    expect(view.querySelector('.joy-code-job-card')?.classList.contains('is-running')).toBe(false);
  });

  it('converts a job card to media when cancel reports an already completed job', async () => {
    const adapter = generationAdapter({
      status: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'running' })),
      cancel: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'completed' })),
      list: vi.fn(async () => []),
    } as never);
    const { view } = componentHarness({ adapter, readMedia: () => new Promise(() => undefined) });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );
    await vi.waitFor(() => expect(view.querySelector('.joy-code-job-card')).not.toBeNull());
    await act(async () =>
      [...view.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Cancel'))!
        .click(),
    );
    await vi.waitFor(() =>
      expect(view.querySelector('.joy-code-media-card.is-image')).not.toBeNull(),
    );
    expect(view.querySelector('.joy-code-job-card')).toBeNull();
  });

  it('allows attaching a completed job from a later run', async () => {
    const adapter = generationAdapter({
      status: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'completed' })),
      list: vi.fn(async () => []),
    } as never);
    const { view, hosts } = componentHarness({ adapter });
    await sendPrompt(view);
    await vi.waitFor(() => expect(view.textContent).toContain('Generation Cost Card'));
    await act(async () =>
      view.querySelector<HTMLButtonElement>('button[aria-label="Allow generation"]')!.click(),
    );
    await vi.waitFor(() =>
      expect(view.querySelector('.joy-code-media-card.is-image')).not.toBeNull(),
    );
    await sendPrompt(view, 'Use that generated picture on my timeline');
    await vi.waitFor(() => expect(hosts).toHaveLength(2));
    const attach = hosts[1]!.methods.attach_generated_media as HostRpcMethod<
      Record<string, unknown>,
      Record<string, unknown>
    >;
    await expect(
      attach.execute(
        { jobId: 'job-older', target: 'timeline', atSeconds: 2 },
        context('generation-run-2'),
      ),
    ).resolves.toMatchObject({ ok: true, assetId: 'generated-asset', placed: false });
    expect(adapter.canAttachCompletedJob).toHaveBeenCalledWith('job-older', expect.anything());
    expect(adapter.attach).toHaveBeenCalledWith(
      { jobId: 'job-older', target: 'timeline', atSeconds: 2 },
      expect.anything(),
    );
  });

  it('restores and polls an active desktop job without adding a duplicate job card', async () => {
    const adapter = generationAdapter({
      list: vi.fn(async () => [
        {
          id: 'restored-job',
          kind: 'image',
          provider: 'provider',
          model: 'model',
          prompt: 'restored picture',
          state: 'running',
          createdAt: '2026-11-21T00:00:00.000Z',
        },
      ]),
      status: vi.fn(async (jobId: string) => ({
        id: jobId,
        kind: 'image',
        provider: 'provider',
        model: 'model',
        prompt: 'restored picture',
        state: 'running',
        createdAt: '2026-11-21T00:00:00.000Z',
      })),
    } as never);
    const { view } = componentHarness({ adapter });
    await act(async () => {
      await vi.waitFor(() => expect(adapter.status).toHaveBeenCalledWith('restored-job'));
    });
    expect(view.textContent).toContain('Generating picture');
    expect(view.querySelectorAll('.joy-code-job-card')).toHaveLength(1);
    expect(adapter.list).toHaveBeenCalledTimes(1);
    expect(adapter.status).toHaveBeenCalledWith('restored-job');
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', 'image', undefined],
    ['abandoned-locally', 'job', 'Stopped on this computer'],
  ] as const)(
    'reconciles a saved running job with list state %s',
    async (state, expectedPartKind, expectedReason) => {
      const project = buildReferenceSpikeProject();
      const storage = memoryStorage();
      const conversation = {
        ...createJoyCodeConversation('saved-conversation', '2026-11-21T00:00:00.000Z'),
        messages: [
          {
            id: 'saved-message',
            role: 'assistant' as const,
            body: 'Generating picture…',
            createdAt: '2026-11-21T00:00:00.000Z',
            parts: [
              {
                kind: 'job' as const,
                jobId: 'restored-job',
                mediaKind: 'image' as const,
                state: 'running' as const,
                startedAt: '2026-11-21T00:00:00.000Z',
              },
            ],
          },
        ],
      };
      saveJoyCodeConversation(storage, project.id, conversation);
      const adapter = generationAdapter({
        list: vi.fn(async () => [
          {
            id: 'restored-job',
            kind: 'image',
            provider: 'provider',
            model: 'model',
            prompt: 'restored picture',
            state,
            createdAt: '2026-11-21T00:00:00.000Z',
            updatedAt: '2026-11-21T00:01:00.000Z',
            error: expectedReason,
          },
        ]),
        status: vi.fn(async (jobId: string) => ({ id: jobId, kind: 'image', state: 'running' })),
      } as never);
      const { view } = componentHarness({
        adapter,
        storage,
        project,
        readMedia: () => new Promise(() => undefined),
      });
      await act(async () => vi.waitFor(() => expect(adapter.list).toHaveBeenCalledTimes(1)));

      await act(async () =>
        vi.waitFor(() => {
          const restored = loadJoyCodeConversation(storage, project.id)?.messages[0]?.parts?.[0];
          expect(restored?.kind).toBe(expectedPartKind);
          if (expectedPartKind === 'job') expect(restored).toMatchObject({ state });
        }),
      );
      const restored = loadJoyCodeConversation(storage, project.id)?.messages[0]?.parts?.[0];
      if (state === 'completed') {
        expect(restored).toEqual({ kind: 'image', jobId: 'restored-job' });
        expect(view.querySelector('.joy-code-media-card.is-image')).not.toBeNull();
      } else {
        expect(restored).toMatchObject({
          kind: 'job',
          state: 'abandoned-locally',
          endedAt: expect.any(String),
          reason: expectedReason,
        });
        expect(view.querySelector('.joy-code-job-card.is-abandoned-locally')).not.toBeNull();
      }
      expect(adapter.status).not.toHaveBeenCalled();
    },
  );
});
