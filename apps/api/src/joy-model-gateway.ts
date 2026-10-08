import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentUsageLedger } from './agent-usage-ledger.js';
import type { AccountApi } from './account-service.js';
import type { MediaAuthApi } from './media-auth.js';
import {
  JOY_AGENT_FREE_MODELS,
  JOY_AGENT_LEGACY_MODEL_IDS,
  type JoyModelCatalogEntry,
} from './joy-free-models.js';

export { JOY_AGENT_FREE_MODELS, type JoyModelCatalogEntry } from './joy-free-models.js';

export const JOY_AGENT_FREE_DEFAULT_MODEL: JoyModelCatalogEntry = JOY_AGENT_FREE_MODELS.find(
  (model) => model.isDefault === true,
)!;

/** Legacy ids from installed clients all resolve to the free default. */
export const LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(JOY_AGENT_LEGACY_MODEL_IDS.map((id) => [id, JOY_AGENT_FREE_DEFAULT_MODEL.id])),
);

/**
 * Models to try for a request, in order.
 * - Text: the requested model, then the rest of the free list in catalog order.
 * - Images: only vision models. A vision model that was asked for goes first; a request for a
 *   text model (such as the text default) goes to the vision models in catalog order.
 * An id outside the free list gets nothing to try (the handler has already refused it).
 */
export function joyModelFallbackOrder(
  modelId: string,
  options: { readonly requireVision?: boolean } = {},
): readonly string[] {
  const requested = JOY_AGENT_FREE_MODELS.find((model) => model.id === modelId);
  if (requested === undefined) return [];
  if (options.requireVision === true) {
    const vision = JOY_AGENT_FREE_MODELS.filter((model) => model.vision).map((model) => model.id);
    return requested.vision ? [modelId, ...vision.filter((id) => id !== modelId)] : vision;
  }
  return [
    modelId,
    ...JOY_AGENT_FREE_MODELS.filter((model) => model.id !== modelId).map((model) => model.id),
  ];
}

/** True when any message carries an image_url part. */
function messagesHaveImages(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        Array.isArray((message as { content?: unknown }).content) &&
        ((message as { content: unknown[] }).content as unknown[]).some(
          (part) =>
            part !== null &&
            typeof part === 'object' &&
            (part as { type?: unknown }).type === 'image_url',
        ),
    )
  );
}

/** What one failed upstream attempt tells us; never holds the response body itself. */
interface UpstreamFailure {
  readonly status: number;
  /** OpenRouter's `error.code`, if any. */
  readonly code?: string;
  /** OpenRouter's `error.message`; used only to classify a 403, never logged or returned. */
  readonly message?: string;
  readonly failedRoutingStep?: string;
  readonly limitSource?: string;
  readonly providerName?: string;
  readonly retryAfter?: string;
}

type UpstreamFailureKind = 'fallback' | 'auth' | 'stop';

/** A 403 that is about the gateway's key rather than the model (disabled, revoked, over its limit). */
const KEY_LEVEL_FORBIDDEN =
  /api[\s_-]?key|\bkey\b[^.]{0,40}\b(?:invalid|disabled|revoked|expired|limit|not found)|credential|unauthori[sz]ed/i;

/**
 * - auth: the key itself was rejected (401, or a 403 clearly about the key). Every model
 *   would fail the same way, so stop.
 * - fallback: this model is busy, gated or failing right now; try the next candidate. That is
 *   404 (withdrawn or no provider), 429 (including a shared free pool), 5xx, any other 403
 *   (e.g. a free endpoint gated to agentic harnesses, reported as a failed routing step), and
 *   a 200 whose body (or first stream event) is an error, e.g. a provider's ResourceExhausted.
 * - stop: anything else (such as 400 or 402) is about the request or the account; stop.
 */
function classifyUpstreamFailure(failure: UpstreamFailure): UpstreamFailureKind {
  const { status } = failure;
  // An error carried in a 200 body or as a stream's first event: the model failed this time.
  if (status >= 200 && status <= 299) return 'fallback';
  if (status === 401) return 'auth';
  if (status === 403)
    return failure.failedRoutingStep === undefined &&
      KEY_LEVEL_FORBIDDEN.test(failure.message ?? '')
      ? 'auth'
      : 'fallback';
  if (status === 404 || status === 429 || (status >= 500 && status <= 599)) return 'fallback';
  return 'stop';
}

/**
 * Paid models were once enabled by JOY_GATEWAY_PAID_MODEL_ALLOWLIST. That path is gone: the
 * gateway serves only the free catalog. Say so loudly if an old environment still sets it.
 */
export function warnIfPaidModelAllowlistSet(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.JOY_GATEWAY_PAID_MODEL_ALLOWLIST ?? '').trim() === '') return false;
  console.warn(
    'joy-model-gateway: JOY_GATEWAY_PAID_MODEL_ALLOWLIST is set but ignored; the hosted gateway serves only the free catalog and paid models cannot be enabled.',
  );
  return true;
}

export const DEFAULT_COMMISSION_RATE_BPS = 2500; // 25% gross margin
export const JOY_MODEL_MAX_OUTPUT_TOKENS = 8192;
const UPSTREAM_HEADER_TIMEOUT_MS = 85_000;
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
  // Per-minute throttling is process-local and resets when this API process restarts.
  private readonly requestTimesByUser = new Map<string, number[]>();

  constructor(options: JoyModelGatewayOptions) {
    warnIfPaidModelAllowlistSet();
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
    const catalog = JOY_AGENT_FREE_MODELS;
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    });
    res.end(JSON.stringify({ models: catalog }));
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
    const catalog = JOY_AGENT_FREE_MODELS;
    const aliasedModel = Object.hasOwn(LEGACY_MODEL_ALIASES, requestedModel)
      ? LEGACY_MODEL_ALIASES[requestedModel]
      : undefined;
    let modelId = aliasedModel ?? requestedModel;
    const allowed = catalog.some((m) => m.id === modelId);
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

    // Only text and images may reach OpenRouter: a `file` part would be parsed upstream and can
    // be billed (e.g. mistral-ocr for PDFs) even on a free model. Images are sent only to vision
    // models (see joyModelFallbackOrder), whichever model was asked for.
    const contentIssue = unsupportedContentIssue(parsedBody.messages);
    if (contentIssue !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'UNSUPPORTED_CONTENT_PART', message: contentIssue } }),
      );
      return;
    }

    const dailyCapMicros = BigInt(
      Math.round(positiveEnvNumber('JOY_GATEWAY_DAILY_SPEND_CAP_USD', 5) * 1_000_000),
    );
    // Daily billing cap resets at 00:00 UTC (03:30 Asia/Tehran).
    const dayStart = new Date(now - (now % 86_400_000));
    const requestedOutputLimit = Number(parsedBody.max_tokens ?? parsedBody.max_completion_tokens);
    const reservedOutputTokens =
      Number.isSafeInteger(requestedOutputLimit) && requestedOutputLimit > 0
        ? Math.min(requestedOutputLimit, JOY_MODEL_MAX_OUTPUT_TOKENS)
        : JOY_MODEL_MAX_OUTPUT_TOKENS;
    const maximumRawCost = BigInt(
      Math.ceil(
        estimateCostUsd(
          modelId,
          estimatePromptTokens(parsedBody.messages, parsedBody.tools),
          reservedOutputTokens,
        ) * 1_000_000,
      ),
    );
    const maximumRequestCost = (maximumRawCost * BigInt(10000 + this.commissionRateBps)) / 10000n;
    let reservationId: string;
    try {
      if (!this.ledger.reserveSpend) throw new Error('SPEND_LEDGER_UNAVAILABLE');
      reservationId = await this.ledger.reserveSpend(
        actor.id,
        dayStart,
        maximumRequestCost,
        dailyCapMicros,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'DAILY_SPEND_CAP_REACHED') {
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
      if (error instanceof Error && error.message === 'SPEND_LEDGER_BUSY') {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(
          JSON.stringify({
            error: {
              code: 'SPEND_LEDGER_BUSY',
              message: 'Spend accounting is busy; retry shortly.',
            },
          }),
        );
        return;
      }
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'SPEND_LEDGER_UNAVAILABLE',
            message: 'Spend accounting is temporarily unavailable; request was not forwarded.',
          },
        }),
      );
      return;
    }

    // Forward to OpenRouter. A free model that is busy, gated or failing (see
    // classifyUpstreamFailure) is retried with the next candidate; only a key-level rejection
    // stops as an auth failure. Timeouts and network failures are not model-specific and stop.
    const isStream = parsedBody.stream === true;
    let upstreamRes: Response | undefined;
    let verdict: 'ok' | UpstreamFailureKind = 'fallback';
    const failures: UpstreamFailure[] = [];
    // What the answering attempt already read: the parsed JSON body, or the start of the stream.
    let upstreamJson: Record<string, unknown> | undefined;
    let streamStart: StreamStart | undefined;
    const candidates = joyModelFallbackOrder(modelId, {
      requireVision: messagesHaveImages(parsedBody.messages),
    });
    for (const [index, candidate] of candidates.entries()) {
      const attempt = { ownerId: actor.id, attempt: index + 1, of: candidates.length };
      const upstreamController = new AbortController();
      let upstreamTimedOut = false;
      const attemptDeadline = Date.now() + UPSTREAM_HEADER_TIMEOUT_MS;
      const headerTimeout = setTimeout(() => {
        upstreamTimedOut = true;
        upstreamController.abort();
      }, UPSTREAM_HEADER_TIMEOUT_MS);
      let streamPeek: StreamPeek | undefined;
      try {
        upstreamRes = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.openRouterApiKey}`,
            'http-referer': 'https://joyst.ir',
            'x-title': 'JOY Media Built-in Agent',
          },
          body: JSON.stringify(buildUpstreamBody(parsedBody, candidate, isStream)),
          signal: upstreamController.signal,
        });
        // A stream can start with HTTP 200 and an error as its first event. Look before
        // committing the response, within the same time budget as the headers.
        if (upstreamRes.ok && isStream && upstreamRes.body !== null)
          streamPeek = await peekStreamStart(upstreamRes.body, attemptDeadline);
      } catch (error) {
        await this.safeRelease(reservationId);
        const timedOut =
          upstreamTimedOut ||
          (error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError'));
        logUpstreamAttempt({
          ...attempt,
          modelId: candidate,
          outcome: timedOut ? 'timeout' : 'unreachable',
        });
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
      modelId = candidate;
      let failure: UpstreamFailure | undefined;
      if (!upstreamRes.ok) {
        failure = await readUpstreamFailure(upstreamRes);
      } else if (streamPeek?.kind === 'error') {
        failure = { status: upstreamRes.status, ...openRouterErrorFields(streamPeek.payload) };
      } else if (!isStream) {
        const parsed = parseJsonObject(await upstreamRes.text().catch(() => ''));
        const bodyError = parsed === undefined ? undefined : bodyErrorOf(parsed);
        if (bodyError !== undefined)
          failure = { status: upstreamRes.status, ...openRouterErrorFields(bodyError) };
        else upstreamJson = parsed;
      }
      if (failure === undefined) {
        logUpstreamAttempt({ ...attempt, modelId, status: upstreamRes.status, outcome: 'ok' });
        if (streamPeek?.kind === 'ok') streamStart = streamPeek.start;
        verdict = 'ok';
        break;
      }
      const kind = classifyUpstreamFailure(failure);
      logUpstreamAttempt({ ...attempt, modelId, ...failureLogFields(failure), outcome: kind });
      failures.push(failure);
      verdict = kind;
      if (kind !== 'fallback') break;
    }
    if (upstreamRes === undefined) throw new Error('joy-model-gateway: no upstream attempt');

    if (verdict !== 'ok') {
      await this.safeRelease(reservationId);
      const last = failures.at(-1)!;
      const status = last.status;
      if (verdict === 'auth') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'JOY_AGENT_UPSTREAM_AUTH_FAILED',
              message: 'Server provider credential rejected',
            },
          }),
        );
      } else if (verdict === 'fallback') {
        // Every candidate was busy, gated or failing: a temporary, retryable condition.
        const retryAfterSeconds = retryHintSeconds(failures);
        const vision = messagesHaveImages(parsedBody.messages);
        res.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': String(retryAfterSeconds),
        });
        res.end(
          JSON.stringify({
            error: {
              code: 'JOY_AGENT_MODELS_BUSY',
              message: vision
                ? `Every free image model is busy or unavailable right now (${failures.length} tried); retry in about ${retryAfterSeconds} seconds, or send the request without images.`
                : `Every free model is busy or unavailable right now (${failures.length} tried); retry in about ${retryAfterSeconds} seconds.`,
              retryable: true,
              retryAfterSeconds,
              vision,
            },
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

    if (streamStart !== undefined) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const { reader, decoder } = streamStart;
      let promptTokens = 0;
      let completionTokens = 0;
      let rawCostUsd = 0;
      let usageReported = false;
      let streamedOutputText = '';
      let generationId: string | undefined;
      let pending = '';
      let streamComplete = false;
      const onClose = () => {
        if (!streamComplete) void reader.cancel().catch(() => {});
      };
      res.on('close', onClose);
      // Forwards complete SSE lines (minus any reasoning the model streamed) and accounts for
      // usage. A partial line waits in `pending` for the rest of it.
      const processLines = (text: string) => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        let forward = '';
        for (const line of lines) {
          const payload = line.startsWith('data: ') ? line.slice(6) : undefined;
          const data =
            payload === undefined || payload.trim() === '[DONE]'
              ? undefined
              : parseJsonObject(payload);
          if (data === undefined) {
            forward += `${line}\n`;
            continue;
          }
          forward += stripReasoning(data) ? `data: ${JSON.stringify(data)}\n` : `${line}\n`;
          // The shape is not trusted: anything unexpected throws and the frame is skipped.
          const chunk = data as StreamChunkShape;
          try {
            if (typeof chunk.id === 'string') generationId = chunk.id;
            for (const choice of chunk.choices ?? []) {
              if (typeof choice?.delta?.content === 'string')
                streamedOutputText += choice.delta.content;
              for (const toolCall of choice?.delta?.tool_calls ?? []) {
                if (typeof toolCall?.function?.name === 'string')
                  streamedOutputText += toolCall.function.name;
                if (typeof toolCall?.function?.arguments === 'string')
                  streamedOutputText += toolCall.function.arguments;
              }
            }
            if (chunk.usage) {
              usageReported = true;
              promptTokens = Number(chunk.usage.prompt_tokens ?? promptTokens);
              completionTokens = Number(chunk.usage.completion_tokens ?? completionTokens);
              const reportedCost = chunk.usage.cost ?? chunk.usage.total_cost;
              if (typeof reportedCost === 'number') rawCostUsd = reportedCost;
            }
          } catch {
            // Ignore frames with unexpected shapes.
          }
        }
        if (forward.length > 0 && !res.destroyed && !res.writableEnded) res.write(forward);
      };

      const keepAlive = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
      }, 15_000);
      // Forward what the peek already read, then carry on with the rest of the stream.
      processLines(streamStart.text);

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
          if (value) processLines(decoder.decode(value, { stream: true }));
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

      if (usageReported) warnIfFreeModelBilled(modelId, rawCostUsd, actor.id);
      // Record in ledger
      const estimated = !usageReported || rawCostUsd === 0;
      if (!usageReported) {
        promptTokens = estimatePromptTokens(parsedBody.messages, parsedBody.tools);
        completionTokens = estimateTextTokens(streamedOutputText);
      }
      if (estimated) {
        rawCostUsd = estimateCostUsd(modelId, promptTokens, completionTokens);
      }
      const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
      const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
      const recordId = await this.safeSettle(reservationId, {
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

    // Non-streaming response (already read and checked for an in-body error by the attempt loop)
    const jsonResponse = upstreamJson;
    if (jsonResponse === undefined) {
      await this.safeSettle(reservationId, {
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
    // Reasoning (nano-omni) never reaches the client or its conversation history.
    stripReasoning(jsonResponse);
    const usage = (jsonResponse.usage ?? {}) as Record<string, unknown>;
    const costReported = usage.cost !== undefined || usage.total_cost !== undefined;
    const promptTokens = Number.isFinite(Number(usage.prompt_tokens))
      ? Number(usage.prompt_tokens)
      : estimatePromptTokens(parsedBody.messages, parsedBody.tools);
    const completionTokens = Number.isFinite(Number(usage.completion_tokens))
      ? Number(usage.completion_tokens)
      : estimateCompletionTokens(jsonResponse.choices);
    const generationId = typeof jsonResponse.id === 'string' ? jsonResponse.id : undefined;
    const rawCostUsd =
      usage.cost !== undefined || usage.total_cost !== undefined
        ? Number(usage.cost ?? usage.total_cost ?? 0)
        : estimateCostUsd(modelId, promptTokens, completionTokens);

    if (costReported) warnIfFreeModelBilled(modelId, rawCostUsd, actor.id);
    const upstreamMicros = BigInt(Math.round(rawCostUsd * 1_000_000));
    const billedMicros = (upstreamMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
    let recordId: string | undefined;
    try {
      recordId = await this.ledger.settleSpend(reservationId, {
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
    } catch {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'SPEND_LEDGER_UNAVAILABLE',
            message: 'Spend accounting failed; the upstream response was not returned.',
          },
        }),
      );
      return;
    }
    if (!costReported && generationId && recordId)
      void this.reconcileGenerationUsage(recordId, generationId);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(jsonResponse));
  }

  private async safeSettle(
    reservationId: string,
    input: Parameters<AgentUsageLedger['record']>[0],
  ): Promise<string | undefined> {
    try {
      if (!this.ledger.settleSpend) throw new Error('SPEND_LEDGER_UNAVAILABLE');
      return await this.ledger.settleSpend(reservationId, input);
    } catch {
      console.error('joy-model-gateway: spend settlement failed', {
        code: 'SPEND_LEDGER_UNAVAILABLE',
        ownerId: input.ownerId,
        modelId: input.modelId,
      });
      return undefined;
    }
  }

  private async safeRelease(reservationId: string): Promise<void> {
    try {
      await this.ledger.releaseSpend?.(reservationId);
    } catch {
      console.error('joy-model-gateway: spend reservation release failed', {
        code: 'SPEND_LEDGER_UNAVAILABLE',
      });
    }
  }

  private async reconcileGenerationUsage(recordId: string, generationId: string): Promise<void> {
    if (!this.ledger.replaceEstimate) return;
    for (const delayMs of [0, 2_000, 5_000, 10_000]) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const response = await this.fetchImpl(
          `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
          {
            headers: { authorization: `Bearer ${this.openRouterApiKey}` },
            signal: AbortSignal.timeout(5_000),
          },
        );
        if (!response.ok) continue;
        const payload = (await response.json()) as { data?: Record<string, unknown> };
        const data = payload.data ?? {};
        const promptTokens = Number(data.tokens_prompt ?? data.prompt_tokens);
        const completionTokens = Number(data.tokens_completion ?? data.completion_tokens);
        const cost = Number(data.total_cost ?? data.cost);
        if (![promptTokens, completionTokens, cost].every(Number.isFinite) || cost < 0) continue;
        warnIfFreeModelBilled(String(data.model ?? 'unknown'), cost, undefined);
        const upstreamCostMicros = BigInt(Math.round(cost * 1_000_000));
        const billedCostMicros =
          (upstreamCostMicros * BigInt(10000 + this.commissionRateBps)) / 10000n;
        await this.ledger.replaceEstimate(recordId, {
          promptTokens,
          completionTokens,
          upstreamCostMicros,
          billedCostMicros,
        });
        return;
      } catch {
        // Best effort; scheduled retry never delays the already-sent response.
      }
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
  // Reasoning models think anyway; ask OpenRouter to leave the reasoning out of the reply.
  if (JOY_AGENT_FREE_MODELS.find((model) => model.id === modelId)?.reasoning === true)
    body.reasoning = { exclude: true };
  // Pin OpenRouter's file parser to its free engine so no paid one (mistral-ocr) can ever be
  // chosen. File parts are refused above; this is the second lock. Client plugins are never
  // forwarded (they are not in FORWARDED_COMPLETION_FIELDS).
  body.plugins = [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }];
  return body;
}

/**
 * Every catalog model is free, so OpenRouter reporting a cost means something upstream billed
 * us anyway (a plugin, a re-routed model). Log it loudly so it is noticed and the key capped.
 */
function warnIfFreeModelBilled(modelId: string, costUsd: number, ownerId: string | undefined) {
  if (!(costUsd > 0)) return;
  console.error('joy-model-gateway: PAID SPEND REPORTED FOR A FREE MODEL', {
    code: 'JOY_FREE_MODEL_BILLED',
    modelId,
    costUsd,
    ...(ownerId === undefined ? {} : { ownerId }),
  });
}

/** Content part types the gateway forwards; anything else (file, input_audio, video_url) is refused. */
function unsupportedContentIssue(messages: unknown): string | undefined {
  if (messages === undefined) return undefined;
  if (!Array.isArray(messages)) return 'messages must be an array.';
  for (const [index, message] of messages.entries()) {
    if (message === null || typeof message !== 'object' || Array.isArray(message))
      return `Message ${index + 1} is not an object.`;
    const content = (message as { content?: unknown }).content;
    if (content === undefined || content === null || typeof content === 'string') continue;
    if (!Array.isArray(content))
      return `Message ${index + 1} content must be a string or an array of parts.`;
    for (const part of content) {
      const type =
        part !== null && typeof part === 'object' ? (part as { type?: unknown }).type : undefined;
      if (type === 'text') continue;
      if (type === 'image_url') {
        const imageUrl = (part as { image_url?: unknown }).image_url;
        const url =
          typeof imageUrl === 'string'
            ? imageUrl
            : imageUrl !== null && typeof imageUrl === 'object'
              ? (imageUrl as { url?: unknown }).url
              : undefined;
        if (typeof url !== 'string' || !/^(?:https:\/\/|data:image\/)/i.test(url))
          return 'image_url parts must carry an https: or data:image/ URL.';
        continue;
      }
      return `Content part type ${typeof type === 'string' ? `'${type.slice(0, 40)}'` : '(missing)'} is not supported; send text or image_url parts only.`;
    }
  }
  return undefined;
}

/** The parts of an OpenRouter stream chunk the gateway reads for accounting. */
interface StreamChunkShape {
  readonly id?: unknown;
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: unknown;
      readonly tool_calls?: ReadonlyArray<{
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }>;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly cost?: unknown;
    readonly total_cost?: unknown;
  };
}

const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_details'] as const;

/**
 * Removes reasoning from a completion or a stream chunk, in place: the reasoning fields of each
 * choice's message or delta, and a leading <think>...</think> block in a message's content.
 * Returns true if anything was removed.
 */
function stripReasoning(payload: Record<string, unknown>): boolean {
  if (!Array.isArray(payload.choices)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    if (!isPlainObject(choice)) continue;
    for (const key of ['message', 'delta'] as const) {
      const part = choice[key];
      if (!isPlainObject(part)) continue;
      for (const field of REASONING_FIELDS) {
        if (!Object.hasOwn(part, field)) continue;
        delete part[field];
        changed = true;
      }
      if (key === 'message' && typeof part.content === 'string') {
        const content = part.content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
        if (content !== part.content) {
          part.content = content;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/**
 * OpenRouter can answer HTTP 200 and still report a failure in the body: a top-level `error`
 * object, or an `error` on every choice. Returns it in the `{ error }` shape, or undefined.
 */
function bodyErrorOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isPlainObject(payload.error)) return { error: payload.error };
  const choices = payload.choices;
  if (
    Array.isArray(choices) &&
    choices.length > 0 &&
    choices.every((choice) => isPlainObject(choice) && isPlainObject(choice.error))
  )
    return { error: (choices[0] as { error: Record<string, unknown> }).error };
  return undefined;
}

/** The start of an upstream stream, read before the client response is committed. */
interface StreamStart {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly decoder: TextDecoder;
  /** What was read so far, decoded; forwarded once the stream is accepted. */
  readonly text: string;
}

type StreamPeek =
  | { readonly kind: 'ok'; readonly start: StreamStart }
  | { readonly kind: 'error'; readonly payload: Record<string, unknown> };

/**
 * Reads the stream up to its first `data:` event (skipping comments such as OpenRouter's
 * processing notices). An error event there means the model failed before answering, so the
 * caller can still try the next one. Throws a TimeoutError at the deadline.
 */
async function peekStreamStart(
  body: ReadableStream<Uint8Array>,
  deadline: number,
): Promise<StreamPeek> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = false;
  const accept = (): StreamPeek => ({ kind: 'ok', start: { reader, decoder, text } });
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, Math.max(1, deadline - Date.now()));
      if (done) {
        text += decoder.decode();
        return accept();
      }
      received = true;
      text += decoder.decode(value, { stream: true });
      const lines = text.split(/\r?\n/);
      lines.pop();
      for (const line of lines) {
        const match = /^data:\s?(.*)$/.exec(line);
        if (match === null) continue;
        const payload = parseJsonObject(match[1]!);
        const bodyError = payload === undefined ? undefined : bodyErrorOf(payload);
        if (bodyError === undefined) return accept();
        void reader.cancel().catch(() => {});
        return { kind: 'error', payload: bodyError };
      }
    }
  } catch (error) {
    // A stream that breaks after sending something is accepted: the main loop meets the same
    // error, ends the response cleanly and accounts for what arrived. A timeout still fails.
    if (received && !(error instanceof Error && error.name === 'TimeoutError')) return accept();
    void reader.cancel().catch(() => {});
    throw error;
  }
}

/**
 * Seconds a client should wait when every model was busy: the soonest upstream Retry-After,
 * clamped to 5..300, or 30 when no attempt sent one.
 */
function retryHintSeconds(failures: readonly UpstreamFailure[]): number {
  let soonest: number | undefined;
  for (const { retryAfter } of failures) {
    if (retryAfter === undefined) continue;
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter)
      : (Date.parse(retryAfter) - Date.now()) / 1000;
    if (Number.isFinite(seconds) && seconds > 0)
      soonest = soonest === undefined ? seconds : Math.min(soonest, seconds);
  }
  return Math.min(300, Math.max(5, Math.ceil(soonest ?? 30)));
}

const UPSTREAM_ERROR_BODY_MAX_BYTES = 32 * 1024;

/** Reads a bounded error body and keeps only OpenRouter's error code and routing metadata. */
async function readUpstreamFailure(response: Response): Promise<UpstreamFailure> {
  const retryAfter = response.headers.get('retry-after');
  return {
    status: response.status,
    ...openRouterErrorFields(parseJsonObject(await readBoundedText(response))),
    ...(retryAfter === null ? {} : { retryAfter }),
  };
}

async function readBoundedText(
  response: Response,
  maxBytes = UPSTREAM_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await readStreamChunk(reader, 10_000);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A partial body is enough to classify the failure.
  } finally {
    void reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** OpenRouter's `{ error: { code, message, metadata: { failed_routing_step, ... } } }`. */
function openRouterErrorFields(
  payload: Record<string, unknown> | undefined,
): Omit<UpstreamFailure, 'status' | 'retryAfter'> {
  const error = payload?.error;
  if (!isPlainObject(error)) return {};
  const metadata = isPlainObject(error.metadata) ? error.metadata : {};
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? logSafe(String(value)) : undefined;
  const code = text(error.code);
  const failedRoutingStep = text(metadata.failed_routing_step);
  const limitSource = text(metadata.limit_source);
  const providerName = text(metadata.provider_name);
  return {
    ...(code === undefined ? {} : { code }),
    ...(typeof error.message === 'string' ? { message: error.message.slice(0, 500) } : {}),
    ...(failedRoutingStep === undefined ? {} : { failedRoutingStep }),
    ...(limitSource === undefined ? {} : { limitSource }),
    ...(providerName === undefined ? {} : { providerName }),
  };
}

/** Short, single-line, printable: safe for a log line. */
function logSafe(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function failureLogFields(failure: UpstreamFailure) {
  return {
    status: failure.status,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.failedRoutingStep === undefined
      ? {}
      : { failedRoutingStep: failure.failedRoutingStep }),
    ...(failure.limitSource === undefined ? {} : { limitSource: failure.limitSource }),
    ...(failure.providerName === undefined ? {} : { providerName: failure.providerName }),
  };
}

/**
 * One line per upstream attempt: model, HTTP status, OpenRouter error code and routing metadata.
 * Never the request or response body, which can carry user content.
 */
function logUpstreamAttempt(entry: {
  readonly ownerId: string;
  readonly attempt: number;
  readonly of: number;
  readonly modelId: string;
  readonly outcome: 'ok' | UpstreamFailureKind | 'timeout' | 'unreachable';
  readonly status?: number;
  readonly code?: string;
  readonly failedRoutingStep?: string;
  readonly limitSource?: string;
  readonly providerName?: string;
}): void {
  if (entry.outcome === 'ok') console.info('joy-model-gateway: upstream attempt', entry);
  else console.warn('joy-model-gateway: upstream attempt', entry);
}

function positiveEnvInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function estimatePromptTokens(messages: unknown, tools?: unknown): number {
  let imageCount = 0;
  const textParts = Array.isArray(messages)
    ? messages.flatMap((message) => {
        if (message === null || typeof message !== 'object') return [];
        const item = message as { content?: unknown; tool_calls?: unknown };
        const parts: string[] = [];
        if (typeof item.content === 'string') parts.push(item.content);
        else if (Array.isArray(item.content))
          parts.push(
            ...item.content.flatMap((part) => {
              if (
                part !== null &&
                typeof part === 'object' &&
                ((part as { type?: unknown }).type === 'image' ||
                  (part as { type?: unknown }).type === 'image_url')
              )
                imageCount += 1;
              return part !== null &&
                typeof part === 'object' &&
                typeof (part as { text?: unknown }).text === 'string'
                ? [(part as { text: string }).text]
                : [];
            }),
          );
        parts.push(...toolCallsAsText(item.tool_calls));
        return parts;
      })
    : [];
  if (tools !== undefined) textParts.push(JSON.stringify(tools));
  return estimateTextTokens(textParts.join(' ')) + imageCount * 1600;
}

function estimateCompletionTokens(choices: unknown): number {
  const text = Array.isArray(choices)
    ? choices
        .flatMap((choice) => {
          if (choice === null || typeof choice !== 'object') return [];
          const message = (choice as { message?: unknown }).message;
          if (message === null || typeof message !== 'object') return [];
          const item = message as { content?: unknown; tool_calls?: unknown };
          const parts: string[] = [];
          if (typeof item.content === 'string') parts.push(item.content);
          parts.push(...toolCallsAsText(item.tool_calls));
          return parts;
        })
        .join(' ')
    : '';
  return estimateTextTokens(text);
}

function toolCallsAsText(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.flatMap((toolCall) => {
    if (toolCall === null || typeof toolCall !== 'object') return [];
    const fn = (toolCall as { function?: unknown }).function;
    if (fn === null || typeof fn !== 'object') return [];
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown };
    return [name, args].filter((part): part is string => typeof part === 'string');
  });
}

function estimateTextTokens(text: string): number {
  let latinCharacters = 0;
  let nonLatinText = '';
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) latinCharacters += 1;
    else nonLatinText += character;
  }
  const latinEstimate = latinCharacters / 4;
  const nonLatinEstimate = Buffer.byteLength(nonLatinText, 'utf8') / 3;
  return Math.ceil(latinEstimate + nonLatinEstimate);
}

function estimateCostUsd(modelId: string, promptTokens: number, completionTokens: number): number {
  const model = JOY_AGENT_FREE_MODELS.find((entry) => entry.id === modelId);
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
