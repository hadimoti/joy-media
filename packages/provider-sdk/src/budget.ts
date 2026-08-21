import type { CapabilityId, Money } from './types.js';
import { addMoney, compareMoney } from './utils.js';

export interface ProviderBudgetLedgerV1 {
  readonly ledgerVersion: 1;
  readonly reservations: readonly ProviderBudgetReservationV1[];
  readonly reconciliations: readonly ProviderBudgetReconciliationV1[];
}

export interface ProviderBudgetReservationV1 {
  readonly reservationVersion: 1;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly reserved: Money;
  readonly cap: Money;
  readonly spent: Money;
  readonly released: Money;
  readonly status: 'reserved' | 'settled';
  readonly providerDecisionId?: string;
  readonly productionRunId?: string;
}

export interface ProviderBudgetReconciliationV1 {
  readonly reconciliationVersion: 1;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly kind: 'partial' | 'final';
  readonly actualCost: Money;
  readonly providerUsageId?: string;
}

export interface ReserveProviderBudgetInput {
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly capability: CapabilityId;
  readonly estimatedCost: Money;
  readonly cap: Money;
  readonly providerDecisionId?: string;
  readonly productionRunId?: string;
}

export interface ReconcileProviderBudgetInput {
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly kind: 'partial' | 'final';
  readonly actualCost: Money;
  readonly providerUsageId?: string;
}

export type ReserveProviderBudgetResult =
  | {
      readonly ok: true;
      readonly ledger: ProviderBudgetLedgerV1;
      readonly reservation: ProviderBudgetReservationV1;
      readonly replay: boolean;
    }
  | {
      readonly ok: false;
      readonly ledger: ProviderBudgetLedgerV1;
      readonly reason: 'cap-exceeded' | 'currency-mismatch' | 'idempotency-conflict';
    };

export type ReconcileProviderBudgetResult =
  | {
      readonly ok: true;
      readonly ledger: ProviderBudgetLedgerV1;
      readonly reservation: ProviderBudgetReservationV1;
      readonly reconciliation: ProviderBudgetReconciliationV1;
      readonly replay: boolean;
    }
  | {
      readonly ok: false;
      readonly ledger: ProviderBudgetLedgerV1;
      readonly reason:
        | 'reservation-not-found'
        | 'currency-mismatch'
        | 'cap-exceeded'
        | 'already-settled'
        | 'idempotency-conflict';
    };

const ZERO_USD: Money = { amount: '0.00', currency: 'USD' };

export function createProviderBudgetLedger(): ProviderBudgetLedgerV1 {
  return {
    ledgerVersion: 1,
    reservations: [],
    reconciliations: [],
  };
}

export function reserveProviderBudget(
  ledger: ProviderBudgetLedgerV1,
  input: ReserveProviderBudgetInput,
): ReserveProviderBudgetResult {
  const replay = ledger.reservations.find(
    (reservation) => reservation.idempotencyKey === input.idempotencyKey,
  );
  if (replay !== undefined) {
    if (!sameReservationReplay(replay, input)) {
      return { ok: false, ledger, reason: 'idempotency-conflict' };
    }
    return { ok: true, ledger, reservation: replay, replay: true };
  }

  if (input.estimatedCost.currency !== input.cap.currency) {
    return { ok: false, ledger, reason: 'currency-mismatch' };
  }
  if (compareMoney(input.estimatedCost, input.cap) > 0) {
    return { ok: false, ledger, reason: 'cap-exceeded' };
  }

  const zero = zeroMoney(input.estimatedCost.currency);
  const reservation: ProviderBudgetReservationV1 = {
    reservationVersion: 1,
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    providerId: input.providerId,
    capability: input.capability,
    reserved: input.estimatedCost,
    cap: input.cap,
    spent: zero,
    released: zero,
    status: 'reserved',
    ...(input.providerDecisionId === undefined
      ? {}
      : { providerDecisionId: input.providerDecisionId }),
    ...(input.productionRunId === undefined ? {} : { productionRunId: input.productionRunId }),
  };

  return {
    ok: true,
    ledger: {
      ...ledger,
      reservations: [...ledger.reservations, reservation],
    },
    reservation,
    replay: false,
  };
}

export function reconcileProviderBudget(
  ledger: ProviderBudgetLedgerV1,
  input: ReconcileProviderBudgetInput,
): ReconcileProviderBudgetResult {
  const replay = ledger.reconciliations.find(
    (reconciliation) => reconciliation.idempotencyKey === input.idempotencyKey,
  );
  if (replay !== undefined) {
    const reservation = ledger.reservations.find(
      (candidate) => candidate.reservationId === replay.reservationId,
    );
    if (reservation === undefined || !sameReconciliationReplay(replay, input)) {
      return { ok: false, ledger, reason: 'idempotency-conflict' };
    }
    return { ok: true, ledger, reservation, reconciliation: replay, replay: true };
  }

  const reservation = ledger.reservations.find(
    (candidate) => candidate.reservationId === input.reservationId,
  );
  if (reservation === undefined) {
    return { ok: false, ledger, reason: 'reservation-not-found' };
  }
  if (reservation.status === 'settled') {
    return { ok: false, ledger, reason: 'already-settled' };
  }
  if (reservation.reserved.currency !== input.actualCost.currency) {
    return { ok: false, ledger, reason: 'currency-mismatch' };
  }

  const nextSpent = addMoney(reservation.spent, input.actualCost);
  if (compareMoney(nextSpent, reservation.reserved) > 0) {
    return { ok: false, ledger, reason: 'cap-exceeded' };
  }

  const released =
    input.kind === 'final' ? subtractMoney(reservation.reserved, nextSpent) : reservation.released;
  const nextReservation: ProviderBudgetReservationV1 = {
    ...reservation,
    spent: nextSpent,
    released,
    status: input.kind === 'final' ? 'settled' : 'reserved',
  };
  const reconciliation: ProviderBudgetReconciliationV1 = {
    reconciliationVersion: 1,
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    actualCost: input.actualCost,
    ...(input.providerUsageId === undefined ? {} : { providerUsageId: input.providerUsageId }),
  };

  return {
    ok: true,
    ledger: {
      ...ledger,
      reservations: ledger.reservations.map((candidate) =>
        candidate.reservationId === input.reservationId ? nextReservation : candidate,
      ),
      reconciliations: [...ledger.reconciliations, reconciliation],
    },
    reservation: nextReservation,
    reconciliation,
    replay: false,
  };
}

function zeroMoney(currency: string): Money {
  return currency === 'USD' ? ZERO_USD : { amount: '0.00', currency };
}

function sameReservationReplay(
  reservation: ProviderBudgetReservationV1,
  input: ReserveProviderBudgetInput,
): boolean {
  return (
    reservation.reservationId === input.reservationId &&
    reservation.providerId === input.providerId &&
    reservation.capability === input.capability &&
    sameMoney(reservation.reserved, input.estimatedCost) &&
    sameMoney(reservation.cap, input.cap) &&
    reservation.providerDecisionId === input.providerDecisionId &&
    reservation.productionRunId === input.productionRunId
  );
}

function sameReconciliationReplay(
  reconciliation: ProviderBudgetReconciliationV1,
  input: ReconcileProviderBudgetInput,
): boolean {
  return (
    reconciliation.reservationId === input.reservationId &&
    reconciliation.kind === input.kind &&
    sameMoney(reconciliation.actualCost, input.actualCost) &&
    reconciliation.providerUsageId === input.providerUsageId
  );
}

function sameMoney(left: Money, right: Money): boolean {
  return left.amount === right.amount && left.currency === right.currency;
}

function subtractMoney(left: Money, right: Money): Money {
  if (left.currency !== right.currency) {
    throw new Error(
      `Cannot subtract money with different currencies: ${left.currency} vs ${right.currency}`,
    );
  }
  return {
    amount: (parseFloat(left.amount) - parseFloat(right.amount)).toFixed(2),
    currency: left.currency,
  };
}
