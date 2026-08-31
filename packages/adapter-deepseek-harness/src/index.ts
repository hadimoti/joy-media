import type {
  AsyncAdapterOptions,
  AsyncOutcome,
  JoyCodeModelPlanV1,
  JoyCodePlannerInputV1,
  JoyCodeValidationOptions,
} from '@joy-media/agent-tools';
import { validateJoyCodeModelPlan } from '@joy-media/agent-tools';

/** The stable engine identifier written to local provenance, never to cloud settings. */
export const DEEPSEEK_HARNESS_ENGINE = 'deepseek-harness' as const;
export const DEEPSEEK_HARNESS_DEFAULT_MODEL = 'deepseek-chat' as const;
export const DEEPSEEK_HARNESS_DEFAULT_TIMEOUT_MS = 30_000;
export const DEEPSEEK_HARNESS_MAX_RESPONSE_BYTES = 256 * 1024;

export interface DeepSeekHarnessEndpoint {
  readonly endpointUrl: string;
  readonly modelId?: string;
  readonly apiKey: string;
}

export interface DeepSeekHarnessTransport {
  post(url: string, options: RequestInit): Promise<Response>;
}

export interface DeepSeekHarnessAdapterOptions extends DeepSeekHarnessEndpoint {
  readonly timeoutMs?: number;
  readonly transport?: DeepSeekHarnessTransport;
  readonly validationOptions?: JoyCodeValidationOptions;
}

export interface DeepSeekHarnessRequest {
  readonly model: string;
  readonly messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ];
  readonly temperature: 0;
  readonly max_tokens: 4096;
  readonly response_format: { readonly type: 'json_object' };
}

export type DeepSeekHarnessDecodeOutcome =
  | { readonly category: 'ready'; readonly result: JoyCodeModelPlanV1 }
  | {
      readonly category: 'invalid-output' | 'provider-failed';
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: boolean;
    };

const DEFAULT_VALIDATION_OPTIONS: JoyCodeValidationOptions = {
  textTemplateIds: ['clean-title'],
  captionTemplateIds: ['joy-clean', 'joy-karaoke-pop', 'joy-rtl-classic'],
  transitionIds: ['dissolve', 'wipe', 'slide'],
  allowedModelIds: [DEEPSEEK_HARNESS_DEFAULT_MODEL],
};

/**
 * Build the harness request. The endpoint is caller-owned, but the payload is
 * deliberately bounded and excludes credentials, paths, URLs, and media bytes.
 */
export function buildDeepSeekHarnessRequest(
  input: JoyCodePlannerInputV1,
  modelId: string = DEEPSEEK_HARNESS_DEFAULT_MODEL,
): DeepSeekHarnessRequest {
  const serialized = JSON.stringify({
    projectId: input.projectId,
    snapshotRevisionId: input.snapshotRevisionId,
    prompt: input.prompt,
    ...(input.creativeBrief === undefined ? {} : { creativeBrief: input.creativeBrief }),
    semanticSnapshot: input.semanticSnapshot,
    intelligenceSummary: input.intelligenceSummary,
    catalogs: input.catalogs,
    selection: input.selection,
  });
  if (new TextEncoder().encode(serialized).byteLength > 32_000) {
    throw new Error('DEEPSEEK_HARNESS_PROMPT_TOO_LARGE');
  }
  if (containsForbiddenData(serialized)) {
    throw new Error('DEEPSEEK_HARNESS_FORBIDDEN_DATA');
  }
  return {
    model: modelId,
    messages: [
      {
        role: 'system',
        content:
          'You are the JOY Media Joy Code planner. Return exactly one JSON object matching the bounded Joy Code plan schema. Never include paths, URLs, secrets, raw documents, or media bytes.',
      },
      { role: 'user', content: serialized },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  };
}

export function decodeDeepSeekHarnessResponse(
  value: unknown,
  validationOptions: JoyCodeValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): DeepSeekHarnessDecodeOutcome {
  if (!isRecord(value)) return providerFailure('DEEPSEEK_HARNESS_RESPONSE_INVALID', true);
  if (isRecord(value.error)) return providerFailure('DEEPSEEK_HARNESS_PROVIDER_FAILED', true);
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length !== 1 || !isRecord(choices[0]))
    return invalid('DEEPSEEK_HARNESS_CHOICE_INVALID');
  const message = isRecord(choices[0].message) ? choices[0].message : undefined;
  const content = typeof message?.content === 'string' ? message.content : undefined;
  if (content === undefined || content.trim() === '')
    return invalid('DEEPSEEK_HARNESS_EMPTY_RESPONSE');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return invalid('DEEPSEEK_HARNESS_JSON_INVALID');
  }
  const result = validateJoyCodeModelPlan(parsed, validationOptions);
  if (!result.valid) return invalid('DEEPSEEK_HARNESS_PLAN_INVALID');
  return { category: 'ready', result: result.value };
}

export class DeepSeekHarnessJoyCodeAdapter {
  readonly adapterName = 'deepseek-harness-joy-code-v1';
  readonly isTestOnly = false;
  readonly #options: DeepSeekHarnessAdapterOptions;

  constructor(options: DeepSeekHarnessAdapterOptions) {
    this.#options = options;
  }

  async createPlan(
    input: JoyCodePlannerInputV1,
    runtime: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<JoyCodeModelPlanV1>> {
    const started = Date.now();
    const fail = (
      category: AsyncOutcome<JoyCodeModelPlanV1>['category'],
      errorCode: string,
      retryable: boolean,
    ): AsyncOutcome<JoyCodeModelPlanV1> => ({
      category,
      errorCode,
      message: 'DeepSeek harness Joy Code request failed',
      retryable,
      durationMs: Date.now() - started,
    });
    if (runtime.signal?.aborted) return fail('cancelled', 'DEEPSEEK_HARNESS_CANCELLED', false);
    const endpoint = parseEndpoint(this.#options.endpointUrl);
    if (endpoint === undefined || this.#options.apiKey.trim() === '')
      return fail('policy-denied', 'DEEPSEEK_HARNESS_ENDPOINT_INVALID', false);
    if (this.#options.transport === undefined)
      return fail('unavailable', 'DEEPSEEK_HARNESS_TRANSPORT_UNAVAILABLE', false);
    let request: DeepSeekHarnessRequest;
    try {
      request = buildDeepSeekHarnessRequest(
        input,
        this.#options.modelId ?? DEEPSEEK_HARNESS_DEFAULT_MODEL,
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DEEPSEEK_HARNESS_REQUEST_INVALID';
      return fail('invalid-output', code, false);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    runtime.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutMs = Math.max(
      1,
      runtime.timeoutMs ?? this.#options.timeoutMs ?? DEEPSEEK_HARNESS_DEFAULT_TIMEOUT_MS,
    );
    try {
      const responsePromise = this.#options.transport.post(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('timeout'));
        }, timeoutMs);
      });
      const response = await Promise.race([responsePromise, timeoutPromise]);
      if (!response.ok) {
        await cancelResponseBody(response);
        return fail('provider-failed', 'DEEPSEEK_HARNESS_PROVIDER_FAILED', true);
      }
      const text = await readResponseBody(response, controller, timeoutMs);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail('provider-failed', 'DEEPSEEK_HARNESS_RESPONSE_INVALID', true);
      }
      const decoded = decodeDeepSeekHarnessResponse(body, this.#options.validationOptions);
      if (decoded.category !== 'ready')
        return fail(decoded.category, decoded.errorCode, decoded.retryable);
      return {
        category: 'ready',
        result: decoded.result,
        retryable: false,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (runtime.signal?.aborted) return fail('cancelled', 'DEEPSEEK_HARNESS_CANCELLED', false);
      if (
        timedOut ||
        error instanceof ResponseBodyTimeoutError ||
        (error instanceof Error && error.message === 'timeout')
      )
        return fail('timeout', 'DEEPSEEK_HARNESS_TIMEOUT', true);
      if (error instanceof ResponseTooLargeError)
        return fail('provider-failed', 'DEEPSEEK_HARNESS_RESPONSE_TOO_LARGE', false);
      return fail('provider-failed', 'DEEPSEEK_HARNESS_PROVIDER_FAILED', true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      runtime.signal?.removeEventListener('abort', onAbort);
    }
  }
}

class ResponseTooLargeError extends Error {}
class ResponseBodyTimeoutError extends Error {}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) await response.body.cancel('provider-failed').catch(() => undefined);
}

async function readResponseBody(
  response: Response,
  controller: AbortController,
  timeoutMs: number,
): Promise<string> {
  if (response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > DEEPSEEK_HARNESS_MAX_RESPONSE_BYTES)
      throw new ResponseTooLargeError();
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new ResponseBodyTimeoutError();
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            controller.abort();
            reject(new ResponseBodyTimeoutError());
          }, remainingMs);
        }),
      ]).finally(() => {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      });
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > DEEPSEEK_HARNESS_MAX_RESPONSE_BYTES) {
        await reader.cancel('response-too-large');
        controller.abort();
        throw new ResponseTooLargeError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel('response-body-failed').catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createDeepSeekHarnessJoyCodeAdapter(
  options: DeepSeekHarnessAdapterOptions,
): DeepSeekHarnessJoyCodeAdapter {
  return new DeepSeekHarnessJoyCodeAdapter(options);
}

function parseEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}
function containsForbiddenData(value: string): boolean {
  return /https?:\/\/|(?:^|[\\/])(?:etc|home|root)[\\/]|sk-[A-Za-z0-9]|bearer\s|authorization|password\s*=/i.test(
    value,
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(errorCode: string): DeepSeekHarnessDecodeOutcome {
  return {
    category: 'invalid-output',
    errorCode,
    message: 'DeepSeek harness returned invalid Joy Code output',
    retryable: false,
  };
}
function providerFailure(errorCode: string, retryable: boolean): DeepSeekHarnessDecodeOutcome {
  return {
    category: 'provider-failed',
    errorCode,
    message: 'DeepSeek harness provider failed',
    retryable,
  };
}
