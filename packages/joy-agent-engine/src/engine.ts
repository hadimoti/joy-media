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
  readonly now?: () => Date;
  readonly apiKeyForRedaction?: string;
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
    const toolCallLimit: StopCondition<typeof tools> = ({ steps }) =>
      steps.reduce((count, step) => count + step.toolCalls.length, 0) >= this.limits.maxToolCalls;
    const agent = new ToolLoopAgent({
      model: this.options.model,
      instructions: JOY_AGENT_INSTRUCTIONS,
      tools,
      stopWhen: [stepCountIs(this.limits.maxSteps), toolCallLimit],
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
    const result = await agent.generate({
      prompt: request.request,
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
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
      resolvedModelId: result.response.modelId,
    };
  }
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
