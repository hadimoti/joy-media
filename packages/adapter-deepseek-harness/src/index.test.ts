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

  it('allows HTTP only for loopback and requires HTTPS for remote endpoints', async () => {
    const remote = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      endpointUrl: 'http://provider.example/v1/chat/completions',
    }).createPlan(input, { correlationId: 'test' });
    expect(remote.errorCode).toBe('DEEPSEEK_HARNESS_ENDPOINT_INVALID');
    const loopback = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      endpointUrl: 'http://127.0.0.1:8080/v1/chat/completions',
    }).createPlan(input, { correlationId: 'test' });
    expect(loopback.category).toBe('ready');
  });

  it('cancels non-OK response bodies before returning provider failure', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('provider error'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      transport: { post: async () => new Response(stream, { status: 503 }) },
    }).createPlan(input, { correlationId: 'test' });
    expect(result).toMatchObject({
      category: 'provider-failed',
      errorCode: 'DEEPSEEK_HARNESS_PROVIDER_FAILED',
    });
    expect(cancelled).toBe(true);
  });

  it('cancels an oversized streaming response before accumulating it', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_144));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      transport: { post: async () => new Response(stream, { status: 200 }) },
    }).createPlan(input, { correlationId: 'test' });
    expect(result).toMatchObject({
      category: 'provider-failed',
      errorCode: 'DEEPSEEK_HARNESS_RESPONSE_TOO_LARGE',
    });
    expect(cancelled).toBe(true);
  });

  it('times out a body that stalls after headers', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":['));
      },
    });
    const result = await createDeepSeekHarnessJoyCodeAdapter({
      ...options,
      timeoutMs: 10,
      transport: { post: async () => new Response(stream, { status: 200 }) },
    }).createPlan(input, { correlationId: 'test' });
    expect(result).toMatchObject({ category: 'timeout', errorCode: 'DEEPSEEK_HARNESS_TIMEOUT' });
  });
});
