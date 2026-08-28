import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CapabilityId, Money, ProviderApprovalGrant } from '@joy-media/provider-sdk';
import {
  createProviderBudgetLedger,
  compareMoney,
  reconcileProviderBudget,
  reserveProviderBudget,
  type ProviderApprovalPreflight,
  type ProviderBudgetLedgerV1,
  type ReconcileProviderBudgetInput,
  type ReconcileProviderBudgetResult,
  type ProviderBudgetReservationV1,
  type ReserveProviderBudgetInput,
  type ReserveProviderBudgetResult,
} from '@joy-media/provider-sdk';
import { POSTGRES_SCHEMA } from './postgres-schema.js';

export type ProviderApprovalAuditStatus = 'denied' | 'unavailable' | 'failed' | 'succeeded';

export interface ProviderApprovalSigningConfig {
  readonly keyId: string;
  readonly secret: string;
}

export function providerApprovalSigningConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderApprovalSigningConfig | null {
  const keyId = env.JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_KEY_ID?.trim();
  const secret = env.JOY_MEDIA_PROVIDER_APPROVAL_SIGNING_SECRET;
  return keyId !== undefined && keyId.length > 0 && secret !== undefined && secret.length > 0
    ? { keyId, secret }
    : null;
}

export interface ProviderApprovalAuditRow {
  readonly rowVersion: 1;
  readonly decisionId: string;
  readonly actorId: string;
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly requestDigest: string;
  readonly idempotencyKey: string;
  readonly status: ProviderApprovalAuditStatus;
  readonly reason: string;
  readonly createdAt: string;
  readonly approvalGrantId?: string;
  readonly budgetReservationId?: string;
  readonly estimatedCost?: Money;
  readonly costCap?: Money;
}

export interface ProviderApprovalStore {
  append(row: ProviderApprovalAuditRow): Promise<void>;
  list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]>;
  /** Durable implementations may persist grants and expose their signing key id. */
  saveGrant?(grant: ProviderApprovalGrant, signingKeyId: string): Promise<void>;
  loadGrant?(
    grantId: string,
  ): Promise<{ readonly grant: ProviderApprovalGrant; readonly signingKeyId: string } | undefined>;
  reserveBudget?(input: ReserveProviderBudgetInput): Promise<ReserveProviderBudgetResult>;
  reconcileBudget?(input: ReconcileProviderBudgetInput): Promise<ReconcileProviderBudgetResult>;
  /** Record a provider charge that exceeded the approved reservation. */
  recordBudgetOverage?(input: ProviderBudgetOverageInput): Promise<void>;
}

export interface ProviderBudgetOverageInput {
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly actualCost: Money;
  readonly providerUsageId: string;
}

export interface ProviderApprovalVerification {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly preflight: ProviderApprovalPreflight;
  readonly privacyMode: 'local-only' | 'ask-before-remote';
  readonly grant?: ProviderApprovalGrant | undefined;
  readonly fallbackCostCap?: Money | undefined;
  readonly now?: Date | undefined;
}

export interface ProviderFailureUsage {
  /** Known provider spend, when a provider returned a result before failing. */
  readonly actualCost?: Money | undefined;
  /** Provider usage/request identifier; it is hashed before persistence. */
  readonly providerUsageId?: string | undefined;
}

export interface ProviderApprovalOutcome {
  readonly grant: ProviderApprovalGrant;
  readonly reservation?: ProviderBudgetReservationV1;
}

export class ProviderApprovalError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_APPROVAL_REQUIRED'
      | 'PROVIDER_APPROVAL_DENIED'
      | 'PROVIDER_APPROVAL_EXPIRED'
      | 'PROVIDER_APPROVAL_REPLAY_REJECTED'
      | 'PROVIDER_SPEND_CAP_EXCEEDED'
      | 'REMOTE_PROCESSING_BLOCKED'
      | 'PROVIDER_APPROVAL_UNAVAILABLE',
    message: string,
    readonly preflight?: ProviderApprovalPreflight,
  ) {
    super(message);
    this.name = 'ProviderApprovalError';
  }
}

export class MemoryProviderApprovalStore implements ProviderApprovalStore {
  readonly #rows: ProviderApprovalAuditRow[] = [];
  readonly #grants = new Map<string, { grant: ProviderApprovalGrant; signingKeyId: string }>();

  async append(row: ProviderApprovalAuditRow): Promise<void> {
    this.#rows.push(row);
  }

  async list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
    return actorId === undefined
      ? [...this.#rows]
      : this.#rows.filter((row) => row.actorId === actorId);
  }

  async saveGrant(grant: ProviderApprovalGrant, signingKeyId: string): Promise<void> {
    this.#grants.set(grant.grantId, { grant, signingKeyId });
  }

  async loadGrant(
    grantId: string,
  ): Promise<{ readonly grant: ProviderApprovalGrant; readonly signingKeyId: string } | undefined> {
    return this.#grants.get(grantId);
  }
}

interface PostgresGrantRow {
  readonly grant_data: unknown;
  readonly signing_key_id: string;
}

interface PostgresReservationRow {
  readonly reservation_data: unknown;
}

interface PostgresReconciliationRow {
  readonly reconciliation_data: unknown;
}

/** PostgreSQL-backed approval state. Secrets never cross this persistence boundary. */
export class PostgresProviderApprovalStore implements ProviderApprovalStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA);
  }

  async append(row: ProviderApprovalAuditRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_approval_audit
         (decision_id, actor_id, provider_id, capability, request_digest, idempotency_key,
          status, reason, approval_grant_id, budget_reservation_id, estimated_cost, cost_cap, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
      [
        row.decisionId,
        row.actorId,
        row.providerId,
        row.capability,
        row.requestDigest,
        row.idempotencyKey,
        row.status,
        row.reason,
        row.approvalGrantId ?? null,
        row.budgetReservationId ?? null,
        row.estimatedCost === undefined ? null : JSON.stringify(row.estimatedCost),
        row.costCap === undefined ? null : JSON.stringify(row.costCap),
        new Date(row.createdAt),
      ],
    );
  }

  async list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
    const result =
      actorId === undefined
        ? await this.pool.query<ProviderApprovalAuditDbRow>(
            `SELECT decision_id, actor_id, provider_id, capability, request_digest, idempotency_key,
                    status, reason, approval_grant_id, budget_reservation_id, estimated_cost, cost_cap, created_at
             FROM provider_approval_audit ORDER BY created_at ASC, decision_id ASC`,
          )
        : await this.pool.query<ProviderApprovalAuditDbRow>(
            `SELECT decision_id, actor_id, provider_id, capability, request_digest, idempotency_key,
                    status, reason, approval_grant_id, budget_reservation_id, estimated_cost, cost_cap, created_at
             FROM provider_approval_audit WHERE actor_id = $1 ORDER BY created_at ASC, decision_id ASC`,
            [actorId],
          );
    return result.rows.map(providerApprovalAuditOf);
  }

  async saveGrant(grant: ProviderApprovalGrant, signingKeyId: string): Promise<void> {
    await this.transaction(async (client) => {
      const now = new Date();
      await client.query(
        `INSERT INTO provider_approval_signing_keys (key_id, created_at)
         VALUES ($1, $2) ON CONFLICT (key_id) DO NOTHING`,
        [signingKeyId, now],
      );
      await client.query(
        `INSERT INTO provider_approval_grants
           (grant_id, signing_key_id, actor_id, provider_id, capability, request_digest, grant_data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (grant_id) DO NOTHING`,
        [
          grant.grantId,
          signingKeyId,
          grant.actorId,
          grant.providerId,
          grant.capability,
          grant.requestDigest,
          JSON.stringify(grant),
          now,
        ],
      );
    });
  }

  async loadGrant(
    grantId: string,
  ): Promise<{ readonly grant: ProviderApprovalGrant; readonly signingKeyId: string } | undefined> {
    const result = await this.pool.query<PostgresGrantRow>(
      'SELECT grant_data, signing_key_id FROM provider_approval_grants WHERE grant_id = $1',
      [grantId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { grant: parseProviderApprovalGrant(row.grant_data), signingKeyId: row.signing_key_id };
  }

  async reserveBudget(input: ReserveProviderBudgetInput): Promise<ReserveProviderBudgetResult> {
    try {
      return await this.transaction(async (client) => {
        // Serialize every transition for this reservation. This is required
        // in addition to the in-memory reducer: two API instances can settle
        // the same reservation concurrently after a restart.
        await client.query(
          'SELECT reservation_id FROM provider_approval_reservations WHERE reservation_id = $1 FOR UPDATE',
          [input.reservationId],
        );
        const ledger = await loadProviderBudgetLedger(client);
        const result = reserveProviderBudget(ledger, input);
        if (!result.ok || result.replay) return result;
        await client.query(
          `INSERT INTO provider_approval_reservations
             (reservation_id, idempotency_key, provider_id, capability, reservation_data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)`,
          [
            result.reservation.reservationId,
            result.reservation.idempotencyKey,
            result.reservation.providerId,
            result.reservation.capability,
            JSON.stringify(result.reservation),
            new Date(),
          ],
        );
        return result;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return this.reserveBudget(input);
      throw error;
    }
  }

  async reconcileBudget(
    input: ReconcileProviderBudgetInput,
  ): Promise<ReconcileProviderBudgetResult> {
    try {
      return await this.transaction(async (client) => {
        // Lock the reservation before rebuilding the ledger. Without this,
        // concurrent API instances can both observe an unsettled reservation
        // and race to apply a final settlement.
        await client.query(
          'SELECT reservation_id FROM provider_approval_reservations WHERE reservation_id = $1 FOR UPDATE',
          [input.reservationId],
        );
        const ledger = await loadProviderBudgetLedger(client);
        const result = reconcileProviderBudget(ledger, input);
        if (!result.ok || result.replay) return result;
        await client.query(
          `UPDATE provider_approval_reservations
           SET reservation_data = $2::jsonb, updated_at = $3 WHERE reservation_id = $1`,
          [result.reservation.reservationId, JSON.stringify(result.reservation), new Date()],
        );
        await client.query(
          `INSERT INTO provider_approval_reconciliations
             (idempotency_key, reservation_id, kind, reconciliation_data, created_at)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            result.reconciliation.idempotencyKey,
            result.reconciliation.reservationId,
            result.reconciliation.kind,
            JSON.stringify(result.reconciliation),
            new Date(),
          ],
        );
        return result;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return this.reconcileBudget(input);
      throw error;
    }
  }

  async recordBudgetOverage(input: ProviderBudgetOverageInput): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        'SELECT reservation_id FROM provider_approval_reservations WHERE reservation_id = $1 FOR UPDATE',
        [input.reservationId],
      );
      await client.query(
        `INSERT INTO provider_approval_reconciliations
           (idempotency_key, reservation_id, kind, reconciliation_data, created_at)
         VALUES ($1, $2, 'overage', $3::jsonb, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          input.idempotencyKey,
          input.reservationId,
          JSON.stringify({
            reconciliationVersion: 1,
            reservationId: input.reservationId,
            idempotencyKey: input.idempotencyKey,
            kind: 'overage',
            actualCost: input.actualCost,
            providerUsageId: input.providerUsageId,
          }),
          new Date(),
        ],
      );
    });
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

interface ProviderApprovalAuditDbRow {
  readonly decision_id: string;
  readonly actor_id: string;
  readonly provider_id: string;
  readonly capability: CapabilityId;
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly status: ProviderApprovalAuditStatus;
  readonly reason: string;
  readonly approval_grant_id: string | null;
  readonly budget_reservation_id: string | null;
  readonly estimated_cost: unknown;
  readonly cost_cap: unknown;
  readonly created_at: Date | string;
}

export class ProviderApprovalService {
  #budgetLedger: ProviderBudgetLedgerV1;
  readonly #signingSecret: string | undefined;
  readonly #signingKeyId: string;

  constructor(
    private readonly store: ProviderApprovalStore = new MemoryProviderApprovalStore(),
    budgetLedger: ProviderBudgetLedgerV1 = createProviderBudgetLedger(),
    signingConfig: ProviderApprovalSigningConfig | string | null = {
      keyId: 'ephemeral-test',
      secret: randomBytes(32).toString('base64url'),
    },
  ) {
    this.#budgetLedger = budgetLedger;
    if (signingConfig === null) {
      this.#signingKeyId = '';
      this.#signingSecret = undefined;
    } else if (typeof signingConfig === 'string') {
      this.#signingKeyId = 'injected';
      this.#signingSecret = signingConfig;
    } else {
      this.#signingKeyId = signingConfig.keyId;
      this.#signingSecret = signingConfig.secret;
    }
  }

  createGrant(
    input: Omit<ProviderApprovalGrant, 'grantVersion' | 'grantId' | 'grantSignature' | 'status'> & {
      readonly grantId?: string | undefined;
      readonly status?: ProviderApprovalGrant['status'] | undefined;
    },
  ): ProviderApprovalGrant {
    this.assertSigningAvailable();
    const unsigned: Omit<ProviderApprovalGrant, 'grantSignature'> = {
      grantVersion: 1,
      grantId: input.grantId ?? `grant-${crypto.randomUUID()}`,
      actorId: input.actorId,
      providerId: input.providerId,
      capability: input.capability,
      requestDigest: input.requestDigest,
      expiresAt: input.expiresAt,
      status: input.status ?? 'approved',
      ...(input.costCap === undefined ? {} : { costCap: input.costCap }),
    };
    const grant = {
      ...unsigned,
      grantSignature: this.signGrant(unsigned),
    };
    // Memory storage is synchronous through the first await, and durable
    // callers use persistGrant before sending the HTTP response.
    void this.store.saveGrant?.(grant, this.#signingKeyId);
    return grant;
  }

  async persistGrant(grant: ProviderApprovalGrant): Promise<void> {
    this.assertSigningAvailable();
    await this.store.saveGrant?.(grant, this.#signingKeyId);
  }

  async verify(input: ProviderApprovalVerification): Promise<ProviderApprovalOutcome> {
    const estimatedCost = input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap);
    const costCap = input.grant?.costCap ?? input.fallbackCostCap;

    if (input.privacyMode === 'local-only' && input.preflight.requiresUserApproval) {
      await this.audit(input, 'denied', 'remote-processing-blocked', { estimatedCost, costCap });
      throw new ProviderApprovalError(
        'REMOTE_PROCESSING_BLOCKED',
        'Local-only policy blocks remote provider processing.',
        input.preflight,
      );
    }

    const approvalRequired =
      input.preflight.requiresUserApproval || estimatedCost.amount !== '0.00';
    if (this.#signingSecret === undefined && approvalRequired) {
      await this.audit(input, 'unavailable', 'approval-signing-config-missing', {
        estimatedCost,
        costCap,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_UNAVAILABLE',
        'Provider approval is unavailable because signing configuration is missing.',
        input.preflight,
      );
    }

    if (!input.preflight.requiresUserApproval && estimatedCost.amount === '0.00') {
      return {
        grant: this.createGrant({
          actorId: input.actorId,
          providerId: input.preflight.providerId,
          capability: input.preflight.capability,
          requestDigest: input.preflight.requestDigest,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          costCap: estimatedCost,
          status: 'approved',
        }),
      };
    }

    if (input.grant === undefined) {
      await this.audit(input, 'denied', 'approval-required', { estimatedCost, costCap });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_REQUIRED',
        'Provider processing requires an approval grant bound to this request.',
        input.preflight,
      );
    }

    if (!this.isAuthenticGrant(input.grant)) {
      await this.audit(input, 'denied', 'approval-forgery-rejected', {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_REPLAY_REJECTED',
        'Approval grant was not issued by this server.',
        input.preflight,
      );
    }

    const durableGrant = await this.store.loadGrant?.(input.grant.grantId);
    if (
      (this.store.loadGrant !== undefined && durableGrant === undefined) ||
      (durableGrant !== undefined &&
        (durableGrant.signingKeyId !== this.#signingKeyId ||
          stableJson(durableGrant.grant) !== stableJson(input.grant)))
    ) {
      await this.audit(input, 'denied', 'approval-replay-rejected', {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_REPLAY_REJECTED',
        'Approval grant does not match its durable record.',
        input.preflight,
      );
    }

    const mismatch =
      input.grant.actorId !== input.actorId ||
      input.grant.providerId !== input.preflight.providerId ||
      input.grant.capability !== input.preflight.capability ||
      input.grant.requestDigest !== input.preflight.requestDigest;
    if (mismatch) {
      await this.audit(input, 'denied', 'approval-replay-rejected', {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_REPLAY_REJECTED',
        'Approval grant does not match this actor, provider, capability, or request digest.',
        input.preflight,
      );
    }

    if (input.grant.status !== 'approved') {
      await this.audit(input, 'denied', 'approval-denied', {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_DENIED',
        'Provider processing was denied by approval policy.',
        input.preflight,
      );
    }

    if (Date.parse(input.grant.expiresAt) <= (input.now ?? new Date()).getTime()) {
      await this.audit(input, 'denied', 'approval-expired', {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_APPROVAL_EXPIRED',
        'Provider approval grant has expired.',
        input.preflight,
      );
    }

    if (costCap === undefined) {
      await this.audit(input, 'denied', 'spend-cap-required', {
        estimatedCost,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_SPEND_CAP_EXCEEDED',
        'Provider spend requires an explicit approval cost cap.',
        input.preflight,
      );
    }

    const scopedKey = scopedBudgetKey(input);
    // Reserve the approved cap (rather than a possibly missing/optimistic
    // estimate) so a provider-reported charge can be settled truthfully after
    // invocation. The cap check below still rejects estimates over the cap.
    const reservationCost =
      estimatedCost.currency === costCap.currency && compareMoney(estimatedCost, costCap) <= 0
        ? costCap
        : estimatedCost;
    const reservationInput: ReserveProviderBudgetInput = {
      reservationId: `reserve-${scopedKey}`,
      idempotencyKey: scopedKey,
      providerId: input.preflight.providerId,
      capability: input.preflight.capability,
      estimatedCost: reservationCost,
      cap: costCap,
    };
    const reserved = this.store.reserveBudget
      ? await this.store.reserveBudget(reservationInput)
      : reserveProviderBudget(this.#budgetLedger, reservationInput);
    if (!reserved.ok) {
      await this.audit(input, 'denied', `budget-${reserved.reason}`, {
        estimatedCost,
        costCap,
        grant: input.grant,
      });
      throw new ProviderApprovalError(
        'PROVIDER_SPEND_CAP_EXCEEDED',
        `Provider budget reservation failed: ${reserved.reason}.`,
        input.preflight,
      );
    }
    this.#budgetLedger = reserved.ledger;
    return { grant: input.grant, reservation: reserved.reservation };
  }

  async recordUnavailable(input: ProviderApprovalVerification, reason: string): Promise<void> {
    await this.audit(input, 'unavailable', reason, {
      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
      costCap: input.grant?.costCap ?? input.fallbackCostCap,
      grant: input.grant,
    });
  }

  async recordFailed(
    input: ProviderApprovalVerification,
    reservation: ProviderBudgetReservationV1 | undefined,
    reason: string,
    usageOrCost: ProviderFailureUsage | Money = {},
    providerUsageId?: string,
  ): Promise<void> {
    const usage = isMoney(usageOrCost) ? { actualCost: usageOrCost, providerUsageId } : usageOrCost;
    const reconciliationFailure = await this.reconcile(
      input.idempotencyKey,
      reservation,
      usage.actualCost ?? zeroMoney(reservation?.reserved),
      safeFailureUsageId(usage.providerUsageId),
    );
    await this.audit(
      input,
      'failed',
      reconciliationFailure === 'cap-exceeded'
        ? 'provider-cost-over-cap'
        : safeFailureAuditReason(reason),
      {
        estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
        costCap: input.grant?.costCap ?? input.fallbackCostCap,
        grant: input.grant,
        reservation,
      },
    );
  }

  async recordSucceeded(
    input: ProviderApprovalVerification,
    reservation: ProviderBudgetReservationV1 | undefined,
    actualCost?: Money,
  ): Promise<void> {
    const reconciliationFailure = await this.reconcile(
      input.idempotencyKey,
      reservation,
      actualCost ?? input.preflight.estimatedCost ?? zeroMoney(reservation?.reserved),
      'succeeded',
    );
    if (reconciliationFailure !== undefined) {
      await this.audit(
        input,
        'failed',
        reconciliationFailure === 'cap-exceeded'
          ? 'provider-cost-over-cap'
          : 'provider-budget-reconciliation-failed',
        {
          estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
          costCap: input.grant?.costCap ?? input.fallbackCostCap,
          grant: input.grant,
          reservation,
        },
      );
      throw new ProviderApprovalError(
        'PROVIDER_SPEND_CAP_EXCEEDED',
        reconciliationFailure === 'cap-exceeded'
          ? 'Provider usage exceeded the approved spend cap.'
          : 'Provider budget reconciliation failed.',
        input.preflight,
      );
    }
    await this.audit(input, 'succeeded', 'succeeded', {
      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
      costCap: input.grant?.costCap ?? input.fallbackCostCap,
      grant: input.grant,
      reservation,
    });
  }

  auditRows(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
    return this.store.list(actorId);
  }

  private async reconcile(
    idempotencyKey: string,
    reservation: ProviderBudgetReservationV1 | undefined,
    actualCost: Money,
    providerUsageId: string,
  ): Promise<Extract<ReconcileProviderBudgetResult, { readonly ok: false }>['reason'] | undefined> {
    if (reservation === undefined) return undefined;
    const scopedKey = scopedReconciliationKey(idempotencyKey, reservation);
    const reconciliationInput: ReconcileProviderBudgetInput = {
      reservationId: reservation.reservationId,
      idempotencyKey: scopedKey,
      kind: 'final',
      actualCost,
      providerUsageId,
    };
    const reconciled = this.store.reconcileBudget
      ? await this.store.reconcileBudget(reconciliationInput)
      : reconcileProviderBudget(this.#budgetLedger, reconciliationInput);
    if (!reconciled.ok) {
      if (reconciled.reason === 'cap-exceeded' && this.store.recordBudgetOverage) {
        await this.store.recordBudgetOverage({
          reservationId: reservation.reservationId,
          idempotencyKey: scopedKey,
          actualCost,
          providerUsageId,
        });
      }
      return reconciled.reason;
    }
    this.#budgetLedger = reconciled.ledger;
    return undefined;
  }

  private async audit(
    input: ProviderApprovalVerification,
    status: ProviderApprovalAuditStatus,
    reason: string,
    options: {
      readonly estimatedCost?: Money;
      readonly costCap?: Money | undefined;
      readonly grant?: ProviderApprovalGrant | undefined;
      readonly reservation?: ProviderBudgetReservationV1 | undefined;
    },
  ): Promise<void> {
    await this.store.append({
      rowVersion: 1,
      decisionId: `decision-${crypto.randomUUID()}`,
      actorId: input.actorId,
      providerId: input.preflight.providerId,
      capability: input.preflight.capability,
      requestDigest: input.preflight.requestDigest,
      idempotencyKey: input.idempotencyKey,
      status,
      reason: redactAuditReason(reason),
      createdAt: (input.now ?? new Date()).toISOString(),
      ...(options.grant === undefined ? {} : { approvalGrantId: options.grant.grantId }),
      ...(options.reservation === undefined
        ? {}
        : { budgetReservationId: options.reservation.reservationId }),
      ...(options.estimatedCost === undefined ? {} : { estimatedCost: options.estimatedCost }),
      ...(options.costCap === undefined ? {} : { costCap: options.costCap }),
    });
  }

  private signGrant(
    grant: Omit<ProviderApprovalGrant, 'grantSignature'>,
  ): ProviderApprovalGrant['grantSignature'] {
    this.assertSigningAvailable();
    return createHmac('sha256', this.#signingSecret!).update(stableJson(grant)).digest('base64url');
  }

  private isAuthenticGrant(grant: ProviderApprovalGrant): boolean {
    if (this.#signingSecret === undefined) return false;
    const { grantSignature: provided, ...unsigned } = grant;
    const expected = this.signGrant(unsigned);
    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided);
    return (
      expectedBytes.byteLength === providedBytes.byteLength &&
      timingSafeEqual(expectedBytes, providedBytes)
    );
  }

  private assertSigningAvailable(): void {
    if (this.#signingSecret !== undefined) return;
    throw new ProviderApprovalError(
      'PROVIDER_APPROVAL_UNAVAILABLE',
      'Provider approval is unavailable because signing configuration is missing.',
    );
  }
}

export function providerApprovalRequiredPayload(error: ProviderApprovalError): {
  readonly code: ProviderApprovalError['code'];
  readonly message: string;
  readonly preflight?: ProviderApprovalPreflight;
} {
  return {
    code: error.code,
    message: error.message,
    ...(error.preflight === undefined ? {} : { preflight: error.preflight }),
  };
}

function zeroMoney(reference?: Money): Money {
  return { amount: '0.00', currency: reference?.currency ?? 'USD' };
}

function redactAuditReason(reason: string): string {
  return reason.replace(
    /(secret|token|api[-_]?key|authorization)[A-Za-z0-9._:=/-]*/gi,
    '$1-redacted',
  );
}

const SAFE_FAILURE_CODES = new Set([
  'idempotency-request-digest-conflict',
  'invalid-structured-output',
  'provider-request-failed',
  'provider-unavailable',
]);

function safeFailureAuditReason(reason: string): string {
  const redacted = redactAuditReason(reason);
  if (redacted !== reason) return redacted;
  return SAFE_FAILURE_CODES.has(reason) ? reason : `provider-failed-${hashKey(reason)}`;
}

function safeFailureUsageId(providerUsageId: string | undefined): string {
  return providerUsageId === undefined
    ? 'provider-failed'
    : `provider-usage-${hashKey(providerUsageId)}`;
}

function isMoney(value: ProviderFailureUsage | Money): value is Money {
  return 'amount' in value && 'currency' in value;
}

function scopedBudgetKey(input: ProviderApprovalVerification): string {
  return hashKey({
    actorId: input.actorId,
    requestDigest: input.preflight.requestDigest,
    idempotencyKey: input.idempotencyKey,
  });
}

function scopedReconciliationKey(
  idempotencyKey: string,
  reservation: ProviderBudgetReservationV1,
): string {
  return hashKey({
    idempotencyKey,
    reservationId: reservation.reservationId,
  });
}

function hashKey(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

async function loadProviderBudgetLedger(client: PoolClient): Promise<ProviderBudgetLedgerV1> {
  const [reservations, reconciliations] = await Promise.all([
    client.query<PostgresReservationRow>(
      'SELECT reservation_data FROM provider_approval_reservations ORDER BY created_at ASC, reservation_id ASC',
    ),
    client.query<PostgresReconciliationRow>(
      "SELECT reconciliation_data FROM provider_approval_reconciliations WHERE kind IN ('partial', 'final') ORDER BY created_at ASC, idempotency_key ASC",
    ),
  ]);
  return {
    ledgerVersion: 1,
    reservations: reservations.rows.map((row) =>
      parseProviderBudgetReservation(row.reservation_data),
    ),
    reconciliations: reconciliations.rows.map((row) =>
      parseProviderBudgetReconciliation(row.reconciliation_data),
    ),
  };
}

function providerApprovalAuditOf(row: ProviderApprovalAuditDbRow): ProviderApprovalAuditRow {
  const estimatedCost = parseOptionalMoney(row.estimated_cost);
  const costCap = parseOptionalMoney(row.cost_cap);
  return {
    rowVersion: 1,
    decisionId: row.decision_id,
    actorId: row.actor_id,
    providerId: row.provider_id,
    capability: row.capability,
    requestDigest: row.request_digest,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    reason: row.reason,
    createdAt: dateValue(row.created_at),
    ...(row.approval_grant_id === null ? {} : { approvalGrantId: row.approval_grant_id }),
    ...(row.budget_reservation_id === null
      ? {}
      : { budgetReservationId: row.budget_reservation_id }),
    ...(estimatedCost === undefined ? {} : { estimatedCost }),
    ...(costCap === undefined ? {} : { costCap }),
  };
}

function parseProviderApprovalGrant(value: unknown): ProviderApprovalGrant {
  const candidate = parseJsonValue(value);
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('stored provider approval grant is invalid');
  return candidate as ProviderApprovalGrant;
}

function parseProviderBudgetReservation(value: unknown): ProviderBudgetReservationV1 {
  const candidate = parseJsonValue(value);
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('stored provider budget reservation is invalid');
  return candidate as ProviderBudgetReservationV1;
}

function parseProviderBudgetReconciliation(value: unknown) {
  const candidate = parseJsonValue(value);
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('stored provider budget reconciliation is invalid');
  return candidate as ProviderBudgetLedgerV1['reconciliations'][number];
}

function parseOptionalMoney(value: unknown): Money | undefined {
  if (value === null || value === undefined) return undefined;
  const candidate = parseJsonValue(value);
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    Array.isArray(candidate) ||
    typeof (candidate as Record<string, unknown>).amount !== 'string' ||
    typeof (candidate as Record<string, unknown>).currency !== 'string'
  )
    throw new Error('stored provider money value is invalid');
  return candidate as Money;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error('stored provider approval JSON is invalid');
  }
}

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  );
}
