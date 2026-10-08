import {
  APICallError,
  generateObject,
  generateText,
  stepCountIs,
  ToolLoopAgent,
  tool,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
} from 'ai';
import { z } from 'zod';
import {
  JOY_AGENT_PROTOCOL_VERSION,
  parseJoyAgentSafeEvent,
  type JoyAgentCapability,
  type JoyAgentErrorDetail,
  type JoyAgentErrorCode,
  type JoyAgentSafeError,
  type JoyAgentSafeEvent,
  type JoyAgentRunRequest,
} from './contracts.js';
import { DEFAULT_JOY_AGENT_LIMITS, clampJoyAgentLimits, type JoyAgentLimits } from './limits.js';
import { safeErrorDetail, toSafeJoyAgentError } from './redaction.js';
import { createJoyAgentTools, type JoyAgentToolBridge } from './tools.js';

export const JOY_AGENT_INSTRUCTIONS = [
  'You are the JOY Media editing assistant.',
  'Inspect bounded context and propose bounded operations only.',
  'Never claim an edit is applied until submit_plan returns a committed result.',
  'When applying a timeline change, call submit_plan and use its verified placement summary in your final response.',
  'Batch every requested change into one plan and one submit_plan call whenever possible.',
  'When calling submit_plan, include a non-empty checklist covering every staged operation type and every requested trim, centered text, clip look, start position, or duration so the host can verify the final timeline.',
  'Do not split a requested edit across multiple partial plans. Unsupported requests must be called out explicitly.',
  'Do not request credentials, DOM selectors, endpoints, arbitrary headers, or hidden reasoning.',
].join(' ');

const planOnlyOutput = z
  .object({
    goal: z.string().max(512),
    summary: z.string().max(2048),
    operations: z.array(z.object({ kind: z.string().max(64) }).strict()).max(32),
  })
  .strict();

export interface JoyAgentEngineOptions {
  readonly model: LanguageModel;
  readonly bridge: JoyAgentToolBridge;
  readonly modelId?: string;
  readonly allowFrames?: boolean;
  readonly vision?: boolean;
  readonly limits?: Partial<JoyAgentLimits>;
  readonly capability?: JoyAgentCapability;
  readonly onEvent?: (event: JoyAgentSafeEvent) => void;
  readonly onTrace?: (record: JoyAgentTraceRecord) => void;
  readonly now?: () => Date;
  readonly apiKeyForRedaction?: string;
}

/** One line of the run transcript; failed tool calls are traced, never dropped. */
export interface JoyAgentTraceRecord {
  readonly type: 'tool_call' | 'observation' | 'tool_error' | 'assistant_text';
  readonly name: string;
  readonly value: unknown;
}

const MAX_TRACE_ERROR_CHARS = 500;

function redactApiKey(text: string, apiKey?: string): string {
  return apiKey ? text.split(apiKey).join('[REDACTED]') : text;
}

function traceErrorMessage(error: unknown, apiKey?: string): string {
  const message = redactApiKey(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown error'),
    apiKey,
  );
  return message.length > MAX_TRACE_ERROR_CHARS
    ? `${message.slice(0, MAX_TRACE_ERROR_CHARS)}…`
    : message;
}

function boundedTraceText(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  return `${new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/, '')}…`;
}

export class JoyAgentRunError extends Error {
  readonly detail: JoyAgentErrorDetail;

  constructor(
    readonly code: JoyAgentErrorCode,
    options: { readonly cause?: unknown; readonly detail: JoyAgentErrorDetail },
  ) {
    super(code, { cause: options.cause });
    this.name = 'JoyAgentRunError';
    this.detail = options.detail;
  }
}

export interface JoyAgentRunResult {
  readonly capability: JoyAgentCapability;
  readonly text: string;
  readonly steps: number;
  readonly status: 'completed' | 'partial';
  readonly partialReason?: 'step-limit' | 'tool-call-limit' | 'no-plan';
  readonly resolvedModelId?: string;
}

export interface JoyAgentProbeResult {
  readonly capability: JoyAgentCapability;
  readonly failure?: JoyAgentSafeError & { readonly detail?: JoyAgentErrorDetail };
  readonly resolvedModelId?: string;
}

type JoyAgentEventPayload = JoyAgentSafeEvent extends infer Event
  ? Event extends JoyAgentSafeEvent
    ? Omit<Event, 'protocolVersion' | 'runId' | 'seq' | 'at'>
    : never
  : never;

export async function probeJoyAgentModel(
  model: LanguageModel,
  abortSignal?: AbortSignal,
  maxOutputTokens = DEFAULT_JOY_AGENT_LIMITS.probeMaxOutputTokens,
  apiKeyForRedaction?: string,
): Promise<JoyAgentProbeResult> {
  const probeTool = tool({
    description: 'A harmless capability probe.',
    inputSchema: z.object({ value: z.literal('JOY_PROBE') }).strict(),
    execute: async () => ({ ok: true as const }),
  });
  let resolvedModelId: string | undefined;
  try {
    const result = await generateText({
      model,
      prompt: 'Call the JOY_PROBE tool exactly once, then stop.',
      tools: { joy_probe: probeTool },
      toolChoice: { type: 'tool', toolName: 'joy_probe' },
      stopWhen: stepCountIs(1),
      maxOutputTokens,
      maxRetries: 0,
      telemetry: { isEnabled: false },
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    resolvedModelId = result.response.modelId;
    return { capability: 'tool-loop', resolvedModelId };
  } catch (toolFailure) {
    const toolFailureIsCapability =
      APICallError.isInstance(toolFailure) &&
      (toolFailure.statusCode === 400 || toolFailure.statusCode === 422) &&
      /tool|function/i.test(toolFailure.responseBody ?? toolFailure.message);
    if (!toolFailureIsCapability) {
      const safe = toSafeJoyAgentError(toolFailure);
      return {
        capability: 'untested',
        failure: { ...safe, detail: safeErrorDetail(toolFailure, apiKeyForRedaction) },
      };
    }
    try {
      const result = await generateObject({
        model,
        schema: planOnlyOutput,
        prompt: 'Return a minimal valid JOY plan with goal, summary, and no operations.',
        maxOutputTokens: Math.min(1024, maxOutputTokens * 2),
        maxRetries: 0,
        telemetry: { isEnabled: false },
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      return { capability: 'plan-only', resolvedModelId: result.response.modelId };
    } catch (planFailure) {
      const safe = toSafeJoyAgentError(planFailure);
      const providerFailure =
        APICallError.isInstance(planFailure) &&
        planFailure.statusCode !== undefined &&
        !(
          (planFailure.statusCode === 400 || planFailure.statusCode === 422) &&
          /tool|function/i.test(planFailure.responseBody ?? planFailure.message)
        );
      return {
        capability: providerFailure ? 'untested' : 'incompatible',
        failure: { ...safe, detail: safeErrorDetail(planFailure, apiKeyForRedaction) },
      };
    }
  }
}

export class JoyAgentEngine {
  private readonly limits: JoyAgentLimits;
  private readonly now: () => Date;
  private readonly onEvent: ((event: JoyAgentSafeEvent) => void) | undefined;
  private capability: JoyAgentCapability;

  constructor(private readonly options: JoyAgentEngineOptions) {
    this.limits = clampJoyAgentLimits(options.limits);
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
    this.capability = options.capability ?? 'tool-loop';
  }

  getLimits(): JoyAgentLimits {
    return this.limits;
  }

  getCapability(): JoyAgentCapability {
    return this.capability;
  }

  async probe(abortSignal?: AbortSignal): Promise<JoyAgentProbeResult> {
    const result = await withTimeout(
      (signal) =>
        probeJoyAgentModel(
          this.options.model,
          signal,
          this.limits.probeMaxOutputTokens,
          this.options.apiKeyForRedaction,
        ),
      this.limits.probeTimeMs,
      abortSignal,
    );
    this.capability = result.capability;
    return result;
  }

  async run(request: JoyAgentRunRequest, abortSignal?: AbortSignal): Promise<JoyAgentRunResult> {
    if (this.capability === 'incompatible') {
      throw new JoyAgentRunError('JOY_AGENT_PROVIDER_INCOMPATIBLE', {
        detail: {
          name: 'JoyAgentProbeError',
          message: 'Provider capability probe failed',
          responseBodySnippet: '',
        },
      });
    }
    let sequence = -1;
    const emit = (event: JoyAgentEventPayload): void => {
      const parsed = parseJoyAgentSafeEvent(
        {
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          runId: request.runId,
          seq: sequence + 1,
          at: this.now().toISOString(),
          ...event,
        },
        sequence,
      );
      sequence = parsed.seq;
      this.onEvent?.(parsed);
    };
    emit({
      type: 'activity',
      phase: 'thinking',
      surface: 'joy-code',
      activityCode: 'agent.thinking',
    });
    try {
      const result = await withTimeout(
        (signal) => this.runWithCapability(request, emit, signal),
        this.limits.wallTimeMs,
        abortSignal,
      );
      emit({ type: 'completed' });
      return result;
    } catch (error) {
      const safe = toSafeJoyAgentError(error);
      emit({ type: 'failed', code: safe.code, retryable: safe.retryable });
      throw new JoyAgentRunError(safe.code, {
        cause: error,
        detail: safeErrorDetail(error, this.options.apiKeyForRedaction),
      });
    }
  }

  private async runWithCapability(
    request: JoyAgentRunRequest,
    emit: (event: JoyAgentEventPayload) => void,
    abortSignal: AbortSignal,
  ): Promise<JoyAgentRunResult> {
    if (this.capability === 'plan-only') {
      emit({
        type: 'activity',
        phase: 'planning',
        surface: 'joy-code',
        activityCode: 'agent.planning',
      });
      const result = await generateObject({
        model: this.options.model,
        schema: planOnlyOutput,
        prompt: request.request,
        maxOutputTokens: this.limits.maxOutputTokens,
        maxRetries: 0,
        telemetry: { isEnabled: false },
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      emit({ type: 'text-delta', text: result.object.summary });
      emit({
        type: 'proposal',
        proposalHash: `plan-${request.runId}`,
        operationCount: result.object.operations.length,
        baseRevision: request.baseRevision,
      });
      return {
        capability: 'plan-only',
        text: result.object.summary,
        steps: 1,
        status: 'completed',
        resolvedModelId: result.response.modelId,
      };
    }

    emit({
      type: 'activity',
      phase: 'inspecting',
      surface: 'joy-code',
      activityCode: 'agent.inspecting',
    });
    const pendingFrames: Array<{
      readonly mediaType: 'image/png' | 'image/jpeg';
      readonly base64: string;
      readonly width: number;
      readonly height: number;
    }> = [];
    const tools = createJoyAgentTools(this.options.bridge, this.limits, {
      ...(this.options.modelId === undefined ? {} : { modelId: this.options.modelId }),
      ...(this.options.allowFrames === undefined ? {} : { allowFrames: this.options.allowFrames }),
      ...(this.options.vision === undefined ? {} : { vision: this.options.vision }),
      onFrameRead: (frame) => pendingFrames.push(frame),
    });
    const requestedOperations = estimateRequestedOperations(request.request);
    const maxSteps = Math.min(30, this.limits.maxSteps + requestedOperations * 2);
    const toolCallLimit: StopCondition<typeof tools> = ({ steps }) =>
      steps.reduce((count, step) => count + step.toolCalls.length, 0) >= this.limits.maxToolCalls;
    const agent = new ToolLoopAgent({
      model: this.options.model,
      instructions: JOY_AGENT_INSTRUCTIONS,
      tools,
      stopWhen: [stepCountIs(maxSteps), toolCallLimit],
      maxOutputTokens: this.limits.maxOutputTokens,
      maxRetries: 0,
      telemetry: { isEnabled: false },
      prepareStep: ({ messages }) => {
        if (pendingFrames.length === 0) return undefined;
        const frames = pendingFrames.splice(0);
        const additions: ModelMessage[] = frames.map((frame) => ({
          role: 'user',
          content: [
            { type: 'text', text: 'Frame read from the local timeline:' },
            {
              type: 'file',
              data: { type: 'data', data: frame.base64 },
              mediaType: frame.mediaType,
            },
          ],
        }));
        return { messages: [...messages, ...additions] };
      },
    });
    let result = await agent.generate({
      prompt: request.request,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    // Steps whose text is already part of result.text (reported once as the final notes).
    const finalTextSteps = new Set<unknown>([result.steps.at(-1)]);
    const endedAfterFrameWithoutPlan =
      result.text.trim().length === 0 &&
      result.steps.some((step) => step.toolCalls.some((call) => call.toolName === 'read_frame')) &&
      this.options.bridge.hasSubmittedPlan?.() === false;
    if (endedAfterFrameWithoutPlan) {
      const retry = await agent.generate({
        prompt: `Original request: ${request.request}\nCall submit_plan with all requested operations and a non-empty checklist covering every operation type and requested outcome.`,
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      finalTextSteps.add(retry.steps.at(-1));
      result = {
        ...retry,
        text: [result.text, retry.text].filter(Boolean).join('\n'),
        steps: [...result.steps, ...retry.steps],
      };
    }
    for (const step of result.steps) {
      for (const part of step.content) {
        if (part.type === 'text') {
          // Models often wrap interim text in blank lines; trace it trimmed, and not at all
          // when nothing but whitespace is left.
          const interim = part.text.trim();
          if (!finalTextSteps.has(step) && interim)
            this.options.onTrace?.({
              type: 'assistant_text',
              name: 'assistant',
              // Redact before bounding so a key cut at the limit cannot leak a prefix.
              value: boundedTraceText(
                redactApiKey(interim, this.options.apiKeyForRedaction),
                this.limits.toolPayloadBytes,
              ),
            });
        } else if (part.type === 'tool-call')
          this.options.onTrace?.({ type: 'tool_call', name: part.toolName, value: part.input });
        else if (part.type === 'tool-result')
          this.options.onTrace?.({ type: 'observation', name: part.toolName, value: part.output });
        else if (part.type === 'tool-error')
          this.options.onTrace?.({
            type: 'tool_error',
            name: part.toolName,
            value: { error: traceErrorMessage(part.error, this.options.apiKeyForRedaction) },
          });
      }
    }
    const toolCalls = result.steps.reduce((count, step) => count + step.toolCalls.length, 0);
    const noPlan = this.options.bridge.hasSubmittedPlan?.() === false;
    const stepLimitHit =
      result.steps.length >= maxSteps && result.steps.at(-1)?.finishReason === 'tool-calls';
    const toolCallLimitHit =
      toolCalls >= this.limits.maxToolCalls && result.steps.at(-1)?.finishReason === 'tool-calls';
    if (result.text.length > this.limits.toolPayloadBytes)
      throw new Error('JOY_AGENT_INVALID_TOOL');
    emit({ type: 'text-delta', text: result.text });
    emit({
      type: 'activity',
      phase: 'planning',
      surface: 'joy-code',
      activityCode: 'agent.planning',
    });
    const totalTokens = result.usage?.totalTokens ?? 0;
    emit({
      type: 'usage',
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      totalTokens,
    });
    return {
      capability: 'tool-loop',
      text: result.text,
      steps: result.steps.length,
      status: stepLimitHit || toolCallLimitHit ? 'partial' : 'completed',
      ...(stepLimitHit ? { partialReason: 'step-limit' as const } : {}),
      ...(!stepLimitHit && toolCallLimitHit ? { partialReason: 'tool-call-limit' as const } : {}),
      ...(noPlan ? { status: 'partial' as const, partialReason: 'no-plan' as const } : {}),
      resolvedModelId: result.response?.modelId,
    };
  }
}

function estimateRequestedOperations(request: string): number {
  const distinctIntentCount = [
    /\b(trim|shorten|cut)\b/i,
    /\b(title|text|caption|subtitle)\b/i,
    /\b(look|effect|crt|warm|cool|black\s*and\s*white)\b/i,
    /\b(split|move|remove|delete|add|insert)\b/i,
  ].filter((pattern) => pattern.test(request)).length;
  const explicitListItems = request.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+\S/g)?.length ?? 0;
  return Math.max(1, distinctIntentCount, explicitListItems);
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  parent?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', forwardAbort);
  }
}

export { DEFAULT_JOY_AGENT_LIMITS };
