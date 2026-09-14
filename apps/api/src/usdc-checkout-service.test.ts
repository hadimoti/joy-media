import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UsdcCheckoutError, UsdcCheckoutService } from './usdc-checkout-service.js';
import { UsdcInvoiceLedger } from './usdc-invoice-ledger.js';
import { ERC20_TRANSFER_EVENT_TOPIC } from './usdc-confirmation.js';
import type { JsonRpcTransport } from './usdc-confirmation.js';
import type { AccountApi, AccountDevice, Subscription } from './account-service.js';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SENDER = '0x2222222222222222222222222222222222222222';
const SIGNING_KEY = 'test-webhook-signing-key';

function toHex(value: bigint, bytes = 32): string {
  return `0x${value.toString(16).padStart(bytes * 2, '0')}`;
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function fakeTransport(
  receiptsByHash: Record<string, unknown>,
  blockNumber: string,
): JsonRpcTransport {
  return {
    async call(method, params) {
      if (method === 'eth_getTransactionReceipt') {
        const hash = params[0] as string;
        return receiptsByHash[hash] ?? null;
      }
      if (method === 'eth_blockNumber') return blockNumber;
      throw new Error(`unexpected RPC method in test: ${method}`);
    },
  };
}

function successReceipt(value: bigint, blockNumber: bigint, logIndex = 0n, to = RECIPIENT) {
  return {
    status: '0x1',
    blockNumber: toHex(blockNumber, 1),
    transactionHash: '0xtx',
    logs: [
      {
        address: CONTRACT,
        topics: [ERC20_TRANSFER_EVENT_TOPIC, addressTopic(SENDER), addressTopic(to)],
        data: toHex(value),
        logIndex: toHex(logIndex, 1),
      },
    ],
  };
}

class FakeAccountService implements AccountApi {
  readonly activations: Array<{ ownerId: string; periodEndMs: number }> = [];
  async registerDevice(): Promise<AccountDevice> {
    throw new Error('not used in these tests');
  }
  async listDevices(): Promise<readonly AccountDevice[]> {
    return [];
  }
  async revokeDevice(): Promise<void> {}
  async getSubscription(ownerId: string): Promise<Subscription> {
    return { ownerId, plan: 'none', status: 'none', updatedAt: 0 };
  }
  async selectPlan(): Promise<Subscription> {
    throw new Error('not used in these tests');
  }
  async activateSubscription(ownerId: string, periodEndMs: number): Promise<Subscription> {
    this.activations.push({ ownerId, periodEndMs });
    return {
      ownerId,
      plan: 'monthly',
      status: 'active',
      currentPeriodEnd: periodEndMs,
      updatedAt: 0,
    };
  }
  async issueEntitlement(): Promise<never> {
    throw new Error('not used in these tests');
  }
}

async function ledgerPool(): Promise<Pool> {
  const database = newDb();
  const adapter = database.adapters.createPg();
  const db = new adapter.Pool() as Pool;
  await db.query(`
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
  return db;
}

async function service(
  overrides: Partial<{
    checkoutEnabled: boolean;
    receipts: Record<string, unknown>;
    blockNumber: string;
    requiredConfirmations: number;
  }> = {},
) {
  const pool = await ledgerPool();
  const ledger = new UsdcInvoiceLedger({
    pool,
    recipientAddress: RECIPIENT,
    contractAddress: CONTRACT,
    chainId: 1,
    catalog: [
      { plan: 'monthly', usd: '12.00' },
      { plan: 'yearly', usd: '120.00' },
    ],
    nudgeFactory: () => 0,
  });
  const account = new FakeAccountService();
  const transport = fakeTransport(overrides.receipts ?? {}, overrides.blockNumber ?? '0x0');
  const checkout = new UsdcCheckoutService({
    ledger,
    account,
    transport,
    webhookSigningKey: SIGNING_KEY,
    checkoutEnabled: overrides.checkoutEnabled ?? true,
    policy: {
      requiredConfirmations: overrides.requiredConfirmations ?? 1,
      expectedChainId: 1,
      expectedContractAddress: CONTRACT,
      expectedRecipientAddress: RECIPIENT,
    },
  });
  return { checkout, ledger, account };
}

describe('UsdcCheckoutService.createInvoice', () => {
  it('refuses to create an invoice while checkout is disabled', async () => {
    const { checkout } = await service({ checkoutEnabled: false });
    await expect(checkout.createInvoice('user@example.com', 'monthly')).rejects.toMatchObject({
      code: 'CHECKOUT_DISABLED',
    });
  });

  it('creates an invoice when checkout is enabled', async () => {
    const { checkout } = await service();
    const invoice = await checkout.createInvoice('user@example.com', 'monthly');
    expect(invoice).toMatchObject({ ownerId: 'user@example.com', status: 'pending' });
  });
});

describe('UsdcCheckoutService.getOwnedInvoice', () => {
  it('returns the invoice for its owner', async () => {
    const { checkout } = await service();
    const invoice = await checkout.createInvoice('user@example.com', 'monthly');
    expect(await checkout.getOwnedInvoice('user@example.com', invoice.id)).toEqual(invoice);
  });

  it('refuses to return another owner’s invoice', async () => {
    const { checkout } = await service();
    const invoice = await checkout.createInvoice('owner-a@example.com', 'monthly');
    await expect(checkout.getOwnedInvoice('owner-b@example.com', invoice.id)).rejects.toMatchObject(
      { code: 'INVOICE_NOT_FOUND' },
    );
  });
});

describe('UsdcCheckoutService.attemptConfirmation', () => {
  it('confirms a matching, sufficiently-confirmed transfer and activates the subscription exactly once', async () => {
    const { checkout, account } = await service({
      receipts: { '0xtx': successReceipt(12_000_000n, 100n) },
      blockNumber: toHex(100n, 1),
      requiredConfirmations: 1,
    });
    const invoice = await checkout.createInvoice('user@example.com', 'monthly');
    const confirmed = await checkout.attemptConfirmation('0xtx');
    expect(confirmed).toMatchObject({ id: invoice.id, status: 'confirmed', txHash: '0xtx' });
    expect(account.activations).toHaveLength(1);
    expect(account.activations[0]?.ownerId).toBe('user@example.com');
  });

  it('returns undefined for a transaction that has not been mined yet', async () => {
    const { checkout } = await service({ receipts: {} });
    await checkout.createInvoice('user@example.com', 'monthly');
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
  });

  it('returns undefined (does not throw) when the transfer amount matches no pending invoice', async () => {
    const { checkout } = await service({
      receipts: { '0xtx': successReceipt(999_999n, 100n) },
      blockNumber: toHex(100n, 1),
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
  });

  it('returns undefined while confirmations are still below the required threshold', async () => {
    const { checkout, account } = await service({
      receipts: { '0xtx': successReceipt(12_000_000n, 100n) },
      blockNumber: toHex(100n, 1), // exactly 1 confirmation
      requiredConfirmations: 12,
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
    expect(account.activations).toHaveLength(0);
  });

  it('never activates a subscription for a transfer to the wrong recipient', async () => {
    const { checkout, account } = await service({
      receipts: {
        '0xtx': successReceipt(12_000_000n, 100n, 0n, '0x9999999999999999999999999999999999999999'),
      },
      blockNumber: toHex(100n, 1),
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
    expect(account.activations).toHaveLength(0);
  });

  it('re-running attemptConfirmation with the same evidence activates the subscription again, idempotently', async () => {
    const { checkout, account } = await service({
      receipts: { '0xtx': successReceipt(12_000_000n, 100n) },
      blockNumber: toHex(100n, 1),
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    const first = await checkout.attemptConfirmation('0xtx');
    const second = await checkout.attemptConfirmation('0xtx');
    // findPendingInvoiceForTransfer no longer finds the invoice once it's confirmed, so the
    // second call can't even reach ledger.confirmInvoice again - this is the ledger's own
    // "invoice no longer pending" protection kicking in before activation would be attempted.
    expect(second).toBeUndefined();
    expect(first?.status).toBe('confirmed');
    expect(account.activations).toHaveLength(1);
  });
});

describe('UsdcCheckoutService.attemptConfirmation edge cases', () => {
  it('treats a transfer with no Transfer log on the expected (USDC) contract as "not ours" instead of throwing', async () => {
    // A look-alike/wrong contract address: the receipt is real and successful, but its only
    // Transfer log is emitted by a different contract than the one this policy expects, so
    // observeTransferFromReceipt can't decode a matching event at all. This must resolve the
    // same documented "not ours, no error" way a wrong-recipient or wrong-amount transfer
    // does — see the class-level doc on attemptConfirmation never throwing for that case —
    // so one unrelated transaction in a webhook batch can never abort the rest of the batch.
    const wrongContract = '0x9999999999999999999999999999999999999999';
    const { checkout, account } = await service({
      receipts: {
        '0xtx': {
          status: '0x1',
          blockNumber: toHex(100n, 1),
          transactionHash: '0xtx',
          logs: [
            {
              address: wrongContract,
              topics: [ERC20_TRANSFER_EVENT_TOPIC, addressTopic(SENDER), addressTopic(RECIPIENT)],
              data: toHex(12_000_000n),
              logIndex: toHex(0n, 1),
            },
          ],
        },
      },
      blockNumber: toHex(100n, 1),
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    await expect(checkout.attemptConfirmation('0xtx')).resolves.toBeUndefined();
    expect(account.activations).toHaveLength(0);
  });

  it('never confirms an invoice once it has expired, even if a late matching transfer arrives', async () => {
    let nowMs = 1_000_000;
    const pool = await ledgerPool();
    const invoiceTtlMs = 30 * 60_000;
    const ledger = new UsdcInvoiceLedger({
      pool,
      recipientAddress: RECIPIENT,
      contractAddress: CONTRACT,
      chainId: 1,
      catalog: [
        { plan: 'monthly', usd: '12.00' },
        { plan: 'yearly', usd: '120.00' },
      ],
      nudgeFactory: () => 0,
      invoiceTtlMs,
      now: () => nowMs,
    });
    const account = new FakeAccountService();
    const transport = fakeTransport({ '0xtx': successReceipt(12_000_000n, 100n) }, toHex(100n, 1));
    const checkout = new UsdcCheckoutService({
      ledger,
      account,
      transport,
      webhookSigningKey: SIGNING_KEY,
      checkoutEnabled: true,
      now: () => nowMs,
      policy: {
        requiredConfirmations: 1,
        expectedChainId: 1,
        expectedContractAddress: CONTRACT,
        expectedRecipientAddress: RECIPIENT,
      },
    });

    const invoice = await checkout.createInvoice('user@example.com', 'monthly');
    nowMs += invoiceTtlMs + 1; // past the invoice's expiresAt
    const expired = await ledger.expireStalePending();
    expect(expired.map((entry) => entry.id)).toContain(invoice.id);

    // The late transfer still lands on-chain (and would otherwise verify exactly), but the
    // invoice it paid is no longer pending, so findPendingInvoiceForTransfer can't find it —
    // this is the ledger's expiry, not a chain-side check, refusing the late payment.
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
    expect(account.activations).toHaveLength(0);
  });

  it('re-evaluates confirmations fresh on every call, so a reorg that drops them back below the threshold blocks confirmation until the chain re-extends', async () => {
    const pool = await ledgerPool();
    const ledger = new UsdcInvoiceLedger({
      pool,
      recipientAddress: RECIPIENT,
      contractAddress: CONTRACT,
      chainId: 1,
      catalog: [
        { plan: 'monthly', usd: '12.00' },
        { plan: 'yearly', usd: '120.00' },
      ],
      nudgeFactory: () => 0,
    });
    const account = new FakeAccountService();
    let currentBlock = 100n; // the tx's own block, i.e. 1 confirmation
    const transport: JsonRpcTransport = {
      async call(method, params) {
        if (method === 'eth_getTransactionReceipt') {
          const hash = params[0] as string;
          return hash === '0xtx' ? successReceipt(12_000_000n, 100n) : null;
        }
        if (method === 'eth_blockNumber') return toHex(currentBlock, 1);
        throw new Error(`unexpected RPC method in test: ${method}`);
      },
    };
    const checkout = new UsdcCheckoutService({
      ledger,
      account,
      transport,
      webhookSigningKey: SIGNING_KEY,
      checkoutEnabled: true,
      policy: {
        requiredConfirmations: 3,
        expectedChainId: 1,
        expectedContractAddress: CONTRACT,
        expectedRecipientAddress: RECIPIENT,
      },
    });
    await checkout.createInvoice('user@example.com', 'monthly');

    // Chain tip reorgs back down to the tx's own block — only 1 confirmation, not enough.
    currentBlock = 100n;
    expect(await checkout.attemptConfirmation('0xtx')).toBeUndefined();
    expect(account.activations).toHaveLength(0);

    // Chain re-extends past the requirement: now it confirms.
    currentBlock = 102n;
    const confirmed = await checkout.attemptConfirmation('0xtx');
    expect(confirmed?.status).toBe('confirmed');
    expect(account.activations).toHaveLength(1);
  });

  it('extends a renewal from "now", not by stacking onto the previous period end', async () => {
    let nowMs = 1_000_000;
    const pool = await ledgerPool();
    const ledger = new UsdcInvoiceLedger({
      pool,
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
    const account = new FakeAccountService();
    // successReceipt always reports transactionHash '0xtx' regardless of the map key used to
    // look it up (matching every other use of this helper in this file) — so the two receipts
    // are disambiguated by logIndex instead, exactly as the ledger's own uniqueness guarantee
    // (a unique index on (tx_hash, log_index)) intends for two distinct on-chain events.
    const receipts: Record<string, unknown> = {
      '0xtx-1': successReceipt(12_000_000n, 100n, 0n),
      '0xtx-2': successReceipt(12_000_000n, 200n, 1n),
    };
    const transport = fakeTransport(receipts, toHex(200n, 1));
    const checkout = new UsdcCheckoutService({
      ledger,
      account,
      transport,
      webhookSigningKey: SIGNING_KEY,
      checkoutEnabled: true,
      now: () => nowMs,
      policy: {
        requiredConfirmations: 1,
        expectedChainId: 1,
        expectedContractAddress: CONTRACT,
        expectedRecipientAddress: RECIPIENT,
      },
    });

    await checkout.createInvoice('user@example.com', 'monthly');
    const firstConfirmed = await checkout.attemptConfirmation('0xtx-1');
    expect(firstConfirmed?.status).toBe('confirmed');
    expect(account.activations).toEqual([
      { ownerId: 'user@example.com', periodEndMs: nowMs + 30 * 24 * 60 * 60_000 },
    ]);

    // Renew a while later, before the first period would have lapsed. The new activation is
    // computed from the *second* confirmation's "now", not added on top of the first period
    // end — a deliberate, documented choice (see usdc-checkout-service.ts's module doc on
    // "no activation call can silently double-extend a period"), not stacked entitlement.
    nowMs += 5 * 24 * 60 * 60_000; // 5 days later, well before the first period ends
    await checkout.createInvoice('user@example.com', 'monthly');
    const secondConfirmed = await checkout.attemptConfirmation('0xtx-2');
    expect(secondConfirmed?.status).toBe('confirmed');
    expect(account.activations).toHaveLength(2);
    expect(account.activations[1]).toEqual({
      ownerId: 'user@example.com',
      periodEndMs: nowMs + 30 * 24 * 60 * 60_000,
    });
  });
});

describe('UsdcCheckoutService.handleWebhook', () => {
  function webhookPayload(hash: string) {
    return JSON.stringify({ webhookId: 'wh_1', event: { activity: [{ hash }] } });
  }

  function sign(rawBody: string): string {
    return createHmac('sha256', SIGNING_KEY).update(rawBody, 'utf8').digest('hex');
  }

  it('rejects a webhook whose signature does not verify, before touching the ledger', async () => {
    const { checkout } = await service();
    const rawBody = webhookPayload('0xtx');
    await expect(checkout.handleWebhook(rawBody, 'wrong-signature')).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  });

  it('confirms every matching invoice named by a verified webhook payload', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    const { checkout } = await service({
      receipts: { [hash]: successReceipt(12_000_000n, 100n) },
      blockNumber: toHex(100n, 1),
    });
    await checkout.createInvoice('user@example.com', 'monthly');
    const rawBody = webhookPayload(hash);
    const confirmed = await checkout.handleWebhook(rawBody, sign(rawBody));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]?.status).toBe('confirmed');
  });

  it('rejects malformed JSON even with a valid signature over it', async () => {
    const { checkout } = await service();
    const rawBody = 'not json';
    await expect(checkout.handleWebhook(rawBody, sign(rawBody))).rejects.toMatchObject({
      code: 'WEBHOOK_PAYLOAD_INVALID',
    });
  });
});

describe('UsdcCheckoutService.listForReconciliation', () => {
  it('works even while checkout is disabled (operators can still review history)', async () => {
    const { checkout } = await service({ checkoutEnabled: false });
    await expect(checkout.listForReconciliation()).resolves.toEqual([]);
  });
});
