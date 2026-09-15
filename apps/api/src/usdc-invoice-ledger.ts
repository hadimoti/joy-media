import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { priceForPlan, usdToUsdcBaseUnits } from './usdc-catalog.js';
import type { BillingPlan, CatalogPrice } from './usdc-catalog.js';

/**
 * USDC invoice ledger (JOY Media desktop migration, wave 5). Locked owner decisions: "exact
 * integer base units, unique invoice identity/amount ... duplicate tx/log protection ...
 * expiry/refund-safe state transitions."
 *
 * ERC20 transfers on Ethereum mainnet carry no memo/reference field, so a shared recipient
 * address cannot tell invoices apart by itself. This ledger disambiguates pending invoices by
 * giving each one a *unique exact amount*: the catalog price plus a small per-invoice base-unit
 * nudge (at most $0.000999), enforced unique among currently-pending invoices for the same
 * recipient by a partial unique index. `usdc-checkout-service.ts` watches the chain for a
 * transfer whose (recipient, amount) matches a pending invoice, then confirms that exact
 * invoice — see `findPendingInvoiceForTransfer`.
 */

export type InvoiceStatus = 'pending' | 'confirmed' | 'expired' | 'refunded';

export interface Invoice {
  readonly id: string;
  readonly ownerId: string;
  readonly plan: BillingPlan;
  /** Exact integer USDC base units (6 decimals), as a decimal string — never a float. */
  readonly amountUsdcBaseUnits: string;
  readonly recipientAddress: string;
  readonly contractAddress: string;
  readonly chainId: number;
  readonly status: InvoiceStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly confirmedAt?: number;
  readonly txHash?: string;
  readonly logIndex?: number;
  readonly refundedAt?: number;
  readonly refundReason?: string;
}

export class UsdcLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UsdcLedgerError';
  }
}

export interface UsdcLedgerOptions {
  readonly pool: Pool;
  /** Owner-verified deployed configuration — never invented or defaulted by this class. See
   * the wave 5 progress log for why this worktree does not hardcode a contract/recipient. */
  readonly recipientAddress: string;
  readonly contractAddress: string;
  readonly chainId: number;
  readonly catalog?: readonly CatalogPrice[];
  readonly invoiceTtlMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Source of the per-invoice amount-uniqueness nudge (0-999 base units). Injected for
   * deterministic tests; production uses a random value. */
  readonly nudgeFactory?: () => number;
}

const DEFAULT_INVOICE_TTL_MS = 30 * 60_000; // 30 minutes — long enough for a wallet transfer.
const NUDGE_RANGE = 1000; // up to $0.000999, negligible next to any real USD price.
const MAX_CREATE_ATTEMPTS = 5;

interface InvoiceRow {
  readonly id: string;
  readonly owner_id: string;
  readonly plan: string;
  readonly amount_usdc_base_units: string;
  readonly recipient_address: string;
  readonly contract_address: string;
  readonly chain_id: number;
  readonly status: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly confirmed_at: Date | null;
  readonly tx_hash: string | null;
  readonly log_index: number | null;
  readonly refunded_at: Date | null;
  readonly refund_reason: string | null;
}

export class UsdcInvoiceLedger {
  private readonly pool: Pool;
  private readonly recipientAddress: string;
  private readonly contractAddress: string;
  private readonly chainId: number;
  private readonly catalog: readonly CatalogPrice[] | undefined;
  private readonly invoiceTtlMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly nudgeFactory: () => number;

  constructor(options: UsdcLedgerOptions) {
    this.pool = options.pool;
    this.recipientAddress = options.recipientAddress;
    this.contractAddress = options.contractAddress;
    this.chainId = options.chainId;
    this.catalog = options.catalog;
    this.invoiceTtlMs = options.invoiceTtlMs ?? DEFAULT_INVOICE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.nudgeFactory = options.nudgeFactory ?? (() => Math.floor(Math.random() * NUDGE_RANGE));
  }

  /**
   * Idempotent per (ownerId, plan): a caller who retries checkout before the first invoice
   * expires gets the same pending invoice back rather than accumulating duplicates.
   */
  async createInvoice(ownerId: string, plan: BillingPlan): Promise<Invoice> {
    const existing = await this.pendingInvoiceForOwnerPlan(ownerId, plan);
    if (existing !== undefined) return existing;

    const price = priceForPlan(plan, this.catalog);
    const baseAmount = usdToUsdcBaseUnits(price.usd);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      const nudge = BigInt(((this.nudgeFactory() % NUDGE_RANGE) + NUDGE_RANGE) % NUDGE_RANGE);
      const amount = (baseAmount + nudge).toString(10);
      const id = this.idFactory();
      const createdAt = new Date(this.now());
      const expiresAt = new Date(createdAt.getTime() + this.invoiceTtlMs);
      try {
        const result = await this.pool.query<InvoiceRow>(
          `INSERT INTO usdc_invoices
             (id, owner_id, plan, amount_usdc_base_units, recipient_address, contract_address,
              chain_id, status, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
           RETURNING *`,
          [
            id,
            ownerId,
            plan,
            amount,
            this.recipientAddress,
            this.contractAddress,
            this.chainId,
            createdAt,
            expiresAt,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new UsdcLedgerError('INVOICE_CREATE_FAILED', 'insert failed');
        }
        return invoiceOf(row);
      } catch (error) {
        if (isUniqueViolation(error)) continue; // amount collided with another pending invoice
        throw error;
      }
    }
    throw new UsdcLedgerError(
      'INVOICE_AMOUNT_COLLISION',
      `could not allocate a unique pending amount for plan "${plan}" after ${MAX_CREATE_ATTEMPTS} attempts`,
    );
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const result = await this.pool.query<InvoiceRow>('SELECT * FROM usdc_invoices WHERE id = $1', [
      id,
    ]);
    const row = result.rows[0];
    return row === undefined ? undefined : invoiceOf(row);
  }

  /** Matches an observed on-chain transfer back to the one pending invoice it pays, by the
   * (recipient, exact amount) pair the createInvoice nudge made unique. */
  async findPendingInvoiceForTransfer(
    recipientAddress: string,
    amountUsdcBaseUnits: string,
  ): Promise<Invoice | undefined> {
    const result = await this.pool.query<InvoiceRow>(
      `SELECT * FROM usdc_invoices
       WHERE status = 'pending' AND recipient_address = $1 AND amount_usdc_base_units = $2
       LIMIT 1`,
      [recipientAddress, amountUsdcBaseUnits],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : invoiceOf(row);
  }

  /**
   * Exactly-once activation, guarded twice: the `WHERE status = 'pending'` compare-and-set
   * means a second call for the same invoice never re-confirms it, and a unique index on
   * (tx_hash, log_index) means the same on-chain event can never confirm two different
   * invoices even under a concurrent race. A retry with the exact same evidence for an
   * already-confirmed invoice returns the existing row rather than erroring — replay-safe.
   */
  async confirmInvoice(
    invoiceId: string,
    evidence: { readonly txHash: string; readonly logIndex: number },
  ): Promise<Invoice> {
    const confirmedAt = new Date(this.now());
    try {
      const result = await this.pool.query<InvoiceRow>(
        `UPDATE usdc_invoices
           SET status = 'confirmed', confirmed_at = $2, tx_hash = $3, log_index = $4
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [invoiceId, confirmedAt, evidence.txHash, evidence.logIndex],
      );
      const row = result.rows[0];
      if (row !== undefined) return invoiceOf(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Falls through to the replay/conflict check below.
    }

    const existing = await this.getInvoice(invoiceId);
    if (existing === undefined) {
      throw new UsdcLedgerError('INVOICE_NOT_FOUND', `no invoice with id "${invoiceId}"`);
    }
    if (
      existing.status === 'confirmed' &&
      existing.txHash === evidence.txHash &&
      existing.logIndex === evidence.logIndex
    ) {
      return existing; // idempotent replay of the same confirmation
    }
    throw new UsdcLedgerError(
      'INVOICE_NOT_CONFIRMABLE',
      `invoice "${invoiceId}" is "${existing.status}" and cannot be confirmed by this evidence`,
    );
  }

  /** Terminal, explicit transition (unlike wave 4's subscriptions, an invoice's `pending`
   * status is not just computed on read): a real UPDATE is required so the amount slot the
   * partial unique index reserved is freed for a fresh invoice. Call periodically; not wired
   * to a live scheduler in this wave. */
  async expireStalePending(): Promise<readonly Invoice[]> {
    const result = await this.pool.query<InvoiceRow>(
      `UPDATE usdc_invoices SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= $1
       RETURNING *`,
      [new Date(this.now())],
    );
    return result.rows.map(invoiceOf);
  }

  /** No on-chain refund execution here — that needs a signing wallet, explicitly out of scope
   * (see the wave 5 progress log). This only records that a refund happened by other means. */
  async refundInvoice(invoiceId: string, reason: string): Promise<Invoice> {
    const result = await this.pool.query<InvoiceRow>(
      `UPDATE usdc_invoices SET status = 'refunded', refunded_at = $2, refund_reason = $3
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *`,
      [invoiceId, new Date(this.now()), reason],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new UsdcLedgerError(
        'INVOICE_NOT_REFUNDABLE',
        `invoice "${invoiceId}" is not in a refundable (confirmed) state`,
      );
    }
    return invoiceOf(row);
  }

  /** Operator-safe: every field here (amounts, addresses, status, timestamps) is safe to show
   * an operator reconciling payments — no wallet private key, no API key, no raw webhook
   * payload ever passes through this ledger. Not wired to any HTTP route this wave — see the
   * wave 5 progress log for why an admin-auth decision is required first. */
  async listForReconciliation(
    options: { readonly limit?: number } = {},
  ): Promise<readonly Invoice[]> {
    const limit = options.limit ?? 200;
    const result = await this.pool.query<InvoiceRow>(
      'SELECT * FROM usdc_invoices ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return result.rows.map(invoiceOf);
  }

  private async pendingInvoiceForOwnerPlan(
    ownerId: string,
    plan: BillingPlan,
  ): Promise<Invoice | undefined> {
    const result = await this.pool.query<InvoiceRow>(
      `SELECT * FROM usdc_invoices
       WHERE owner_id = $1 AND plan = $2 AND status = 'pending' AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [ownerId, plan, new Date(this.now())],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : invoiceOf(row);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function invoiceOf(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    ownerId: row.owner_id,
    plan: row.plan === 'yearly' ? 'yearly' : 'monthly',
    amountUsdcBaseUnits: row.amount_usdc_base_units,
    recipientAddress: row.recipient_address,
    contractAddress: row.contract_address,
    chainId: row.chain_id,
    status: asStatus(row.status),
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    ...(row.confirmed_at !== null ? { confirmedAt: row.confirmed_at.getTime() } : {}),
    ...(row.tx_hash !== null ? { txHash: row.tx_hash } : {}),
    ...(row.log_index !== null ? { logIndex: row.log_index } : {}),
    ...(row.refunded_at !== null ? { refundedAt: row.refunded_at.getTime() } : {}),
    ...(row.refund_reason !== null ? { refundReason: row.refund_reason } : {}),
  };
}

function asStatus(value: string): InvoiceStatus {
  return value === 'confirmed' || value === 'expired' || value === 'refunded' ? value : 'pending';
}
