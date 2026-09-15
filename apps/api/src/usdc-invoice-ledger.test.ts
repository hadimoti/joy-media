import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';
import { UsdcInvoiceLedger, UsdcLedgerError } from './usdc-invoice-ledger.js';

const RECIPIENT = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function pool(): Pool {
  const database = newDb();
  const adapter = database.adapters.createPg();
  return new adapter.Pool() as Pool;
}

async function ledger(
  overrides: Partial<{
    now: () => number;
    idFactory: () => string;
    nudgeFactory: () => number;
    invoiceTtlMs: number;
  }> = {},
) {
  const db = pool();
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
  let idCount = 0;
  return new UsdcInvoiceLedger({
    pool: db,
    recipientAddress: RECIPIENT,
    contractAddress: CONTRACT,
    chainId: 1,
    catalog: [
      { plan: 'monthly', usd: '12.00' },
      { plan: 'yearly', usd: '120.00' },
    ],
    idFactory: overrides.idFactory ?? (() => `invoice-${++idCount}`),
    nudgeFactory: overrides.nudgeFactory ?? (() => 0),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.invoiceTtlMs !== undefined ? { invoiceTtlMs: overrides.invoiceTtlMs } : {}),
  });
}

describe('UsdcInvoiceLedger.createInvoice', () => {
  it('creates a pending invoice priced from the catalog in exact USDC base units', async () => {
    const l = await ledger({ now: () => 1_000 });
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    expect(invoice).toMatchObject({
      id: 'invoice-1',
      ownerId: 'user@example.com',
      plan: 'monthly',
      amountUsdcBaseUnits: '12000000',
      recipientAddress: RECIPIENT,
      contractAddress: CONTRACT,
      chainId: 1,
      status: 'pending',
      createdAt: 1_000,
    });
  });

  it('returns the same pending invoice on a repeated call (idempotent retry)', async () => {
    const l = await ledger();
    const first = await l.createInvoice('user@example.com', 'monthly');
    const second = await l.createInvoice('user@example.com', 'monthly');
    expect(second).toEqual(first);
  });

  it('gives two different owners different, independently unique invoice amounts', async () => {
    let call = 0;
    const l = await ledger({ nudgeFactory: () => call++ });
    const a = await l.createInvoice('owner-a@example.com', 'monthly');
    const b = await l.createInvoice('owner-b@example.com', 'monthly');
    expect(a.amountUsdcBaseUnits).not.toBe(b.amountUsdcBaseUnits);
  });

  it('retries with a new nudge when the amount collides with another pending invoice', async () => {
    const nudges = [5, 5, 7]; // first two collide, third succeeds
    let index = 0;
    const l = await ledger({ nudgeFactory: () => nudges[index++] ?? 0 });
    const a = await l.createInvoice('owner-a@example.com', 'monthly');
    const b = await l.createInvoice('owner-b@example.com', 'monthly');
    expect(a.amountUsdcBaseUnits).toBe('12000005');
    expect(b.amountUsdcBaseUnits).toBe('12000007');
  });

  it('allows reusing an amount once the earlier invoice using it is no longer pending', async () => {
    const l = await ledger({ nudgeFactory: () => 5 });
    const a = await l.createInvoice('owner-a@example.com', 'monthly');
    await l.confirmInvoice(a.id, { txHash: '0xabc', logIndex: 0 });
    const b = await l.createInvoice('owner-b@example.com', 'monthly');
    expect(b.amountUsdcBaseUnits).toBe(a.amountUsdcBaseUnits);
  });
});

describe('UsdcInvoiceLedger.findPendingInvoiceForTransfer', () => {
  it('finds the pending invoice matching an exact recipient+amount pair', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    const found = await l.findPendingInvoiceForTransfer(RECIPIENT, invoice.amountUsdcBaseUnits);
    expect(found).toEqual(invoice);
  });

  it('finds nothing for an amount no pending invoice has', async () => {
    const l = await ledger();
    await l.createInvoice('user@example.com', 'monthly');
    expect(await l.findPendingInvoiceForTransfer(RECIPIENT, '999999999')).toBeUndefined();
  });

  it('does not match a confirmed invoice’s old amount', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 0 });
    expect(
      await l.findPendingInvoiceForTransfer(RECIPIENT, invoice.amountUsdcBaseUnits),
    ).toBeUndefined();
  });
});

describe('UsdcInvoiceLedger.confirmInvoice', () => {
  it('confirms a pending invoice exactly once', async () => {
    const l = await ledger({ now: () => 5_000 });
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    const confirmed = await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 2 });
    expect(confirmed).toMatchObject({
      status: 'confirmed',
      confirmedAt: 5_000,
      txHash: '0xabc',
      logIndex: 2,
    });
  });

  it('is replay-safe: confirming again with the identical evidence returns the same result', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    const first = await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 2 });
    const second = await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 2 });
    expect(second).toEqual(first);
  });

  it('refuses to re-confirm an already-confirmed invoice with different evidence', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 2 });
    await expect(
      l.confirmInvoice(invoice.id, { txHash: '0xdef', logIndex: 0 }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_CONFIRMABLE' });
  });

  it('refuses to confirm an unknown invoice', async () => {
    const l = await ledger();
    await expect(
      l.confirmInvoice('missing', { txHash: '0xabc', logIndex: 0 }),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });

  it('never lets the same on-chain evidence confirm two different invoices', async () => {
    const l = await ledger({ nudgeFactory: () => Math.floor(Math.random() * 900) });
    const a = await l.createInvoice('owner-a@example.com', 'monthly');
    const b = await l.createInvoice('owner-b@example.com', 'monthly');
    await l.confirmInvoice(a.id, { txHash: '0xshared', logIndex: 1 });
    await expect(l.confirmInvoice(b.id, { txHash: '0xshared', logIndex: 1 })).rejects.toThrow(
      UsdcLedgerError,
    );
  });
});

describe('UsdcInvoiceLedger.expireStalePending', () => {
  it('expires only pending invoices past their expiry, leaving others untouched', async () => {
    let now = 1_000;
    let nudge = 0;
    const l = await ledger({ now: () => now, invoiceTtlMs: 500, nudgeFactory: () => nudge++ });
    const stale = await l.createInvoice('owner-a@example.com', 'monthly'); // expires at 1500
    now = 2_000; // past expiry
    const fresh = await l.createInvoice('owner-b@example.com', 'monthly'); // expires at 2500

    const expired = await l.expireStalePending();
    expect(expired.map((invoice) => invoice.id)).toEqual([stale.id]);
    expect((await l.getInvoice(stale.id))?.status).toBe('expired');
    expect((await l.getInvoice(fresh.id))?.status).toBe('pending');
  });

  it('frees the amount slot so a new invoice can reuse it after expiry', async () => {
    let now = 1_000;
    const l = await ledger({ now: () => now, invoiceTtlMs: 500, nudgeFactory: () => 5 });
    const stale = await l.createInvoice('owner-a@example.com', 'monthly');
    now = 2_000;
    await l.expireStalePending();
    const fresh = await l.createInvoice('owner-b@example.com', 'monthly');
    expect(fresh.amountUsdcBaseUnits).toBe(stale.amountUsdcBaseUnits);
  });
});

describe('UsdcInvoiceLedger.refundInvoice', () => {
  it('refunds a confirmed invoice', async () => {
    const l = await ledger({ now: () => 9_000 });
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 0 });
    const refunded = await l.refundInvoice(invoice.id, 'customer requested cancellation');
    expect(refunded).toMatchObject({
      status: 'refunded',
      refundedAt: 9_000,
      refundReason: 'customer requested cancellation',
    });
  });

  it('refuses to refund a pending (never-paid) invoice', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    await expect(l.refundInvoice(invoice.id, 'x')).rejects.toMatchObject({
      code: 'INVOICE_NOT_REFUNDABLE',
    });
  });

  it('refuses to refund an already-refunded invoice twice', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    await l.confirmInvoice(invoice.id, { txHash: '0xabc', logIndex: 0 });
    await l.refundInvoice(invoice.id, 'first refund');
    await expect(l.refundInvoice(invoice.id, 'second refund')).rejects.toMatchObject({
      code: 'INVOICE_NOT_REFUNDABLE',
    });
  });
});

describe('UsdcInvoiceLedger.listForReconciliation', () => {
  it('lists invoices newest first', async () => {
    let now = 1_000;
    const l = await ledger({ now: () => now });
    const first = await l.createInvoice('owner-a@example.com', 'monthly');
    now = 2_000;
    const second = await l.createInvoice('owner-b@example.com', 'yearly');
    const list = await l.listForReconciliation();
    expect(list.map((invoice) => invoice.id)).toEqual([second.id, first.id]);
  });

  it('never includes anything beyond the documented safe fields (no secrets to leak in the first place)', async () => {
    const l = await ledger();
    const invoice = await l.createInvoice('user@example.com', 'monthly');
    const [reconciled] = await l.listForReconciliation();
    expect(Object.keys(reconciled!).sort()).toEqual(Object.keys(invoice).sort());
  });
});
