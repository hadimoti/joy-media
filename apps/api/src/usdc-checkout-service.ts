import { extractCandidateTxHashes, verifyAlchemyWebhookSignature } from './alchemy-webhook.js';
import { observeTransferFromReceipt, verifyTransferAgainstInvoice } from './usdc-confirmation.js';
import type { ConfirmationPolicy, JsonRpcTransport } from './usdc-confirmation.js';
import type { Invoice, UsdcInvoiceLedger } from './usdc-invoice-ledger.js';
import type { BillingPlan } from './usdc-catalog.js';
import type { AccountApi } from './account-service.js';

/**
 * Orchestrates the full USDC checkout flow (JOY Media desktop migration, wave 5): create an
 * invoice, observe the chain, verify canonically, confirm exactly once, and activate the
 * owner's subscription. Locked owner decision: "Keep checkout disabled until the live-wallet
 * test gate is recorded" — `checkoutEnabled` defaults to (and, in this worktree, always is)
 * `false`; `createInvoice` refuses to run at all while it is.
 *
 * "Exactly-once entitlement activation" here comes from `AccountService.activateSubscription`
 * itself being an idempotent *overwrite* (`SET status = 'active', current_period_end = $2`),
 * not from a separate dedup guard: calling it twice with the same computed period end leaves
 * the subscription in exactly the state one confirmed payment implies, however many times a
 * webhook redelivers or a race lets two confirmation attempts reach this point. Combined with
 * `UsdcInvoiceLedger.confirmInvoice`'s own compare-and-set + replay-safety, no payment is
 * counted twice and no activation call can silently "double-extend" a period.
 */

export interface UsdcCheckoutApi {
  createInvoice(ownerId: string, plan: BillingPlan): Promise<Invoice>;
  getOwnedInvoice(ownerId: string, invoiceId: string): Promise<Invoice>;
  attemptConfirmation(txHash: string): Promise<Invoice | undefined>;
  handleWebhook(rawBody: string, signatureHeader: string | undefined): Promise<readonly Invoice[]>;
  listForReconciliation(options?: { readonly limit?: number }): Promise<readonly Invoice[]>;
}

export class UsdcCheckoutError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UsdcCheckoutError';
  }
}

const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60_000;
const YEARLY_PERIOD_MS = 365 * 24 * 60 * 60_000;

export interface UsdcCheckoutServiceOptions {
  readonly ledger: UsdcInvoiceLedger;
  readonly account: AccountApi;
  readonly transport: JsonRpcTransport;
  readonly policy: ConfirmationPolicy;
  readonly webhookSigningKey: string;
  /** Defaults to `false`. Only `server.ts` may set this true, and only by reading
   * `JOY_MEDIA_USDC_CHECKOUT_ENABLED` — this worktree never sets that variable. */
  readonly checkoutEnabled?: boolean;
  readonly now?: () => number;
}

export class UsdcCheckoutService implements UsdcCheckoutApi {
  private readonly ledger: UsdcInvoiceLedger;
  private readonly account: AccountApi;
  private readonly transport: JsonRpcTransport;
  private readonly policy: ConfirmationPolicy;
  private readonly webhookSigningKey: string;
  private readonly checkoutEnabled: boolean;
  private readonly now: () => number;

  constructor(options: UsdcCheckoutServiceOptions) {
    this.ledger = options.ledger;
    this.account = options.account;
    this.transport = options.transport;
    this.policy = options.policy;
    this.webhookSigningKey = options.webhookSigningKey;
    this.checkoutEnabled = options.checkoutEnabled ?? false;
    this.now = options.now ?? (() => Date.now());
  }

  async createInvoice(ownerId: string, plan: BillingPlan): Promise<Invoice> {
    if (!this.checkoutEnabled) {
      throw new UsdcCheckoutError('CHECKOUT_DISABLED', 'USDC checkout is not enabled yet');
    }
    return this.ledger.createInvoice(ownerId, plan);
  }

  async getOwnedInvoice(ownerId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.ledger.getInvoice(invoiceId);
    if (invoice === undefined || invoice.ownerId !== ownerId) {
      throw new UsdcCheckoutError('INVOICE_NOT_FOUND', 'invoice not found');
    }
    return invoice;
  }

  /**
   * The one path that turns on-chain evidence into a confirmed invoice + active subscription.
   * Called once per candidate tx hash from a verified webhook delivery, or directly with a
   * user-submitted hash as a fallback if webhook delivery is ever missed. Returns `undefined`
   * (never throws) for "not yet", "not ours", or "not enough confirmations yet" — those are
   * all normal, expected, retry-later states, not errors.
   */
  async attemptConfirmation(txHash: string): Promise<Invoice | undefined> {
    const observation = await observeTransferFromReceipt(
      txHash,
      this.transport,
      this.policy.expectedChainId,
      this.policy.expectedContractAddress,
    );
    if (observation === undefined) return undefined; // not yet mined

    const candidate = await this.ledger.findPendingInvoiceForTransfer(
      observation.toAddress,
      observation.valueBaseUnits,
    );
    if (candidate === undefined) return undefined; // doesn't match any pending invoice

    const verdict = verifyTransferAgainstInvoice(observation, candidate, this.policy);
    if (!verdict.ok) return undefined; // e.g. insufficient confirmations yet — poll again later

    const confirmed = await this.ledger.confirmInvoice(candidate.id, {
      txHash: observation.txHash,
      logIndex: observation.logIndex,
    });
    await this.account.activateSubscription(
      confirmed.ownerId,
      periodEndForPlan(confirmed.plan, this.now()),
    );
    return confirmed;
  }

  /**
   * Verifies the Alchemy signature over the exact raw body before touching anything else —
   * an unverified payload is never even parsed as JSON here (see alchemy-webhook.ts).
   */
  async handleWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
  ): Promise<readonly Invoice[]> {
    if (!verifyAlchemyWebhookSignature(rawBody, signatureHeader, this.webhookSigningKey)) {
      throw new UsdcCheckoutError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature did not verify');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new UsdcCheckoutError('WEBHOOK_PAYLOAD_INVALID', 'webhook body is not valid JSON');
    }
    const candidates = extractCandidateTxHashes(payload);
    const confirmed: Invoice[] = [];
    for (const hash of candidates) {
      const invoice = await this.attemptConfirmation(hash);
      if (invoice !== undefined) confirmed.push(invoice);
    }
    return confirmed;
  }

  /** Delegates straight through — reconciliation stays available even while checkout is
   * disabled, so an operator can review invoice history from an earlier enabled period. */
  async listForReconciliation(options?: { readonly limit?: number }): Promise<readonly Invoice[]> {
    return this.ledger.listForReconciliation(options);
  }
}

function periodEndForPlan(plan: BillingPlan, fromMs: number): number {
  return fromMs + (plan === 'yearly' ? YEARLY_PERIOD_MS : MONTHLY_PERIOD_MS);
}

/** Used when the ledger's Postgres pool, the Alchemy RPC/webhook credentials, or the
 * owner-verified recipient/contract configuration are not all present — every route stays
 * reachable but reports the feature as absent, same disabled-fallback shape as the other
 * services in this migration. */
export class DisabledUsdcCheckoutService implements UsdcCheckoutApi {
  async createInvoice(_ownerId: string, _plan: BillingPlan): Promise<Invoice> {
    throw new UsdcCheckoutError('CHECKOUT_DISABLED', 'USDC checkout is not enabled yet');
  }
  async getOwnedInvoice(_ownerId: string, _invoiceId: string): Promise<Invoice> {
    throw new UsdcCheckoutError('INVOICE_NOT_FOUND', 'invoice not found');
  }
  async attemptConfirmation(_txHash: string): Promise<Invoice | undefined> {
    return undefined;
  }
  async handleWebhook(
    _rawBody: string,
    _signatureHeader: string | undefined,
  ): Promise<readonly Invoice[]> {
    throw new UsdcCheckoutError('CHECKOUT_DISABLED', 'USDC checkout is not enabled yet');
  }
  async listForReconciliation(): Promise<readonly Invoice[]> {
    return [];
  }
}
