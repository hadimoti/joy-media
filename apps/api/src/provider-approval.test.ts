import { describe, expect, it } from 'vitest';
import {
  computeProviderApprovalPreflight,
  createMockProvider,
  type CapabilityRequest,
  type ProviderApprovalGrant,
} from '@joy-media/provider-sdk';
import { MemoryProviderApprovalStore, ProviderApprovalService } from './provider-approval.js';

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
