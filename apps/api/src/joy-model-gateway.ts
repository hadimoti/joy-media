import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentUsageLedger } from './agent-usage-ledger.js';
import type { AccountApi } from './account-service.js';
import type { MediaAuthApi } from './media-auth.js';

export interface JoyModelCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextLength: number;
  readonly vision: boolean;
  readonly isDefault?: boolean;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const JOY_AGENT_DEFAULT_MODELS: readonly JoyModelCatalogEntry[] = Object.freeze([
  {
    id: 'bytedance-seed/seed-2.0-lite',
    displayName: 'Joy Vision',
    description: 'Vision-capable model for visual analysis and creative reasoning',
    contextLength: 262144,
    vision: true,
    isDefault: true,
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 2,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'Joy Fast',
    description: 'Fast text model for tool and metadata edits',
    contextLength: 131072,
    vision: false,
    inputUsdPerMillion: 0.0679,
    outputUsdPerMillion: 0.168,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    displayName: 'Joy Studio',
    description: 'Advanced multimodal and deep video script orchestration',
    contextLength: 200000,
    vision: true,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  },
  {
    id: 'openai/gpt-4o-mini',
    displayName: 'Joy Compact',
    description: 'Ultra-fast low-latency tool and metadata edits',
    contextLength: 128000,
    vision: true,
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
  },
]);

export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'minimax/minimax-m3': 'bytedance-seed/seed-2.0-lite',
  'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.6',
  'meta-llama/llama-3.3-70b-instruct': 'deepseek/deepseek-v4-flash',
});

export const DEFAULT_COMMISSION_RATE_BPS = 2500; // 25% gross margin
export const JOY_MODEL_MAX_OUTPUT_TOKENS = 8192;
const UPSTREAM_HEADER_TIMEOUT_MS = 90_000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 60_000;
const ESTIMATED_CHARS_PER_TOKEN = 4; // Conservative text-only estimate: 4 UTF-16 chars per token.

const FORWARDED_COMPLETION_FIELDS = [
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'stream_options',
  'response_format',
  'stop',
  'seed',
] as const;

export interface JoyModelGatewayOptions {
  readonly mediaAuth: MediaAuthApi;
  readonly account: AccountApi;
  readonly ledger: AgentUsageLedger;
  readonly openRouterApiKey: string | undefined;
  readonly commissionRateBps?: number;
  readonly fetchImpl?: typeof fetch;
}

export class JoyModelGateway {
  private readonly mediaAuth: MediaAuthApi;
  private readonly account: AccountApi;
  private readonly ledger: AgentUsageLedger;
  private readonly openRouterApiKey: string | undefined;
  private readonly commissionRateBps: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimesByUser = new Map<string, number[]>();

  constructor(options: JoyModelGatewayOptions) {
    this.mediaAuth = options.mediaAuth;
    this.account = options.account;
    this.ledger = options.ledger;
    this.openRouterApiKey = options.openRouterApiKey;
    this.commissionRateBps = options.commissionRateBps ?? DEFAULT_COMMISSION_RATE_BPS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return typeof this.openRouterApiKey === 'string' && this.openRouterApiKey.trim().length > 0;
  }

  async handleGetModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const actor = await this.mediaAuth.authenticate(req);
    if (actor === undefined) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
      );
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    });
    res.end(JSON.stringify({ models: JOY_AGENT_DEFAULT_MODELS }));
  }

  async handleGetUsage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const actor = await this.mediaAuth.authenticate(req);
    if (actor === undefined) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
      );
      return;
    }
    const summary = await this.ledger.getSummary(actor.id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: summary }));
  }

  async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isConfigured()) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'JOY_AGENT_UNCONFIGURED',
            message: 'Joy Model gateway is not configured on this server',
          },
        }),
      );
      return;
    }

    const actor = await this.mediaAuth.authenticate(req);
    if (actor === undefined) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'UNAUTHORIZED', message: 'Valid Joy session token required' },
        }),
      );
      return;
    }

    const subscription = await this.account.getSubscription(actor.id);
    if (subscription.status !== 'active') {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'JOY_SUBSCRIPTION_REQUIRED',
            message:
              'Active JOY Pro subscription required to use the built-in Joy Model. Switch to BYOK or upgrade.',
          },
        }),
      );
      return;
    }

    const now = Date.now();
    const rateWindowStart = now - 60_000;
    const recentRequests = (this.requestTimesByUser.get(actor.id) ?? []).filter(
      (at) => at > rateWindowStart,
    );
    const rateLimit = positiveEnvInteger('JOY_GATEWAY_RATE_LIMIT_PER_MIN', 30);
    if (recentRequests.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((recentRequests[0]! + 60_000 - now) / 1000));
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(retryAfter) });
      res.end(
        JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'Per-user request limit reached; retry later.' },
        }),
      );
      return;
    }
    recentRequests.push(now);
    this.requestTimesByUser.set(actor.id, recentRequests);
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readRequestBody(req);
    } catch (error) {
      if (error instanceof Error && error.message === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
          }),
        );
        return;
      }
      throw error;
    }
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Malformed JSON payload' } }),
      );
      return;
    }

    if (
      parsedBody.tools !== undefined &&
      (!Array.isArray(parsedBody.tools) ||
        parsedBody.tools.some(
          (tool) =>
            tool === null ||
            typeof tool !== 'object' ||
            (tool as { type?: unknown }).type !== 'function',
        ))
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'UNSUPPORTED_TOOL_TYPE',
            message: 'Only tools with type "function" are supported.',
          },
        }),
      );
      return;
    }

    const requestedModel = typeof parsedBody.model === 'string' ? parsedBody.model : '';
    const modelId = LEGACY_MODEL_ALIASES[requestedModel] ?? requestedModel;
    const allowed = JOY_AGENT_DEFAULT_MODELS.some((m) => m.id === modelId);
    if (!allowed) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'MODEL_NOT_ALLOWED',
            message: `Model '${requestedModel}' is not in the Joy Model catalog.`,
          },
        }),
      );
      return;
    }

    const dailyCapMicros = BigInt(
      Math.round(positiveEnvNumber('JOY_GATEWAY_DAILY_SPEND_CAP_USD', 5) * 1_000_000),
    );
    const dailySpend = this.ledger.getDailyBilledCostMicros
      ? await this.ledger.getDailyBilledCostMicros(actor.id, new Date(now - (now % 86_400_000)))
      : 0n;
    const requestedOutputLimit = Number(parsedBody.max_tokens ?? parsedBody.max_completion_tokens);
    const reservedOutputTokens =
      Number.isSafeInteger(requestedOutputLimit) && requestedOutputLimit > 0
        ? Math.min(requestedOutputLimit, JOY_MODEL_MAX_OUTPUT_TOKENS)
        : JOY_MODEL_MAX_OUTPUT_TOKENS;
    const maximumRequestCost = BigInt(
      Math.ceil(
        estimateCostUsd(modelId, estimatePromptTokens(parsedBody.messages), reservedOutputTokens) *
          1_000_000,
      ),
    );
    if (dailySpend >= dailyCapMicros || dailySpend + maximumRequestCost > dailyCapMicros) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' });
      res.end(
        JSON.stringify({
          error: {
            code: 'DAILY_SPEND_CAP_REACHED',
            message: 'Daily JOY Agent spend cap would be exceeded; retry after the daily reset.',
          },
        }),
      );
      return;
    }

    // Forward to OpenRouter
    const isStream = parsedBody.stream === true;
    let upstreamRes: Response;
    const upstreamController = new AbortController();
    let upstreamTimedOut = false;
    const headerTimeout = setTimeout(() => {
      upstreamTimedOut = true;
      upstreamController.abort();
    }, UPSTREAM_HEADER_TIMEOUT_MS);
    try {
      upstreamRes = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.openRouterApiKey}`,
          'http-referer': 'https://joyst.ir',
          'x-title': 'JOY Media Built-in Agent',
        },
        body: JSON.stringify(buildUpstreamBody(parsedBody, modelId, isStream)),
        signal: upstreamController.signal,
      });
    } catch (error) {
      const timedOut =
        upstreamTimedOut ||
        (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
            message: timedOut ? 'AI upstream timed out' : 'Failed to connect to AI upstream',
          },
        }),
      );
      return;
    } finally {
      clearTimeout(headerTimeout);
    }

    if (!upstreamRes.ok) {
      const status = upstreamRes.status;
      if (status === 401 || status === 403) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'JOY_AGENT_UPSTREAM_AUTH_FAILED',
              message: 'Server provider credential rejected',
            },
          }),
        );
      } else if (status === 404) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'MODEL_UNAVAILABLE', message: 'The selected model is unavailable' },
          }),
        );
      } else if (status === 429) {
        const retryAfter = upstreamRes.headers.get('retry-after');
        res.writeHead(429, {
          'content-type': 'application/json',
          ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
        });
        res.end(
          JSON.stringify({
            error: { code: 'RATE_LIMITED', message: 'AI upstream rate limit reached' },
          }),
        );
      } else {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'UPSTREAM_ERROR',
              message: 'AI upstream request failed',
              upstreamStatus: status,
            },
          }),
        );
      }
      return;
    }

    if (isStream && upstreamRes.body !== null) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let promptTokens = 0;
      let completionTokens = 0;
      let rawCostUsd = 0;
      let usageReported = false;
      let streamedOutputChars = 0;
      let generationId: string | undefined;
      let pending = '';
      let streamComplete = false;
      const onClose = () => {
        if (!streamComplete) void reader.cancel().catch(() => {});
      };
      res.on('close', onClose);
      const processLines = (text: string) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (typeof data.id === 'string') generationId = data.id;
            for (const choice of data.choices ?? []) {
              if (typeof choice?.delta?.content === 'string')
                streamedOutputChars += choice.delta.content.length;
            }
            if (data.usage) {
              usageReported = true;
              promptTokens = Number(data.usage.prompt_tokens ?? promptTokens);
              completionTokens = Number(data.usage.completion_tokens ?? completionTokens);
              const reportedCost = data.usage.cost ?? data.usage.total_cost;
              if (typeof reportedCost === 'number') rawCostUsd = reportedCost;
            }
          } catch {
            // Ignore non-JSON SSE frames.
          }
        }
      };

      const keepAlive = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
      }, 15_000);

      try {
        while (true) {
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await readStreamChunk(reader, UPSTREAM_STREAM_IDLE_TIMEOUT_MS);
          } catch {
            // The response has already started. End it cleanly and account for usage seen so far.
            processLines(decoder.decode());
            if (pending.length > 0) processLines('\n');
            void reader.cancel().catch(() => {});
            break;
          }
          const { done, value } = readResult;
          if (done) {
            processLines(decoder.decode());
            if (pending.length > 0) processLines('\n');
            streamComplete = true;
            break;
          }
          if (value) {
            res.write(value);
            processLines(decoder.decode(value, { stream: true }));
          }
        }
      } finally {
        clearInterval(keepAlive);
        res.off('close', onClose);
        res.end();
      }

      if (!usageReported) {
        console.warn('joy-model-gateway: stream usage unavailable', {
          ownerId: actor.id,
          modelId,
          usageReported: false,
        });
      }

      // Record in ledger
      const estimated = !usageReported || rawCostUsd === 0;
      if (estimated) {
        promptTokens = estimatePromptTokens(parsedBody.messages);
        completionTokens = Math.ceil(streamedOutputChars / ESTIMATED_CHARS_PER_TOKEN);
        rawCostUsd = estimateCostUsd(modelId, promptTokens, completionTokens);
      }
      const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
      const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
      const recordId = await this.safeRecord({
        ownerId: actor.id,
        modelId,
        promptTokens,
        completionTokens,
        upstreamCostMicros: upstreamMicros,
        billedCostMicros: billedMicros,
        commissionRateBps: this.commissionRateBps,
        estimated,
        ...(generationId ? { generationId } : {}),
      });
      if (estimated && generationId && recordId)
        void this.reconcileGenerationUsage(recordId, generationId);
      return;
    }

    // Non-streaming response
    let jsonResponse: Record<string, unknown>;
    try {
      const parsedResponse: unknown = await upstreamRes.json();
      if (
        parsedResponse === null ||
        typeof parsedResponse !== 'object' ||
        Array.isArray(parsedResponse)
      )
        throw new Error('Upstream response was not an object.');
      jsonResponse = parsedResponse as Record<string, unknown>;
    } catch {
      await this.safeRecord({
        ownerId: actor.id,
        modelId,
        promptTokens: 0,
        completionTokens: 0,
        upstreamCostMicros: 0n,
        billedCostMicros: 0n,
        commissionRateBps: this.commissionRateBps,
      });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'UPSTREAM_ERROR', message: 'AI upstream returned an invalid response' },
        }),
      );
      return;
    }
    const usage = (jsonResponse.usage ?? {}) as Record<string, unknown>;
    const costReported = usage.cost !== undefined || usage.total_cost !== undefined;
    const promptTokens = Number.isFinite(Number(usage.prompt_tokens))
      ? Number(usage.prompt_tokens)
      : estimatePromptTokens(parsedBody.messages);
    const completionTokens = Number.isFinite(Number(usage.completion_tokens))
      ? Number(usage.completion_tokens)
      : estimateCompletionTokens(jsonResponse.choices);
    const generationId = typeof jsonResponse.id === 'string' ? jsonResponse.id : undefined;
    const rawCostUsd =
      usage.cost !== undefined || usage.total_cost !== undefined
        ? Number(usage.cost ?? usage.total_cost ?? 0)
        : estimateCostUsd(modelId, promptTokens, completionTokens);

    const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
    const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
    const recordId = await this.safeRecord({
      ownerId: actor.id,
      modelId,
      promptTokens,
      completionTokens,
      upstreamCostMicros: upstreamMicros,
      billedCostMicros: billedMicros,
      commissionRateBps: this.commissionRateBps,
      estimated: !costReported,
      ...(generationId ? { generationId } : {}),
    });
    if (!costReported && generationId && recordId)
      void this.reconcileGenerationUsage(recordId, generationId);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonResponse));
  }

  private async safeRecord(
    input: Parameters<AgentUsageLedger['record']>[0],
  ): Promise<string | undefined> {
    try {
      return await this.ledger.record(input);
    } catch {
      console.error('joy-model-gateway: ledger write failed', {
        code: 'LEDGER_WRITE_FAILED',
        ownerId: input.ownerId,
        modelId: input.modelId,
      });
      return undefined;
    }
  }

  private async reconcileGenerationUsage(recordId: string, generationId: string): Promise<void> {
    if (!this.ledger.replaceEstimate) return;
    try {
      const response = await this.fetchImpl(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        {
          headers: { authorization: `Bearer ${this.openRouterApiKey}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { data?: Record<string, unknown> };
      const data = payload.data ?? {};
      const promptTokens = Number(data.tokens_prompt ?? data.prompt_tokens);
      const completionTokens = Number(data.tokens_completion ?? data.completion_tokens);
      const cost = Number(data.total_cost ?? data.cost);
      if (![promptTokens, completionTokens, cost].every(Number.isFinite) || cost < 0) return;
      const upstreamCostMicros = BigInt(Math.round(cost * 1_000_000));
      const billedCostMicros =
        (upstreamCostMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
      await this.ledger.replaceEstimate(recordId, {
        promptTokens,
        completionTokens,
        upstreamCostMicros,
        billedCostMicros,
      });
    } catch {
      // Reconciliation is best effort and never delays an already-sent response.
    }
  }
}

async function readRequestBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error('PAYLOAD_TOO_LARGE');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function buildUpstreamBody(
  parsedBody: Record<string, unknown>,
  modelId: string,
  isStream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model: modelId };
  let hasOutputLimit = false;
  for (const field of FORWARDED_COMPLETION_FIELDS) {
    if (!Object.hasOwn(parsedBody, field)) continue;
    const value = parsedBody[field];
    if (field === 'max_tokens' || field === 'max_completion_tokens') {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        body[field] = Math.min(value, JOY_MODEL_MAX_OUTPUT_TOKENS);
        hasOutputLimit = true;
      }
      continue;
    }
    if (field !== 'stream') body[field] = value;
  }
  body.stream = isStream;
  if (!hasOutputLimit) body.max_tokens = JOY_MODEL_MAX_OUTPUT_TOKENS;
  // Request OpenRouter's usage metadata internally; clients cannot override this.
  body.usage = { include: true };
  return body;
}

function positiveEnvInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimatePromptTokens(messages: unknown): number {
  return Math.ceil(JSON.stringify(messages ?? []).length / ESTIMATED_CHARS_PER_TOKEN);
}

function estimateCompletionTokens(choices: unknown): number {
  const text = JSON.stringify(choices ?? []);
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

function estimateCostUsd(modelId: string, promptTokens: number, completionTokens: number): number {
  const model = JOY_AGENT_DEFAULT_MODELS.find((entry) => entry.id === modelId);
  if (!model) return 0;
  return (
    (promptTokens * model.inputUsdPerMillion + completionTokens * model.outputUsdPerMillion) /
    1_000_000
  );
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            Object.assign(new Error('Upstream stream idle timeout'), { name: 'TimeoutError' }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Legacy credential ID retained for compatibility; prefer OPENROUTER_SYSTEMD_CREDENTIAL_IDS. */
export const OPENROUTER_SYSTEMD_CREDENTIAL_ID = 'joy-media-openrouter-api-key' as const;
export const OPENROUTER_SYSTEMD_CREDENTIAL_IDS = [
  'openrouter-api-key',
  OPENROUTER_SYSTEMD_CREDENTIAL_ID,
] as const;
export const DEFAULT_OPENROUTER_CREDENTIAL_DIRECTORY = '/run/credentials/joy-media@api.service';

export function readOpenRouterApiKeyFromCredential(
  readFile: (path: string, encoding: 'utf8') => string,
  directory = process.env.CREDENTIALS_DIRECTORY ?? DEFAULT_OPENROUTER_CREDENTIAL_DIRECTORY,
): string | undefined {
  for (const id of OPENROUTER_SYSTEMD_CREDENTIAL_IDS) {
    try {
      const value = readFile(`${directory}/${id}`, 'utf8').trim();
      if (value !== '') return value;
    } catch {
      // Try the next compatible credential id.
    }
  }
  return undefined;
}
