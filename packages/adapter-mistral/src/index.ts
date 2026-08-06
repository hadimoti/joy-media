import type {
  CapabilityDeclaration,
  CapabilityId,
  CapabilityRequest,
  CapabilityResult,
  Diagnostic,
  ModelDescriptor,
  ProviderManifestV2,
  ProviderUsage,
  ProviderV2,
} from '@joy-media/provider-sdk';

export const MISTRAL_PROVIDER_ID = 'mistral' as const;
export const MISTRAL_ADAPTER_VERSION = '1.0.0' as const;

/** The initial, deliberately small allowlist for JOY Code reasoning. */
export const MISTRAL_REASONING_MODELS: readonly ModelDescriptor[] = [
  {
    id: 'mistral-small-latest',
    displayName: 'Mistral Small',
    version: 'latest',
  },
];

export interface MistralChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface MistralCompletionInput {
  readonly model: string;
  readonly messages: readonly MistralChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface MistralAdapterOptions {
  /** Resolved by the API process only. Never pass this across a browser boundary. */
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 30_000;

export function createMistralAdapter(options: MistralAdapterOptions): ProviderV2 {
  const manifest: ProviderManifestV2 = {
    protocolVersion: 2,
    id: MISTRAL_PROVIDER_ID,
    displayName: 'Mistral',
    adapterVersion: MISTRAL_ADAPTER_VERSION,
    execution: 'remote-api',
    capabilities: [completionCapability()],
    configurationSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultModel: { type: 'string', enum: MISTRAL_REASONING_MODELS.map((model) => model.id) },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      },
    },
    // This declares a server-side field name only; it is not a credential value.
    secretFields: ['apiKey'],
    healthCheck: { endpoint: DEFAULT_ENDPOINT, intervalMs: 60_000, timeoutMs: DEFAULT_TIMEOUT_MS },
    privacy: {
      dataLeavesDevice: true,
      retentionDisclosure: 'Prompt text is sent to Mistral for remote processing.',
    },
  };

  return {
    manifest,
    async invoke(
      capability: CapabilityId,
      input: unknown,
      request?: CapabilityRequest,
    ): Promise<CapabilityResult> {
      const startedAt = Date.now();
      const requestId = `mistral-${crypto.randomUUID()}`;
      const idempotencyKey = request?.idempotencyKey ?? requestId;
      const parsed = parseInput(input);
      const provenance = (modelId: string) => ({
        providerId: MISTRAL_PROVIDER_ID,
        modelId,
        adapterVersion: MISTRAL_ADAPTER_VERSION,
        createdAt: new Date().toISOString(),
        requestHash: hashRequest({ input, idempotencyKey }),
        idempotencyKey,
        processingTimeMs: Date.now() - startedAt,
        execution: 'remote-api' as const,
      });

      if (capability !== 'llm.complete') {
        return failed(
          requestId,
          provenance('unknown'),
          'UNSUPPORTED_CAPABILITY',
          'Only llm.complete is supported.',
        );
      }
      if ('error' in parsed) {
        return failed(requestId, provenance('unknown'), 'INVALID_INPUT', parsed.error);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await (options.fetchImpl ?? fetch)(options.endpoint ?? DEFAULT_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            model: parsed.value.model,
            messages: parsed.value.messages,
            ...(parsed.value.maxTokens === undefined ? {} : { max_tokens: parsed.value.maxTokens }),
            ...(parsed.value.temperature === undefined
              ? {}
              : { temperature: parsed.value.temperature }),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const code =
            response.status === 401 || response.status === 403
              ? 'MISTRAL_UNAUTHORIZED'
              : 'MISTRAL_REQUEST_FAILED';
          return failed(
            requestId,
            provenance(parsed.value.model),
            code,
            `Mistral request failed (${response.status}).`,
          );
        }
        const payload: unknown = await response.json();
        const text = completionText(payload);
        if (text === undefined) {
          return failed(
            requestId,
            provenance(parsed.value.model),
            'INVALID_PROVIDER_RESPONSE',
            'Mistral response did not contain text.',
          );
        }
        const usage = usageFrom(payload, parsed.value.model, Date.now() - startedAt);
        return {
          requestId,
          status: 'succeeded',
          outputs: [
            {
              kind: 'text',
              assetId: `mistral-completion-${requestId}`,
              mimeType: 'text/plain; charset=utf-8',
              metadata: { text },
            },
          ],
          provenance: provenance(parsed.value.model),
          ...(usage === undefined ? {} : { usage }),
          diagnostics: [],
        };
      } catch (error) {
        const code =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'MISTRAL_TIMEOUT'
            : 'MISTRAL_UNAVAILABLE';
        const message =
          code === 'MISTRAL_TIMEOUT' ? 'Mistral request timed out.' : 'Mistral is unavailable.';
        return failed(requestId, provenance(parsed.value.model), code, message);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function completionCapability(): CapabilityDeclaration {
  return {
    id: 'llm.complete',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'messages'],
      properties: {
        model: { type: 'string', enum: MISTRAL_REASONING_MODELS.map((model) => model.id) },
        messages: { type: 'array', minItems: 1 },
        maxTokens: { type: 'integer', minimum: 1, maximum: 4096 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
      },
    },
    outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    models: MISTRAL_REASONING_MODELS,
    supportsCancel: true,
    estimatedResources: { estimatedDurationMs: DEFAULT_TIMEOUT_MS },
    policyFlags: ['remote-processing', 'provider.spend', 'privacy-approval-required'],
  };
}

function parseInput(
  input: unknown,
): { readonly value: MistralCompletionInput } | { readonly error: string } {
  if (!isRecord(input)) return { error: 'Completion input must be an object.' };
  const model = input.model;
  const messages = input.messages;
  if (typeof model !== 'string' || !MISTRAL_REASONING_MODELS.some((item) => item.id === model))
    return { error: 'Requested model is not in the Mistral allowlist.' };
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 64)
    return { error: 'messages must contain between 1 and 64 entries.' };
  if (messages.some((message) => !validMessage(message))) return { error: 'messages are invalid.' };
  const totalCharacters = messages.reduce(
    (sum, message) => sum + (message as MistralChatMessage).content.length,
    0,
  );
  if (totalCharacters > 64_000) return { error: 'messages exceed the 64,000 character limit.' };
  const rawMaxTokens = input.maxTokens;
  if (
    rawMaxTokens !== undefined &&
    (typeof rawMaxTokens !== 'number' ||
      !Number.isInteger(rawMaxTokens) ||
      rawMaxTokens < 1 ||
      rawMaxTokens > 4096)
  )
    return { error: 'maxTokens must be an integer from 1 to 4096.' };
  const maxTokens = rawMaxTokens as number | undefined;
  const rawTemperature = input.temperature;
  if (
    rawTemperature !== undefined &&
    (typeof rawTemperature !== 'number' ||
      !Number.isFinite(rawTemperature) ||
      rawTemperature < 0 ||
      rawTemperature > 2)
  )
    return { error: 'temperature must be a number from 0 to 2.' };
  const temperature = rawTemperature as number | undefined;
  return {
    value: {
      model,
      messages: messages as readonly MistralChatMessage[],
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
    },
  };
}

function validMessage(value: unknown): value is MistralChatMessage {
  return (
    isRecord(value) &&
    (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    value.content.length > 0
  );
}

function completionText(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string')
    return undefined;
  return first.message.content;
}

function usageFrom(
  payload: unknown,
  modelId: string,
  durationMs: number,
): ProviderUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const inputTokens = payload.usage.prompt_tokens;
  const outputTokens = payload.usage.completion_tokens;
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens)
  )
    return undefined;
  return {
    providerId: MISTRAL_PROVIDER_ID,
    capability: 'llm.complete',
    modelId,
    timestamp: new Date().toISOString(),
    durationMs,
    inputTokens,
    outputTokens,
  };
}

function failed(
  requestId: string,
  provenance: CapabilityResult['provenance'],
  code: string,
  message: string,
): CapabilityResult {
  const diagnostics: readonly Diagnostic[] = [{ severity: 'error', code, message }];
  return { requestId, status: 'failed', outputs: [], provenance, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hashRequest(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
