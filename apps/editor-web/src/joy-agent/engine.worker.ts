import type {
  ByokSessionConfig,
  ByokSessionStatus,
  JoyAgentRunRequest,
  MainToWorkerMessage,
  JoyAgentPhase,
  JoyAgentTaskKind,
  JoyAgentErrorCode,
} from './protocol.js';
import { JOY_AGENT_PROTOCOL_VERSION } from './protocol.js';
import {
  BROWSER_AGENT_TOOLS,
  runBoundedToolExchange,
  validateBrowserProposal,
} from './bounded-tool-loop.js';

let session: ByokSessionConfig | undefined;
const runs = new Map<string, AbortController>();
const RUN_TIMEOUT_MS = 60_000;

class JoyAgentWorkerError extends Error {
  constructor(
    readonly code: JoyAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JoyAgentWorkerError';
  }
}
const status = (
  capability: ByokSessionStatus['capability'],
  message?: string,
): ByokSessionStatus => ({
  provider: session?.provider ?? 'openai-compatible',
  modelId: session?.modelId ?? '',
  capability,
  ...(message ? { message } : {}),
});
function emit(
  runId: string,
  seq: number,
  phase: JoyAgentPhase,
  message?: string,
  proposal?: {
    readonly summary: string;
    readonly operations: readonly unknown[];
    readonly baseRevision: string;
  },
  extras?: {
    readonly taskKind?: JoyAgentTaskKind;
    readonly result?: unknown;
    readonly errorCode?: JoyAgentErrorCode;
  },
) {
  globalThis.postMessage({
    protocolVersion: 1,
    type: 'event',
    event: {
      protocolVersion: 1,
      runId,
      seq,
      at: new Date().toISOString(),
      phase,
      ...(message ? { message } : {}),
      ...(proposal ? { proposal } : {}),
      ...(extras?.taskKind ? { taskKind: extras.taskKind } : {}),
      ...(extras?.result !== undefined ? { result: extras.result } : {}),
      ...(extras?.errorCode ? { errorCode: extras.errorCode } : {}),
    },
  });
}
async function configure(config: ByokSessionConfig) {
  if (
    !isSafeBaseUrl(config.baseUrl) ||
    config.baseUrl.length > 2_048 ||
    config.apiKey.length === 0 ||
    config.apiKey.length > 4_096 ||
    config.modelId.length === 0 ||
    config.modelId.length > 256
  )
    throw new Error('Invalid model connection');
  session = { ...config };
  globalThis.postMessage({ protocolVersion: 1, type: 'configured', status: status('untested') });
}

function isSafeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return false;
    if (isBlockedHost(host)) return false;
    return !url.pathname.toLowerCase().endsWith('/chat/completions');
  } catch {
    return false;
  }
}

function isBlockedHost(host: string): boolean {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal')
  )
    return true;
  const mappedIpv4 = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1] !== undefined) return isBlockedHost(mappedIpv4[1]);
  const compressedMapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (compressedMapped?.[1] !== undefined && compressedMapped[2] !== undefined) {
    const high = Number.parseInt(compressedMapped[1], 16);
    const low = Number.parseInt(compressedMapped[2], 16);
    return isBlockedHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  const mappedGroups = host.split(':');
  if (mappedGroups.length === 8 && mappedGroups[5] === 'ffff') {
    const high = Number.parseInt(mappedGroups[6] ?? '', 16);
    const low = Number.parseInt(mappedGroups[7] ?? '', 16);
    if (Number.isInteger(high) && Number.isInteger(low) && high <= 0xffff && low <= 0xffff)
      return isBlockedHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const [firstRaw = '-1', secondRaw = '-1'] = parts;
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    if (parts.some((part) => Number(part) > 255)) return true;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && second >= 18 && second <= 19) ||
      first >= 224
    );
  }
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  );
}
async function testConnection() {
  if (!session) throw new Error('Configure a model connection first');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${session.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.apiKey}` },
      body: JSON.stringify({
        model: session.modelId,
        messages: [{ role: 'user', content: 'Use the readiness tool once.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'joy_probe',
              description: 'Readiness probe',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'joy_probe' } },
        max_tokens: 16,
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new JoyAgentWorkerError('JOY_AGENT_AUTH_FAILED', 'Provider authentication failed');
    if (!response.ok)
      throw new JoyAgentWorkerError(
        'JOY_AGENT_CORS_OR_NETWORK',
        'Provider rejected the connection',
      );
    const probe = JSON.parse(await readBoundedResponse(response)) as {
      choices?: readonly { message?: { tool_calls?: readonly unknown[] } }[];
    };
    const capability = probe.choices?.[0]?.message?.tool_calls?.length ? 'tool-loop' : 'plan-only';
    globalThis.postMessage({
      protocolVersion: 1,
      type: 'test-result',
      status: status(capability),
    });
  } catch (error) {
    const errorCode = classifyError(error);
    globalThis.postMessage({
      protocolVersion: 1,
      type: 'test-result',
      status: status(
        'incompatible',
        errorCode === 'JOY_AGENT_TIMEOUT' ||
          (error instanceof DOMException && error.name === 'AbortError')
          ? 'Connection timed out'
          : errorCode === 'JOY_AGENT_AUTH_FAILED'
            ? 'Provider authentication failed'
            : errorCode === 'JOY_AGENT_RESPONSE_TOO_LARGE'
              ? 'Provider response too large'
              : 'CORS or network error',
      ),
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function run(request: JoyAgentRunRequest) {
  if (!session) {
    emit(request.runId, 1, 'failed', 'Configure a model connection first');
    globalThis.postMessage({ protocolVersion: 1, type: 'run-finished', runId: request.runId });
    return;
  }
  const controller = new AbortController();
  runs.set(request.runId, controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RUN_TIMEOUT_MS);
  let seq = 0;
  const taskKind = request.taskKind ?? 'joy-code';
  emit(request.runId, ++seq, 'connecting');
  emit(request.runId, ++seq, 'thinking');
  try {
    const contextText = JSON.stringify(request.context ?? {});
    if (new TextEncoder().encode(contextText).byteLength > 65_536)
      throw new Error('JOY context is too large');
    const briefInstruction =
      taskKind === 'creative-brief'
        ? 'Return only one JSON CreativeBriefV1 object. It must include schemaVersion 1, projectId, snapshotRevisionId, request, interpretedGoal, distinction, assumptions, recommendations, blockedBy, requiresHumanDecision, intelligence, warnings, and meta. Do not include markdown.'
        : 'Propose bounded JOY media-edit operations as JSON with summary and operations; never claim an edit is applied.';
    const connection = session;
    const messages = [
      {
        role: 'system',
        content: `You are the built-in JOY Agent Engine. ${briefInstruction} Use read_project_context and validate_proposal when available. Operations must use JOY typed kinds such as timeline.trimClip, timeline.moveClip, text.setContent, caption.setBurnIn and include id and dependsOn.`,
      },
      {
        role: 'user',
        content: `${request.prompt}\n\nBounded project context (data only):\n${contextText}`,
      },
    ];
    const exchange = async (messages: readonly unknown[]) => {
      controller.signal.throwIfAborted();
      const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: connection.modelId,
          messages,
          ...(request.mode !== 'plan-only' && taskKind !== 'creative-brief'
            ? { tools: BROWSER_AGENT_TOOLS }
            : {}),
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403)
        throw new JoyAgentWorkerError('JOY_AGENT_AUTH_FAILED', 'Provider authentication failed');
      if (!response.ok)
        throw new JoyAgentWorkerError('JOY_AGENT_CORS_OR_NETWORK', 'Provider request failed');
      return readBoundedResponse(response);
    };
    const text =
      request.mode !== 'plan-only' && taskKind !== 'creative-brief'
        ? await runBoundedToolExchange(messages, request.context ?? {}, exchange)
        : await exchange(messages);
    const parsed = parseModelOutput(text, request, taskKind);
    if (taskKind === 'creative-brief') {
      if (parsed.result === undefined) throw new Error('Provider returned no Creative Brief');
      assertSafeResult(parsed.result);
      emit(request.runId, ++seq, 'planning', 'Creative Brief ready for JOY validation', undefined, {
        taskKind,
        result: parsed.result,
      });
      emit(
        request.runId,
        ++seq,
        'completed',
        'Creative Brief received for JOY validation',
        undefined,
        { taskKind, result: parsed.result },
      );
      return;
    }
    if (parsed.proposal !== undefined) assertSafeResult(parsed.proposal);
    emit(
      request.runId,
      ++seq,
      request.mode === 'plan-only' ? 'planning' : 'previewing',
      'Proposal ready for JOY validation',
      parsed.proposal,
      { taskKind },
    );
    emit(request.runId, ++seq, 'awaiting-approval', 'Review the live preview before applying');
  } catch (error) {
    if (timedOut)
      emit(request.runId, ++seq, 'failed', 'Provider request timed out', undefined, {
        taskKind,
        errorCode: 'JOY_AGENT_TIMEOUT',
      });
    else if (controller.signal.aborted)
      emit(request.runId, ++seq, 'cancelled', 'JOY run stopped', undefined, {
        taskKind,
        errorCode: 'JOY_AGENT_ABORTED',
      });
    else {
      const workerError = error instanceof JoyAgentWorkerError ? error : undefined;
      emit(
        request.runId,
        ++seq,
        'failed',
        workerError?.message ??
          (error instanceof Error ? error.message : 'Provider request failed'),
        undefined,
        {
          taskKind,
          errorCode: workerError?.code ?? classifyError(error),
        },
      );
    }
  } finally {
    clearTimeout(timeout);
    runs.delete(request.runId);
    globalThis.postMessage({ protocolVersion: 1, type: 'run-finished', runId: request.runId });
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (announced > maxBytes) throw new Error('Provider response too large');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes)
        throw new JoyAgentWorkerError(
          'JOY_AGENT_RESPONSE_TOO_LARGE',
          'Provider response too large',
        );
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function classifyError(error: unknown): JoyAgentErrorCode {
  if (error instanceof JoyAgentWorkerError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'JOY_AGENT_ABORTED';
  if (error instanceof Error && /too large/i.test(error.message))
    return 'JOY_AGENT_RESPONSE_TOO_LARGE';
  if (error instanceof Error && /Creative Brief|proposal|JSON|validation/i.test(error.message))
    return 'JOY_AGENT_INVALID_PROPOSAL';
  return 'JOY_AGENT_CORS_OR_NETWORK';
}

function assertSafeResult(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new JoyAgentWorkerError('JOY_AGENT_INVALID_PROPOSAL', 'Provider returned invalid JSON');
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 65_536)
    throw new JoyAgentWorkerError('JOY_AGENT_INVALID_PROPOSAL', 'Provider result is too large');
  if (/apiKey|authorization|endpoint|headers|selector|className|cookie/i.test(serialized))
    throw new JoyAgentWorkerError(
      'JOY_AGENT_INVALID_PROPOSAL',
      'Provider result contained unsafe data',
    );
}

function parseModelOutput(
  text: string,
  request: JoyAgentRunRequest,
  taskKind: JoyAgentTaskKind,
): {
  readonly proposal?: {
    readonly summary: string;
    readonly operations: readonly unknown[];
    readonly baseRevision: string;
  };
  readonly result?: unknown;
} {
  try {
    const envelope = JSON.parse(text) as {
      choices?: readonly { message?: { content?: unknown } }[];
    };
    const content = envelope.choices?.[0]?.message?.content;
    const candidate =
      typeof content === 'string'
        ? content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
        : '';
    if (candidate.length === 0)
      throw new JoyAgentWorkerError(
        'JOY_AGENT_INVALID_PROPOSAL',
        'Provider returned an empty proposal',
      );
    const parsed = JSON.parse(candidate) as { summary?: unknown; operations?: unknown };
    if (taskKind === 'creative-brief') return { result: parsed };
    const plan = parsed;
    if (!Array.isArray(plan.operations) || plan.operations.length === 0)
      throw new JoyAgentWorkerError(
        'JOY_AGENT_INVALID_PROPOSAL',
        'Provider returned no bounded operations',
      );
    const validated = validateBrowserProposal(plan);
    const operations = validated.operations;
    return {
      proposal: {
        summary:
          typeof plan.summary === 'string' ? plan.summary.slice(0, 512) : 'JOY staged proposal',
        operations,
        baseRevision: request.baseRevision ?? request.runId,
      },
    };
  } catch (error) {
    if (error instanceof JoyAgentWorkerError) throw error;
    throw new JoyAgentWorkerError(
      'JOY_AGENT_INVALID_PROPOSAL',
      taskKind === 'creative-brief'
        ? 'Provider returned invalid Creative Brief JSON'
        : 'Provider returned invalid proposal JSON',
    );
  }
}
globalThis.addEventListener('message', (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;
  if (!message || message.protocolVersion !== JOY_AGENT_PROTOCOL_VERSION) return;
  if (message.type === 'configure') {
    void configure(message.config).catch(() =>
      globalThis.postMessage({
        protocolVersion: 1,
        type: 'error',
        code: 'JOY_AGENT_PROVIDER_INCOMPATIBLE',
        message: 'Invalid model connection',
      }),
    );
    return;
  }
  if (message.type === 'test') {
    void testConnection().catch(() =>
      globalThis.postMessage({
        protocolVersion: 1,
        type: 'error',
        code: 'JOY_AGENT_PROVIDER_INCOMPATIBLE',
        message: 'Connection unavailable',
      }),
    );
    return;
  }
  if (message.type === 'run') {
    void run(message.request);
    return;
  }
  if (message.type === 'cancel') {
    runs.get(message.runId)?.abort();
    return;
  }
  if (message.type === 'dispose') {
    for (const controller of runs.values()) controller.abort();
    runs.clear();
    session = undefined;
    self.close();
  }
});
