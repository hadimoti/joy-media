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
            usage: { prompt_tokens: 4, completion_tokens: 5 },
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
    expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 5 });
    expect(await request?.text()).not.toContain('test-only-secret');
    expect(JSON.stringify(adapter.manifest)).not.toContain('test-only-secret');
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
