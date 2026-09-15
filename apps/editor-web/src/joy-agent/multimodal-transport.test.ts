import { describe, expect, it, vi } from 'vitest';
import {
  createMultimodalTransport,
  MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES,
  MAX_MULTIMODAL_RESPONSE_BYTES,
  type MultimodalFetch,
  type MultimodalTransportRequest,
  type ObservationEvidencePayload,
} from './multimodal-transport.js';
import {
  issueObservationConsent,
  type ObservationConsent,
  type ObservationMediaCapability,
} from './observation-consent.js';

const imageCapability: ObservationMediaCapability = {
  modelId: 'openrouter/model-a',
  modalities: ['image'],
};

const visualCapability: ObservationMediaCapability = {
  modelId: 'openrouter/model-a',
  modalities: ['image', 'video'],
};

function consentInput(overrides: Partial<ObservationConsent> = {}): ObservationConsent {
  return {
    projectId: 'project-1',
    runId: 'run-1',
    endpointOrigin: 'https://provider.example',
    modelId: 'openrouter/model-a',
    range: { domain: 'source', startUs: 0, endUs: 1_000_000 },
    evidenceIds: ['frame-1', 'video-1'],
    modalities: ['image', 'video'],
    maxRequests: 2,
    maxBytes: 8_192,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function issue(
  overrides: Partial<ObservationConsent> = {},
  capability: ObservationMediaCapability = visualCapability,
) {
  return issueObservationConsent(consentInput(overrides), capability, Date.now());
}

function imageEvidence(data = new Uint8Array([1, 2, 3])): ObservationEvidencePayload {
  return { evidenceId: 'frame-1', modality: 'image', mimeType: 'image/png', data };
}

function videoEvidence(): ObservationEvidencePayload {
  return {
    evidenceId: 'video-1',
    modality: 'video',
    mimeType: 'video/mp4',
    data: new Uint8Array([4, 5, 6]),
  };
}

function request(overrides: Partial<MultimodalTransportRequest> = {}): MultimodalTransportRequest {
  return {
    connection: {
      provider: 'openrouter',
      baseUrl: 'https://provider.example/v1',
      modelId: 'openrouter/model-a',
      apiKey: 'fixture-byok-key',
    },
    projectId: 'project-1',
    runId: 'run-1',
    range: { domain: 'source', startUs: 0, endUs: 500_000 },
    prompt: 'Inspect the selected evidence.',
    evidence: [imageEvidence()],
    mediaCapability: imageCapability,
    ...overrides,
  };
}

function providerSuccess(content = 'The subject enters at 00:01.'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

function successfulFetch(
  content = 'The subject enters at 00:01.',
): ReturnType<typeof vi.fn<MultimodalFetch>> {
  return vi.fn(async () => providerSuccess(content));
}

describe('multimodal direct-provider transport', () => {
  it('sends zero media without a host-issued consent and never exposes the canary in its result', async () => {
    const fetcher = successfulFetch();
    const transport = createMultimodalTransport({ fetch: fetcher });
    const result = await transport.send(
      request({ evidence: [imageEvidence(new TextEncoder().encode('PRIVATE_FRAME_CANARY'))] }),
    );

    expect(result).toEqual({ ok: false, code: 'consent-denied' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FRAME_CANARY');
    expect(JSON.stringify(result)).not.toContain('fixture-byok-key');
  });

  it('accepts only an opaque issued consent, sends a bounded direct body, and returns only a sanitized model analysis', async () => {
    const fetcher = successfulFetch();
    const transport = createMultimodalTransport({ fetch: fetcher });
    expect(() => transport.grant(consentInput())).toThrow('must be issued by the local host');

    transport.grant(issue());
    const result = await transport.send(request());

    expect(result).toEqual({
      ok: true,
      requestBytes: expect.any(Number),
      remainingRequests: 1,
      analysis: {
        text: 'The subject enters at 00:01.',
        submittedEvidenceIds: ['frame-1'],
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetcher.mock.calls[0] ?? [];
    expect(endpoint).toBeInstanceOf(URL);
    expect((endpoint as URL).toString()).toBe('https://provider.example/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    expect(init?.headers).toMatchObject({ authorization: 'Bearer fixture-byok-key' });
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON provider body');
    expect(init.body).not.toContain('fixture-byok-key');
    expect(result).toMatchObject({ requestBytes: new TextEncoder().encode(init.body).byteLength });
  });

  it('reads a provider response through its bounded stream rather than Response.text()', async () => {
    const response = providerSuccess('A safe bounded analysis.');
    Object.defineProperty(response, 'text', {
      value: () => {
        throw new Error('Response.text must not be used');
      },
    });
    const fetcher = vi.fn(async () => response) as unknown as MultimodalFetch;
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue());

    await expect(transport.send(request())).resolves.toEqual({
      ok: true,
      requestBytes: expect.any(Number),
      remainingRequests: 1,
      analysis: {
        text: 'A safe bounded analysis.',
        submittedEvidenceIds: ['frame-1'],
      },
    });
  });

  it('enforces the exact serialized request-byte budget before any direct fetch', async () => {
    const fetcher = successfulFetch();
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue({ maxBytes: 128 }));

    const result = await transport.send(request());

    expect(result).toEqual({ ok: false, code: 'consent-denied' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS/non-loopback configured endpoints and redirected provider responses', async () => {
    const unsafeFetcher = successfulFetch();
    const unsafeTransport = createMultimodalTransport({ fetch: unsafeFetcher });
    unsafeTransport.grant(issue());
    expect(
      await unsafeTransport.send(
        request({ connection: { ...request().connection, baseUrl: 'http://provider.example/v1' } }),
      ),
    ).toEqual({ ok: false, code: 'invalid-request' });
    expect(
      await unsafeTransport.send(
        request({
          connection: {
            ...request().connection,
            baseUrl: 'https://provider.example/v1/chat/completions/',
          },
        }),
      ),
    ).toEqual({ ok: false, code: 'invalid-request' });
    expect(unsafeFetcher).not.toHaveBeenCalled();

    const loopbackFetcher = successfulFetch();
    const loopbackTransport = createMultimodalTransport({ fetch: loopbackFetcher });
    loopbackTransport.grant(
      issue({ runId: 'loopback-run', endpointOrigin: 'http://localhost:4010' }),
    );
    expect(
      await loopbackTransport.send(
        request({
          runId: 'loopback-run',
          connection: { ...request().connection, baseUrl: 'http://localhost:4010/v1' },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(loopbackFetcher).toHaveBeenCalledTimes(1);

    const redirected = new Response('{}', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const redirectFetcher = vi.fn(async () => redirected) as unknown as MultimodalFetch;
    const redirectTransport = createMultimodalTransport({ fetch: redirectFetcher });
    redirectTransport.grant(issue({ runId: 'redirect-run' }));
    expect(await redirectTransport.send(request({ runId: 'redirect-run' }))).toEqual({
      ok: false,
      code: 'provider-rejected',
    });
  });

  it('rejects image and video transfer when the current model capability is text-only', async () => {
    const textOnly: ObservationMediaCapability = {
      modelId: 'openrouter/model-a',
      modalities: ['transcript'],
    };
    const fetcher = successfulFetch();
    const imageTransport = createMultimodalTransport({ fetch: fetcher });
    imageTransport.grant(issue());
    expect(await imageTransport.send(request({ mediaCapability: textOnly }))).toEqual({
      ok: false,
      code: 'invalid-request',
    });

    const videoTransport = createMultimodalTransport({ fetch: fetcher });
    videoTransport.grant(issue({ runId: 'video-run' }));
    expect(
      await videoTransport.send(
        request({
          runId: 'video-run',
          evidence: [videoEvidence()],
          mediaCapability: textOnly,
        }),
      ),
    ).toEqual({ ok: false, code: 'invalid-request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts current work and prevents later batches after cancellation', async () => {
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    ) as unknown as MultimodalFetch;
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue());

    const first = transport.send(request());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(transport.cancel('run-1')).toBe(true);
    await expect(first).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(await transport.send(request())).toEqual({ ok: false, code: 'consent-denied' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a received-but-incomplete provider response before it can yield analysis', async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"choices":[{"message":{"content":"partial'));
        },
      }),
      { status: 200 },
    );
    const fetcher = vi.fn(async () => response) as unknown as MultimodalFetch;
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue());

    const pending = transport.send(request());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(transport.cancel('run-1')).toBe(true);

    await expect(pending).resolves.toEqual({ ok: false, code: 'cancelled' });
  });

  it('returns a redacted provider failure without reading the response body', async () => {
    const fetcher = vi.fn(
      async () => new Response('PROVIDER_FAILURE_CANARY', { status: 500 }),
    ) as unknown as MultimodalFetch;
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue());

    const result = await transport.send(request());

    expect(result).toEqual({ ok: false, code: 'provider-rejected' });
    expect(JSON.stringify(result)).not.toContain('PROVIDER_FAILURE_CANARY');
    expect(JSON.stringify(result)).not.toContain('fixture-byok-key');
  });

  it.each([
    {
      name: 'malformed JSON',
      response: new Response('{not-json', { status: 200 }),
    },
    {
      name: 'a missing OpenAI-compatible message content',
      response: new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    },
    {
      name: 'an oversized provider body',
      response: new Response(
        JSON.stringify({
          choices: [{ message: { content: 'x'.repeat(MAX_MULTIMODAL_RESPONSE_BYTES) } }],
        }),
        { status: 200 },
      ),
    },
    {
      name: 'an oversized analysis field inside an otherwise bounded body',
      response: providerSuccess('x'.repeat(MAX_MULTIMODAL_ANALYSIS_TEXT_BYTES + 1)),
    },
    {
      name: 'a control-character analysis',
      response: providerSuccess('unsafe\u202Eanalysis'),
    },
    {
      name: 'an analysis that reflects the private BYOK key',
      response: providerSuccess('The key is fixture-byok-key.'),
    },
  ])('rejects $name without returning raw provider output', async ({ response }) => {
    const fetcher = vi.fn(async () => response) as unknown as MultimodalFetch;
    const transport = createMultimodalTransport({ fetch: fetcher });
    transport.grant(issue());

    const result = await transport.send(request());

    expect(result).toEqual({ ok: false, code: 'provider-rejected' });
    expect(JSON.stringify(result)).not.toContain('fixture-byok-key');
    expect(JSON.stringify(result)).not.toContain('not-json');
  });
});
