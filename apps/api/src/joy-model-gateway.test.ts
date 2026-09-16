import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { JoyModelGateway, JOY_AGENT_DEFAULT_MODELS } from './joy-model-gateway.js';
import { MemoryAgentUsageLedger } from './agent-usage-ledger.js';
import type { MediaAuthService } from './media-auth.js';
import type { AccountService, Subscription } from './account-service.js';

function createMockReq(options: {
  method?: string;
  url?: string;
  body?: unknown;
}): IncomingMessage {
  const content = options.body !== undefined ? Buffer.from(JSON.stringify(options.body)) : Buffer.alloc(0);
  const stream = Readable.from([content]) as unknown as IncomingMessage;
  (stream as any).method = options.method ?? 'POST';
  (stream as any).url = options.url ?? '/v1/agent/chat/completions';
  (stream as any).headers = { 'content-type': 'application/json' };
  return stream;
}

function createMockRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getHeaders: () => Record<string, string>;
  getBody: () => string;
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
      return res;
    },
    write(chunk: unknown) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as any).toString('utf8'));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk) {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as any).toString('utf8'));
      }
      return res;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getBody: () => chunks.join(''),
  };
}

describe('JoyModelGateway', () => {
  it('serves the models catalog publicly without auth', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: {} as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ method: 'GET', url: '/v1/agent/models' });
    await gateway.handleGetModels(req, res);

    expect(getStatus()).toBe(200);
    const data = JSON.parse(getBody());
    expect(data.models).toHaveLength(JOY_AGENT_DEFAULT_MODELS.length);
    expect(data.models[0].id).toBe('minimax/minimax-m3');
  });

  it('rejects chat requests when unconfigured', async () => {
    const gateway = new JoyModelGateway({
      mediaAuth: {} as MediaAuthService,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: undefined,
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'minimax/minimax-m3', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(503);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('JOY_AGENT_UNCONFIGURED');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const mockAuth = {
      authenticate: async () => undefined,
    } as unknown as MediaAuthService;

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: {} as AccountService,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'minimax/minimax-m3', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(401);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unsubscribed users with 402 JOY_SUBSCRIPTION_REQUIRED', async () => {
    const mockAuth = {
      authenticate: async () => ({ id: 'user-free' }),
    } as unknown as MediaAuthService;

    const mockAccount = {
      getSubscription: async (): Promise<Subscription> => ({
        ownerId: 'user-free',
        plan: 'none',
        status: 'none',
        updatedAt: Date.now(),
      }),
    } as unknown as AccountService;

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: mockAccount,
      ledger: new MemoryAgentUsageLedger(),
      openRouterApiKey: 'test-key',
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({ body: { model: 'minimax/minimax-m3', messages: [] } });
    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(402);
    const data = JSON.parse(getBody());
    expect(data.error.code).toBe('JOY_SUBSCRIPTION_REQUIRED');
  });

  it('proxies request for subscribed users and records commission in ledger', async () => {
    const mockAuth = {
      authenticate: async () => ({ id: 'user-pro' }),
    } as unknown as MediaAuthService;

    const mockAccount = {
      getSubscription: async (): Promise<Subscription> => ({
        ownerId: 'user-pro',
        plan: 'monthly',
        status: 'active',
        updatedAt: Date.now(),
      }),
    } as unknown as AccountService;

    const ledger = new MemoryAgentUsageLedger();

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-123',
          choices: [{ message: { role: 'assistant', content: 'Video edits applied' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_cost: 0.002, // $0.002 = 2000 micros
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const gateway = new JoyModelGateway({
      mediaAuth: mockAuth,
      account: mockAccount,
      ledger,
      openRouterApiKey: 'test-key',
      commissionRateBps: 2500, // 25% margin
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const { res, getStatus, getBody } = createMockRes();
    const req = createMockReq({
      body: {
        model: 'minimax/minimax-m3',
        messages: [{ role: 'user', content: 'add transition' }],
      },
    });

    await gateway.handleChatCompletions(req, res);

    expect(getStatus()).toBe(200);
    const data = JSON.parse(getBody());
    expect(data.choices[0].message.content).toBe('Video edits applied');

    // Verify ledger entry
    const summary = await ledger.getSummary('user-pro');
    expect(summary.totalRequests).toBe(1);
    expect(summary.totalPromptTokens).toBe(100);
    expect(summary.totalCompletionTokens).toBe(50);
    expect(summary.totalUpstreamCostMicros).toBe('2000');
    // Billed = 2000 * 1.25 = 2500
    expect(summary.totalBilledCostMicros).toBe('2500');
  });
});
