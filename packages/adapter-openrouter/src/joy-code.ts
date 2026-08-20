import type { AsyncAdapterOptions, AsyncOutcome } from '@joy-media/agent-tools';
import type {
  AsyncJoyCodePlannerAdapter,
  JoyCodeModelPlanV1,
  JoyCodePlannerInputV1,
  JoyCodePlanValidationResult,
  JoyCodeValidationOptions,
} from '@joy-media/agent-tools';
import { validateJoyCodeModelPlan } from '@joy-media/agent-tools';
import type { Clock, HttpPostTransport, SecretResolver } from './index.js';

export const JOY_CODE_MODEL_ID = 'nvidia/nemotron-3.5-lightning:free' as const;
export const JOY_CODE_SECRET_REF = 'joy-media/openrouter/joy-code-planner/v1' as const;
export const JOY_CODE_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions' as const;
export const JOY_CODE_MAX_OUTPUT_TOKENS = 4096 as const;
export const JOY_CODE_MAX_RESPONSE_BYTES = 256 * 1024;
const JOY_CODE_TOOL_NAME = 'submit_joy_code_plan' as const;

export interface JoyCodeRequest {
  readonly model: string;
  readonly messages: readonly [
    { readonly role: 'system'; readonly content: string },
    { readonly role: 'user'; readonly content: string },
  ];
  readonly temperature: 0;
  readonly max_tokens: typeof JOY_CODE_MAX_OUTPUT_TOKENS;
  readonly tools: readonly [
    {
      readonly type: 'function';
      readonly function: {
        readonly name: typeof JOY_CODE_TOOL_NAME;
        readonly description: string;
        readonly parameters: Readonly<Record<string, unknown>>;
      };
    },
  ];
  readonly tool_choice: {
    readonly type: 'function';
    readonly function: { readonly name: typeof JOY_CODE_TOOL_NAME };
  };
  readonly provider: { readonly allow_fallbacks: false };
}

export type JoyCodeRequestOutcome =
  | { readonly category: 'ready'; readonly result: JoyCodeRequest }
  | {
      readonly category: 'invalid-output';
      readonly errorCode: string;
      readonly message: string;
      readonly retryable: false;
    };

export type JoyCodeDecodeOutcome =
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
  allowedModelIds: [JOY_CODE_MODEL_ID],
};

export function buildJoyCodeRequest(
  input: JoyCodePlannerInputV1,
  options: Pick<OpenRouterJoyCodeAdapterOptions, 'modelId'>,
): JoyCodeRequestOutcome {
  const serialized = JSON.stringify({
    projectId: input.projectId,
    snapshotRevisionId: input.snapshotRevisionId,
    prompt: input.prompt,
    semanticSnapshot: input.semanticSnapshot,
    intelligenceSummary: input.intelligenceSummary,
    catalogs: input.catalogs,
    selection: input.selection,
  });
  if (containsForbiddenData(serialized))
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_FORBIDDEN_DATA',
      message: 'Joy Code request contains forbidden data',
      retryable: false,
    };
  if (new TextEncoder().encode(serialized).byteLength > 32_000)
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_PROMPT_TOO_LARGE',
      message: 'Joy Code request exceeded its bounded prompt limit',
      retryable: false,
    };
  const system =
    'You are the JOY Media Joy Code planner. Return exactly one submit_joy_code_plan tool call. Produce only bounded catalog operations; never include paths, URLs, secrets, raw documents, or media bytes. The plan is untrusted and will be previewed before Apply.';
  return {
    category: 'ready',
    result: {
      model: options.modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: serialized },
      ],
      temperature: 0,
      max_tokens: JOY_CODE_MAX_OUTPUT_TOKENS,
      tools: [
        {
          type: 'function',
          function: {
            name: JOY_CODE_TOOL_NAME,
            description: 'Submit a bounded Joy Code edit plan for explicit user approval.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: [
                'schemaVersion',
                'goal',
                'summary',
                'operations',
                'assumptions',
                'blockedBy',
                'requiresHumanDecision',
              ],
              properties: {
                schemaVersion: { type: 'integer', enum: [1] },
                goal: { type: 'string' },
                summary: { type: 'string' },
                operations: { type: 'array', maxItems: 24 },
                assumptions: { type: 'array' },
                blockedBy: { type: 'array' },
                requiresHumanDecision: { type: 'array' },
              },
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: JOY_CODE_TOOL_NAME } },
      provider: { allow_fallbacks: false },
    },
  };
}

export function decodeJoyCodeResponse(
  value: unknown,
  validationOptions: JoyCodeValidationOptions = DEFAULT_VALIDATION_OPTIONS,
): JoyCodeDecodeOutcome {
  if (!isRecord(value) || value.model !== JOY_CODE_MODEL_ID)
    return {
      category: 'provider-failed',
      errorCode: 'OPENROUTER_JOY_CODE_MODEL_MISMATCH',
      message: 'OpenRouter returned an unexpected model',
      retryable: false,
    };
  const usage = value.usage;
  if (
    !isRecord(usage) ||
    !Number.isSafeInteger(usage.prompt_tokens) ||
    !Number.isSafeInteger(usage.completion_tokens) ||
    typeof usage.cost !== 'number' ||
    !Number.isFinite(usage.cost) ||
    usage.cost !== 0
  )
    return {
      category: 'provider-failed',
      errorCode: 'OPENROUTER_JOY_CODE_USAGE_INVALID',
      message: 'OpenRouter usage was missing, invalid, or nonzero-cost',
      retryable: false,
    };
  if (!Array.isArray(value.choices) || value.choices.length !== 1)
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_TOOL_CALL_INVALID',
      message: 'OpenRouter must return exactly one choice',
      retryable: false,
    };
  const message =
    isRecord(value.choices[0]) && isRecord(value.choices[0].message)
      ? value.choices[0].message
      : undefined;
  const calls = message?.tool_calls;
  if (
    !Array.isArray(calls) ||
    calls.length !== 1 ||
    !isRecord(calls[0]) ||
    calls[0].type !== 'function' ||
    !isRecord(calls[0].function) ||
    calls[0].function.name !== JOY_CODE_TOOL_NAME ||
    typeof calls[0].function.arguments !== 'string'
  )
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_TOOL_CALL_INVALID',
      message: 'OpenRouter response did not contain the required tool call',
      retryable: false,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(calls[0].function.arguments);
  } catch {
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_ARGUMENTS_INVALID',
      message: 'Joy Code tool arguments were not valid JSON',
      retryable: false,
    };
  }
  const validation: JoyCodePlanValidationResult<JoyCodeModelPlanV1> = validateJoyCodeModelPlan(
    parsed,
    validationOptions,
  );
  if (!validation.valid)
    return {
      category: 'invalid-output',
      errorCode: 'OPENROUTER_JOY_CODE_PLAN_INVALID',
      message: 'Joy Code tool arguments failed schema validation',
      retryable: false,
    };
  return { category: 'ready', result: validation.value };
}

export interface OpenRouterJoyCodeAdapterOptions {
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly spendLimitUsdCents: number;
  readonly secretRef: string;
  readonly secretResolver?: SecretResolver;
  readonly transport?: HttpPostTransport;
  readonly clock?: Clock;
  readonly validationOptions?: JoyCodeValidationOptions;
}

export class OpenRouterJoyCodeAdapter implements AsyncJoyCodePlannerAdapter {
  readonly adapterName = 'openrouter-joy-code-v1';
  readonly isTestOnly = false;
  constructor(private readonly options: OpenRouterJoyCodeAdapterOptions) {}

  async createPlan(
    input: JoyCodePlannerInputV1,
    runtime: AsyncAdapterOptions,
  ): Promise<AsyncOutcome<JoyCodeModelPlanV1>> {
    const started = this.options.clock?.now() ?? Date.now();
    const duration = () => (this.options.clock?.now() ?? Date.now()) - started;
    const fail = (
      category: AsyncOutcome<JoyCodeModelPlanV1>['category'],
      errorCode: string,
      retryable: boolean,
    ): AsyncOutcome<JoyCodeModelPlanV1> => ({
      category,
      errorCode,
      message: 'OpenRouter Joy Code request failed',
      retryable,
      durationMs: duration(),
    });
    if (runtime.signal?.aborted) return fail('cancelled', 'OPENROUTER_JOY_CODE_CANCELLED', false);
    if (
      this.options.modelId !== JOY_CODE_MODEL_ID ||
      this.options.spendLimitUsdCents !== 0 ||
      this.options.secretRef !== JOY_CODE_SECRET_REF
    )
      return fail('policy-denied', 'OPENROUTER_JOY_CODE_POLICY_DENIED', false);
    const request = buildJoyCodeRequest(input, this.options);
    if (request.category !== 'ready') return fail('invalid-output', request.errorCode, false);
    const secret = this.options.secretResolver?.resolve(this.options.secretRef);
    if (secret === undefined)
      return fail('unavailable', 'OPENROUTER_JOY_CODE_SECRET_NOT_RESOLVED', false);
    if (this.options.transport === undefined)
      return fail('unavailable', 'OPENROUTER_JOY_CODE_TRANSPORT_NOT_CONFIGURED', false);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    runtime.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const requestPromise = this.options.transport.post(JOY_CODE_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.result),
        signal: controller.signal,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error('timeout'));
          },
          Math.max(1, runtime.timeoutMs ?? this.options.timeoutMs),
        );
      });
      const response = await Promise.race([requestPromise, timeoutPromise]);
      if (!response.ok) return fail('provider-failed', 'OPENROUTER_JOY_CODE_PROVIDER_FAILED', true);
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > JOY_CODE_MAX_RESPONSE_BYTES)
        return fail('provider-failed', 'OPENROUTER_JOY_CODE_RESPONSE_TOO_LARGE', false);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail('provider-failed', 'OPENROUTER_JOY_CODE_RESPONSE_INVALID', true);
      }
      const decoded = decodeJoyCodeResponse(body, this.options.validationOptions);
      if (decoded.category !== 'ready')
        return fail(decoded.category, decoded.errorCode, decoded.retryable);
      return {
        category: 'ready',
        result: decoded.result,
        retryable: false,
        durationMs: duration(),
      };
    } catch (error) {
      if (runtime.signal?.aborted) return fail('cancelled', 'OPENROUTER_JOY_CODE_CANCELLED', false);
      if (error instanceof Error && error.message === 'timeout')
        return fail('timeout', 'OPENROUTER_JOY_CODE_TIMEOUT', true);
      return fail('provider-failed', 'OPENROUTER_JOY_CODE_PROVIDER_FAILED', true);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      runtime.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function createOpenRouterJoyCodeAdapter(
  options: OpenRouterJoyCodeAdapterOptions,
): OpenRouterJoyCodeAdapter {
  return new OpenRouterJoyCodeAdapter(options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function containsForbiddenData(value: string): boolean {
  return /https?:\/\/|(?:^|[\\/])(?:etc|home|root)[\\/]|sk-[A-Za-z0-9]|bearer\s|authorization|password\s*=/i.test(
    value,
  );
}
