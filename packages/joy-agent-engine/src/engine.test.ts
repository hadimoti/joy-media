import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { JoyAgentEngine, JoyAgentRunError, probeJoyAgentModel } from './engine.js';
import { createJoyAgentProvider } from './provider.js';
import type { JoyAgentRunRequest } from './contracts.js';
import type { JoyAgentToolBridge } from './tools.js';

const request: JoyAgentRunRequest = {
  runId: 'run-1',
  taskKind: 'joy-code-edit',
  baseRevision: 'revision-1',
  request: 'Make the title shorter.',
  context: {},
};

const bridge: JoyAgentToolBridge = {
  readProjectSummary: async () => ({ project: 'safe' }),
  readSelection: async () => ({ selection: [] }),
  readTimelineWindow: async () => ({ clips: [] }),
  readAssetMetadata: async () => ({ assets: [] }),
  readStyleCatalog: async () => ({ styles: [] }),
  proposeTimelineOperations: async () => ({ accepted: true }),
  proposeDocumentOperations: async () => ({ accepted: true }),
  submitPlan: async () => ({ pendingApproval: true }),
};

function textModel(text = 'Done.', modelId?: string, resolvedModelId?: string) {
  return new MockLanguageModelV3({
    ...(modelId === undefined ? {} : { modelId }),
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
      ...(resolvedModelId === undefined ? {} : { response: { modelId: resolvedModelId } }),
    },
  });
}

type ScriptedPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolName: string; readonly input: unknown };

function scriptedModel(steps: readonly (readonly ScriptedPart[])[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const parts = steps[index++] ?? [{ type: 'text' as const, text: 'Done.' }];
      const hasToolCall = parts.some((part) => part.type === 'tool-call');
      return {
        content: parts.map((part, partIndex) =>
          part.type === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'tool-call' as const,
                toolCallId: `call-${index}-${partIndex}`,
                toolName: part.toolName,
                input: JSON.stringify(part.input),
              },
        ),
        finishReason: hasToolCall
          ? { unified: 'tool-calls' as const, raw: 'tool_calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

describe('JOY Agent bounded model loop', () => {
  it('uses an explicit capability result and no fallback provider', async () => {
    const result = await probeJoyAgentModel(textModel());
    expect(['tool-loop', 'plan-only', 'incompatible', 'untested']).toContain(result.capability);
  });

  it('probes with enough output budget for a small tool call', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if ((options.maxOutputTokens ?? 0) < 256) throw new Error('budget too small');
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'probe-call',
              toolName: 'joy_probe',
              input: JSON.stringify({ value: 'JOY_PROBE' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
          response: { modelId: 'actual-tool-model' },
        };
      },
    });
    const result = await probeJoyAgentModel(model);
    expect(result.capability).toBe('tool-loop');
    expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(512);
    expect(result.resolvedModelId).toBe('actual-tool-model');
  });

  it('returns redacted failure detail when neither probe stage works', async () => {
    const secret = 'sk-test-REDACTED-0000';
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new APICallError({
          message: `probe failed ${secret}`,
          url: 'https://provider.invalid/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 503,
          responseBody: `Bearer ${secret}`,
        });
      },
    });
    const engine = new JoyAgentEngine({ model, bridge, apiKeyForRedaction: secret });
    const result = await engine.probe();
    expect(result).toMatchObject({
      capability: 'untested',
      failure: { code: 'JOY_AGENT_UPSTREAM_UNAVAILABLE', detail: { statusCode: 503 } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    [401, 'JOY_AGENT_AUTH_FAILED'],
    [403, 'JOY_AGENT_AUTH_FAILED'],
    [404, 'JOY_AGENT_MODEL_NOT_FOUND'],
    [429, 'JOY_AGENT_RATE_LIMITED'],
    [503, 'JOY_AGENT_UPSTREAM_UNAVAILABLE'],
    [500, 'JOY_AGENT_UPSTREAM_UNAVAILABLE'],
  ] as const)(
    'preserves provider HTTP %i as a probe failure, not incompatibility',
    async (status, code) => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          throw new APICallError({
            message: `provider rejected request ${status}`,
            url: 'https://provider.invalid/v1/chat/completions',
            requestBodyValues: {},
            statusCode: status,
            responseBody: `provider message ${status}`,
          });
        },
      });
      const result = await probeJoyAgentModel(model);
      expect(result).toMatchObject({
        capability: 'untested',
        failure: {
          code,
          detail: { statusCode: status, message: `provider rejected request ${status}` },
        },
      });
      expect(model.doGenerateCalls).toHaveLength(1);
    },
  );

  it('returns the model ID reported by the final run response', async () => {
    const engine = new JoyAgentEngine({
      model: textModel('Done.', 'configured-model', 'upstream-resolved-model'),
      bridge,
    });
    await expect(engine.run(request)).resolves.toMatchObject({
      resolvedModelId: 'upstream-resolved-model',
    });
  });

  it('nudges once after a silent read_frame and returns partial when no plan is submitted', async () => {
    let calls = 0;
    const promptSnapshots: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls += 1;
        promptSnapshots.push(JSON.stringify(options.prompt));
        return {
          content:
            calls === 1
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: 'frame-1',
                    toolName: 'read_frame',
                    input: JSON.stringify({ atUs: 0 }),
                  },
                ]
              : [{ type: 'text', text: '' }],
          finishReason: {
            unified: calls === 1 ? 'tool-calls' : 'stop',
            raw: calls === 1 ? 'tool_calls' : 'stop',
          },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 0, text: 0, reasoning: undefined },
          },
          warnings: [],
          response: { modelId: 'mock-vision-model' },
        };
      },
    });
    const silentBridge: JoyAgentToolBridge = {
      ...bridge,
      hasSubmittedPlan: () => false,
      readFrame: async () => ({ mediaType: 'image/jpeg', base64: 'ZmFrZQ==', width: 1, height: 1 }),
    };
    const engine = new JoyAgentEngine({
      model,
      bridge: silentBridge,
      allowFrames: true,
      vision: true,
    });
    const result = await engine.run(request);
    expect(calls).toBe(3);
    expect(promptSnapshots[2]).toContain('Call submit_plan');
    expect(result).toMatchObject({ status: 'partial', partialReason: 'no-plan', text: '' });
  });

  it('returns partial when a mocked model keeps using tools through the adaptive step budget', async () => {
    let callIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callIndex += 1;
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `loop-${callIndex}`,
              toolName: 'read_project_summary',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const engine = new JoyAgentEngine({ model, bridge });
    const result = await engine.run({ ...request, request: 'trim the title and add a CRT look' });
    expect(result.status).toBe('partial');
    expect(result.partialReason).toBe('step-limit');
    expect(result.steps).toBeGreaterThan(12);
    expect(result.steps).toBeLessThanOrEqual(30);
  });

  it('traces a failing tool call as a tool error instead of hiding it', async () => {
    const model = scriptedModel([
      [{ type: 'tool-call', toolName: 'read_project_summary', input: {} }],
      [{ type: 'tool-call', toolName: 'read_selection', input: {} }],
      [{ type: 'text', text: 'Done.' }],
    ]);
    const traces: Array<{ type: string; name: string; value: unknown }> = [];
    const engine = new JoyAgentEngine({
      model,
      bridge: {
        ...bridge,
        readProjectSummary: async () => {
          throw new TypeError('summary exploded');
        },
      },
      onTrace: (record) => traces.push(record),
    });

    await engine.run(request);

    expect(traces).toEqual([
      { type: 'tool_call', name: 'read_project_summary', value: {} },
      {
        type: 'tool_error',
        name: 'read_project_summary',
        value: { error: 'TypeError: summary exploded' },
      },
      { type: 'tool_call', name: 'read_selection', value: {} },
      { type: 'observation', name: 'read_selection', value: { selection: [] } },
    ]);
  });

  it('traces model text written between tool calls, without repeating the final text', async () => {
    const model = scriptedModel([
      [
        { type: 'text', text: 'Frame at 08.000 is frame 240.' },
        { type: 'tool-call', toolName: 'read_selection', input: {} },
      ],
      [{ type: 'text', text: 'All checks done.' }],
    ]);
    const traces: Array<{ type: string; name: string; value: unknown }> = [];
    const engine = new JoyAgentEngine({ model, bridge, onTrace: (record) => traces.push(record) });

    const result = await engine.run(request);

    expect(result.text).toBe('All checks done.');
    expect(traces).toEqual([
      { type: 'assistant_text', name: 'assistant', value: 'Frame at 08.000 is frame 240.' },
      { type: 'tool_call', name: 'read_selection', value: {} },
      { type: 'observation', name: 'read_selection', value: { selection: [] } },
    ]);
  });

  it('returns a proposal validation error to the model and accepts its retry', async () => {
    const createText = {
      kind: 'create-text',
      id: 'retry-text',
      text: 'Retry this caption',
      startUs: 0,
      durationUs: 1_000_000,
      dependsOn: [],
    };
    const promptSnapshots: string[] = [];
    let modelStep = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        modelStep += 1;
        promptSnapshots.push(JSON.stringify(options.prompt));
        const responseContent =
          modelStep <= 2
            ? {
                type: 'tool-call' as const,
                toolCallId: `proposal-${modelStep}`,
                toolName: 'propose_document_operations',
                input: JSON.stringify({ operations: [createText] }),
              }
            : modelStep === 3
              ? {
                  type: 'tool-call' as const,
                  toolCallId: 'submit-plan',
                  toolName: 'submit_plan',
                  input: '{}',
                }
              : { type: 'text' as const, text: 'The model can say anything here.' };
        return {
          content: [responseContent],
          finishReason: {
            unified: responseContent.type === 'tool-call' ? 'tool-calls' : 'stop',
            raw: responseContent.type === 'tool-call' ? 'tool_calls' : 'stop',
          },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    let proposals = 0;
    const retryBridge: JoyAgentToolBridge = {
      ...bridge,
      proposeDocumentOperations: async () => {
        proposals += 1;
        return proposals === 1
          ? { accepted: false, errors: ['Text duration must be at least one frame.'] }
          : { accepted: true, staged: true };
      },
    };
    const engine = new JoyAgentEngine({ model, bridge: retryBridge });

    await engine.run(request);

    expect(proposals).toBe(2);
    expect(promptSnapshots[1]).toContain('Text duration must be at least one frame.');
  });

  it('sends read_frame output as an image_url user part after its tool result', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchStub = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const callIndex = requests.length;
      const completion =
        callIndex === 1
          ? {
              id: 'completion-1',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'frame-call-1',
                        type: 'function',
                        function: { name: 'read_frame', arguments: '{"atUs":0}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            }
          : {
              id: 'completion-2',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'I see the frame.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            };
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { model } = createJoyAgentProvider(
      {
        provider: 'openai-compatible',
        baseUrl: 'https://provider.invalid/v1',
        modelId: 'vision-model',
        apiKey: 'sk-test-REDACTED-0000',
        vision: true,
      },
      fetchStub,
    );
    const engine = new JoyAgentEngine({
      model,
      modelId: 'vision-model',
      vision: true,
      allowFrames: true,
      bridge: {
        ...bridge,
        readFrame: async () => ({
          mediaType: 'image/jpeg',
          base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/',
          width: 1,
          height: 1,
        }),
      },
    });

    await engine.run(request);

    expect(requests).toHaveLength(2);
    const secondMessages = requests[1]?.messages as Array<{
      role: string;
      content?: Array<Record<string, unknown>>;
    }>;
    const toolMessageIndex = secondMessages.findIndex((message) => message.role === 'tool');
    const imageMessage = secondMessages[toolMessageIndex + 1];
    expect(imageMessage?.role).toBe('user');
    expect(imageMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image_url', image_url: expect.any(Object) }),
      ]),
    );
    expect(imageMessage?.content?.[0]).toMatchObject({
      type: 'text',
      text: 'Frame read from the local timeline:',
    });
  });

  it('fails closed for an explicitly incompatible model', async () => {
    const events: unknown[] = [];
    const engine = new JoyAgentEngine({
      model: textModel(),
      bridge,
      capability: 'incompatible',
      onEvent: (event) => events.push(event),
    });
    await expect(engine.run(request)).rejects.toThrow('JOY_AGENT_PROVIDER_INCOMPATIBLE');
    expect(events).toHaveLength(0);
  });

  it('keeps engine limits at or below approved defaults', () => {
    const engine = new JoyAgentEngine({
      model: textModel(),
      bridge,
      limits: { maxSteps: 999, maxToolCalls: 4, maxOutputTokens: 128 },
    });
    expect(engine.getLimits().maxSteps).toBe(DEFAULT_LIMITS.maxSteps);
    expect(engine.getLimits().maxToolCalls).toBe(4);
    expect(engine.getLimits().maxOutputTokens).toBe(128);
    expect(engine.getLimits().probeMaxOutputTokens).toBe(512);
  });

  it('preserves a classified failure with redacted diagnostic detail and cause', async () => {
    const secret = 'sk-test-REDACTED-0000';
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new APICallError({
          message: `request failed ${secret}`,
          url: 'https://provider.invalid/v1/chat/completions?token=private',
          requestBodyValues: {},
          statusCode: 429,
          responseBody: `Bearer ${secret}`,
        });
      },
    });
    const engine = new JoyAgentEngine({ model, bridge, apiKeyForRedaction: secret });

    const error = await engine.run(request).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(JoyAgentRunError);
    expect(error).toMatchObject({
      code: 'JOY_AGENT_RATE_LIMITED',
      detail: { statusCode: 429, urlOrigin: 'https://provider.invalid' },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).cause).toBeDefined();
  });
});

const DEFAULT_LIMITS = { maxSteps: 12 };
