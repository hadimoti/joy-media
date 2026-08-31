import { describe, expect, it } from 'vitest';
import { createLocalDeepSeekHarnessPlanner } from './local-deepseek-harness.js';

describe('local DeepSeek harness planner', () => {
  it('uses the existing proposal transport shape without cloud sync', async () => {
    let requested = '';
    let requestUrl = '';
    const plan = {
      schemaVersion: 1,
      goal: 'Add a title',
      summary: 'One title',
      operations: [],
      assumptions: [],
      blockedBy: [],
      requiresHumanDecision: [],
    };
    const planner = createLocalDeepSeekHarnessPlanner(
      {
        endpointUrl: 'https://provider.example/v1/chat/completions',
        modelId: 'deepseek-chat',
        apiKey: 'pc-only-key',
      },
      {
        post: async (url, options) => {
          requestUrl = url;
          requested = String(options.body);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
            { status: 200 },
          );
        },
      },
    );
    const proposal = await planner({
      projectId: 'p',
      snapshotRevisionId: 'r',
      prompt: 'Add a title',
      selection: { clipIds: [] },
    });
    expect(proposal.provenance.adapterName).toBe('deepseek-harness-joy-code-v1');
    expect(requestUrl).toBe('https://provider.example/v1/chat/completions');
    expect(requested).not.toContain('pc-only-key');
  });
});
