import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryMistralInvocationLedger,
  MistralProviderRegistry,
  PostgresMistralInvocationLedger,
} from './mistral-provider.js';

describe('MistralProviderRegistry idempotency', () => {
  it('replays the same completed request but rejects a reused key with different input', async () => {
    let calls = 0;
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Guarded result.' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        );
      },
    );

    const first = await registry.complete('owner-1', completionRequest());
    const replayed = await registry.complete('owner-1', completionRequest());
    await expect(
      registry.complete(
        'owner-1',
        completionRequest({
          messages: [{ role: 'user', content: 'Different request body.' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(replayed).toEqual(first);
    expect(calls).toBe(1);
  });

  it('shares one in-flight provider invocation for concurrent exact retries', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      fetchImpl,
    );

    const first = registry.complete('owner-1', completionRequest());
    const second = registry.complete('owner-1', completionRequest());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch?.(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Guarded result.' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      ),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        status: 'succeeded',
        provenance: expect.objectContaining({ idempotencyKey: 'mistral-1' }),
      }),
      expect.objectContaining({
        status: 'succeeded',
        provenance: expect.objectContaining({ idempotencyKey: 'mistral-1' }),
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves durable replay semantics across restarts and rejects hash drift', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const ledger = new PostgresMistralInvocationLedger(pool);
    await ledger.initialize();

    let calls = 0;
    const firstRegistry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      ledger,
      async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Durable result.' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        );
      },
    );

    await expect(firstRegistry.complete('owner-1', completionRequest())).resolves.toMatchObject({
      status: 'succeeded',
    });

    const restartedRegistry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new PostgresMistralInvocationLedger(pool),
      async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'Must not run.' } }] }),
        );
      },
    );

    await expect(restartedRegistry.complete('owner-1', completionRequest())).resolves.toMatchObject(
      {
        status: 'succeeded',
      },
    );
    await expect(
      restartedRegistry.complete(
        'owner-1',
        completionRequest({
          messages: [{ role: 'user', content: 'Different durable request body.' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(calls).toBe(1);
    await pool.end();
  });
});

function completionRequest(
  overrides: Partial<{
    model: string;
    messages: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    idempotencyKey: string;
    maxTokens: number;
    temperature: number;
  }> = {},
) {
  return {
    model: overrides.model ?? 'mistral-small-latest',
    messages: overrides.messages ?? [{ role: 'user', content: 'Plan only.' }],
    idempotencyKey: overrides.idempotencyKey ?? 'mistral-1',
    privacyMode: 'ask-before-remote' as const,
    approvedRemoteProcessing: true,
    approvedSpend: true,
    ...(overrides.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
    ...(overrides.temperature === undefined ? {} : { temperature: overrides.temperature }),
  };
}
