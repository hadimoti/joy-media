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
}

export const JOY_AGENT_DEFAULT_MODELS: readonly JoyModelCatalogEntry[] = Object.freeze([
  {
    id: 'bytedance-seed/seed-2.0-lite',
    displayName: 'Joy Vision',
    description: 'Vision-capable model for visual analysis and creative reasoning',
    contextLength: 262144,
    vision: true,
    isDefault: true,
  },
  {
    id: 'deepseek/deepseek-v4-flash',
    displayName: 'Joy Fast',
    description: 'Fast text model for tool and metadata edits',
    contextLength: 131072,
    vision: false,
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    displayName: 'Joy Studio',
    description: 'Advanced multimodal and deep video script orchestration',
    contextLength: 200000,
    vision: true,
  },
  {
    id: 'openai/gpt-4o-mini',
    displayName: 'Joy Compact',
    description: 'Ultra-fast low-latency tool and metadata edits',
    contextLength: 128000,
    vision: true,
  },
]);

export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'minimax/minimax-m3': 'bytedance-seed/seed-2.0-lite',
  'anthropic/claude-3.5-sonnet': 'anthropic/claude-sonnet-4.6',
});

export const DEFAULT_COMMISSION_RATE_BPS = 2500; // 25% gross margin
export const JOY_MODEL_MAX_OUTPUT_TOKENS = 8192;
const UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
const UPSTREAM_STREAM_IDLE_TIMEOUT_MS = 60_000;

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

  async handleGetModels(_req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
      const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
      await this.safeRecord({
        ownerId: actor.id,
        modelId,
        promptTokens,
        completionTokens,
        upstreamCostMicros: upstreamMicros,
        billedCostMicros: billedMicros,
        commissionRateBps: this.commissionRateBps,
      });
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
    const promptTokens = Number(usage.prompt_tokens ?? 0);
    const completionTokens = Number(usage.completion_tokens ?? 0);
    const rawCostUsd = Number(usage.cost ?? usage.total_cost ?? 0);

    const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
    const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
    await this.safeRecord({
      ownerId: actor.id,
      modelId,
      promptTokens,
      completionTokens,
      upstreamCostMicros: upstreamMicros,
      billedCostMicros: billedMicros,
      commissionRateBps: this.commissionRateBps,
    });

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonResponse));
  }

  private async safeRecord(input: Parameters<AgentUsageLedger['record']>[0]): Promise<void> {
    try {
      await this.ledger.record(input);
    } catch {
      console.error('joy-model-gateway: ledger write failed', {
        code: 'LEDGER_WRITE_FAILED',
        ownerId: input.ownerId,
        modelId: input.modelId,
      });
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

/** @deprecated Use OPENROUTER_SYSTEMD_CREDENTIAL_IDS. */
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
