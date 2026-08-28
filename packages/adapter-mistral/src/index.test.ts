import { describe, expect, it } from 'vitest';
import { createMistralAdapter, MISTRAL_REASONING_MODELS } from './index.js';

describe('Mistral adapter', () => {
  it('only accepts the explicit reasoning-model allowlist and never exposes its key', async () => {
    let request: Request | undefined;
    const adapter = createMistralAdapter({
      apiKey: 'test-only-secret',
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'A guarded completion.' } }],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 5,
              cost: { amount: '0.06', currency: 'USD' },
            },
          }),
        );
      },
    });
    const result = await adapter.invoke(
      'llm.complete',
      {
        model: MISTRAL_REASONING_MODELS[0]!.id,
        messages: [{ role: 'user', content: 'Plan only.' }],
      },
      {
        requestVersion: 1,
        capability: 'llm.complete',
        input: {},
        constraints: {},
        idempotencyKey: 'key-1',
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.provenance.idempotencyKey).toBe('key-1');
    expect(result.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 5,
      cost: { amount: '0.06', currency: 'USD' },
    });
    expect(await request?.text()).not.toContain('test-only-secret');
    expect(JSON.stringify(adapter.manifest)).not.toContain('test-only-secret');
  });

  it('passes bounded json-schema formatting through to Mistral and keeps provider decision ids in provenance', async () => {
    let request: Request | undefined;
    const adapter = createMistralAdapter({
      apiKey: 'test-only-secret',
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 12, completion_tokens: 9 },
          }),
        );
      },
    });

    const result = await adapter.invoke(
      'llm.complete',
      {
        model: MISTRAL_REASONING_MODELS[0]!.id,
        messages: [{ role: 'user', content: 'Return structured JSON only.' }],
        decisionId: 'provider-decision-joy-code-1',
        responseFormat: {
          type: 'json_schema',
          name: 'joy_code_reasoning',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
            },
            required: ['ok'],
          },
          strict: true,
        },
      },
      {
        requestVersion: 1,
        capability: 'llm.complete',
        input: {},
        constraints: {},
        idempotencyKey: 'key-structured-1',
      },
    );

    expect(result.status).toBe('succeeded');
    expect(result.provenance.providerDecisionId).toBe('provider-decision-joy-code-1');
    const requestBody = await request?.text();
    expect(requestBody).toContain('"response_format"');
    expect(requestBody).toContain('"json_schema"');
    expect(requestBody).toContain('"joy_code_reasoning"');
  });

  it('preserves provider-reported cost even when token counters are absent', async () => {
    const adapter = createMistralAdapter({
      apiKey: 'test-only-secret',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Cost-bearing completion.' } }],
            usage: { cost: { amount: '0.06', currency: 'USD' } },
          }),
        ),
    });
    const result = await adapter.invoke(
      'llm.complete',
      {
        model: MISTRAL_REASONING_MODELS[0]!.id,
        messages: [{ role: 'user', content: 'Return a completion.' }],
      },
      {
        requestVersion: 1,
        capability: 'llm.complete',
        input: {},
        constraints: {},
        idempotencyKey: 'key-cost-only-1',
      },
    );
    expect(result.usage).toMatchObject({ cost: { amount: '0.06', currency: 'USD' } });
  });

  it('fails closed before network access for an unallowlisted model', async () => {
    const adapter = createMistralAdapter({
      apiKey: 'test-only-secret',
      fetchImpl: async () => {
        throw new Error('network must not be reached');
      },
    });
    const result = await adapter.invoke('llm.complete', {
      model: 'not-allowed',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result).toMatchObject({ status: 'failed', diagnostics: [{ code: 'INVALID_INPUT' }] });
  });
});
