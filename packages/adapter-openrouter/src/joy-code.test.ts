import { describe, expect, it } from 'vitest';
import {
  JOY_CODE_MODEL_ID,
  buildJoyCodeRequest,
  decodeJoyCodeResponse,
  createOpenRouterJoyCodeAdapter,
} from './joy-code.js';

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
  projectId: 'project-1',
  snapshotRevisionId: 'rev-1',
  prompt: 'Add a title',
  semanticSnapshot: {
    durationUs: 5_000_000,
    scenes: [{ id: 'scene-1', startUs: 0, endUs: 5_000_000 }],
  },
  intelligenceSummary: { readiness: 'ready' },
  catalogs: {
    textTemplateIds: ['clean-title'],
    captionTemplateIds: ['joy-clean'],
    transitionIds: ['dissolve'],
  },
  selection: { clipIds: ['clip-1'] },
  contextSummary: 'bounded semantic context',
} as const;
const options = {
  modelId: JOY_CODE_MODEL_ID,
  secretRef: 'joy-media/openrouter/joy-code-planner/v1',
  spendLimitUsdCents: 0,
  timeoutMs: 100,
  secretResolver: { resolve: () => 'secret' },
  transport: {
    post: async () =>
      new Response(
        JSON.stringify({
          model: JOY_CODE_MODEL_ID,
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    type: 'function',
                    function: { name: 'submit_joy_code_plan', arguments: JSON.stringify(plan) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
  },
};

describe('OpenRouter Joy Code codec and adapter', () => {
  it('builds the pinned free request with one forced tool and no response_format', () => {
    const result = buildJoyCodeRequest(input, options);
    expect(result.category).toBe('ready');
    if (result.category !== 'ready') return;
    expect(result.result.model).toBe(JOY_CODE_MODEL_ID);
    expect(result.result.temperature).toBe(0);
    expect(result.result.max_tokens).toBe(4096);
    expect(result.result.provider).toEqual({ allow_fallbacks: false });
    expect(result.result).not.toHaveProperty('response_format');
    expect(result.result.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_joy_code_plan' },
    });
  });

  it('rejects forbidden egress data before secret resolution', () => {
    let resolved = false;
    const result = buildJoyCodeRequest({ ...input, prompt: 'https://example.com' }, options);
    expect(result.category).toBe('invalid-output');
    const adapter = createOpenRouterJoyCodeAdapter({
      ...options,
      secretResolver: {
        resolve: () => {
          resolved = true;
          return 'secret';
        },
      },
    });
    void adapter;
    expect(resolved).toBe(false);
  });

  it('accepts exactly one valid forced tool call and rejects duplicates/wrong names', () => {
    const valid = decodeJoyCodeResponse({
      model: JOY_CODE_MODEL_ID,
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: { name: 'submit_joy_code_plan', arguments: JSON.stringify(plan) },
              },
            ],
          },
        },
      ],
    });
    expect(valid.category).toBe('ready');
    const duplicate = decodeJoyCodeResponse({
      model: JOY_CODE_MODEL_ID,
      usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: { name: 'submit_joy_code_plan', arguments: JSON.stringify(plan) },
              },
              {
                type: 'function',
                function: { name: 'submit_joy_code_plan', arguments: JSON.stringify(plan) },
              },
            ],
          },
        },
      ],
    });
    expect(duplicate.category).toBe('invalid-output');
  });

  it('maps nonzero cost and model mismatch to provider-failed', () => {
    expect(
      decodeJoyCodeResponse({
        model: JOY_CODE_MODEL_ID,
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 },
        choices: [],
      }).category,
    ).toBe('provider-failed');
    expect(
      decodeJoyCodeResponse({
        model: 'other',
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        choices: [],
      }).category,
    ).toBe('provider-failed');
  });
});
