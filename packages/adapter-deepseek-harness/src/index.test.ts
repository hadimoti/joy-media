import { describe, expect, it } from 'vitest';
import {
  buildDeepSeekHarnessRequest,
  decodeDeepSeekHarnessResponse,
  createDeepSeekHarnessJoyCodeAdapter,
} from './index.js';

const plan = {
  schemaVersion: 1,
  goal: 'Add a title',
  summary: 'One title',
  operations: [],
  assumptions: [],
  blockedBy: [],
  requiresHumanDecision: [],
} as const;
const input = {
  projectId: 'p',
  snapshotRevisionId: 'r',
  prompt: 'Add a title',
  semanticSnapshot: {},
  intelligenceSummary: {},
  catalogs: {
    textTemplateIds: ['clean-title'],
    captionTemplateIds: ['joy-clean'],
    transitionIds: ['dissolve'],
  },
  selection: { clipIds: [] },
  contextSummary: 'bounded',
} as const;
const options = {
  endpointUrl: 'https://provider.example/v1/chat/completions',
  apiKey: 'local-only',
  timeoutMs: 100,
  transport: {
    post: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), {
        status: 200,
      }),
  },
};

describe('DeepSeek harness Joy Code adapter', () => {
  it('builds a bounded JSON-mode request without credentials', () => {
    const request = buildDeepSeekHarnessRequest(input);
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(request)).not.toContain('local-only');
    expect(request.messages[0].content).toContain('bounded Joy Code plan');
  });
  it('strictly decodes a plan and rejects tool-shaped/non-JSON output', () => {
    expect(
      decodeDeepSeekHarnessResponse({ choices: [{ message: { content: JSON.stringify(plan) } }] })
        .category,
    ).toBe('ready');
    expect(
      decodeDeepSeekHarnessResponse({ choices: [{ message: { content: 'not json' } }] }).category,
    ).toBe('invalid-output');
  });
  it('uses the configured endpoint but never includes the key in the JSON body', async () => {
    let seenUrl = '';
    let seenBody = '';
    const adapter = createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      transport: {
        post: async (url, request) => {
          seenUrl = url;
          seenBody = String(request.body);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
            { status: 200 },
          );
        },
      },
    });
    const result = await adapter.createPlan(input, { correlationId: 'test' });
    expect(result.category).toBe('ready');
    expect(seenUrl).toBe(options.endpointUrl);
    expect(seenBody).not.toContain(options.apiKey);
  });
  it('fails closed for endpoint credentials/query strings', async () => {
    const result = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      endpointUrl: 'https://user:pass@example.com/v1?key=secret',
    }).createPlan(input, { correlationId: 'test' });
    expect(result).toMatchObject({
      category: 'policy-denied',
      errorCode: 'DEEPSEEK_HARNESS_ENDPOINT_INVALID',
    });
  });
});
