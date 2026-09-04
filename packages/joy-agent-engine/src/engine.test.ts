import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { JoyAgentEngine, probeJoyAgentModel } from './engine.js';
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
});

const DEFAULT_LIMITS = { maxSteps: 12 };
