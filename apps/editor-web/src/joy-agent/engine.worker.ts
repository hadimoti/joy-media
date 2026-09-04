import type {
  ByokSessionConfig,
  ByokSessionStatus,
  JoyAgentRunRequest,
  MainToWorkerMessage,
  JoyAgentPhase,
} from './protocol.js';
import { JOY_AGENT_PROTOCOL_VERSION } from './protocol.js';

let session: ByokSessionConfig | undefined;
const runs = new Map<string, AbortController>();
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
    },
  });
}
async function configure(config: ByokSessionConfig) {
  if (!isSafeBaseUrl(config.baseUrl) || config.apiKey.length === 0 || config.modelId.length === 0)
    throw new Error('Invalid model connection');
  session = { ...config };
  globalThis.postMessage({ protocolVersion: 1, type: 'configured', status: status('untested') });
}

function isSafeBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return false;
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.')
    )
      return false;
    return !url.pathname.toLowerCase().endsWith('/chat/completions');
  } catch {
    return false;
  }
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
    if (!response.ok) throw new Error('Provider rejected the connection');
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
    globalThis.postMessage({
      protocolVersion: 1,
      type: 'test-result',
      status: status(
        'incompatible',
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Connection timed out'
          : 'CORS or network error',
      ),
    });
  } finally {
    clearTimeout(timeout);
  }
}
async function run(request: JoyAgentRunRequest) {
  if (!session) throw new Error('Configure a model connection first');
  const controller = new AbortController();
  runs.set(request.runId, controller);
  let seq = 0;
  emit(request.runId, ++seq, 'connecting');
  emit(request.runId, ++seq, 'thinking');
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
        messages: [
          {
            role: 'system',
            content:
              'You are the built-in JOY Agent Engine. Propose bounded media-edit operations; never claim an edit is applied.',
          },
          { role: 'user', content: request.prompt },
        ],
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Provider request failed');
    const text = await readBoundedResponse(response);
    const parsed = parseProposal(text, request);
    emit(
      request.runId,
      ++seq,
      request.mode === 'plan-only' ? 'planning' : 'previewing',
      'Proposal ready for JOY validation',
      parsed,
    );
    emit(request.runId, ++seq, 'awaiting-approval', 'Review the live preview before applying');
  } catch (error) {
    if (controller.signal.aborted) emit(request.runId, ++seq, 'cancelled');
    else
      emit(
        request.runId,
        ++seq,
        'failed',
        error instanceof Error ? error.message : 'Provider request failed',
      );
  } finally {
    runs.delete(request.runId);
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
      if (total > maxBytes) throw new Error('Provider response too large');
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

function parseProposal(
  text: string,
  request: JoyAgentRunRequest,
): {
  readonly summary: string;
  readonly operations: readonly unknown[];
  readonly baseRevision: string;
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
    const plan = JSON.parse(candidate) as { summary?: unknown; operations?: unknown };
    const operations = Array.isArray(plan.operations) ? plan.operations.slice(0, 32) : [];
    return {
      summary:
        typeof plan.summary === 'string' ? plan.summary.slice(0, 512) : 'JOY staged proposal',
      operations,
      baseRevision: request.baseRevision ?? request.runId,
    };
  } catch {
    return {
      summary: 'JOY staged proposal',
      operations: [],
      baseRevision: request.baseRevision ?? request.runId,
    };
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
