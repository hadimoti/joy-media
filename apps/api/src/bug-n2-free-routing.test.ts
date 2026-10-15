// N2: hosted `openrouter/free` routed to whatever OpenRouter picked (a content-safety
// classifier answered "User Safety: safe"), and reasoning deltas reached the client.
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { JoyModelGateway } from './joy-model-gateway.js';
import { MemoryAgentUsageLedger } from './agent-usage-ledger.js';
import type { MediaAuthService } from './media-auth.js';
import type { AccountService } from './account-service.js';

function request(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: 'POST',
    url: '/v1/agent/chat/completions',
    headers: { 'content-type': 'application/json' },
  });
  return stream;
}
const text = (chunk: unknown): string =>
  typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
function response() {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    writeHead: () => res,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: unknown) => (chunks.push(text(chunk)), true),
    end: (chunk?: unknown) => (chunk ? chunks.push(text(chunk)) : 0, res),
  }) as unknown as ServerResponse;
  return { res, body: () => chunks.join('') };
}
function gateway(fetchImpl: typeof fetch) {
  return new JoyModelGateway({
    mediaAuth: { authenticate: async () => ({ id: 'u' }) } as unknown as MediaAuthService,
    account: {
      getSubscription: async () => ({
        ownerId: 'u',
        plan: 'yearly',
        status: 'active',
        updatedAt: 0,
      }),
    } as unknown as AccountService,
    ledger: new MemoryAgentUsageLedger(),
    openRouterApiKey: 'test-placeholder',
    fetchImpl,
  });
}

describe('N2: hosted free routing', () => {
  it('never forwards the openrouter/free router id; it is pinned to the catalog default', async () => {
    const models: string[] = [];
    await gateway((async (_url: unknown, init?: RequestInit) => {
      models.push(String(JSON.parse(String(init?.body)).model));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { cost: 0 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch).handleChatCompletions(
      request({ model: 'openrouter/free', messages: [{ role: 'user', content: 'hi' }] }),
      response().res,
    );
    expect(models).toEqual(['nvidia/nemotron-3-super-120b-a12b:free']);
  });

  it('strips streamed reasoning from a non-reasoning model too (seen live from nemotron-3-ultra)', async () => {
    const out = response();
    await gateway(
      (async () =>
        new Response(
          [
            'data: {"id":"g","model":"nvidia/nemotron-3-ultra-550b-a55b:free","choices":[{"delta":{"role":"assistant","reasoning":"HIDDEN-THOUGHTS"}}]}',
            'data: {"id":"g","choices":[{"delta":{"content":"Hello"}}]}',
            'data: {"id":"g","choices":[],"usage":{"cost":0}}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )) as unknown as typeof fetch,
    ).handleChatCompletions(
      request({
        model: 'openrouter/free',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      out.res,
    );
    expect(out.body()).toContain('Hello');
    expect(out.body()).not.toContain('HIDDEN-THOUGHTS');
  });
});
