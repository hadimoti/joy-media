import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostRpcHost,
  HostRpcDiagnosticError,
  type HostRpcJson,
  type HostRpcMethods,
  type HostRpcWireMessage,
} from './host-rpc.js';
import {
  JOY_AGENT_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
} from './protocol.js';
import {
  PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
  PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN,
  PROVIDER_TOOL_PROBE_RESULT,
} from './provider-capabilities.js';
import {
  createPrivateObservationPortBind,
  MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES,
  type PrivateObservationMainToWorkerMessage,
  type PrivateObservationWorkerToMainMessage,
} from './observation-transfer-port-protocol.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

type HostHandler = (args: HostRpcJson) => HostRpcJson | Promise<HostRpcJson>;
type ProviderHandler = (
  body: Readonly<Record<string, unknown>>,
  callIndex: number,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

interface MountedWorker {
  readonly output: WorkerToMainMessage[];
  readonly fetcher: ReturnType<typeof vi.fn>;
  send(message: MainToWorkerMessage): void;
  sendRaw(message: unknown): void;
  bindPrivateObservationPort(): MountedPrivateObservationPort;
}

interface MountedPrivateObservationPort {
  readonly output: PrivateObservationWorkerToMainMessage[];
  send(message: PrivateObservationMainToWorkerMessage): void;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerResponse(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    headers: { 'content-type': 'application/json' },
  });
}

function providerToolResponse(id: string, name: string, args: HostRpcJson = {}): Response {
  return providerResponse({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
}

function providerTextResponse(content: string): Response {
  return providerResponse({ role: 'assistant', content });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON request body');
  const value = JSON.parse(init.body) as unknown;
  if (!isRecord(value)) throw new Error('Expected JSON request object');
  return value;
}

function defaultHostMethods(
  handlers: Partial<Record<'read_project_context' | 'validate_proposal', HostHandler>> = {},
): HostRpcMethods {
  const parse = (value: HostRpcJson): HostRpcJson => value;
  return {
    read_project_context: {
      parseArgs: parse,
      execute: handlers.read_project_context ?? (() => ({ domain: 'overview', records: [] })),
      parseResult: parse,
    },
    validate_proposal: {
      parseArgs: parse,
      execute:
        handlers.validate_proposal ??
        (() => ({
          summary: 'Prepared preview',
          baseRevision: 'revision-1',
          changeSetId: 'change-set-1',
          operationDigest: DIGEST_A,
          bindingDigest: DIGEST_B,
          operationCount: 1,
        })),
      parseResult: parse,
    },
  } as HostRpcMethods;
}

/**
 * Mount the real Worker module with a real host-RPC host on the opposite side
 * of the V2 envelope. The test harness intentionally has no editor writer,
 * persistence object, or BYOK credential outside of the Worker configuration.
 */
async function mountedWorker(
  provider: ProviderHandler,
  hostMethods: HostRpcMethods = defaultHostMethods(),
): Promise<MountedWorker> {
  const output: WorkerToMainMessage[] = [];
  let receive: ((event: MessageEvent<unknown>) => void) | undefined;
  const sendRaw = (message: unknown): void => {
    if (receive === undefined) throw new Error('Worker listener was not mounted');
    receive({ data: message } as MessageEvent<unknown>);
  };
  const host = createHostRpcHost({
    methods: hostMethods,
    transport: {
      postMessage(message: HostRpcWireMessage): void {
        queueMicrotask(() =>
          sendRaw({
            protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
            type: 'host-rpc',
            message,
          }),
        );
      },
    },
  });
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    provider(parseBody(init), fetcher.mock.calls.length - 1, init),
  );

  vi.stubGlobal(
    'addEventListener',
    (_type: string, listener: (event: MessageEvent<unknown>) => void) => {
      receive = listener;
    },
  );
  vi.stubGlobal('postMessage', (message: WorkerToMainMessage) => {
    output.push(message);
    if (
      message.type === 'host-rpc' &&
      (message.message.type === 'host-rpc-request' || message.message.type === 'host-rpc-cancel')
    ) {
      host.receive(message.message);
    }
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('close', vi.fn());
  await import('./engine.worker.js');

  const send = (message: MainToWorkerMessage): void => sendRaw(message);
  send({
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    type: 'configure',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      modelId: 'fixture-model',
      apiKey: 'fixture-only',
    },
  });
  await vi.waitFor(() =>
    expect(output).toContainEqual(
      expect.objectContaining({ type: 'configured', protocolVersion: JOY_AGENT_PROTOCOL_VERSION }),
    ),
  );
  const bindPrivateObservationPort = (): MountedPrivateObservationPort => {
    const channel = new MessageChannel();
    const privateOutput: PrivateObservationWorkerToMainMessage[] = [];
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (typeof message === 'object' && message !== null)
        privateOutput.push(message as PrivateObservationWorkerToMainMessage);
    };
    channel.port1.start();
    if (receive === undefined) throw new Error('Worker listener was not mounted');
    receive({
      data: createPrivateObservationPortBind(1),
      ports: [channel.port2],
    } as unknown as MessageEvent<unknown>);
    return {
      output: privateOutput,
      send(message: PrivateObservationMainToWorkerMessage): void {
        channel.port1.postMessage(message);
      },
      close(): void {
        channel.port1.close();
      },
    };
  };
  return { output, fetcher, send, sendRaw, bindPrivateObservationPort };
}

async function verifyStructuredConnection(worker: MountedWorker): Promise<void> {
  worker.send({ protocolVersion: JOY_AGENT_PROTOCOL_VERSION, type: 'test' });
  await vi.waitFor(() =>
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'test-result',
        status: expect.objectContaining({ capability: 'tool-loop' }),
      }),
    ),
  );
}

async function waitForMediaCapabilityReport(
  worker: MountedWorker,
  requestId = 'media-probe-1',
): Promise<Extract<WorkerToMainMessage, { type: 'media-capability-result' }>['report']> {
  await vi.waitFor(() =>
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'media-capability-result',
        requestId,
      }),
    ),
  );
  const result = worker.output.find(
    (message): message is Extract<WorkerToMainMessage, { type: 'media-capability-result' }> =>
      message.type === 'media-capability-result' && message.requestId === requestId,
  );
  if (result === undefined) throw new Error('Expected a media capability result');
  return result.report;
}

function run(
  worker: MountedWorker,
  request: Omit<Extract<MainToWorkerMessage, { type: 'run' }>['request'], 'runEpoch'> & {
    readonly runEpoch?: number;
  },
): void {
  worker.send({
    protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
    type: 'run',
    request: { ...request, runEpoch: request.runEpoch ?? 1 },
  });
}

async function waitForRunFinished(
  worker: MountedWorker,
  runId: string,
  runEpoch: number,
): Promise<void> {
  await vi.waitFor(() =>
    expect(worker.output).toContainEqual({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run-finished',
      runId,
      runEpoch,
    }),
  );
}

function structuredProvider(exchange: ProviderHandler): ProviderHandler {
  return (body, index, init) => {
    if (index === 0) return providerToolResponse('probe-1', 'joy_probe');
    if (index === 1) return providerTextResponse(PROVIDER_TOOL_PROBE_CONTINUATION_TOKEN);
    if (index === 2) return providerTextResponse('plan-only probe ready');
    return exchange(body, index - 3, init);
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('JOY Agent Engine Worker V2', () => {
  it('requires a named, schema-valid probe continuation and a distinct no-tools plan probe', async () => {
    const bodies: Record<string, unknown>[] = [];
    const worker = await mountedWorker(
      structuredProvider((body) => {
        bodies.push(body);
        return providerTextResponse('unused');
      }),
    );

    await verifyStructuredConnection(worker);

    const requests = worker.fetcher.mock.calls.map(([, init]) => parseBody(init));
    expect(requests).toHaveLength(3);
    const [initialRequest, continuationRequest, planOnlyRequest] = requests;
    if (
      initialRequest === undefined ||
      continuationRequest === undefined ||
      planOnlyRequest === undefined
    ) {
      throw new Error('Expected the full provider capability probe');
    }
    expect(initialRequest).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'joy_probe' } },
      tools: [
        expect.objectContaining({ function: expect.objectContaining({ name: 'joy_probe' }) }),
      ],
    });
    expect(continuationRequest).toMatchObject({ tool_choice: 'none' });
    const continuationMessages = continuationRequest.messages as Record<string, unknown>[];
    expect(continuationMessages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'probe-1',
      content: PROVIDER_TOOL_PROBE_RESULT,
    });
    expect(continuationMessages.some((message) => message.role === 'assistant')).toBe(true);
    expect(planOnlyRequest.tools).toBeUndefined();
    expect(planOnlyRequest.tool_choice).toBeUndefined();
    expect(JSON.stringify(worker.output)).not.toContain('fixture-only');
    expect(bodies).toHaveLength(0);
  });

  it('bounds a connection probe even when the provider ignores the abort signal', async () => {
    const worker = await mountedWorker(() => new Promise<Response>(() => undefined));
    vi.useFakeTimers();
    worker.send({ protocolVersion: JOY_AGENT_PROTOCOL_VERSION, type: 'test' });

    await vi.advanceTimersByTimeAsync(15_001);
    await Promise.resolve();

    expect(worker.output).toContainEqual(
      expect.objectContaining({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'test-result',
        status: expect.objectContaining({
          capability: 'incompatible',
          message: 'Connection timed out',
        }),
      }),
    );
    expect(worker.fetcher).toHaveBeenCalledTimes(1);
  });

  it('only probes synthetic media after the explicit request and records partial support', async () => {
    const providerBodies: Record<string, unknown>[] = [];
    const worker = await mountedWorker((body) => {
      providerBodies.push(body);
      const content = (body.messages as readonly Record<string, unknown>[])[0]?.content;
      if (!Array.isArray(content)) throw new Error('Expected an explicit multimodal content array');
      const media = content[1] as Record<string, unknown> | undefined;
      if (media?.type === 'image_url')
        return providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
        });
      if (media?.type === 'input_audio')
        return providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
        });
      if (media?.type === 'video_url')
        return providerResponse({ role: 'assistant', content: 'Video input is unavailable.' });
      throw new Error('Unexpected synthetic media type');
    });

    // Configuration itself made zero provider calls; the tool-loop readiness
    // check remains its own, separately invoked probe.
    expect(worker.fetcher).not.toHaveBeenCalled();
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities',
      requestId: 'media-probe-1',
    });

    await expect(waitForMediaCapabilityReport(worker)).resolves.toEqual({
      modelId: 'fixture-model',
      image: 'supported',
      audio: 'supported',
      video: 'unavailable',
      modalities: ['image', 'audio'],
    });
    expect(providerBodies).toHaveLength(3);
    for (const body of providerBodies) {
      expect(body).toMatchObject({ model: 'fixture-model', max_tokens: 8 });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      const content = (body.messages as readonly Record<string, unknown>[])[0]?.content;
      expect(Array.isArray(content)).toBe(true);
    }
    const serializedOutput = JSON.stringify(worker.output);
    expect(serializedOutput).not.toContain('fixture-only');
    expect(serializedOutput).not.toContain('data:image');
    expect(serializedOutput).not.toContain('data:video');
    expect(serializedOutput).not.toContain(PROVIDER_MEDIA_CAPABILITY_PROBE_ACK);
  });

  it('rejects a hostile private image request above the first-release cap before requesting evidence', async () => {
    const worker = await mountedWorker(
      structuredProvider((body, _index, init) => {
        const content = (body.messages as readonly Record<string, unknown>[])[0]?.content;
        if (Array.isArray(content))
          return providerResponse({
            role: 'assistant',
            content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
          });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    );
    await verifyStructuredConnection(worker);
    const port = worker.bindPrivateObservationPort();
    const authority = {
      projectId: 'project-1',
      revision: 'revision-1',
      run: { runId: 'private-review-run', epoch: 1 },
      modelId: 'fixture-model',
      promptPolicyDigest: 'policy-1',
    } as const;
    const range = { domain: 'source' as const, startUs: 0, endUs: 1_000_000 };
    const evidenceIds = ['frame-1'] as const;
    const expiresAtMs = Date.now() + 60_000;

    await vi.waitFor(() =>
      expect(port.output).toContainEqual(
        expect.objectContaining({ type: 'session-ready', sessionEpoch: 1 }),
      ),
    );
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities',
      requestId: 'private-port-image-capability',
    });
    await expect(
      waitForMediaCapabilityReport(worker, 'private-port-image-capability'),
    ).resolves.toMatchObject({
      image: 'supported',
    });

    run(worker, { runId: authority.run.runId, prompt: 'hold this run', mode: 'plan-only' });
    await vi.waitFor(() => expect(worker.fetcher).toHaveBeenCalledTimes(7));
    port.send({
      type: 'register-review-lease',
      requestId: 'private-lease-request',
      sessionEpoch: 1,
      authority,
      manifestId: 'manifest-1',
      range,
      evidenceIds,
      expiresAtMs,
    });
    await vi.waitFor(() =>
      expect(port.output).toContainEqual(
        expect.objectContaining({ type: 'lease-registered', requestId: 'private-lease-request' }),
      ),
    );
    const lease = port.output.find(
      (
        message,
      ): message is Extract<
        PrivateObservationWorkerToMainMessage,
        { readonly type: 'lease-registered' }
      > => message.type === 'lease-registered' && message.requestId === 'private-lease-request',
    );
    if (lease === undefined) throw new Error('Expected a private review lease');

    port.send({
      type: 'start',
      transferId: 'hostile-private-transfer',
      sessionEpoch: 1,
      leaseId: lease.leaseId,
      authority,
      range,
      evidenceIds,
      maxBytes: MAX_PRIVATE_OBSERVATION_FIRST_RELEASE_BYTES + 1,
      expiresAtMs,
      prompt: 'review approved evidence',
    });
    await vi.waitFor(() =>
      expect(port.output).toContainEqual(
        expect.objectContaining({
          type: 'result',
          transferId: 'hostile-private-transfer',
          result: { ok: false, code: 'invalid-request' },
        }),
      ),
    );
    expect(port.output.some((message) => message.type === 'need-evidence')).toBe(false);
    expect(worker.fetcher).toHaveBeenCalledTimes(7);

    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'cancel',
      runId: authority.run.runId,
      runEpoch: authority.run.epoch,
    });
    await waitForRunFinished(worker, authority.run.runId, authority.run.epoch);
    port.close();
  });

  it('fails closed for hostile media responses without exposing provider data', async () => {
    const secret = 'sk-owner-secret-must-not-appear';
    const worker = await mountedWorker((body) => {
      const content = (body.messages as readonly Record<string, unknown>[])[0]?.content;
      const media = Array.isArray(content)
        ? (content[1] as Record<string, unknown> | undefined)
        : undefined;
      if (media?.type === 'image_url')
        return providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
        });
      if (media?.type === 'input_audio')
        return providerResponse({
          role: 'assistant',
          content: PROVIDER_MEDIA_CAPABILITY_PROBE_ACK,
          tool_calls: [],
          apiKey: secret,
        });
      return new Response('{"choices":', { headers: { 'content-type': 'application/json' } });
    });

    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities',
      requestId: 'hostile-media',
    });

    await expect(waitForMediaCapabilityReport(worker, 'hostile-media')).resolves.toEqual({
      modelId: 'fixture-model',
      image: 'supported',
      audio: 'unavailable',
      video: 'unavailable',
      modalities: ['image'],
    });
    expect(JSON.stringify(worker.output)).not.toContain(secret);
    expect(JSON.stringify(worker.output)).not.toContain('"choices"');
  });

  it('bounds explicit media probes even if every provider request ignores abort', async () => {
    const worker = await mountedWorker(() => new Promise<Response>(() => undefined));
    vi.useFakeTimers();
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities',
      requestId: 'media-timeout',
    });

    await vi.advanceTimersByTimeAsync(4_001);
    await Promise.resolve();

    expect(await waitForMediaCapabilityReport(worker, 'media-timeout')).toEqual({
      modelId: 'fixture-model',
      image: 'unavailable',
      audio: 'unavailable',
      video: 'unavailable',
      modalities: [],
    });
    expect(worker.fetcher).toHaveBeenCalledTimes(3);
  });

  it('cancels a stale media probe when its configured model session is replaced', async () => {
    const worker = await mountedWorker(
      (_body, _index, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities',
      requestId: 'stale-media',
    });
    await vi.waitFor(() => expect(worker.fetcher).toHaveBeenCalledTimes(3));
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'configure',
      config: {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        modelId: 'replacement-model',
        apiKey: 'replacement-fixture-only',
      },
    });

    await vi.waitFor(() =>
      expect(worker.output).toContainEqual(
        expect.objectContaining({
          type: 'error',
          requestId: 'stale-media',
          code: 'JOY_AGENT_ABORTED',
        }),
      ),
    );
    expect(
      worker.output.some(
        (message) =>
          message.type === 'media-capability-result' && message.requestId === 'stale-media',
      ),
    ).toBe(false);
  });

  it('rejects injected structured context and sends only prompt plus host-RPC facts to the provider', async () => {
    const providerBodies: Record<string, unknown>[] = [];
    const worker = await mountedWorker(
      structuredProvider((body) => {
        providerBodies.push(body);
        if (providerBodies.length === 1)
          return providerTextResponse(JSON.stringify({ summary: 'A safe answer' }));
        throw new Error('Unexpected structured provider request');
      }),
    );
    await verifyStructuredConnection(worker);

    worker.sendRaw({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run',
      request: {
        runId: 'blocked-context',
        runEpoch: 1,
        prompt: 'edit',
        mode: 'tool-loop',
        context: { privateMarker: 'TOP_SECRET_CONTEXT' },
      },
    });
    await Promise.resolve();
    expect(worker.fetcher).toHaveBeenCalledTimes(3);

    run(worker, {
      runId: 'no-context',
      runEpoch: 4,
      prompt: 'Answer without editing',
      mode: 'tool-loop',
    });
    await waitForRunFinished(worker, 'no-context', 4);
    expect(providerBodies).toHaveLength(1);
    const providerBody = providerBodies[0];
    if (providerBody === undefined) throw new Error('Expected structured provider request');
    expect(JSON.stringify(providerBody)).not.toContain('TOP_SECRET_CONTEXT');
    const messages = providerBody.messages as Record<string, unknown>[];
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Answer without editing' });
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          runId: 'no-context',
          runEpoch: 4,
          phase: 'completed',
          result: { kind: 'answer', text: 'A safe answer' },
        }),
      }),
    );
  });

  it('uses host RPC for read → canonical repair → opaque prepared preview and preserves the outer epoch', async () => {
    let validationAttempts = 0;
    const validateArgs: HostRpcJson[] = [];
    const worker = await mountedWorker(
      structuredProvider((_body, exchangeIndex) => {
        if (exchangeIndex === 0)
          return providerToolResponse('read-1', 'read_project_context', { domain: 'overview' });
        if (exchangeIndex === 1)
          return providerToolResponse('invalid-1', 'validate_proposal', {
            summary: 'Caption pass',
            operations: [{ kind: 'caption.setBurnIn', enabled: 'yes' }],
          });
        if (exchangeIndex === 2)
          return providerToolResponse('repair-1', 'validate_proposal', {
            summary: 'Caption pass',
            operations: [{ kind: 'caption.setBurnIn', enabled: true }],
          });
        throw new Error(`Unexpected exchange ${exchangeIndex}`);
      }),
      defaultHostMethods({
        read_project_context: () => ({
          domain: 'overview',
          revision: 'revision-42',
          records: [{ id: 'track-1', title: 'Captions' }],
        }),
        validate_proposal: (args) => {
          validateArgs.push(args);
          validationAttempts += 1;
          if (validationAttempts === 1) {
            throw new HostRpcDiagnosticError({
              code: 'JOY_AGENT_RPC_CANONICAL_REJECTED',
              retryable: true,
              operation: 'caption.setBurnIn',
              field: 'enabled',
              facts: { requiredType: 'boolean' },
            });
          }
          return {
            summary: 'Caption pass',
            baseRevision: 'revision-42',
            changeSetId: 'prepared-change-42',
            operationDigest: DIGEST_A,
            bindingDigest: DIGEST_B,
            operationCount: 1,
          };
        },
      }),
    );
    await verifyStructuredConnection(worker);

    run(worker, {
      runId: 'semantic-preview',
      runEpoch: 7,
      prompt: 'Make captions readable',
      baseRevision: 'revision-42',
      mode: 'tool-loop',
    });
    await waitForRunFinished(worker, 'semantic-preview', 7);

    expect(validationAttempts).toBe(2);
    expect(validateArgs).toHaveLength(2);
    const proposalEvent = worker.output.find(
      (message) =>
        message.type === 'event' &&
        message.event.runId === 'semantic-preview' &&
        message.event.phase === 'previewing' &&
        message.event.proposal !== undefined,
    );
    if (proposalEvent?.type !== 'event' || proposalEvent.event.proposal === undefined)
      throw new Error('Expected opaque prepared proposal');
    expect(proposalEvent.event).toMatchObject({ runEpoch: 7, phase: 'previewing' });
    expect(proposalEvent.event.proposal).toEqual({
      summary: 'Caption pass',
      baseRevision: 'revision-42',
      changeSetId: 'prepared-change-42',
      operationDigest: DIGEST_A,
      bindingDigest: DIGEST_B,
      operationCount: 1,
    });
    expect('operations' in proposalEvent.event.proposal).toBe(false);
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({ phase: 'awaiting-approval', runEpoch: 7 }),
      }),
    );
    expect(JSON.stringify(worker.output)).not.toContain('fixture-only');
  });

  it('uses the exact host-approved observation catalog and marks its reads as inspecting', async () => {
    let advertisedNames: unknown;
    const parse = (value: HostRpcJson): HostRpcJson => value;
    const worker = await mountedWorker(
      structuredProvider((body, exchangeIndex) => {
        if (exchangeIndex === 0) {
          advertisedNames = (
            body.tools as { readonly function?: { readonly name?: unknown } }[]
          ).map((tool) => tool.function?.name);
          return providerToolResponse('read-observation-context', 'read_project_context', {
            domain: 'overview',
          });
        }
        if (exchangeIndex === 1)
          return providerToolResponse('describe-observation-asset', 'media_describe', {
            assetId: 'asset-1',
          });
        if (exchangeIndex === 2)
          return providerTextResponse(JSON.stringify({ summary: 'The intro is ready to review.' }));
        throw new Error(`Unexpected observation exchange ${exchangeIndex}`);
      }),
      {
        ...defaultHostMethods(),
        media_describe: {
          parseArgs: parse,
          execute: () => ({
            assetId: 'asset-1',
            assetDigest: DIGEST_A,
            kind: 'video',
            durationUs: 1_000_000,
            streamCount: 1,
            transcriptAvailable: false,
          }),
          parseResult: parse,
        },
      },
    );
    await verifyStructuredConnection(worker);

    run(worker, {
      runId: 'observation-catalog',
      runEpoch: 8,
      prompt: 'Inspect the intro before suggesting edits',
      mode: 'tool-loop',
      allowedToolNames: ['read_project_context', 'media_describe'],
    });
    await waitForRunFinished(worker, 'observation-catalog', 8);

    expect(advertisedNames).toEqual(['read_project_context', 'media_describe']);
    expect(
      worker.output.filter(
        (message) =>
          message.type === 'event' &&
          message.event.runId === 'observation-catalog' &&
          message.event.phase === 'inspecting',
      ),
    ).toHaveLength(2);
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          runId: 'observation-catalog',
          phase: 'completed',
          result: { kind: 'answer', text: 'The intro is ready to review.' },
        }),
      }),
    );
  });

  it('permits non-mutating answer and clarification results with zero edit operations', async () => {
    const worker = await mountedWorker(
      structuredProvider((_body, exchangeIndex) =>
        exchangeIndex === 0
          ? providerTextResponse(JSON.stringify({ summary: 'The timeline is ready to review.' }))
          : providerTextResponse(JSON.stringify({ question: 'Which clip should be shorter?' })),
      ),
    );
    await verifyStructuredConnection(worker);

    run(worker, { runId: 'answer', runEpoch: 1, prompt: 'What can improve?', mode: 'tool-loop' });
    await waitForRunFinished(worker, 'answer', 1);
    run(worker, { runId: 'clarify', runEpoch: 3, prompt: 'Make it better', mode: 'tool-loop' });
    await waitForRunFinished(worker, 'clarify', 3);

    const completed = worker.output.filter(
      (message) => message.type === 'event' && message.event.phase === 'completed',
    );
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            result: { kind: 'answer', text: 'The timeline is ready to review.' },
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            result: { kind: 'clarification', question: 'Which clip should be shorter?' },
          }),
        }),
      ]),
    );
    expect(
      worker.output.some(
        (message) => message.type === 'event' && message.event.proposal !== undefined,
      ),
    ).toBe(false);
  });

  it.each([
    ['URL', 'https://provider.example.invalid/private-result'],
    ['credential', 'sk-abcdefghijklmnopqrst'],
  ])(
    'rejects a provider-derived %s-shaped result before it reaches the UI',
    async (_kind, unsafe) => {
      const worker = await mountedWorker(
        structuredProvider((_body, exchangeIndex) => {
          expect(exchangeIndex).toBe(0);
          return providerTextResponse(unsafe);
        }),
      );
      await verifyStructuredConnection(worker);

      run(worker, {
        runId: `unsafe-${_kind.toLowerCase()}`,
        runEpoch: 9,
        prompt: 'Give a safe answer',
        mode: 'plan-only',
      });
      await waitForRunFinished(worker, `unsafe-${_kind.toLowerCase()}`, 9);

      expect(worker.output).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: expect.objectContaining({
            runId: `unsafe-${_kind.toLowerCase()}`,
            runEpoch: 9,
            phase: 'failed',
            errorCode: 'JOY_AGENT_INVALID_PROPOSAL',
          }),
        }),
      );
      expect(
        worker.output.some(
          (message) =>
            message.type === 'event' &&
            message.event.runId === `unsafe-${_kind.toLowerCase()}` &&
            message.event.phase === 'completed',
        ),
      ).toBe(false);
      expect(JSON.stringify(worker.output)).not.toContain(unsafe);
    },
  );

  it('cancels an in-flight provider turn, cancels the matching host epoch, and closes the run', async () => {
    let exchangeCalls = 0;
    const worker = await mountedWorker(
      structuredProvider((_body, exchangeIndex, init) => {
        exchangeCalls += 1;
        if (exchangeIndex === 0)
          return providerToolResponse('read-before-cancel', 'read_project_context', {
            domain: 'overview',
          });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    );
    await verifyStructuredConnection(worker);

    run(worker, { runId: 'cancel-me', runEpoch: 5, prompt: 'Edit', mode: 'tool-loop' });
    await vi.waitFor(() => expect(exchangeCalls).toBe(2));
    worker.send({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'cancel',
      runId: 'cancel-me',
      runEpoch: 5,
    });
    await waitForRunFinished(worker, 'cancel-me', 5);

    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          runId: 'cancel-me',
          runEpoch: 5,
          phase: 'cancelled',
          errorCode: 'JOY_AGENT_ABORTED',
        }),
      }),
    );
    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'host-rpc',
        message: expect.objectContaining({
          type: 'host-rpc-cancel',
          runId: 'cancel-me',
          runEpoch: 5,
        }),
      }),
    );
  });

  it('turns an expired host-RPC deadline into a bounded timeout failure', async () => {
    const worker = await mountedWorker(
      structuredProvider((_body, exchangeIndex) => {
        if (exchangeIndex === 0)
          return providerToolResponse('read-timeout', 'read_project_context', {
            domain: 'overview',
          });
        throw new Error('The host call should stop the exchange before another provider call');
      }),
      defaultHostMethods({
        read_project_context: () => new Promise<HostRpcJson>(() => undefined),
      }),
    );
    await verifyStructuredConnection(worker);

    vi.useFakeTimers();
    run(worker, { runId: 'timeout', runEpoch: 2, prompt: 'Inspect', mode: 'tool-loop' });
    await vi.advanceTimersByTimeAsync(15_001);
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.output).toContainEqual(
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          runId: 'timeout',
          runEpoch: 2,
          phase: 'failed',
          errorCode: 'JOY_AGENT_TIMEOUT',
        }),
      }),
    );
    expect(worker.output).toContainEqual({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run-finished',
      runId: 'timeout',
      runEpoch: 2,
    });
  });

  it('fails closed with an actionable V2 reload message for a stale V1 envelope', async () => {
    const worker = await mountedWorker(() => providerTextResponse('unused'));
    worker.sendRaw({
      protocolVersion: 1,
      type: 'run',
      request: { runId: 'legacy', prompt: 'edit', mode: 'tool-loop' },
    });

    await vi.waitFor(() =>
      expect(worker.output).toContainEqual({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'error',
        code: 'JOY_AGENT_PROTOCOL_MISMATCH',
        message: 'JOY Agent Engine updated. Reconnect the model and reload this page.',
      }),
    );
    expect(worker.fetcher).not.toHaveBeenCalled();
  });
});
