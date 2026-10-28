import { describe, expect, it } from 'vitest';
import type { LocalAiRequest } from '../../jobs/local-job-api.js';
import { createWorkerCompletion } from './worker-completion.js';
import { MAX_WORKER_REQUEST_BYTES, type ProviderBroker } from './provider-broker.js';

const REQUEST: LocalAiRequest = {
  workerId: 'worker-1',
  jobId: 'job-1',
  profileId: 'prof-1',
  body: { messages: [{ role: 'user', content: 'hi' }] },
};

/** A broker that refuses every call with the code and message it is given. */
function refusingBroker(code: string, message: string): ProviderBroker {
  return {
    complete: async () => ({ ok: false, code, message }),
  } as unknown as ProviderBroker;
}

describe('the Worker route adapter', () => {
  it('tells the Worker that a redirect was refused, but not where it led', async () => {
    const broker = refusingBroker(
      'REDIRECT_REFUSED',
      'The provider redirected to https://provider.example/v9/secret-path. Redirects are not followed.',
    );

    const result = await createWorkerCompletion(broker)(REQUEST);

    expect(result).toEqual({
      ok: false,
      status: 502,
      message: 'The provider redirected the request. Redirects are not followed.',
    });
    expect(JSON.stringify(result)).not.toContain('provider.example');
  });

  it('passes other refusal messages through unchanged', async () => {
    const broker = refusingBroker(
      'PROVIDER_INCOMPATIBLE',
      'The provider reply was not understood.',
    );

    const result = await createWorkerCompletion(broker)(REQUEST);

    expect(result).toEqual({
      ok: false,
      status: 502,
      message: 'The provider reply was not understood.',
    });
  });

  it('gives the broker the Worker-route size limit and the signal that ends the call', async () => {
    let received: Record<string, unknown> | undefined;
    const broker = {
      complete: async (request: Record<string, unknown>) => {
        received = request;
        return { ok: true, data: { text: 'reply' } };
      },
    } as unknown as ProviderBroker;
    const abandoned = new AbortController();

    const result = await createWorkerCompletion(broker)({
      ...REQUEST,
      signal: abandoned.signal,
    });

    expect(result).toEqual({ ok: true, text: 'reply' });
    expect(received).toMatchObject({
      profileId: 'prof-1',
      maxRequestBytes: MAX_WORKER_REQUEST_BYTES,
      signal: abandoned.signal,
    });
  });
});
