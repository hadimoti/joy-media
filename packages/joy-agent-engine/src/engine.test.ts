import { describe, expect, it } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { JoyAgentEngine, JoyAgentRunError, probeJoyAgentModel } from './engine.js';
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

describe('JOY Agent bounded model loop', () => {
  it('uses an explicit capability result and no fallback provider', async () => {
    const result = await probeJoyAgentModel(textModel());
    expect(['tool-loop', 'plan-only', 'incompatible']).toContain(result.capability);
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
      capability: 'incompatible',
      failure: { code: 'JOY_AGENT_UPSTREAM_UNAVAILABLE', detail: { statusCode: 503 } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('returns the model ID reported by the final run response', async () => {
    const engine = new JoyAgentEngine({
      model: textModel('Done.', 'configured-model', 'upstream-resolved-model'),
      bridge,
    });
    await expect(engine.run(request)).resolves.toMatchObject({
      resolvedModelId: 'upstream-resolved-model',
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
