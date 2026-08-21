import type { CapabilityId, Money, ProviderApprovalGrant } from '@joy-media/provider-sdk';
import {
  createProviderBudgetLedger,
  reconcileProviderBudget,
  reserveProviderBudget,
  type ProviderApprovalPreflight,
  type ProviderBudgetLedgerV1,
  type ProviderBudgetReservationV1,
} from '@joy-media/provider-sdk';

export type ProviderApprovalAuditStatus = 'denied' | 'unavailable' | 'failed' | 'succeeded';

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
      | 'REMOTE_PROCESSING_BLOCKED',
    message: string,
    readonly preflight?: ProviderApprovalPreflight,
  ) {
    super(message);
    this.name = 'ProviderApprovalError';
  }
}

export class MemoryProviderApprovalStore implements ProviderApprovalStore {
  readonly #rows: ProviderApprovalAuditRow[] = [];

  async append(row: ProviderApprovalAuditRow): Promise<void> {
    this.#rows.push(row);
  }

  async list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
    return actorId === undefined
      ? [...this.#rows]
      : this.#rows.filter((row) => row.actorId === actorId);
  }
}

export class ProviderApprovalService {
  #budgetLedger: ProviderBudgetLedgerV1;

  constructor(
    private readonly store: ProviderApprovalStore = new MemoryProviderApprovalStore(),
    budgetLedger: ProviderBudgetLedgerV1 = createProviderBudgetLedger(),
  ) {
    this.#budgetLedger = budgetLedger;
  }

  createGrant(
    input: Omit<ProviderApprovalGrant, 'grantVersion' | 'grantId' | 'status'> & {
      readonly grantId?: string | undefined;
      readonly status?: ProviderApprovalGrant['status'] | undefined;
    },
  ): ProviderApprovalGrant {
    return {
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

    const reserved = reserveProviderBudget(this.#budgetLedger, {
      reservationId: `reserve-${input.idempotencyKey}`,
      idempotencyKey: input.idempotencyKey,
      providerId: input.preflight.providerId,
      capability: input.preflight.capability,
      estimatedCost,
      cap: costCap,
    });
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
  ): Promise<void> {
    await this.reconcile(
      input.idempotencyKey,
      reservation,
      zeroMoney(reservation?.reserved),
      reason,
    );
    await this.audit(input, 'failed', reason, {
      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
      costCap: input.grant?.costCap ?? input.fallbackCostCap,
      grant: input.grant,
      reservation,
    });
  }

  async recordSucceeded(
    input: ProviderApprovalVerification,
    reservation: ProviderBudgetReservationV1 | undefined,
    actualCost?: Money,
  ): Promise<void> {
    await this.reconcile(
      input.idempotencyKey,
      reservation,
      actualCost ?? input.preflight.estimatedCost ?? zeroMoney(reservation?.reserved),
      'succeeded',
    );
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
  ): Promise<void> {
    if (reservation === undefined) return;
    const reconciled = reconcileProviderBudget(this.#budgetLedger, {
      reservationId: reservation.reservationId,
      idempotencyKey: `usage-${idempotencyKey}`,
      kind: 'final',
      actualCost,
      providerUsageId,
    });
    if (reconciled.ok) this.#budgetLedger = reconciled.ledger;
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
