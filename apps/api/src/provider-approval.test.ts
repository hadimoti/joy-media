import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import {
  computeProviderApprovalPreflight,
  createMockProvider,
  type CapabilityRequest,
  type ProviderApprovalGrant,
} from '@joy-media/provider-sdk';
import {
  MemoryProviderApprovalStore,
  PostgresProviderApprovalStore,
  ProviderApprovalService,
} from './provider-approval.js';

describe('ProviderApprovalService', () => {
  it('denies no-egress policy before approval can allow remote processing', async () => {
    const { service, request, preflight } = fixture();
    const grant = grantFor(service, preflight);

    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'local-only',
        grant,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_PROCESSING_BLOCKED' });

    await expect(service.auditRows('actor-1')).resolves.toEqual([
      expect.objectContaining({
        status: 'denied',
        reason: 'remote-processing-blocked',
        requestDigest: preflight.requestDigest,
      }),
    ]);
  });

  it('requires a grant and records a denied audit row without raw prompt text', async () => {
    const { service, request, preflight } = fixture();

    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'ask-before-remote',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REQUIRED' });

    const rows = await service.auditRows('actor-1');
    expect(rows).toEqual([
      expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('private prompt');
  });

  it('rejects cross-prompt and cross-provider approval replay', async () => {
    const { service, request, preflight } = fixture();
    const grant = grantFor(service, preflight);
    const otherPrompt = fixture({ prompt: 'changed prompt' }).preflight;
    const otherProvider = fixture({ providerId: 'other-provider' }).preflight;

    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight: otherPrompt,
        privacyMode: 'ask-before-remote',
        grant,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });

    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight: otherProvider,
        privacyMode: 'ask-before-remote',
        grant,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
  });

  it('rejects self-made grants that were not signed by the approval service', async () => {
    const { service, request, preflight } = fixture();
    const forged: ProviderApprovalGrant = {
      grantVersion: 1,
      grantId: 'grant-forged',
      grantSignature: 'forged-signature',
      actorId: 'actor-1',
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      status: 'approved',
      costCap: { amount: '0.10', currency: 'USD' },
    };

    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'ask-before-remote',
        grant: forged,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });

    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
      expect.objectContaining({ status: 'denied', reason: 'approval-forgery-rejected' }),
    );
  });

  it('rejects expired grants and grants over their spend cap', async () => {
    const { service, request, preflight } = fixture();
    const expired = grantFor(service, preflight, { expiresAt: '2026-01-01T00:00:00.000Z' });
    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'ask-before-remote',
        grant: expired,
        now: new Date('2026-08-21T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_EXPIRED' });

    const overCap = {
      ...preflight,
      estimatedCost: { amount: '0.20', currency: 'USD' },
    };
    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: 'over-cap',
        preflight: overCap,
        privacyMode: 'ask-before-remote',
        grant: grantFor(service, overCap, { costCap: { amount: '0.10', currency: 'USD' } }),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CAP_EXCEEDED' });
  });

  it('reserves spend idempotently and records succeeded outcomes', async () => {
    const { service, request, preflight } = fixture();
    const grant = grantFor(service, preflight);
    const input = {
      actorId: 'actor-1',
      idempotencyKey: request.idempotencyKey,
      preflight,
      privacyMode: 'ask-before-remote' as const,
      grant,
    };

    const first = await service.verify(input);
    const retry = await service.verify(input);

    expect(retry.reservation).toEqual(first.reservation);
    await service.recordSucceeded(input, first.reservation);
    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
      expect.objectContaining({
        status: 'succeeded',
        approvalGrantId: grant.grantId,
        budgetReservationId: first.reservation?.reservationId,
      }),
    );
  });

  it('scopes budget idempotency by actor and request digest', async () => {
    const service = new ProviderApprovalService();
    const first = fixture({ service });
    const secondRequest: CapabilityRequest = {
      ...first.request,
      input: { prompt: 'private prompt for another actor' },
    };
    const provider = createMockProvider('remote-provider', ['llm.complete'], {
      execution: 'remote-api',
      privacy: { dataLeavesDevice: true },
    });
    const secondPreflight = computeProviderApprovalPreflight('actor-2', secondRequest, provider);

    const firstOutcome = await service.verify({
      actorId: 'actor-1',
      idempotencyKey: 'shared-idem',
      preflight: first.preflight,
      privacyMode: 'ask-before-remote',
      grant: grantFor(service, first.preflight),
    });
    const secondOutcome = await service.verify({
      actorId: 'actor-2',
      idempotencyKey: 'shared-idem',
      preflight: secondPreflight,
      privacyMode: 'ask-before-remote',
      grant: grantFor(service, secondPreflight, { actorId: 'actor-2' }),
    });

    expect(firstOutcome.reservation?.reservationId).toBeDefined();
    expect(secondOutcome.reservation?.reservationId).toBeDefined();
    expect(secondOutcome.reservation?.reservationId).not.toBe(
      firstOutcome.reservation?.reservationId,
    );
  });

  it('records unavailable and failed outcomes without secrets', async () => {
    const store = new MemoryProviderApprovalStore();
    const service = new ProviderApprovalService(store);
    const { request, preflight } = fixture({ service });
    const grant = grantFor(service, preflight);
    const input = {
      actorId: 'actor-1',
      idempotencyKey: request.idempotencyKey,
      preflight,
      privacyMode: 'ask-before-remote' as const,
      grant,
    };
    const outcome = await service.verify(input);

    await service.recordFailed(input, outcome.reservation, 'provider-failed-secret-token');
    await service.recordUnavailable(input, 'provider-unavailable');

    const serialized = JSON.stringify(await service.auditRows());
    expect(serialized).toContain('provider-unavailable');
    expect(serialized).toContain('provider-failed-secret-redacted');
    expect(serialized).not.toContain('provider-failed-secret-token');
    expect(serialized).not.toContain('private prompt');
  });

  it('persists grants, budgets, reconciliation, and owner-filtered audit across instances', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const config = { keyId: 'approval-key-test', secret: 'test-only-secret' };
    const first = new ProviderApprovalService(store, undefined, config);
    const { request, preflight } = fixture({ service: first });
    const grant = grantFor(first, preflight);
    await first.persistGrant(grant);
    const input = {
      actorId: 'actor-1',
      idempotencyKey: request.idempotencyKey,
      preflight,
      privacyMode: 'ask-before-remote' as const,
      grant,
    };
    const outcome = await first.verify(input);
    await first.recordSucceeded(input, outcome.reservation);

    const second = new ProviderApprovalService(
      new PostgresProviderApprovalStore(pool),
      undefined,
      config,
    );
    await expect(second.verify(input)).resolves.toMatchObject({
      grant: { grantId: grant.grantId },
      reservation: { reservationId: outcome.reservation?.reservationId, status: 'settled' },
    });
    await expect(second.auditRows('actor-1')).resolves.toContainEqual(
      expect.objectContaining({
        status: 'succeeded',
        budgetReservationId: outcome.reservation?.reservationId,
      }),
    );
    await expect(second.auditRows('actor-2')).resolves.toEqual([]);
  });

  it('rejects a durable grant when the approval key configuration changes', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const first = new ProviderApprovalService(store, undefined, {
      keyId: 'approval-key-one',
      secret: 'test-only-secret-one',
    });
    const { request, preflight } = fixture({ service: first });
    const grant = grantFor(first, preflight);
    await first.persistGrant(grant);
    const second = new ProviderApprovalService(new PostgresProviderApprovalStore(pool), undefined, {
      keyId: 'approval-key-two',
      secret: 'test-only-secret-two',
    });
    await expect(
      second.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'ask-before-remote',
        grant,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
  });

  it('fails closed when server approval signing configuration is missing', async () => {
    const service = new ProviderApprovalService(new MemoryProviderApprovalStore(), undefined, null);
    const { request, preflight } = fixture({ service });
    await expect(
      service.verify({
        actorId: 'actor-1',
        idempotencyKey: request.idempotencyKey,
        preflight,
        privacyMode: 'ask-before-remote',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_UNAVAILABLE' });
    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
      expect.objectContaining({ status: 'unavailable', reason: 'approval-signing-config-missing' }),
    );
    expect(() =>
      service.createGrant({
        actorId: 'actor-1',
        providerId: preflight.providerId,
        capability: preflight.capability,
        requestDigest: preflight.requestDigest,
        expiresAt: '2026-12-31T00:00:00.000Z',
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROVIDER_APPROVAL_UNAVAILABLE' }));
  });

  it('keeps durable reservation and reconciliation replay semantics', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const reservationInput = {
      reservationId: 'reserve-durable-1',
      idempotencyKey: 'durable-reservation-1',
      providerId: 'remote-provider',
      capability: 'llm.complete' as const,
      estimatedCost: { amount: '0.10', currency: 'USD' },
      cap: { amount: '0.20', currency: 'USD' },
    };
    const first = await store.reserveBudget(reservationInput);
    expect(first).toMatchObject({ ok: true, replay: false });
    await expect(store.reserveBudget(reservationInput)).resolves.toMatchObject({
      ok: true,
      replay: true,
    });
    await expect(
      store.reserveBudget({ ...reservationInput, cap: { amount: '0.30', currency: 'USD' } }),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency-conflict' });
    const reconciliationInput = {
      reservationId: reservationInput.reservationId,
      idempotencyKey: 'durable-reconciliation-1',
      kind: 'final' as const,
      actualCost: { amount: '0.08', currency: 'USD' },
      providerUsageId: 'usage-1',
    };
    await expect(store.reconcileBudget(reconciliationInput)).resolves.toMatchObject({
      ok: true,
      replay: false,
      reservation: { status: 'settled' },
    });
    await expect(store.reconcileBudget(reconciliationInput)).resolves.toMatchObject({
      ok: true,
      replay: true,
    });
    await expect(
      store.reconcileBudget({
        ...reconciliationInput,
        actualCost: { amount: '0.07', currency: 'USD' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'idempotency-conflict' });
  });

  it('redacts failure usage markers and preserves known post-provider spend', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const service = new ProviderApprovalService(store, undefined, {
      keyId: 'approval-key-test',
      secret: 'test-only-secret',
    });
    const { request, preflight: originalPreflight } = fixture({ service });
    const preflight = {
      ...originalPreflight,
      estimatedCost: { amount: '0.10', currency: 'USD' },
    };
    const grant = grantFor(service, preflight);
    await service.persistGrant(grant);
    const input = {
      actorId: 'actor-1',
      idempotencyKey: request.idempotencyKey,
      preflight,
      privacyMode: 'ask-before-remote' as const,
      grant,
    };
    const outcome = await service.verify(input);
    await service.recordFailed(input, outcome.reservation, 'provider-secret-token', {
      actualCost: { amount: '0.06', currency: 'USD' },
      providerUsageId: 'provider-secret-token',
    });
    const result = await pool.query<{ reconciliation_data: unknown }>(
      'SELECT reconciliation_data FROM provider_approval_reconciliations',
    );
    expect(result.rows).toHaveLength(1);
    const serialized = JSON.stringify(result.rows[0]?.reconciliation_data);
    expect(serialized).not.toContain('provider-secret-token');
    expect(result.rows[0]?.reconciliation_data).toMatchObject({
      kind: 'final',
      actualCost: { amount: '0.06', currency: 'USD' },
    });
    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
      expect.objectContaining({ reason: 'provider-secret-redacted' }),
    );
  });

  it('records an over-cap success as a durable failed settlement', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const service = new ProviderApprovalService(store, undefined, {
      keyId: 'approval-key-test',
      secret: 'test-only-secret',
    });
    const { request, preflight } = fixture({ service });
    const grant = grantFor(service, preflight, { costCap: { amount: '0.10', currency: 'USD' } });
    await service.persistGrant(grant);
    const input = {
      actorId: 'actor-1',
      idempotencyKey: request.idempotencyKey,
      preflight,
      privacyMode: 'ask-before-remote' as const,
      grant,
    };
    const outcome = await service.verify(input);

    await expect(
      service.recordSucceeded(input, outcome.reservation, {
        amount: '0.11',
        currency: 'USD',
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_SPEND_CAP_EXCEEDED',
      message: 'Provider usage exceeded the approved spend cap.',
    });

    const reconciliations = await pool.query<{ kind: string; reconciliation_data: unknown }>(
      'SELECT kind, reconciliation_data FROM provider_approval_reconciliations',
    );
    expect(reconciliations.rows).toHaveLength(1);
    expect(reconciliations.rows[0]).toMatchObject({ kind: 'overage' });
    expect(reconciliations.rows[0]?.reconciliation_data).toMatchObject({
      kind: 'overage',
      actualCost: { amount: '0.11', currency: 'USD' },
    });
    await expect(service.auditRows('actor-1')).resolves.toEqual([
      expect.objectContaining({ status: 'failed', reason: 'provider-cost-over-cap' }),
    ]);
    const finalRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM provider_approval_reconciliations WHERE kind = 'final'",
    );
    expect(finalRows.rows[0]?.count).toBe('0');
  });

  it('serializes concurrent final reconciliation transitions per reservation', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const store = new PostgresProviderApprovalStore(pool);
    await store.initialize();
    const reservation = await store.reserveBudget({
      reservationId: 'reserve-concurrent-1',
      idempotencyKey: 'concurrent-reservation-1',
      providerId: 'remote-provider',
      capability: 'llm.complete',
      estimatedCost: { amount: '0.10', currency: 'USD' },
      cap: { amount: '0.10', currency: 'USD' },
    });
    expect(reservation.ok).toBe(true);
    const inputs = [
      {
        reservationId: 'reserve-concurrent-1',
        idempotencyKey: 'concurrent-final-1',
        kind: 'final' as const,
        actualCost: { amount: '0.04', currency: 'USD' },
        providerUsageId: 'usage-a',
      },
      {
        reservationId: 'reserve-concurrent-1',
        idempotencyKey: 'concurrent-final-2',
        kind: 'final' as const,
        actualCost: { amount: '0.04', currency: 'USD' },
        providerUsageId: 'usage-b',
      },
    ];
    const results = await Promise.all(inputs.map((input) => store.reconcileBudget(input)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ reason: 'already-settled' });
    const finalRows = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM provider_approval_reconciliations WHERE kind = 'final'",
    );
    expect(finalRows.rows[0]?.count).toBe('1');
  });
});

function fixture(
  options: {
    readonly service?: ProviderApprovalService;
    readonly providerId?: string;
    readonly prompt?: string;
  } = {},
) {
  const service = options.service ?? new ProviderApprovalService();
  const provider = createMockProvider(options.providerId ?? 'remote-provider', ['llm.complete'], {
    execution: 'remote-api',
    privacy: { dataLeavesDevice: true },
  });
  const request: CapabilityRequest = {
    requestVersion: 1,
    capability: 'llm.complete',
    input: { prompt: options.prompt ?? 'private prompt' },
    constraints: { executionPreference: ['remote'] },
    idempotencyKey: 'idem-1',
  };
  return {
    service,
    request,
    preflight: computeProviderApprovalPreflight('actor-1', request, provider),
  };
}

function grantFor(
  service: ProviderApprovalService,
  preflight: ReturnType<typeof computeProviderApprovalPreflight>,
  overrides: Partial<ProviderApprovalGrant> = {},
): ProviderApprovalGrant {
  return service.createGrant({
    actorId: overrides.actorId ?? 'actor-1',
    providerId: overrides.providerId ?? preflight.providerId,
    capability: overrides.capability ?? preflight.capability,
    requestDigest: overrides.requestDigest ?? preflight.requestDigest,
    expiresAt: overrides.expiresAt ?? '2026-12-31T00:00:00.000Z',
    costCap: overrides.costCap ?? { amount: '0.10', currency: 'USD' },
    grantId: overrides.grantId,
    status: overrides.status,
  });
}
