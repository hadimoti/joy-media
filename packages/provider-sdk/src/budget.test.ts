import { describe, expect, it } from 'vitest';
import {
  createProviderBudgetLedger,
  reconcileProviderBudget,
  reserveProviderBudget,
} from './budget.js';

describe('provider budget ledger', () => {
  it('caps reservations and rejects currency mismatches', () => {
    const ledger = createProviderBudgetLedger();

    const capped = reserveProviderBudget(ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'reserve-1',
      providerId: 'remote',
      capability: 'speech.transcribe',
      estimatedCost: { amount: '1.25', currency: 'USD' },
      cap: { amount: '1.00', currency: 'USD' },
    });

    expect(capped.ok).toBe(false);
    if (capped.ok) expect.unreachable('reservation should be capped');
    expect(capped.reason).toBe('cap-exceeded');

    const mismatch = reserveProviderBudget(ledger, {
      reservationId: 'reservation-2',
      idempotencyKey: 'reserve-2',
      providerId: 'remote',
      capability: 'speech.transcribe',
      estimatedCost: { amount: '1.00', currency: 'EUR' },
      cap: { amount: '1.00', currency: 'USD' },
    });

    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) expect.unreachable('reservation should reject currency mismatch');
    expect(mismatch.reason).toBe('currency-mismatch');
  });

  it('records partial and final reconciliation without exceeding the reservation', () => {
    const reserved = reserveProviderBudget(createProviderBudgetLedger(), {
      reservationId: 'reservation-1',
      idempotencyKey: 'reserve-1',
      providerId: 'remote',
      capability: 'speech.transcribe',
      estimatedCost: { amount: '1.00', currency: 'USD' },
      cap: { amount: '2.00', currency: 'USD' },
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) expect.unreachable('reservation should succeed');

    const partial = reconcileProviderBudget(reserved.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-1',
      kind: 'partial',
      actualCost: { amount: '0.25', currency: 'USD' },
      providerUsageId: 'usage-partial',
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) expect.unreachable('partial reconciliation should succeed');
    expect(partial.reservation.status).toBe('reserved');
    expect(partial.reservation.spent.amount).toBe('0.25');

    const final = reconcileProviderBudget(partial.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-2',
      kind: 'final',
      actualCost: { amount: '0.50', currency: 'USD' },
      providerUsageId: 'usage-final',
    });
    expect(final.ok).toBe(true);
    if (!final.ok) expect.unreachable('final reconciliation should succeed');
    expect(final.reservation.status).toBe('settled');
    expect(final.reservation.spent.amount).toBe('0.75');
    expect(final.reservation.released.amount).toBe('0.25');

    const mismatch = reconcileProviderBudget(partial.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-eur',
      kind: 'partial',
      actualCost: { amount: '0.10', currency: 'EUR' },
      providerUsageId: 'usage-eur',
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) expect.unreachable('reconciliation should reject currency mismatch');
    expect(mismatch.reason).toBe('currency-mismatch');

    const overrun = reconcileProviderBudget(final.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-3',
      kind: 'final',
      actualCost: { amount: '0.50', currency: 'USD' },
      providerUsageId: 'usage-overrun',
    });
    expect(overrun.ok).toBe(false);
    if (overrun.ok) expect.unreachable('settled reservation should reject replay with new key');
    expect(overrun.reason).toBe('already-settled');
  });

  it('is idempotent for reservation and reconciliation replay', () => {
    const first = reserveProviderBudget(createProviderBudgetLedger(), {
      reservationId: 'reservation-1',
      idempotencyKey: 'reserve-1',
      providerId: 'remote',
      capability: 'speech.transcribe',
      estimatedCost: { amount: '1.00', currency: 'USD' },
      cap: { amount: '2.00', currency: 'USD' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) expect.unreachable('reservation should succeed');

    const reservationReplay = reserveProviderBudget(first.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'reserve-1',
      providerId: 'remote',
      capability: 'speech.transcribe',
      estimatedCost: { amount: '1.00', currency: 'USD' },
      cap: { amount: '2.00', currency: 'USD' },
    });
    expect(reservationReplay.ok).toBe(true);
    if (!reservationReplay.ok) expect.unreachable('reservation replay should succeed');
    expect(reservationReplay.replay).toBe(true);
    expect(reservationReplay.ledger).toBe(first.ledger);

    const usage = reconcileProviderBudget(first.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-1',
      kind: 'partial',
      actualCost: { amount: '0.20', currency: 'USD' },
      providerUsageId: 'usage-1',
    });
    expect(usage.ok).toBe(true);
    if (!usage.ok) expect.unreachable('usage reconciliation should succeed');

    const usageReplay = reconcileProviderBudget(usage.ledger, {
      reservationId: 'reservation-1',
      idempotencyKey: 'usage-1',
      kind: 'partial',
      actualCost: { amount: '0.20', currency: 'USD' },
      providerUsageId: 'usage-1',
    });
    expect(usageReplay.ok).toBe(true);
    if (!usageReplay.ok) expect.unreachable('usage replay should succeed');
    expect(usageReplay.replay).toBe(true);
    expect(usageReplay.ledger).toBe(usage.ledger);
  });
});
