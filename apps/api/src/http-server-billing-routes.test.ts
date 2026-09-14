import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneHttpServer } from './http-server.js';
import { LocalControlPlane } from './control-plane.js';
import type { MediaAuthApi, MediaSessionProfile } from './media-auth.js';
import { UsdcCheckoutError } from './usdc-checkout-service.js';
import type { UsdcCheckoutApi } from './usdc-checkout-service.js';
import type { Invoice } from './usdc-invoice-ledger.js';

/**
 * HTTP-level wiring tests for the wave 5 billing routes. The actual checkout logic (ledger
 * state machine, on-chain verification, webhook signature checking) is already exercised
 * thoroughly in usdc-invoice-ledger.test.ts/usdc-confirmation.test.ts/
 * usdc-checkout-service.test.ts against real pg-mem SQL — this file only confirms routing,
 * auth requirements, and status-code mapping.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

function fakeMediaAuth(): MediaAuthApi {
  return {
    async requestOtp() {
      return { message: 'ok' };
    },
    async verifyOtp() {
      return 'unused';
    },
    async logout() {},
    async authenticate(request) {
      const header = request.headers.authorization;
      if (typeof header !== 'string' || !header.startsWith('Bearer token:')) return undefined;
      return { id: header.slice('Bearer token:'.length) };
    },
    async sessionProfile(): Promise<MediaSessionProfile | undefined> {
      return undefined;
    },
    async avatarBytes() {
      return undefined;
    },
  };
}

async function start(usdcCheckout?: UsdcCheckoutApi): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane: new LocalControlPlane(),
    authentication: { authenticate: () => undefined },
    mediaAuth: fakeMediaAuth(),
    ...(usdcCheckout === undefined ? {} : { usdcCheckout }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  origin: string,
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const finalHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  const response = await fetch(`${origin}${pathname}`, {
    method,
    ...(Object.keys(finalHeaders).length > 0 ? { headers: finalHeaders } : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const SAMPLE_INVOICE: Invoice = {
  id: 'inv-1',
  ownerId: 'user@example.com',
  plan: 'monthly',
  amountUsdcBaseUnits: '12000000',
  recipientAddress: '0x1111111111111111111111111111111111111111',
  contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  chainId: 1,
  status: 'pending',
  createdAt: 1_000,
  expiresAt: 2_000,
};

describe('POST /v1/billing/invoices', () => {
  it('requires authentication', async () => {
    const origin = await start();
    expect(
      await request(origin, 'POST', '/v1/billing/invoices', { plan: 'monthly' }),
    ).toMatchObject({ status: 401 });
  });

  it('reports CHECKOUT_DISABLED with the default (no usdcCheckout injected) server', async () => {
    const origin = await start();
    const result = await request(
      origin,
      'POST',
      '/v1/billing/invoices',
      { plan: 'monthly' },
      { authorization: 'Bearer token:user@example.com' },
    );
    expect(result).toMatchObject({ status: 503, body: { error: { code: 'CHECKOUT_DISABLED' } } });
  });

  it('rejects an unsupported plan value before reaching the checkout service', async () => {
    const createInvoice = vi.fn();
    const origin = await start({
      createInvoice,
      getOwnedInvoice: vi.fn(),
      attemptConfirmation: vi.fn(),
      handleWebhook: vi.fn(),
      listForReconciliation: vi.fn(),
    });
    const result = await request(
      origin,
      'POST',
      '/v1/billing/invoices',
      { plan: 'weekly' },
      { authorization: 'Bearer token:user@example.com' },
    );
    expect(result.status).toBe(400);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('delegates to the injected checkout service and returns 201 with the invoice', async () => {
    const createInvoice = vi.fn(async () => SAMPLE_INVOICE);
    const origin = await start({
      createInvoice,
      getOwnedInvoice: vi.fn(),
      attemptConfirmation: vi.fn(),
      handleWebhook: vi.fn(),
      listForReconciliation: vi.fn(),
    });
    const result = await request(
      origin,
      'POST',
      '/v1/billing/invoices',
      { plan: 'monthly' },
      { authorization: 'Bearer token:user@example.com' },
    );
    expect(result).toMatchObject({ status: 201, body: { data: SAMPLE_INVOICE } });
    expect(createInvoice).toHaveBeenCalledWith('user@example.com', 'monthly');
  });
});

describe('GET /v1/billing/invoices/:id', () => {
  it('requires authentication', async () => {
    const origin = await start();
    expect(await request(origin, 'GET', '/v1/billing/invoices/inv-1')).toMatchObject({
      status: 401,
    });
  });

  it('returns the invoice for the authenticated owner', async () => {
    const getOwnedInvoice = vi.fn(async () => SAMPLE_INVOICE);
    const origin = await start({
      createInvoice: vi.fn(),
      getOwnedInvoice,
      attemptConfirmation: vi.fn(),
      handleWebhook: vi.fn(),
      listForReconciliation: vi.fn(),
    });
    const result = await request(origin, 'GET', '/v1/billing/invoices/inv-1', undefined, {
      authorization: 'Bearer token:user@example.com',
    });
    expect(result).toMatchObject({ status: 200, body: { data: SAMPLE_INVOICE } });
    expect(getOwnedInvoice).toHaveBeenCalledWith('user@example.com', 'inv-1');
  });

  it('surfaces INVOICE_NOT_FOUND as 404', async () => {
    const origin = await start({
      createInvoice: vi.fn(),
      getOwnedInvoice: vi.fn(async () => {
        throw new UsdcCheckoutError('INVOICE_NOT_FOUND', 'invoice not found');
      }),
      attemptConfirmation: vi.fn(),
      handleWebhook: vi.fn(),
      listForReconciliation: vi.fn(),
    });
    const result = await request(origin, 'GET', '/v1/billing/invoices/missing', undefined, {
      authorization: 'Bearer token:user@example.com',
    });
    expect(result).toMatchObject({ status: 404, body: { error: { code: 'INVOICE_NOT_FOUND' } } });
  });
});

describe('POST /v1/billing/invoices/:id/submit-tx', () => {
  it('checks ownership before attempting confirmation', async () => {
    const getOwnedInvoice = vi.fn(async () => SAMPLE_INVOICE);
    const attemptConfirmation = vi.fn(async () => SAMPLE_INVOICE);
    const origin = await start({
      createInvoice: vi.fn(),
      getOwnedInvoice,
      attemptConfirmation,
      handleWebhook: vi.fn(),
      listForReconciliation: vi.fn(),
    });
    const result = await request(
      origin,
      'POST',
      '/v1/billing/invoices/inv-1/submit-tx',
      { txHash: '0xabc' },
      { authorization: 'Bearer token:user@example.com' },
    );
    expect(result.status).toBe(200);
    expect(getOwnedInvoice).toHaveBeenCalledWith('user@example.com', 'inv-1');
    expect(attemptConfirmation).toHaveBeenCalledWith('0xabc');
  });
});

describe('POST /v1/billing/webhooks/alchemy', () => {
  it('needs no session auth (verified by signature instead)', async () => {
    const handleWebhook = vi.fn(async () => []);
    const origin = await start({
      createInvoice: vi.fn(),
      getOwnedInvoice: vi.fn(),
      attemptConfirmation: vi.fn(),
      handleWebhook,
      listForReconciliation: vi.fn(),
    });
    const result = await request(origin, 'POST', '/v1/billing/webhooks/alchemy', {
      event: { activity: [] },
    });
    expect(result.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('forwards the exact raw body text and the X-Alchemy-Signature header to the service', async () => {
    const handleWebhook = vi.fn(async () => []);
    const origin = await start({
      createInvoice: vi.fn(),
      getOwnedInvoice: vi.fn(),
      attemptConfirmation: vi.fn(),
      handleWebhook,
      listForReconciliation: vi.fn(),
    });
    await request(
      origin,
      'POST',
      '/v1/billing/webhooks/alchemy',
      { event: {} },
      { 'x-alchemy-signature': 'sig123' },
    );
    expect(handleWebhook).toHaveBeenCalledWith(JSON.stringify({ event: {} }), 'sig123');
  });

  it('reports the default (disabled) server as CHECKOUT_DISABLED', async () => {
    const origin = await start();
    const result = await request(origin, 'POST', '/v1/billing/webhooks/alchemy', { event: {} });
    expect(result).toMatchObject({ status: 503, body: { error: { code: 'CHECKOUT_DISABLED' } } });
  });
});
