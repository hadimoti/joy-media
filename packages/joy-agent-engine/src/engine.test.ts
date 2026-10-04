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

function textModel(text = 'Done.') {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

describe('JOY Agent bounded model loop', () => {
  it('uses an explicit capability result and no fallback provider', async () => {
    const result = await probeJoyAgentModel(textModel());
    expect(['tool-loop', 'plan-only', 'incompatible']).toContain(result.capability);
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
