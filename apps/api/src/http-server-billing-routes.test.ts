import { once } from 'node:events';
import type { Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlPlaneHttpServer } from './http-server.js';
import { LocalControlPlane } from './control-plane.js';
import type { MediaAuthApi, MediaSessionProfile } from './media-auth.js';
import { UsdcCheckoutError, UsdcCheckoutService } from './usdc-checkout-service.js';
import type { UsdcCheckoutApi } from './usdc-checkout-service.js';
import { UsdcInvoiceLedger } from './usdc-invoice-ledger.js';
import type { Invoice } from './usdc-invoice-ledger.js';
import { ERC20_TRANSFER_EVENT_TOPIC } from './usdc-confirmation.js';
import type { JsonRpcTransport } from './usdc-confirmation.js';
import { AccountService } from './account-service.js';
import type { AccountApi } from './account-service.js';
import { createEd25519EntitlementSigner } from './entitlement-signing.js';

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

async function start(usdcCheckout?: UsdcCheckoutApi, account?: AccountApi): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane: new LocalControlPlane(),
    authentication: { authenticate: () => undefined },
    mediaAuth: fakeMediaAuth(),
    ...(usdcCheckout === undefined ? {} : { usdcCheckout }),
    ...(account === undefined ? {} : { account }),
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

describe('USDC checkout end-to-end: confirmation activates the subscription the route layer reports', () => {
  const RECIPIENT = '0x1111111111111111111111111111111111111111';
  const CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const SENDER = '0x2222222222222222222222222222222222222222';
  const OWNER = 'user@example.com';
  const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60_000;

  function toHex(value: bigint, bytes = 32): string {
    return `0x${value.toString(16).padStart(bytes * 2, '0')}`;
  }
  function addressTopic(address: string): string {
    return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
  }
  function successReceipt(value: bigint, blockNumber: bigint, txHash: string) {
    return {
      status: '0x1',
      blockNumber: toHex(blockNumber, 1),
      transactionHash: txHash,
      logs: [
        {
          address: CONTRACT,
          topics: [ERC20_TRANSFER_EVENT_TOPIC, addressTopic(SENDER), addressTopic(RECIPIENT)],
          data: toHex(value),
          logIndex: toHex(0n, 1),
        },
      ],
    };
  }

  function pgMemPool(): Pool {
    const database = newDb();
    const adapter = database.adapters.createPg();
    return new adapter.Pool() as Pool;
  }

  async function usdcLedgerPool(): Promise<Pool> {
    const pool = pgMemPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usdc_invoices (
        id text PRIMARY KEY, owner_id text NOT NULL, plan text NOT NULL,
        amount_usdc_base_units text NOT NULL, recipient_address text NOT NULL,
        contract_address text NOT NULL, chain_id integer NOT NULL, status text NOT NULL,
        created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        confirmed_at timestamptz, tx_hash text, log_index integer,
        refunded_at timestamptz, refund_reason text
      );
      CREATE UNIQUE INDEX usdc_invoices_pending_amount_idx
        ON usdc_invoices (recipient_address, amount_usdc_base_units) WHERE status = 'pending';
      CREATE UNIQUE INDEX usdc_invoices_txhash_logindex_idx ON usdc_invoices (tx_hash, log_index);
    `);
    return pool;
  }

  async function accountPool(): Promise<Pool> {
    const pool = pgMemPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_devices (
        id text PRIMARY KEY, owner_id text NOT NULL, display_name text NOT NULL,
        created_at timestamptz NOT NULL, revoked_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS account_subscriptions (
        owner_id text PRIMARY KEY, plan text NOT NULL, status text NOT NULL,
        current_period_end timestamptz, updated_at timestamptz NOT NULL
      );
    `);
    return pool;
  }

  function entitlementSigner() {
    const { privateKey } = generateKeyPairSync('ed25519');
    return createEd25519EntitlementSigner(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
  }

  it('activates the subscription with the exact monthly period end and the route layer reports it active afterwards', async () => {
    const nowMs = 1_700_000_000_000;
    const txHash = `0x${'a'.repeat(64)}`;

    const ledger = new UsdcInvoiceLedger({
      pool: await usdcLedgerPool(),
      recipientAddress: RECIPIENT,
      contractAddress: CONTRACT,
      chainId: 1,
      catalog: [
        { plan: 'monthly', usd: '12.00' },
        { plan: 'yearly', usd: '120.00' },
      ],
      nudgeFactory: () => 0,
      now: () => nowMs,
    });
    const account = new AccountService({
      pool: await accountPool(),
      signer: entitlementSigner(),
      now: () => nowMs,
    });
    const activateSubscription = vi.spyOn(account, 'activateSubscription');

    const transport: JsonRpcTransport = {
      async call(method, params) {
        if (method === 'eth_getTransactionReceipt') {
          const hash = params[0] as string;
          return hash === txHash ? successReceipt(12_000_000n, 100n, txHash) : null;
        }
        if (method === 'eth_blockNumber') return toHex(100n, 1);
        throw new Error(`unexpected RPC method in test: ${method}`);
      },
    };
    const usdcCheckout = new UsdcCheckoutService({
      ledger,
      account,
      transport,
      webhookSigningKey: 'test-webhook-signing-key',
      checkoutEnabled: true,
      now: () => nowMs,
      policy: {
        requiredConfirmations: 1,
        expectedChainId: 1,
        expectedContractAddress: CONTRACT,
        expectedRecipientAddress: RECIPIENT,
      },
    });

    const origin = await start(usdcCheckout, account);
    const authHeader = { authorization: `Bearer token:${OWNER}` };

    // Subscription starts out unselected/unpaid.
    expect(
      await request(origin, 'GET', '/v1/account/subscription', undefined, authHeader),
    ).toMatchObject({ status: 200, body: { data: { plan: 'none', status: 'none' } } });

    // The owner picks the monthly plan (pending, not yet active) ...
    await request(origin, 'POST', '/v1/account/subscription', { plan: 'monthly' }, authHeader);

    // ... creates a USDC invoice for it ...
    const createResult = await request(
      origin,
      'POST',
      '/v1/billing/invoices',
      { plan: 'monthly' },
      authHeader,
    );
    expect(createResult.status).toBe(201);
    const invoice = (createResult.body as { data: Invoice }).data;
    expect(invoice.amountUsdcBaseUnits).toBe('12000000');

    // ... and submits the on-chain tx hash for confirmation.
    const submitResult = await request(
      origin,
      'POST',
      `/v1/billing/invoices/${invoice.id}/submit-tx`,
      { txHash },
      authHeader,
    );
    expect(submitResult).toMatchObject({ status: 200, body: { data: { status: 'confirmed' } } });

    const expectedPeriodEnd = nowMs + MONTHLY_PERIOD_MS;
    expect(activateSubscription).toHaveBeenCalledTimes(1);
    expect(activateSubscription).toHaveBeenCalledWith(OWNER, expectedPeriodEnd);

    // The subscription route now independently reports the subscription as active, with the
    // exact period end the monthly plan implies.
    const subscriptionResult = await request(
      origin,
      'GET',
      '/v1/account/subscription',
      undefined,
      authHeader,
    );
    expect(subscriptionResult).toMatchObject({
      status: 200,
      body: {
        data: {
          ownerId: OWNER,
          plan: 'monthly',
          status: 'active',
          currentPeriodEnd: expectedPeriodEnd,
        },
      },
    });
  });
});
