import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ControlPlaneError,
  LocalControlPlane,
  type Actor,
  type AssetLocationRecord,
  type ControlPlane,
  type MediaAssetRecord,
} from './control-plane.js';
import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import type { HermesTagInput, HermesTagResult } from './asset-hermes-tags.js';
import {
  MemoryMistralInvocationLedger,
  MistralProviderRegistry,
  PostgresMistralInvocationLedger,
} from './mistral-provider.js';
import { PostgresProviderApprovalStore, ProviderApprovalService } from './provider-approval.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
import type { WorkerResultReceiptV1, WorkerJobType } from '@joy-media/job-protocol';
import { PostgresControlPlane } from './postgres-control-plane.js';
import type { ProductionRunAuthority, ProductionRunRecordV1 } from './production-runs.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe('control-plane HTTP transport', () => {
  it('exposes owner-scoped v2 document revisions with typed conflicts', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'v2-project', title: 'Project' }),
    ).toMatchObject({
      status: 201,
    });
    const body = {
      baseRevision: 0,
      idempotencyKey: 'http-write-1',
      document: { schemaVersion: 2, projectId: 'v2-project', title: 'A' },
    };
    expect(await request(origin, 'POST', '/v2/projects/v2-project/revisions', body)).toMatchObject({
      status: 201,
      body: { data: { revision: 1 } },
    });
    expect(
      await request(origin, 'POST', '/v2/projects/v2-project/revisions', {
        ...body,
        idempotencyKey: 'http-write-2',
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'REVISION_CONFLICT', details: { currentRevision: 1 } } },
    });
    expect(await request(origin, 'GET', '/v2/projects/v2-project/document')).toMatchObject({
      status: 200,
      body: { data: { revision: 1, document: { title: 'A' } } },
    });
  });

  it('keeps health public while rejecting versioned routes without an authenticated actor', async () => {
    const origin = await start({ authenticate: () => undefined });

    expect(await request(origin, 'GET', '/health')).toMatchObject({
      status: 200,
      body: { ok: true, controlPlane: true },
    });
    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
    expect(
      await request(origin, 'POST', '/v1/providers/speech/transcribe', {
        language: 'en',
        referenceAssetId: 'asset-intro',
      }),
    ).toMatchObject({
      status: 401,
      body: { error: { code: 'AUTH_REQUIRED' } },
    });
  });

  it('exposes separate liveness/readiness endpoints and strict API security headers', async () => {
    const origin = await start({ authenticate: () => undefined });
    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-request-id')).toMatch(/^[a-f0-9]{16}$/);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await (await fetch(`${origin}/live`)).json()).toMatchObject({ liveness: true });
    expect(await (await fetch(`${origin}/ready`)).json()).toMatchObject({ readiness: true });
  });

  it('rejects oversized JSON and applies a bounded per-process request limit', async () => {
    const limitedOrigin = await start(
      { authenticate: () => undefined },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { windowMs: 60_000, maxRequests: 1 },
    );
    const first = await fetch(`${limitedOrigin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'limited', title: 'Limited' }),
    });
    expect(first.status).toBe(401);
    const second = await fetch(`${limitedOrigin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'limited-2', title: 'Limited' }),
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    const v2Limited = await fetch(`${limitedOrigin}/v2/projects/limited/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(v2Limited.status).toBe(429);

    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    const response = await fetch(`${origin}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'too-large', title: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'REQUEST_INVALID', message: 'request body exceeds the size limit' },
    });
  });

  it('keeps Mistral unconfigured without the dedicated runtime secret', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    expect(await request(origin, 'GET', '/v1/providers/reasoning')).toMatchObject({
      status: 200,
      body: { data: { providers: [{ providerId: 'mistral', state: 'unconfigured', models: [] }] } },
    });
    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        model: 'mistral-small-latest',
        messages: [{ role: 'user', content: 'Plan only.' }],
        idempotencyKey: 'unconfigured-1',
        privacyMode: 'ask-before-remote',
        approvedRemoteProcessing: true,
        approvedSpend: true,
      }),
    ).toMatchObject({ status: 503, body: { error: { code: 'PROVIDER_UNCONFIGURED' } } });
  });

  it('requires remote/spend approval and records an idempotent Mistral completion without secrets or prompts', async () => {
    let calls = 0;
    const approvals = new ProviderApprovalService();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      approvals,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Guarded result.' } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
        );
      },
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );
    const base = {
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Do not persist this prompt.' }],
      idempotencyKey: 'mistral-1',
      privacyMode: 'ask-before-remote',
      approvedRemoteProcessing: true,
      approvedSpend: true,
    };
    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    expect(approvalRequired).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_APPROVAL_REQUIRED', preflight: { providerId: 'mistral' } } },
    });
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            actorId?: string;
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const providerApprovalGrant = approvals.createGrant({
      actorId: 'owner',
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      costCap: { amount: '0.00', currency: 'USD' },
      grantId: 'grant-mistral-1',
    });
    const approved = { ...base, providerApprovalGrant };
    const first = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
    expect(first).toMatchObject({
      status: 200,
      body: {
        data: {
          status: 'succeeded',
          provenance: {
            providerId: 'mistral',
            modelId: 'mistral-small-latest',
            idempotencyKey: 'mistral-1',
          },
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      },
    });
    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    expect(retried).toEqual(first);
    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        ...base,
        messages: [{ role: 'user', content: 'Different prompt.' }],
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' } },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(first.body)).not.toContain('test-only-mistral-secret');
    expect(JSON.stringify(first.body)).not.toContain('Do not persist this prompt.');
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: {
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
          expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-mistral-1' }),
        ]),
      },
    });
    expect(JSON.stringify(audit.body)).not.toContain('Do not persist this prompt.');
  });

  it('fails a valid provider result when reported cost exceeds the approved cap', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const approvalStore = new PostgresProviderApprovalStore(pool);
    await approvalStore.initialize();
    const approvalService = new ProviderApprovalService(approvalStore, undefined, {
      keyId: 'approval-key-test',
      secret: 'test-only-secret',
    });
    const invocationLedger = new PostgresMistralInvocationLedger(pool);
    await invocationLedger.initialize();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      invocationLedger,
      approvalService,
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Valid provider output.' } }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              cost: { amount: '0.11', currency: 'USD' },
            },
          }),
        ),
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvalService,
    );
    const base = {
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Cap test.' }],
      idempotencyKey: 'mistral-over-cap-1',
      privacyMode: 'ask-before-remote',
      approvedRemoteProcessing: true,
      approvedSpend: true,
    };
    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const grant = approvalService.createGrant({
      actorId: 'owner',
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      costCap: { amount: '0.05', currency: 'USD' },
      grantId: 'grant-mistral-over-cap-1',
    });
    const failed = await request(origin, 'POST', '/v1/providers/mistral/complete', {
      ...base,
      providerApprovalGrant: grant,
    });
    expect(failed).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'PROVIDER_SPEND_CAP_EXCEEDED',
          message: 'Provider usage exceeded the approved spend cap.',
        },
      },
    });
    expect(JSON.stringify(failed.body)).not.toContain('Valid provider output.');

    const reconciliation = await pool.query<{ kind: string; reconciliation_data: unknown }>(
      'SELECT kind, reconciliation_data FROM provider_approval_reconciliations',
    );
    expect(reconciliation.rows).toHaveLength(1);
    expect(reconciliation.rows[0]).toMatchObject({ kind: 'overage' });
    expect(reconciliation.rows[0]?.reconciliation_data).toMatchObject({
      actualCost: { amount: '0.11', currency: 'USD' },
    });
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: {
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'failed', reason: 'provider-cost-over-cap' }),
        ]),
      },
    });
  });

  it('keeps bounded Joy Code reasoning unconfigured until Mistral is configured', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });

    expect(
      await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
        model: 'mistral-small-latest',
        goal: 'Tighten the opening pacing',
        snapshotDigest: `fnv1a-${'a'.repeat(8)}`,
        projectRevision: 'rev-1',
        idempotencyKey: 'joy-code-unconfigured-1',
        privacyMode: 'ask-before-remote',
        evidence: [
          {
            evidenceId: 'clip:intro',
            kind: 'selected-clip',
            label: 'Intro clip',
            detail: 'Opening narration from 0s to 10s.',
          },
        ],
        allowedIntentIds: ['shorten-intro'],
      }),
    ).toMatchObject({ status: 503, body: { error: { code: 'PROVIDER_UNCONFIGURED' } } });
  });

  it('requires approval, validates evidence refs, and replays bounded Joy Code reasoning without persisting prompts', async () => {
    let calls = 0;
    const approvals = new ProviderApprovalService();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      approvals,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brief: {
                      summary: 'The intro can be tightened without changing the story arc.',
                      rationale:
                        'The opening evidence repeats setup beats before the product lands.',
                      evidenceReferences: ['clip:intro'],
                    },
                    proposal: {
                      intentId: 'shorten-intro',
                      summary: 'Shorten the intro by 2 seconds.',
                      rationale: 'The intro evidence supports a bounded pacing trim.',
                      evidenceReferences: ['clip:intro'],
                    },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 13 },
          }),
        );
      },
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );

    const base = {
      model: 'mistral-small-latest',
      goal: 'Tighten the opening pacing without changing the message.',
      snapshotDigest: `fnv1a-${'b'.repeat(8)}`,
      projectRevision: 'rev-1',
      idempotencyKey: 'joy-code-1',
      privacyMode: 'ask-before-remote',
      evidence: [
        {
          evidenceId: 'clip:intro',
          kind: 'selected-clip',
          label: 'Intro clip',
          detail: 'Opening narration from 0s to 10s.',
        },
      ],
      allowedIntentIds: ['shorten-intro'],
    };

    const approvalRequired = await request(
      origin,
      'POST',
      '/v1/providers/reasoning/joy-code',
      base,
    );
    expect(approvalRequired).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'PROVIDER_APPROVAL_REQUIRED',
          preflight: { providerId: 'mistral', capability: 'llm.complete' },
        },
      },
    });
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const providerApprovalGrant = (
      await request(origin, 'POST', '/v1/providers/approvals/grants', {
        providerId: preflight.providerId,
        capability: preflight.capability,
        requestDigest: preflight.requestDigest,
        expiresAt: '2026-12-31T00:00:00.000Z',
        costCap: { amount: '0.00', currency: 'USD' },
      })
    ).body as { data: { grantId: string } };

    const approved = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
      ...base,
      providerApprovalGrant: providerApprovalGrant.data,
    });
    expect(approved).toMatchObject({
      status: 200,
      body: {
        data: {
          brief: {
            summary: 'The intro can be tightened without changing the story arc.',
            evidenceReferences: ['clip:intro'],
          },
          proposal: { intentId: 'shorten-intro', evidenceReferences: ['clip:intro'] },
          provider: {
            providerId: 'mistral',
            modelId: 'mistral-small-latest',
            decisionRef: 'provider-decision-joy-code-1',
            briefRef: 'reasoning-brief-joy-code-1',
            usage: { inputTokens: 11, outputTokens: 13 },
          },
        },
      },
    });

    const replay = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', base);
    expect(replay).toEqual(approved);
    expect(calls).toBe(1);
    expect(JSON.stringify(approved.body)).not.toContain('test-only-mistral-secret');
    expect(JSON.stringify(approved.body)).not.toContain(base.goal);

    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: {
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
          expect.objectContaining({
            status: 'succeeded',
            approvalGrantId: providerApprovalGrant.data.grantId,
          }),
        ]),
      },
    });
    expect(JSON.stringify(audit.body)).not.toContain(base.goal);
  });

  it('replays bounded Joy Code reasoning from the shared invocation ledger across registry restarts', async () => {
    const ledger = new MemoryMistralInvocationLedger();
    const firstApprovals = new ProviderApprovalService();
    let calls = 0;
    const firstRegistry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      ledger,
      firstApprovals,
      async () => {
        calls++;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brief: {
                      summary: 'Shared ledger replay works.',
                      rationale: 'The stored completion can be replayed after restart.',
                      evidenceReferences: ['clip:intro'],
                    },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 6 },
          }),
        );
      },
    );
    const firstOrigin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      firstRegistry,
      undefined,
      firstApprovals,
    );
    const base = {
      model: 'mistral-small-latest',
      goal: 'Review the intro for pacing.',
      snapshotDigest: `fnv1a-${'d'.repeat(8)}`,
      projectRevision: 'rev-replay',
      idempotencyKey: 'joy-code-replay-shared-1',
      privacyMode: 'ask-before-remote',
      evidence: [
        {
          evidenceId: 'clip:intro',
          kind: 'selected-clip',
          label: 'Intro clip',
          detail: 'Opening narration from 0s to 10s.',
        },
      ],
      allowedIntentIds: ['shorten-intro'],
    };
    const firstApproval = await request(
      firstOrigin,
      'POST',
      '/v1/providers/reasoning/joy-code',
      base,
    );
    const firstPreflight = (
      firstApproval.body as {
        error: {
          preflight: {
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const firstGrant = await request(firstOrigin, 'POST', '/v1/providers/approvals/grants', {
      providerId: firstPreflight.providerId,
      capability: firstPreflight.capability,
      requestDigest: firstPreflight.requestDigest,
      costCap: { amount: '0.00', currency: 'USD' },
    });
    const firstResult = await request(firstOrigin, 'POST', '/v1/providers/reasoning/joy-code', {
      ...base,
      providerApprovalGrant: (firstGrant.body as { data: unknown }).data,
    });

    const secondApprovals = new ProviderApprovalService();
    const secondRegistry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      ledger,
      secondApprovals,
      async () => {
        calls++;
        throw new Error('network must not be reached after replay');
      },
    );
    const secondOrigin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      secondRegistry,
      undefined,
      secondApprovals,
    );

    expect(await request(secondOrigin, 'POST', '/v1/providers/reasoning/joy-code', base)).toEqual(
      firstResult,
    );
    expect(calls).toBe(1);
  });

  it('fails closed when Joy Code reasoning returns malformed structured output or unknown evidence refs', async () => {
    const approvals = new ProviderApprovalService();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      approvals,
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brief: {
                      summary: 'Bad refs.',
                      rationale: 'This cites an unknown item.',
                      evidenceReferences: ['missing-evidence'],
                    },
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 5 },
          }),
        ),
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );

    const base = {
      model: 'mistral-small-latest',
      goal: 'Review the intro only.',
      snapshotDigest: `fnv1a-${'c'.repeat(8)}`,
      projectRevision: 'rev-2',
      idempotencyKey: 'joy-code-malformed-1',
      privacyMode: 'ask-before-remote',
      evidence: [
        {
          evidenceId: 'clip:intro',
          kind: 'selected-clip',
          label: 'Intro clip',
          detail: 'Opening narration from 0s to 10s.',
        },
      ],
      allowedIntentIds: ['shorten-intro'],
    };
    const approvalRequired = await request(
      origin,
      'POST',
      '/v1/providers/reasoning/joy-code',
      base,
    );
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;
    const providerApprovalGrant = await request(origin, 'POST', '/v1/providers/approvals/grants', {
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      costCap: { amount: '0.00', currency: 'USD' },
    });

    expect(
      await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
        ...base,
        providerApprovalGrant: (providerApprovalGrant.body as { data: unknown }).data,
      }),
    ).toMatchObject({
      status: 502,
      body: { error: { code: 'MISTRAL_REQUEST_FAILED' } },
    });

    expect(await request(origin, 'GET', '/v1/providers/reasoning')).toMatchObject({
      status: 200,
      body: {
        data: {
          providers: [expect.objectContaining({ providerId: 'mistral', state: 'degraded' })],
        },
      },
    });
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: {
        data: expect.arrayContaining([
          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
          expect.objectContaining({ status: 'failed', reason: 'invalid-structured-output' }),
        ]),
      },
    });
  });

  it('durably reconciles known provider cost when Joy Code structured output is malformed', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const approvalStore = new PostgresProviderApprovalStore(pool);
    await approvalStore.initialize();
    const invocationLedger = new PostgresMistralInvocationLedger(pool);
    await invocationLedger.initialize();
    const approvals = new ProviderApprovalService(approvalStore, undefined, {
      keyId: 'approval-key-test',
      secret: 'test-only-secret',
    });
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      invocationLedger,
      approvals,
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    brief: {
                      summary: 'Malformed result.',
                      rationale: 'This references an unknown evidence item.',
                      evidenceReferences: ['secret-token-evidence'],
                    },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 4,
              completion_tokens: 5,
              cost: { amount: '0.06', currency: 'USD' },
              provider_usage_id: 'provider-secret-token',
            },
          }),
        ),
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );
    const base = {
      model: 'mistral-small-latest',
      goal: 'Review the intro only.',
      snapshotDigest: `fnv1a-${'e'.repeat(8)}`,
      projectRevision: 'rev-durable-malformed',
      idempotencyKey: 'joy-code-durable-malformed-1',
      privacyMode: 'ask-before-remote',
      evidence: [
        {
          evidenceId: 'clip:intro',
          kind: 'selected-clip',
          label: 'Intro clip',
          detail: 'Opening narration from 0s to 10s.',
        },
      ],
      allowedIntentIds: ['shorten-intro'],
    };
    const approvalRequired = await request(
      origin,
      'POST',
      '/v1/providers/reasoning/joy-code',
      base,
    );
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: { providerId: string; capability: 'llm.complete'; requestDigest: string };
        };
      }
    ).error.preflight;
    const grant = await request(origin, 'POST', '/v1/providers/approvals/grants', {
      providerId: preflight.providerId,
      capability: preflight.capability,
      requestDigest: preflight.requestDigest,
      expiresAt: '2026-12-31T00:00:00.000Z',
      costCap: { amount: '0.20', currency: 'USD' },
    });
    const failed = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
      ...base,
      providerApprovalGrant: (grant.body as { data: unknown }).data,
    });
    expect(failed).toMatchObject({
      status: 502,
      body: { error: { code: 'MISTRAL_REQUEST_FAILED' } },
    });
    expect(JSON.stringify(failed.body)).not.toContain('secret-token-evidence');
    expect(failed.body).toMatchObject({
      error: { message: 'Provider request failed.' },
    });

    const reconciliation = await pool.query<{ reconciliation_data: unknown }>(
      'SELECT reconciliation_data FROM provider_approval_reconciliations',
    );
    expect(reconciliation.rows).toHaveLength(1);
    const serialized = JSON.stringify(reconciliation.rows[0]?.reconciliation_data);
    expect(serialized).not.toContain('provider-secret-token');
    expect(serialized).toContain('0.06');
    expect(reconciliation.rows[0]?.reconciliation_data).toMatchObject({
      kind: 'final',
      actualCost: { amount: '0.06', currency: 'USD' },
    });
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(JSON.stringify(audit.body)).not.toContain('provider-secret-token');
    expect(JSON.stringify(audit.body)).toContain('invalid-structured-output');
  });

  it('rejects forged provider approval grants at the HTTP boundary', async () => {
    const approvals = new ProviderApprovalService();
    const registry = new MistralProviderRegistry(
      'test-only-mistral-secret',
      new MemoryMistralInvocationLedger(),
      approvals,
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'should not run' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        ),
    );
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      registry,
      undefined,
      approvals,
    );
    const base = {
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'Private forged grant prompt.' }],
      idempotencyKey: 'mistral-forged-1',
      privacyMode: 'ask-before-remote',
      approvedRemoteProcessing: true,
      approvedSpend: true,
    };
    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
    const preflight = (
      approvalRequired.body as {
        error: {
          preflight: {
            providerId: string;
            capability: 'llm.complete';
            requestDigest: string;
          };
        };
      }
    ).error.preflight;

    expect(
      await request(origin, 'POST', '/v1/providers/mistral/complete', {
        ...base,
        providerApprovalGrant: {
          grantVersion: 1,
          grantId: 'grant-forged-http',
          grantSignature: 'forged-signature',
          actorId: 'owner',
          providerId: preflight.providerId,
          capability: preflight.capability,
          requestDigest: preflight.requestDigest,
          expiresAt: '2026-12-31T00:00:00.000Z',
          status: 'approved',
          costCap: { amount: '0.00', currency: 'USD' },
        },
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' } },
    });
  });

  it('requires shared remote approval before Edge TTS can run', async () => {
    const approvals = new ProviderApprovalService();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      undefined,
      approvals,
    );

    const blocked = await request(origin, 'POST', '/v1/providers/speech/synthesize', {
      text: 'Do not send before approval.',
      language: 'en-US',
      engine: 'edge-tts',
      idempotencyKey: 'tts-edge-1',
      privacyMode: 'ask-before-remote',
    });

    expect(blocked).toMatchObject({
      status: 409,
      body: {
        error: {
          code: 'PROVIDER_APPROVAL_REQUIRED',
          preflight: { providerId: 'edge-tts', capability: 'speech.synthesize' },
        },
      },
    });
    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
    expect(audit).toMatchObject({
      status: 200,
      body: { data: [expect.objectContaining({ status: 'denied', reason: 'approval-required' })] },
    });
    expect(JSON.stringify(audit.body)).not.toContain('Do not send before approval.');
  });

  it('preserves project, Worker lease, completion, and cursor event semantics over v1', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });

    expect(
      await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'p', revision: 0 } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true }),
    ).toMatchObject({
      status: 200,
      body: { data: { assetSyncEnabled: true } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p')).toMatchObject({
      status: 200,
      body: { data: { id: 'p', assetSyncEnabled: true } },
    });
    const asset = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 8_589_934_592,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1920, height: 1080 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
    };
    expect(await request(origin, 'POST', '/v1/projects/p/assets', asset)).toMatchObject({
      status: 201,
      body: { data: { id: 'asset-1', projectId: 'p', bytes: 8_589_934_592 } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/assets', {
        ...asset,
        id: 'asset-client-private',
        locations: [{ kind: 'private-object', ref: 'client-supplied-ref' }],
      }),
    ).toMatchObject({
      status: 409,
      body: { error: { code: 'ASSET_INVALID' } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/assets/asset-1/derivatives', {
        id: 'derivative-1',
        assetId: 'asset-1',
        kind: 'proxy',
        profile: 'h264-720p',
        sha256: 'b'.repeat(64),
        bytes: 1234,
        descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 1280, height: 720 },
        availability: 'available-local',
        locations: [{ kind: 'opfs-cache', ref: 'opfs-d1' }],
      }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'derivative-1', availability: 'available-local' } },
    });
    const metadata = await request(origin, 'GET', '/v1/projects/p/assets/asset-1/derivatives');
    expect(metadata).toMatchObject({ status: 200, body: { data: [{ id: 'derivative-1' }] } });
    expect(JSON.stringify(metadata.body)).not.toMatch(
      /path|pairing|session|access_token|https?:\/\//i,
    );
    expect(
      await request(origin, 'POST', '/v1/projects/p/assets', {
        ...asset,
        id: 'asset-unsafe',
        displayName: 'C:\\Users\\Hadi\\clip.mp4',
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'ASSET_INVALID' } } });
    expect(await request(origin, 'DELETE', '/v1/projects/p/assets/asset-1')).toMatchObject({
      status: 200,
      body: { data: { id: 'asset-1' } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/assets')).toMatchObject({
      status: 200,
      body: { data: [] },
    });
    expect(await request(origin, 'DELETE', '/v1/projects/p/assets/asset-1')).toMatchObject({
      status: 409,
      body: { error: { code: 'ASSET_NOT_FOUND' } },
    });
    expect(
      await request(origin, 'POST', '/v1/worker-pair/offers', {
        workerId: 'w',
        pairingCode: 'pairing-code',
      }),
    ).toMatchObject({ status: 201, body: { data: { workerId: 'w' } } });
    expect(
      await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' }),
    ).toMatchObject({ status: 200, body: { data: { id: 'w', paired: false, revoked: false } } });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    expect(claim).toMatchObject({ status: 201, body: { data: { workerId: 'w' } } });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/hello',
        { capabilities: ['asset.thumbnail'] },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: { data: { id: 'w', capabilities: ['asset.thumbnail'] } },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/jobs', { id: 'j', type: 'fixture.thumbnail' }),
    ).toMatchObject({
      status: 201,
      body: { data: { id: 'j', state: 'queued' } },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 200,
      body: { data: { id: 'j', state: 'leased', leaseOwner: 'w' } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/heartbeat',
        { progress: 50 },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: { data: { cancelRequested: false, job: { progress: 50 } } },
    });
    expect(await request(origin, 'POST', '/v1/projects/p/jobs/j/cancel', {})).toMatchObject({
      status: 200,
      body: { data: { cancelRequested: true } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/heartbeat',
        { progress: 60 },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { cancelRequested: true } } });
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/j/fail',
        { error: 'canceled' },
        workerToken,
      ),
    ).toMatchObject({ status: 200, body: { data: { state: 'canceled' } } });
    expect(await request(origin, 'POST', '/v1/projects/p/jobs/j/retry', {})).toMatchObject({
      status: 200,
      body: { data: { state: 'queued', progress: 0 } },
    });
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
    const completion = await request(
      origin,
      'POST',
      '/v1/workers/w/jobs/j/complete',
      {
        result: {
          kind: 'fixture.thumbnail',
          sha256: '78bf4c43aa7ab3a14c9f1e34f3333f9f612a08191affba3fb9c3e6de88378735',
          bytes: 14,
        },
      },
      workerToken,
    );
    expect(completion).toMatchObject({
      status: 200,
      body: {
        data: {
          id: 'j',
          state: 'completed',
          progress: 100,
          derivative: {
            jobId: 'j',
            kind: 'fixture.thumbnail',
            bytes: 14,
            workerRef: 'w',
            resultRef: 'derivative:j',
          },
        },
      },
    });
    const serializedCompletion = JSON.stringify(completion.body);
    expect(serializedCompletion).not.toMatch(/path|pairing|session|access_token|\\bbytesData\\b/i);
    expect(await request(origin, 'GET', '/v1/projects/p/jobs')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'j', state: 'completed' }] },
    });
    const events = await request(origin, 'GET', '/v1/projects/p/events?cursor=0');
    expect(events.status).toBe(200);
    expect(
      (events.body as { data: readonly { type: string }[] }).data.map((event) => event.type),
    ).toEqual(expect.arrayContaining(['queued', 'cancel-requested', 'retried', 'completed']));
    expect(await request(origin, 'POST', '/v1/workers/w/revoke', {})).toMatchObject({
      status: 200,
      body: { data: { id: 'w', revoked: true } },
    });
    expect(await request(origin, 'GET', '/v1/workers')).toMatchObject({
      status: 200,
      body: { data: [{ id: 'w', revoked: true }] },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 401,
      body: { error: { code: 'WORKER_SESSION_REQUIRED' } },
    });
  });

  it('keeps project backup state owner-bound over HTTP', async () => {
    const origin = await start({
      authenticate: (incoming) => ({
        id: incoming.headers.authorization === 'Bearer owner-token' ? 'owner' : 'other-owner',
      }),
    });
    await request(
      origin,
      'POST',
      '/v1/projects',
      { id: 'private-project', title: 'Private' },
      'owner-token',
    );

    expect(
      await request(origin, 'GET', '/v1/projects/private-project', undefined, 'owner-token'),
    ).toMatchObject({ status: 200, body: { data: { ownerId: 'owner' } } });
    expect(
      await request(origin, 'GET', '/v1/projects/private-project', undefined, 'other-token'),
    ).toMatchObject({ status: 409, body: { error: { code: 'PROJECT_NOT_FOUND' } } });
  });

  it('brokers a Worker thumbnail through private storage only with sync consent, then streams verified bytes to the owner', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, store);
    const source = {
      id: 'asset-1',
      kind: 'video',
      displayName: 'clip.mp4',
      sha256: 'a'.repeat(64),
      bytes: 123,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000, width: 640, height: 360 },
      locations: [{ kind: 'opfs-cache', ref: 'source-1' }],
    };
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', source);
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: ['asset.thumbnail'], assetIds: ['asset-1'] },
      workerToken,
    );
    await request(origin, 'POST', '/v1/projects/p/jobs', {
      id: 'j',
      type: 'asset.thumbnail',
      assetId: 'asset-1',
    });
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);

    const thumbnail = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const sha256 = createHash('sha256').update(thumbnail).digest('hex');
    const upload = () =>
      fetch(`${origin}/v1/workers/w/jobs/j/derivative`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${workerToken}`,
          'content-type': 'image/jpeg',
          'x-joy-asset-id': 'asset-1',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(thumbnail.byteLength),
          'x-joy-width': '1',
          'x-joy-height': '1',
        },
        body: thumbnail,
      });

    const denied = await upload();
    expect(denied.status).toBe(409);
    expect(store.removed).toEqual([`thumb-j-${sha256.slice(0, 16)}`]);
    expect(store.objects).toHaveLength(0);

    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });
    const uploaded = await upload();
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      data: { id: 'derivative-j', assetId: 'asset-1', availability: 'available-cloud' },
    });
    expect(store.objects).toHaveLength(1);

    const content = await fetch(
      `${origin}/v1/projects/p/assets/asset-1/derivatives/derivative-j/content`,
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/jpeg');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(thumbnail);
    expect(content.url).toContain('/content');
    expect(content.url).not.toContain('parspack');
  });

  it('rejects cloud original uploads until project sync consent is explicitly enabled', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, store);
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'image-1',
      kind: 'image',
      displayName: 'frame.jpg',
      sha256,
      bytes: bytes.byteLength,
      descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
      locations: [{ kind: 'opfs-cache', ref: 'local-image-1' }],
    });

    const upload = () =>
      fetch(`${origin}/v1/projects/p/assets/image-1/original`, {
        method: 'POST',
        headers: {
          'content-type': 'image/jpeg',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(bytes.byteLength),
        },
        body: bytes,
      });

    const denied = await upload();
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: { code: 'ASSET_SYNC_DISABLED' },
    });
    expect(store.objects).toHaveLength(0);
    expect(await request(origin, 'GET', '/v1/projects/p')).toMatchObject({
      body: { data: { assetSyncEnabled: false } },
    });

    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });
    const uploaded = await upload();
    expect(uploaded.status).toBe(201);
    expect(store.objects).toHaveLength(1);
  });

  it('owner-binds private backup listing and content while preserving owner download', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start(
      {
        authenticate: (incoming) => ({
          id: incoming.headers.authorization === 'Bearer owner-token' ? 'owner' : 'peer',
        }),
      },
      store,
    );
    const upload = await prepareOriginalUpload(origin, 'owner-token');
    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true }, 'owner-token');
    expect((await upload()).status).toBe(201);

    expect(
      await request(origin, 'GET', '/v1/library/cloud-assets', undefined, 'owner-token'),
    ).toMatchObject({ status: 200, body: { data: [{ id: 'image-1' }] } });
    expect(
      await request(origin, 'GET', '/v1/library/cloud-assets', undefined, 'peer-token'),
    ).toMatchObject({ status: 200, body: { data: [] } });

    const ownerContent = await fetch(`${origin}/v1/library/cloud-assets/image-1/content`, {
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(ownerContent.status).toBe(200);
    expect(new Uint8Array(await ownerContent.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
    const peerContent = await fetch(`${origin}/v1/library/cloud-assets/image-1/content`, {
      headers: { authorization: 'Bearer peer-token' },
    });
    expect(peerContent.status).toBe(409);
    expect(await peerContent.json()).toMatchObject({ error: { code: 'ASSET_NOT_FOUND' } });
    expect(store.gets).toHaveLength(1);
  });

  it('keeps a successful same-SHA backup readable when a retry fails after storage', async () => {
    let attempts = 0;
    const tagger = async (): Promise<HermesTagResult> => {
      attempts += 1;
      if (attempts === 2) throw new Error('injected retry tag failure');
      return { tags: ['image'], sortName: 'frame.jpg', provenance: 'hermes-heuristic' };
    };
    const store = new MemoryPrivateObjectStore();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      store,
      undefined,
      undefined,
      undefined,
      tagger,
    );
    const upload = await prepareOriginalUpload(origin);
    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });

    const first = await upload();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { cloudRef: string } };
    const firstRef = firstBody.data.cloudRef;
    expect(store.objects.map((entry) => entry.descriptor.ref)).toEqual([firstRef]);

    const failedRetry = await upload();
    expect(failedRetry.status).not.toBe(201);
    expect(store.removed).toHaveLength(1);
    expect(store.removed[0]).not.toBe(firstRef);
    expect(store.objects.map((entry) => entry.descriptor.ref)).toEqual([firstRef]);

    const content = await fetch(`${origin}/v1/library/cloud-assets/image-1/content`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
  });

  it('isolates concurrent same-SHA upload attempts when one fails', async () => {
    let attempts = 0;
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const tagger = async (): Promise<HermesTagResult> => {
      attempts += 1;
      if (attempts === 1) {
        await firstCanFinish;
        return { tags: ['image'], sortName: 'frame.jpg', provenance: 'hermes-heuristic' };
      }
      releaseFirst();
      throw new Error('injected concurrent tag failure');
    };
    const store = new MemoryPrivateObjectStore();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      store,
      undefined,
      undefined,
      undefined,
      tagger,
    );
    const upload = await prepareOriginalUpload(origin);
    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });

    const responses = await Promise.all([upload(), upload()]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 500]);
    expect(store.objects).toHaveLength(1);
    expect(store.removed).toHaveLength(1);
    expect(store.objects[0]?.descriptor.ref).not.toBe(store.removed[0]);
    const content = await fetch(`${origin}/v1/library/cloud-assets/image-1/content`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    );
  });

  it('rejects a raced original upload when consent is disabled before metadata commit', async () => {
    const controlPlane = new LocalControlPlane();
    const owner = { id: 'owner' };
    const store = new MemoryPrivateObjectStore(() => {
      controlPlane.setAssetSync(owner, 'p', false);
    });
    const origin = await start({ authenticate: () => owner }, store, undefined, controlPlane);
    const upload = await prepareOriginalUpload(origin);
    await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });

    const response = await upload();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'ASSET_SYNC_DISABLED' } });
    expect(store.objects).toHaveLength(0);
    expect(store.removed).toHaveLength(1);
    expect(controlPlane.getProject(owner, 'p').assetSyncEnabled).toBe(false);
    expect(controlPlane.assetsForProject(owner, 'p')[0]?.locations).toEqual([
      { kind: 'opfs-cache', ref: 'local-image-1' },
    ]);
  });

  it('never leaves a private location when original-backup mutation boundaries fail', async () => {
    const cases: readonly {
      readonly name: string;
      readonly failure: 'store' | 'tag' | 'metadata' | 'attach';
    }[] = [
      { name: 'object storage', failure: 'store' },
      { name: 'tagging', failure: 'tag' },
      { name: 'metadata update', failure: 'metadata' },
      { name: 'location attachment', failure: 'attach' },
    ];

    for (const scenario of cases) {
      const controlPlane = new FaultInjectingControlPlane(scenario.failure);
      const store = new MemoryPrivateObjectStore(
        scenario.failure === 'store'
          ? () => {
              throw new Error('injected object-store failure');
            }
          : undefined,
      );
      const tagger =
        scenario.failure === 'tag'
          ? async (): Promise<HermesTagResult> => {
              throw new Error('injected tag failure');
            }
          : undefined;
      const origin = await start(
        { authenticate: () => ({ id: 'owner' }) },
        store,
        undefined,
        controlPlane,
        undefined,
        tagger,
      );
      const upload = await prepareOriginalUpload(origin);
      await request(origin, 'POST', '/v1/projects/p/asset-sync', { enabled: true });

      const response = await upload();

      expect(response.status, scenario.name).not.toBe(201);
      expect(store.objects, scenario.name).toHaveLength(0);
      expect(
        controlPlane.assetsForProject({ id: 'owner' }, 'p')[0]?.locations,
        scenario.name,
      ).toEqual([{ kind: 'opfs-cache', ref: 'local-image-1' }]);
      expect(store.removed, scenario.name).toHaveLength(1);
    }
  });

  it('accepts only typed Worker job payloads and leases them back over HTTP', async () => {
    const store = new MemoryPrivateObjectStore();
    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, store);
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: ['render.export'] },
      workerToken,
    );

    const typedJob = {
      id: 'render-export-1',
      type: 'render.export',
      payload: {
        projectRef: 'project-ref-1',
        compositionId: 'composition-main',
        presetId: 'reels-1080',
        reportRef: 'report-render-export-1',
      },
      requirements: { capabilities: ['render.export'], privacy: 'local-only' },
      idempotencyKey: 'idem-render-export-1',
      maxAttempts: 5,
    };
    expect(await request(origin, 'POST', '/v1/projects/p/jobs', typedJob)).toMatchObject({
      status: 201,
      body: { data: typedJob },
    });
    expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
      status: 200,
      body: {
        data: {
          id: 'render-export-1',
          payload: typedJob.payload,
          requirements: typedJob.requirements,
          idempotencyKey: 'idem-render-export-1',
          maxAttempts: 5,
        },
      },
    });
    const artifactBytes = new Uint8Array(2048);
    const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
    const artifactUpload = await fetch(`${origin}/v1/workers/w/jobs/render-export-1/artifact`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workerToken}`,
        'content-type': 'video/mp4',
        'x-joy-output-ref': 'output-render-export-1',
        'x-joy-sha256': artifactSha256,
        'x-joy-bytes': '2048',
      },
      body: artifactBytes,
    });
    expect(artifactUpload.status).toBe(201);
    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/render-export-1/complete',
        {
          result: {
            kind: 'render.export',
            reportRef: 'report-render-export-1',
            outputRef: 'output-render-export-1',
            sha256: artifactSha256,
            bytes: 2048,
            qualityReport: {
              version: 1,
              promiseId: 'promise-1',
              checkedAt: '2026-08-21T00:00:00.000Z',
              artifact: {
                outputRef: 'output-render-export-1',
                sha256: artifactSha256,
                bytes: 2048,
              },
              facts: {},
              findings: [{ code: 'delivery', status: 'pass', message: 'delivery passed' }],
            },
          },
        },
        workerToken,
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          derivative: {
            kind: 'render.export',
            reportRef: 'report-render-export-1',
            outputRef: 'output-render-export-1',
            qualityReport: {
              findings: [{ code: 'delivery', status: 'pass', message: 'delivery passed' }],
            },
          },
        },
      },
    });
    expect(
      await request(origin, 'POST', '/v1/projects/p/jobs', {
        ...typedJob,
        id: 'bad-render-export',
        payload: { ...typedJob.payload, projectRef: 'C:\\private\\project.json' },
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'WORKER_JOB_INVALID' } } });
  });

  it('exposes authenticated PostgreSQL production-run create, list, get, respond, and cancel routes', async () => {
    const database = newDb();
    const adapter = database.adapters.createPg();
    const pool = new adapter.Pool() as Pool;
    const controlPlane = new PostgresControlPlane(pool, { skipLocked: false });
    await controlPlane.initialize();
    const origin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      undefined,
      undefined,
      controlPlane,
    );
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Production' });
    const authority: ProductionRunAuthority = { principalId: 'owner', role: 'owner' };
    const record = parkedRecord('run-api', 'approval-api', authority);

    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api',
        authority,
        record,
      }),
    ).toMatchObject({
      status: 201,
      body: { data: { runId: 'run-api', state: 'parked', updatedSeq: 2 } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/production-runs?limit=1')).toMatchObject({
      status: 200,
      body: { data: { runs: [{ runId: 'run-api' }] } },
    });
    expect(await request(origin, 'GET', '/v1/projects/p/production-runs/run-api')).toMatchObject({
      status: 200,
      body: { data: { runId: 'run-api', approvals: [{ approvalId: 'approval-api' }] } },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api',
          response: { approved: [{ assetId: 'asset-1' }] },
          authority,
          expectedUpdatedSeq: 2,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          duplicate: false,
          record: {
            updatedSeq: 3,
            approvals: [
              {
                state: 'approved',
                responseRef: 'response-api',
                response: { approved: [{ assetId: 'asset-1' }] },
              },
            ],
          },
        },
      },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api',
          response: { approved: [{ assetId: 'asset-1' }] },
          authority,
          expectedUpdatedSeq: 2,
        },
      ),
    ).toMatchObject({
      status: 200,
      body: {
        data: {
          duplicate: true,
          record: {
            updatedSeq: 3,
          },
        },
      },
    });
    expect(
      await request(
        origin,
        'POST',
        '/v1/projects/p/production-runs/run-api/approvals/approval-api/respond',
        {
          approved: true,
          responseRef: 'response-api-role-mismatch',
          response: { approved: true },
          authority: { principalId: 'owner', role: 'reviewer' },
        },
      ),
    ).toMatchObject({ status: 409, body: { error: { code: 'AUTHORITY_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs/run-api/cancel', {
        authority,
        expectedUpdatedSeq: 2,
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } });

    const cancelRecord = queuedRecord('run-api-cancel', authority);
    await request(origin, 'POST', '/v1/projects/p/production-runs', {
      runKey: 'run-key-api-cancel',
      authority,
      record: cancelRecord,
    });
    const mixedAuthorityRecord = parkedRecord('run-api-mixed', 'approval-api-mixed', authority);
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-mixed',
        authority,
        record: {
          ...mixedAuthorityRecord,
          approvals: [
            {
              ...mixedAuthorityRecord.approvals[0]!,
              authority: { principalId: 'reviewer-2', role: 'reviewer' },
            },
          ],
        },
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'AUTHORITY_REQUIRED' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-file',
        authority,
        record: queuedRecord('run-api-file', authority, {
          nodes: [
            {
              nodeId: 'node-1',
              type: 'render.review',
              category: 'review',
              state: 'waiting_for_input',
              attempts: 1,
              deterministic: false,
              reused: false,
              logs: [
                {
                  seq: 1,
                  nodeId: 'node-1',
                  attempt: 1,
                  level: 'info',
                  message: 'file:///private/final.mp4',
                },
              ],
              artifactIds: [],
            },
          ],
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-nested-raw',
        authority,
        record: queuedRecord('run-api-nested-raw', authority, {
          checkpoint: {
            export: {
              opaqueToken: 'QUJD/'.repeat(32),
            },
          },
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs', {
        runKey: 'run-key-api-nested-alnum-raw',
        authority,
        record: queuedRecord('run-api-nested-alnum-raw', authority, {
          checkpoint: {
            export: {
              opaqueToken: 'A'.repeat(128),
            },
          },
        }),
      }),
    ).toMatchObject({ status: 409, body: { error: { code: 'PRODUCTION_RUN_INVALID' } } });
    expect(
      await request(origin, 'POST', '/v1/projects/p/production-runs/run-api-cancel/cancel', {
        authority,
        expectedUpdatedSeq: 1,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { state: 'canceled', events: [{}, { type: 'run.canceled' }] } },
    });
    expect(
      JSON.stringify(await request(origin, 'GET', '/v1/projects/p/production-runs/run-api')),
    ).not.toMatch(/C:\\|mediaBase64|https?:\/\//);
    await pool.end();
  });

  it('accepts every AI Worker receipt variant through the completion route', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-source-1',
      kind: 'image',
      displayName: 'source.png',
      sha256: '2'.repeat(64),
      bytes: 2048,
      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
    });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    const variants: readonly {
      readonly type: Extract<
        WorkerJobType,
        | 'image.comfy'
        | 'audio.ml-denoise'
        | 'text.lm-studio'
        | 'text.openrouter'
        | 'video.runway'
        | 'edit.higgsfield'
      >;
      readonly receipt: WorkerResultReceiptV1;
      readonly assetId?: string;
    }[] = [
      {
        type: 'image.comfy',
        assetId: 'asset-source-1',
        receipt: {
          kind: 'image.comfy',
          assetId: 'asset-source-1',
          sha256: '9'.repeat(64),
          bytes: 1024,
          localRef: 'gpu-image-comfy-1',
          descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
        },
      },
      {
        type: 'audio.ml-denoise',
        assetId: 'asset-source-1',
        receipt: {
          kind: 'audio.ml-denoise',
          assetId: 'asset-source-1',
          sha256: '8'.repeat(64),
          bytes: 1536,
          localRef: 'gpu-audio-denoise-1',
          descriptor: { mimeType: 'audio/wav' },
        },
      },
      {
        type: 'text.lm-studio',
        receipt: {
          kind: 'text.lm-studio',
          resultRef: 'ai-text-local-1',
          sha256: 'd'.repeat(64),
          bytes: 64,
          model: 'local-model',
        },
      },
      {
        type: 'text.openrouter',
        receipt: {
          kind: 'text.openrouter',
          resultRef: 'ai-text-remote-1',
          sha256: 'e'.repeat(64),
          bytes: 128,
          model: 'openrouter-model',
        },
      },
      {
        type: 'video.runway',
        receipt: {
          kind: 'video.runway',
          assetId: 'asset-video-1',
          sha256: 'f'.repeat(64),
          bytes: 8192,
          localRef: 'ai-video-runway-1',
          descriptor: { mimeType: 'video/mp4', width: 1280, height: 720 },
          model: 'gen4',
        },
      },
      {
        type: 'edit.higgsfield',
        receipt: {
          kind: 'edit.higgsfield',
          assetId: 'asset-edit-1',
          sha256: '1'.repeat(64),
          bytes: 4096,
          localRef: 'ai-edit-higgsfield-1',
          descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
          model: 'higgsfield-default',
        },
      },
    ];
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
      workerToken,
    );

    for (const [index, variant] of variants.entries()) {
      const job = {
        id: `ai-job-${index + 1}`,
        type: variant.type,
        ...(variant.assetId === undefined ? {} : { assetId: variant.assetId }),
        payload: {
          prompt: `Generate variant ${index + 1}`,
          ...(variant.type === 'edit.higgsfield' ? { imageAssetId: 'asset-source-1' } : {}),
        },
        requirements: {
          capabilities: [variant.type],
          privacy:
            variant.type === 'text.lm-studio' ? ('local-only' as const) : ('remote-api' as const),
        },
        idempotencyKey: `idem-ai-job-${index + 1}`,
        maxAttempts: 2,
      };
      expect(await request(origin, 'POST', '/v1/projects/p/jobs', job)).toMatchObject({
        status: 201,
        body: { data: { id: job.id, type: variant.type } },
      });
      expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
        status: 200,
        body: { data: { id: job.id, type: variant.type } },
      });
      expect(
        await request(
          origin,
          'POST',
          `/v1/workers/w/jobs/${job.id}/complete`,
          { result: variant.receipt },
          workerToken,
        ),
      ).toMatchObject({
        status: 200,
        body: {
          data: {
            id: job.id,
            state: 'completed',
            derivative: { kind: variant.type },
          },
        },
      });
    }
  });

  it('rejects completion without a result for every Worker job type', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/projects/p/assets', {
      id: 'asset-source-1',
      kind: 'image',
      displayName: 'source.png',
      sha256: '2'.repeat(64),
      bytes: 2048,
      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
    });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    const variants: ReadonlyArray<{
      readonly id: string;
      readonly type: WorkerJobType;
      readonly job: Record<string, unknown>;
    }> = [
      {
        id: 'job-thumb',
        type: 'asset.thumbnail',
        job: { id: 'job-thumb', type: 'asset.thumbnail', assetId: 'asset-source-1' },
      },
      {
        id: 'job-comfy',
        type: 'image.comfy',
        job: { id: 'job-comfy', type: 'image.comfy', assetId: 'asset-source-1' },
      },
      {
        id: 'job-denoise',
        type: 'audio.ml-denoise',
        job: { id: 'job-denoise', type: 'audio.ml-denoise', assetId: 'asset-source-1' },
      },
      { id: 'job-export', type: 'render.export', job: { id: 'job-export', type: 'render.export' } },
      {
        id: 'job-inspect',
        type: 'render.inspect',
        job: { id: 'job-inspect', type: 'render.inspect' },
      },
      {
        id: 'job-text-local',
        type: 'text.lm-studio',
        job: { id: 'job-text-local', type: 'text.lm-studio' },
      },
      {
        id: 'job-text-remote',
        type: 'text.openrouter',
        job: { id: 'job-text-remote', type: 'text.openrouter' },
      },
      {
        id: 'job-video',
        type: 'video.runway',
        job: { id: 'job-video', type: 'video.runway' },
      },
      {
        id: 'job-edit',
        type: 'edit.higgsfield',
        job: { id: 'job-edit', type: 'edit.higgsfield' },
      },
    ];
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
      workerToken,
    );

    for (const variant of variants) {
      expect(await request(origin, 'POST', '/v1/projects/p/jobs', variant.job)).toMatchObject({
        status: 201,
        body: { data: { id: variant.id, type: variant.type } },
      });
      expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
        status: 200,
        body: { data: { id: variant.id, type: variant.type } },
      });
      expect(
        await request(origin, 'POST', `/v1/workers/w/jobs/${variant.id}/complete`, {}, workerToken),
      ).toMatchObject({
        status: 400,
        body: { error: { code: 'REQUEST_INVALID' } },
      });
      expect(
        await request(
          origin,
          'POST',
          `/v1/workers/w/jobs/${variant.id}/fail`,
          { error: 'canceled' },
          workerToken,
        ),
      ).toMatchObject({
        status: 200,
        body: { data: { state: 'canceled' } },
      });
    }
  });

  it('rejects mismatched AI media receipts over HTTP', async () => {
    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
    await request(origin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'w',
      pairingCode: 'pairing-code',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      origin,
      'POST',
      '/v1/workers/w/hello',
      { capabilities: ['video.runway'] },
      workerToken,
    );
    await request(origin, 'POST', '/v1/projects/p/jobs', {
      id: 'ai-mismatch-1',
      type: 'video.runway',
      payload: { prompt: 'Generate a video' },
      requirements: { capabilities: ['video.runway'], privacy: 'remote-api' },
      idempotencyKey: 'idem-ai-mismatch-1',
      maxAttempts: 2,
    });
    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);

    expect(
      await request(
        origin,
        'POST',
        '/v1/workers/w/jobs/ai-mismatch-1/complete',
        {
          result: {
            kind: 'video.runway',
            assetId: 'asset-video-mismatch-1',
            sha256: '7'.repeat(64),
            bytes: 4096,
            localRef: 'ai-mismatch-video-1',
            descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
          },
        },
        workerToken,
      ),
    ).toMatchObject({
      status: 400,
      body: { error: { code: 'REQUEST_INVALID' } },
    });
  });
  it('stores render artifacts only for the leased render job and serves them to the owner', async () => {
    const store = new MemoryPrivateObjectStore();
    const controlPlane = new LocalControlPlane();
    const ownerOrigin = await start(
      { authenticate: () => ({ id: 'owner' }) },
      store,
      undefined,
      controlPlane,
    );
    await request(ownerOrigin, 'POST', '/v1/projects', {
      id: 'artifact-project',
      title: 'Artifacts',
    });
    await request(ownerOrigin, 'POST', '/v1/worker-pair/offers', {
      workerId: 'artifact-worker',
      pairingCode: 'artifact-pairing',
    });
    await request(ownerOrigin, 'POST', '/v1/workers/artifact-worker/pair', {
      pairingCode: 'artifact-pairing',
    });
    const claim = await request(ownerOrigin, 'POST', '/v1/worker-pair/claim', {
      workerId: 'artifact-worker',
      pairingCode: 'artifact-pairing',
    });
    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
    await request(
      ownerOrigin,
      'POST',
      '/v1/workers/artifact-worker/hello',
      { capabilities: ['render.export'] },
      workerToken,
    );
    await request(ownerOrigin, 'POST', '/v1/projects/artifact-project/jobs', {
      id: 'artifact-job',
      type: 'render.export',
    });
    await request(ownerOrigin, 'POST', '/v1/workers/artifact-worker/leases', {}, workerToken);
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactPath = `${ownerOrigin}/v1/workers/artifact-worker/jobs/artifact-job/artifact`;
    const upload = (headers: Record<string, string>, body: Uint8Array = bytes) =>
      fetch(artifactPath, {
        method: 'POST',
        headers: { authorization: `Bearer ${workerToken}`, ...headers },
        body: Buffer.from(body),
      });
    expect(
      (
        await upload({
          'content-type': 'video/webm',
          'x-joy-output-ref': 'render-output',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(bytes.length),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await upload({
          'content-type': 'video/mp4',
          'x-joy-output-ref': 'render-output',
          'x-joy-sha256': 'f'.repeat(64),
          'x-joy-bytes': String(bytes.length),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await upload({
          'content-type': 'video/mp4',
          'x-joy-output-ref': 'render-output',
          'x-joy-sha256': sha256,
          'x-joy-bytes': String(bytes.length + 1),
        })
      ).status,
    ).toBe(400);
    const accepted = await upload({
      'content-type': 'video/mp4',
      'x-joy-output-ref': 'render-output',
      'x-joy-sha256': sha256,
      'x-joy-bytes': String(bytes.length),
    });
    expect(accepted.status).toBe(201);
    const artifact = ((await accepted.json()) as { data: { id: string } }).data;
    expect(
      await request(
        ownerOrigin,
        'POST',
        '/v1/workers/artifact-worker/jobs/artifact-job/complete',
        {
          result: {
            kind: 'render.export',
            reportRef: 'report-artifact-job',
            outputRef: 'render-output',
            sha256,
            bytes: bytes.length,
          },
        },
        workerToken,
      ),
    ).toMatchObject({ status: 200 });
    const content = await fetch(
      `${ownerOrigin}/v1/projects/artifact-project/render-artifacts/${artifact.id}/content`,
      { headers: { authorization: 'Bearer owner-session' } },
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(bytes);
    const otherOwnerOrigin = await start(
      { authenticate: () => ({ id: 'other-owner' }) },
      store,
      undefined,
      controlPlane,
    );
    const isolated = await fetch(
      `${otherOwnerOrigin}/v1/projects/artifact-project/render-artifacts/${artifact.id}/content`,
    );
    expect([404, 409]).toContain(isolated.status);
    const unauthenticatedOrigin = await start(
      { authenticate: () => undefined },
      store,
      undefined,
      controlPlane,
    );
    const denied = await fetch(
      `${unauthenticatedOrigin}/v1/projects/artifact-project/render-artifacts/${artifact.id}/content`,
    );
    expect(denied.status).toBe(401);
  });
});

async function start(
  authentication: ApiAuthentication,
  privateObjectStore?: PrivateObjectStore,
  mistral?: MistralProviderRegistry,
  controlPlane?: ControlPlane,
  providerApprovals?: ProviderApprovalService,
  assetTagger?: (input: HermesTagInput) => Promise<HermesTagResult>,
  rateLimit?: { readonly windowMs?: number; readonly maxRequests?: number },
): Promise<string> {
  const server = createControlPlaneHttpServer({
    controlPlane: controlPlane ?? new LocalControlPlane(),
    authentication,
    mediaAuth: new DisabledMediaAuth(),
    ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
    ...(mistral === undefined ? {} : { mistral }),
    ...(providerApprovals === undefined ? {} : { providerApprovals }),
    ...(assetTagger === undefined ? {} : { assetTagger }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly objects: Array<{
    readonly descriptor: PrivateObjectDescriptor;
    readonly bytes: Uint8Array;
  }> = [];
  readonly removed: string[] = [];
  readonly gets: string[] = [];

  constructor(
    private readonly onPut?: (
      descriptor: PrivateObjectDescriptor,
      bytes: Uint8Array,
    ) => void | Promise<void>,
  ) {}

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    this.objects.push({ descriptor, bytes });
    await this.onPut?.(descriptor, bytes);
  }
  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    this.gets.push(descriptor.ref);
    const object = this.objects.find((candidate) => candidate.descriptor.ref === descriptor.ref);
    if (object === undefined) throw new Error('private object not found');
    return object.bytes;
  }
  async remove(ref: string): Promise<void> {
    this.removed.push(ref);
    const index = this.objects.findIndex((candidate) => candidate.descriptor.ref === ref);
    if (index >= 0) this.objects.splice(index, 1);
  }
}

class FaultInjectingControlPlane extends LocalControlPlane {
  constructor(private readonly failure: 'store' | 'tag' | 'metadata' | 'attach') {
    super();
  }

  override updateAssetMetadata(
    actor: Actor,
    projectId: string,
    assetId: string,
    patch: {
      readonly tags?: readonly string[];
      readonly sortName?: string;
      readonly displayName?: string;
    },
  ): MediaAssetRecord {
    if (this.failure === 'metadata')
      throw new ControlPlaneError('INJECTED_FAILURE', 'metadata update failed');
    return super.updateAssetMetadata(actor, projectId, assetId, patch);
  }

  override attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): MediaAssetRecord {
    if (this.failure === 'attach')
      throw new ControlPlaneError('INJECTED_FAILURE', 'location attachment failed');
    return super.attachCloudOriginal(actor, projectId, assetId, location);
  }
}

async function prepareOriginalUpload(
  origin: string,
  bearerToken?: string,
): Promise<() => Promise<Response>> {
  await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }, bearerToken);
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await request(
    origin,
    'POST',
    '/v1/projects/p/assets',
    {
      id: 'image-1',
      kind: 'image',
      displayName: 'frame.jpg',
      sha256,
      bytes: bytes.byteLength,
      descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
      locations: [{ kind: 'opfs-cache', ref: 'local-image-1' }],
    },
    bearerToken,
  );
  return () =>
    fetch(`${origin}/v1/projects/p/assets/image-1/original`, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        'x-joy-sha256': sha256,
        'x-joy-bytes': String(bytes.byteLength),
        ...(bearerToken === undefined ? {} : { authorization: `Bearer ${bearerToken}` }),
      },
      body: bytes,
    });
}

async function request(
  origin: string,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
  bearerToken?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (bearerToken !== undefined) headers.authorization = `Bearer ${bearerToken}`;
  const response = await fetch(
    `${origin}${pathname}`,
    body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}

function queuedRecord(
  runId: string,
  authority: ProductionRunAuthority,
  overrides: Partial<ProductionRunRecordV1> = {},
): ProductionRunRecordV1 {
  return {
    recordVersion: 1,
    runId,
    workflowId: 'wf-production',
    workflowVersion: '1.0.0',
    projectRevision: 'rev-1',
    state: 'queued',
    checkpointRevision: 0,
    links: {},
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.queued',
        state: 'queued',
        actor: authority,
        checkpointRevision: 0,
        message: 'production run queued',
      },
    ],
    approvals: [],
    nodes: [],
    createdSeq: 1,
    updatedSeq: 1,
    ...overrides,
  };
}

function parkedRecord(
  runId: string,
  approvalId: string,
  authority: ProductionRunAuthority,
): ProductionRunRecordV1 {
  return queuedRecord(runId, authority, {
    state: 'parked',
    checkpointRevision: 1,
    events: [
      {
        eventVersion: 1,
        seq: 1,
        type: 'run.parked',
        state: 'parked',
        actor: authority,
        checkpointRevision: 1,
        message: 'production run parked',
      },
      {
        eventVersion: 1,
        seq: 2,
        type: 'approval.requested',
        state: 'parked',
        nodeId: 'review',
        approvalId,
        checkpointRevision: 1,
        message: 'approve-render',
      },
    ],
    approvals: [
      {
        approvalVersion: 1,
        approvalId,
        nodeId: 'review',
        kind: 'approve-render',
        prompt: 'Approve final?',
        requestPayload: { diffRef: 'asset-diff-1' },
        state: 'pending',
        requestedSeq: 2,
      },
    ],
    nodes: [
      {
        nodeId: 'review',
        type: 'render.review',
        category: 'review',
        state: 'waiting_for_input',
        attempts: 1,
        deterministic: false,
        reused: false,
        pendingApprovalId: approvalId,
        logs: [],
        artifactIds: [],
      },
    ],
    updatedSeq: 2,
  });
}
