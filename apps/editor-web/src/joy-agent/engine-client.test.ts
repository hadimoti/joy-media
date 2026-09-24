import { describe, expect, it, vi } from 'vitest';
import { createJoyAgentEngineClient } from './engine-client.js';
import type { HostRpcMethods } from './host-rpc.js';
import { JOY_AGENT_PROTOCOL_VERSION, type MainToWorkerMessage } from './protocol.js';

const digest = 'a'.repeat(64);

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;
  private modelId = '';
  private provider: 'openrouter' | 'openai-compatible' = 'openrouter';

  constructor(
    private readonly testResultDelayMs = 0,
    private readonly testCapability: 'tool-loop' | 'plan-only' | 'incompatible' = 'tool-loop',
  ) {}

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (!isMainMessage(message)) return;
    if (message.type === 'configure')
      queueMicrotask(() =>
        this.emit({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'configured',
          status: {
            // The Worker reports the normalized provider; Kilo is OpenAI-compatible.
            provider:
              message.config.provider === 'kilo' ? 'openai-compatible' : message.config.provider,
            modelId: message.config.modelId,
            capability: 'untested',
          },
        }),
      );
    if (message.type === 'configure') {
      this.modelId = message.config.modelId;
      this.provider = message.config.provider === 'openrouter' ? 'openrouter' : 'openai-compatible';
    }
    if (message.type === 'test') {
      const emitResult = () =>
        this.emit({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'test-result',
          status: {
            provider: this.provider,
            modelId: this.modelId || 'model',
            capability: this.testCapability,
            ...(this.testCapability === 'incompatible' ? { message: 'provider unavailable' } : {}),
          },
        });
      if (this.testResultDelayMs > 0) setTimeout(emitResult, this.testResultDelayMs);
      else queueMicrotask(emitResult);
    }
    if (message.type === 'probe-media-capabilities')
      queueMicrotask(() =>
        this.emit({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'media-capability-result',
          requestId: message.requestId,
          report: {
            modelId: this.modelId,
            image: 'supported',
            audio: 'unavailable',
            video: 'supported',
            modalities: ['image', 'video'],
          },
        }),
      );
  }

  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function isMainMessage(value: unknown): value is MainToWorkerMessage {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function event(runId: string, runEpoch: number, seq: number, phase: string, extra: object = {}) {
  return {
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    type: 'event' as const,
    event: {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      runId,
      runEpoch,
      seq,
      at: '2026-09-05T00:00:00.000Z',
      phase,
      ...extra,
    },
  };
}

const hostMethods: HostRpcMethods = {
  read_project_context: {
    parseArgs: (value) => value,
    execute: () => ({ projectId: 'project-1', revision: 'revision-1' }),
    parseResult: (value) => value,
  },
};

async function configuredClient(): Promise<{
  readonly worker: FakeWorker;
  readonly client: ReturnType<typeof createJoyAgentEngineClient>;
}> {
  const worker = new FakeWorker();
  const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
  await client.configure({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'model',
    apiKey: 'session-key',
  });
  return { worker, client };
}

describe('JOY Agent Engine client V2 lifecycle', () => {
  it('mints an epoch, strips structured context, and routes only matching host RPC', async () => {
    const { worker, client } = await configuredClient();
    const cancelled = vi.fn();
    const iterator = client.startRun(
      {
        runId: 'run-1',
        taskKind: 'joy-code',
        prompt: 'trim it',
        baseRevision: 'revision-1',
        mode: 'tool-loop',
        context: { shouldNeverReachWorker: true },
        // UI/request data never gets to choose the provider-visible catalog.
        allowedToolNames: ['read_project_context', 'media_describe'],
      },
      {
        methods: hostMethods,
        allowedToolNames: ['read_project_context'],
        onCancelled: cancelled,
      },
    );
    const run = worker.messages.find(
      (message): message is Extract<MainToWorkerMessage, { type: 'run' }> =>
        isMainMessage(message) && message.type === 'run',
    );
    expect(run?.request).toMatchObject({
      runId: 'run-1',
      runEpoch: 1,
      mode: 'tool-loop',
      allowedToolNames: ['read_project_context'],
    });
    expect(run?.request.context).toBeUndefined();

    worker.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'host-rpc',
      message: {
        protocolVersion: 1,
        type: 'host-rpc-request',
        requestId: 'rpc-1',
        runId: 'run-1',
        runEpoch: 1,
        method: 'read_project_context',
        arguments: {},
        deadlineMs: 100,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = worker.messages.at(-1) as Extract<MainToWorkerMessage, { type: 'host-rpc' }>;
    expect(response).toMatchObject({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'host-rpc',
      message: {
        type: 'host-rpc-response',
        runId: 'run-1',
        runEpoch: 1,
        ok: true,
        result: { projectId: 'project-1' },
      },
    });

    const next = iterator.next();
    worker.emit(
      event('run-1', 1, 1, 'previewing', {
        proposal: {
          summary: 'Trim the intro',
          baseRevision: 'revision-1',
          changeSetId: 'change-set-1',
          operationDigest: digest,
          bindingDigest: 'b'.repeat(64),
          operationCount: 1,
        },
      }),
    );
    expect((await next).value).toMatchObject({ phase: 'previewing', runEpoch: 1 });
    worker.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run-finished',
      runId: 'run-1',
      runEpoch: 1,
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await client.cancel('run-1');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(worker.messages.at(-1)).toMatchObject({ type: 'cancel', runId: 'run-1', runEpoch: 1 });
  });

  it('ignores stale events and finishes from a prior epoch when a run id is reused', async () => {
    const { worker, client } = await configuredClient();
    const first = client.startRun(
      { runId: 'reused', prompt: 'first', mode: 'tool-loop' },
      { methods: hostMethods },
    );
    await client.cancel('reused');
    await expect(first.next()).resolves.toMatchObject({ done: true });
    const second = client.startRun(
      { runId: 'reused', prompt: 'second', mode: 'tool-loop' },
      { methods: hostMethods },
    );
    const pending = second.next();
    worker.emit(event('reused', 1, 99, 'failed', { errorCode: 'JOY_AGENT_ABORTED' }));
    worker.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run-finished',
      runId: 'reused',
      runEpoch: 1,
    });
    worker.emit(event('reused', 2, 1, 'thinking'));
    expect((await pending).value).toMatchObject({ runEpoch: 2, phase: 'thinking' });
  });

  it('fails active work with an actionable reconnect error for invalid cached Worker data', async () => {
    const { worker, client } = await configuredClient();
    const iterator = client.startRun(
      { runId: 'run-1', prompt: 'edit', mode: 'tool-loop' },
      { methods: hostMethods },
    );
    const pending = iterator.next();
    worker.emit({ protocolVersion: 1, type: 'event', event: {} });
    await expect(pending).rejects.toThrow('Reconnect the model and reload this page');
    expect(worker.terminated).toBe(true);
  });

  it('configures and tests one Worker-backed session', async () => {
    const { worker, client } = await configuredClient();
    await expect(client.testConnection()).resolves.toMatchObject({ capability: 'tool-loop' });
    expect(
      worker.messages.filter((message) => isMainMessage(message) && message.type === 'configure'),
    ).toHaveLength(1);
    expect(
      worker.messages.filter(
        (message) => isMainMessage(message) && message.type === 'probe-media-capabilities',
      ),
    ).toHaveLength(0);
  });

  it('requires both Dual-Brain workers to pass before reporting tool-loop readiness', async () => {
    const workers = [new FakeWorker(0, 'tool-loop'), new FakeWorker(0, 'incompatible')];
    let index = 0;
    const client = createJoyAgentEngineClient(() => workers[index++] as unknown as Worker);
    const config = {
      mode: 'dual-brain' as const,
      workhorse: {
        provider: 'openrouter' as const,
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'openrouter/free',
        apiKey: 'only-openrouter-key',
      },
      creative: {
        provider: 'kilo' as const,
        baseUrl: 'https://api.kilo.ai/v1',
        modelId: 'kilo-auto/efficient',
        apiKey: 'only-kilo-key',
      },
    };
    await client.configure(config);
    const status = await client.testConnection();

    expect(status.capability).toBe('incompatible');
    expect(status.dualBrain?.workhorse.capability).toBe('tool-loop');
    expect(status.dualBrain?.creative.capability).toBe('incompatible');
    const workerConfigs = workers.map(
      (worker) =>
        worker.messages.find(
          (message): message is Extract<MainToWorkerMessage, { type: 'configure' }> =>
            isMainMessage(message) && message.type === 'configure',
        )?.config,
    );
    expect(workerConfigs[0]?.apiKey).toBe('only-openrouter-key');
    expect(workerConfigs[1]?.apiKey).toBe('only-kilo-key');
  });

  it('runs a media capability probe only when explicitly requested and keeps it session-only', async () => {
    const { worker, client } = await configuredClient();

    expect(client.getMediaCapabilities()).toBeUndefined();
    await client.testConnection();
    expect(client.getMediaCapabilities()).toBeUndefined();

    await expect(client.probeMediaCapabilities()).resolves.toEqual({
      modelId: 'model',
      image: 'supported',
      audio: 'unavailable',
      video: 'supported',
      modalities: ['image', 'video'],
    });
    expect(client.getMediaCapabilities()).toEqual({
      modelId: 'model',
      image: 'supported',
      audio: 'unavailable',
      video: 'supported',
      modalities: ['image', 'video'],
    });
    expect(
      worker.messages.filter(
        (message) => isMainMessage(message) && message.type === 'probe-media-capabilities',
      ),
    ).toHaveLength(1);

    client.clear();
    expect(client.getMediaCapabilities()).toBeUndefined();
  });

  it('rejects a hostile media report before it can become client state', async () => {
    const { worker, client } = await configuredClient();
    const pending = client.probeMediaCapabilities();
    worker.emit({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'media-capability-result',
      requestId: 'media-probe-1',
      report: {
        modelId: 'model',
        image: 'supported',
        audio: 'unavailable',
        video: 'unavailable',
        modalities: ['image'],
        apiKey: 'sk-owner-secret-must-not-appear',
      },
    });

    await expect(pending).rejects.toThrow('Reconnect the model and reload this page');
    expect(client.getMediaCapabilities()).toBeUndefined();
    expect(worker.terminated).toBe(true);
  });

  it('notifies a plan-only lifecycle hook only when the connection is cleared or reconfigured', async () => {
    const { worker, client } = await configuredClient();
    const onConnectionCleared = vi.fn();
    const first = client.startRun(
      { runId: 'plan-only-clear', prompt: 'summarize the project', mode: 'plan-only' },
      undefined,
      { onConnectionCleared },
    );
    worker.emit(event('plan-only-clear', 1, 1, 'thinking'));

    client.clear();

    // A queued event belongs to the cleared connection and must never leak to
    // a later consumer after teardown.
    await expect(first.next()).resolves.toMatchObject({ done: true });
    expect(onConnectionCleared).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);

    const replacementWorker = new FakeWorker();
    const replacementClient = createJoyAgentEngineClient(
      () => replacementWorker as unknown as Worker,
    );
    await replacementClient.configure({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'model',
      apiKey: 'session-key',
    });
    const reconfigured = vi.fn();
    const second = replacementClient.startRun(
      { runId: 'plan-only-reconfigure', prompt: 'summarize the project', mode: 'plan-only' },
      undefined,
      { onConnectionCleared: reconfigured },
    );
    const pendingSecond = second.next();

    await replacementClient.configure({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'model-next',
      apiKey: 'session-key-next',
    });

    await expect(pendingSecond).resolves.toMatchObject({ done: true });
    expect(reconfigured).toHaveBeenCalledOnce();

    const untouched = vi.fn();
    const third = replacementClient.startRun(
      { runId: 'plan-only-cancel', prompt: 'summarize the project', mode: 'plan-only' },
      undefined,
      { onConnectionCleared: untouched },
    );
    const pendingThird = third.next();
    await replacementClient.cancel('plan-only-cancel');
    await expect(pendingThird).resolves.toMatchObject({ done: true });
    expect(untouched).not.toHaveBeenCalled();

    const failureHook = vi.fn();
    const fourth = replacementClient.startRun(
      { runId: 'plan-only-worker-failure', prompt: 'summarize the project', mode: 'plan-only' },
      undefined,
      { onConnectionCleared: failureHook },
    );
    const pendingFourth = fourth.next();
    replacementWorker.onerror?.();
    await expect(pendingFourth).rejects.toThrow('JOY Agent Worker failed');
    expect(failureHook).not.toHaveBeenCalled();
  });

  it('does not preempt the Worker’s bounded connection result', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(15_000);
      const client = createJoyAgentEngineClient(() => worker as unknown as Worker);
      const configured = client.configure({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        modelId: 'model',
        apiKey: 'session-key',
      });
      await vi.runAllTicks();
      await configured;

      const status = client.testConnection();
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(status).resolves.toMatchObject({ capability: 'tool-loop' });
      expect(worker.terminated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
