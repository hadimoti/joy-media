# Review package: ed0b6be..359e294

## Commits
359e294 feat(reasoning): bound Mistral and Joy Code reasoning

## Files changed
 apps/api/src/http-server.test.ts               | 253 ++++++++++++++
 apps/api/src/http-server.ts                    |  99 ++++++
 apps/api/src/mistral-provider.ts               | 434 +++++++++++++++++++++++++
 apps/editor-web/src/AgentPanel.tsx             | 295 ++++++++++++++++-
 apps/editor-web/src/control-plane-client.ts    |  56 ++++
 apps/editor-web/src/joy-code-critique.test.tsx | 162 +++++++++
 packages/adapter-mistral/src/index.test.ts     |  52 +++
 packages/adapter-mistral/src/index.ts          | 106 +++++-
 8 files changed, 1443 insertions(+), 14 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index 980fb98..5aded0a 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -166,20 +166,273 @@ describe('control-plane HTTP transport', () => {
       body: {
         data: expect.arrayContaining([
           expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
           expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-mistral-1' }),
         ]),
       },
     });
     expect(JSON.stringify(audit.body)).not.toContain('Do not persist this prompt.');
   });
 
+  it('keeps bounded Joy Code reasoning unconfigured until Mistral is configured', async () => {
+    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
+
+    expect(
+      await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
+        model: 'mistral-small-latest',
+        goal: 'Tighten the opening pacing',
+        snapshotDigest: `fnv1a-${'a'.repeat(8)}`,
+        projectRevision: 'rev-1',
+        idempotencyKey: 'joy-code-unconfigured-1',
+        privacyMode: 'ask-before-remote',
+        evidence: [
+          {
+            evidenceId: 'clip:intro',
+            kind: 'selected-clip',
+            label: 'Intro clip',
+            detail: 'Opening narration from 0s to 10s.',
+          },
+        ],
+        allowedIntentIds: ['shorten-intro'],
+      }),
+    ).toMatchObject({ status: 503, body: { error: { code: 'PROVIDER_UNCONFIGURED' } } });
+  });
+
+  it('requires approval, validates evidence refs, and replays bounded Joy Code reasoning without persisting prompts', async () => {
+    let calls = 0;
+    const approvals = new ProviderApprovalService();
+    const registry = new MistralProviderRegistry(
+      'test-only-mistral-secret',
+      new MemoryMistralInvocationLedger(),
+      approvals,
+      async () => {
+        calls++;
+        return new Response(
+          JSON.stringify({
+            choices: [
+              {
+                message: {
+                  content: JSON.stringify({
+                    brief: {
+                      summary: 'The intro can be tightened without changing the story arc.',
+                      rationale:
+                        'The opening evidence repeats setup beats before the product lands.',
+                      evidenceReferences: ['clip:intro'],
+                    },
+                    proposal: {
+                      intentId: 'shorten-intro',
+                      summary: 'Shorten the intro by 2 seconds.',
+                      rationale: 'The intro evidence supports a bounded pacing trim.',
+                      evidenceReferences: ['clip:intro'],
+                    },
+                  }),
+                },
+              },
+            ],
+            usage: { prompt_tokens: 11, completion_tokens: 13 },
+          }),
+        );
+      },
+    );
+    const origin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      registry,
+      undefined,
+      approvals,
+    );
+
+    const base = {
+      model: 'mistral-small-latest',
+      goal: 'Tighten the opening pacing without changing the message.',
+      snapshotDigest: `fnv1a-${'b'.repeat(8)}`,
+      projectRevision: 'rev-1',
+      idempotencyKey: 'joy-code-1',
+      privacyMode: 'ask-before-remote',
+      evidence: [
+        {
+          evidenceId: 'clip:intro',
+          kind: 'selected-clip',
+          label: 'Intro clip',
+          detail: 'Opening narration from 0s to 10s.',
+        },
+      ],
+      allowedIntentIds: ['shorten-intro'],
+    };
+
+    const approvalRequired = await request(
+      origin,
+      'POST',
+      '/v1/providers/reasoning/joy-code',
+      base,
+    );
+    expect(approvalRequired).toMatchObject({
+      status: 409,
+      body: {
+        error: {
+          code: 'PROVIDER_APPROVAL_REQUIRED',
+          preflight: { providerId: 'mistral', capability: 'llm.complete' },
+        },
+      },
+    });
+    const preflight = (
+      approvalRequired.body as {
+        error: {
+          preflight: {
+            providerId: string;
+            capability: 'llm.complete';
+            requestDigest: string;
+          };
+        };
+      }
+    ).error.preflight;
+    const providerApprovalGrant = approvals.createGrant({
+      actorId: 'owner',
+      providerId: preflight.providerId,
+      capability: preflight.capability,
+      requestDigest: preflight.requestDigest,
+      expiresAt: '2026-12-31T00:00:00.000Z',
+      costCap: { amount: '0.00', currency: 'USD' },
+      grantId: 'grant-joy-code-1',
+    });
+
+    const approved = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
+      ...base,
+      providerApprovalGrant,
+    });
+    expect(approved).toMatchObject({
+      status: 200,
+      body: {
+        data: {
+          brief: {
+            summary: 'The intro can be tightened without changing the story arc.',
+            evidenceReferences: ['clip:intro'],
+          },
+          proposal: { intentId: 'shorten-intro', evidenceReferences: ['clip:intro'] },
+          provider: {
+            providerId: 'mistral',
+            modelId: 'mistral-small-latest',
+            decisionRef: 'provider-decision-joy-code-1',
+            briefRef: 'reasoning-brief-joy-code-1',
+            usage: { inputTokens: 11, outputTokens: 13 },
+          },
+        },
+      },
+    });
+
+    const replay = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', base);
+    expect(replay).toEqual(approved);
+    expect(calls).toBe(1);
+    expect(JSON.stringify(approved.body)).not.toContain('test-only-mistral-secret');
+    expect(JSON.stringify(approved.body)).not.toContain(base.goal);
+
+    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
+    expect(audit).toMatchObject({
+      status: 200,
+      body: {
+        data: expect.arrayContaining([
+          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
+          expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-joy-code-1' }),
+        ]),
+      },
+    });
+    expect(JSON.stringify(audit.body)).not.toContain(base.goal);
+  });
+
+  it('fails closed when Joy Code reasoning returns malformed structured output or unknown evidence refs', async () => {
+    const approvals = new ProviderApprovalService();
+    const registry = new MistralProviderRegistry(
+      'test-only-mistral-secret',
+      new MemoryMistralInvocationLedger(),
+      approvals,
+      async () =>
+        new Response(
+          JSON.stringify({
+            choices: [
+              {
+                message: {
+                  content: JSON.stringify({
+                    brief: {
+                      summary: 'Bad refs.',
+                      rationale: 'This cites an unknown item.',
+                      evidenceReferences: ['missing-evidence'],
+                    },
+                  }),
+                },
+              },
+            ],
+            usage: { prompt_tokens: 4, completion_tokens: 5 },
+          }),
+        ),
+    );
+    const origin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      registry,
+      undefined,
+      approvals,
+    );
+
+    const base = {
+      model: 'mistral-small-latest',
+      goal: 'Review the intro only.',
+      snapshotDigest: `fnv1a-${'c'.repeat(8)}`,
+      projectRevision: 'rev-2',
+      idempotencyKey: 'joy-code-malformed-1',
+      privacyMode: 'ask-before-remote',
+      evidence: [
+        {
+          evidenceId: 'clip:intro',
+          kind: 'selected-clip',
+          label: 'Intro clip',
+          detail: 'Opening narration from 0s to 10s.',
+        },
+      ],
+      allowedIntentIds: ['shorten-intro'],
+    };
+    const approvalRequired = await request(
+      origin,
+      'POST',
+      '/v1/providers/reasoning/joy-code',
+      base,
+    );
+    const preflight = (
+      approvalRequired.body as {
+        error: {
+          preflight: {
+            providerId: string;
+            capability: 'llm.complete';
+            requestDigest: string;
+          };
+        };
+      }
+    ).error.preflight;
+    const providerApprovalGrant = approvals.createGrant({
+      actorId: 'owner',
+      providerId: preflight.providerId,
+      capability: preflight.capability,
+      requestDigest: preflight.requestDigest,
+      expiresAt: '2026-12-31T00:00:00.000Z',
+      costCap: { amount: '0.00', currency: 'USD' },
+    });
+
+    expect(
+      await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
+        ...base,
+        providerApprovalGrant,
+      }),
+    ).toMatchObject({
+      status: 502,
+      body: { error: { code: 'MISTRAL_REQUEST_FAILED' } },
+    });
+  });
+
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
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 41519e0..88b4afe 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -9,20 +9,21 @@ import {
 } from './control-plane.js';
 import {
   DisabledMediaAuth,
   MediaAuthError,
   type MediaAuthApi,
   type MediaAuthMethod,
 } from './media-auth.js';
 import {
   createRuntimeMistralProviderRegistry,
   MistralProviderError,
+  type JoyCodeReasoningEvidence,
   type MistralProviderRegistry,
 } from './mistral-provider.js';
 import {
   ProviderApprovalError,
   ProviderApprovalService,
   providerApprovalRequiredPayload,
 } from './provider-approval.js';
 import {
   type ProductionRunAuthority,
   type ProductionRunRecordV1,
@@ -314,20 +315,27 @@ async function route(
   }
 
   const actor = await options.authentication.authenticate(request);
   if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');
 
   if (request.method === 'GET' && url.pathname === '/v1/providers/reasoning') {
     respondJson(response, 200, { data: { providers: [options.mistral.summary()] } });
     return;
   }
 
+  if (request.method === 'POST' && url.pathname === '/v1/providers/reasoning/joy-code') {
+    const body = await readJson(request);
+    const result = await options.mistral.joyCodeReason(actor.id, joyCodeReasoningRequest(body));
+    respondJson(response, 200, { data: result });
+    return;
+  }
+
   if (request.method === 'GET' && url.pathname === '/v1/providers/approvals/audit') {
     respondJson(response, 200, { data: await options.providerApprovals.auditRows(actor.id) });
     return;
   }
 
   if (request.method === 'POST' && url.pathname === '/v1/providers/mistral/complete') {
     const body = await readJson(request);
     const result = await options.mistral.complete(actor.id, mistralCompletionRequest(body));
     respondJson(response, 200, { data: result });
     return;
@@ -1075,20 +1083,102 @@ function mistralCompletionRequest(body: Record<string, unknown>) {
     approvedRemoteProcessing: body.approvedRemoteProcessing === true,
     approvedSpend: body.approvedSpend === true,
     ...(optionalProviderApprovalGrant(body) === undefined
       ? {}
       : { approvalGrant: optionalProviderApprovalGrant(body) }),
     ...(maxTokens === undefined ? {} : { maxTokens }),
     ...(temperature === undefined ? {} : { temperature }),
   };
 }
 
+function joyCodeReasoningRequest(body: Record<string, unknown>) {
+  const privacyMode = body.privacyMode;
+  if (privacyMode !== 'local-only' && privacyMode !== 'ask-before-remote')
+    throw new ControlPlaneError('REQUEST_INVALID', 'privacyMode is invalid');
+  const evidence = requiredJoyCodeEvidence(body.evidence);
+  const allowedIntentIds = requiredStringArray(body, 'allowedIntentIds');
+  if (allowedIntentIds.length === 0 || allowedIntentIds.length > 16) {
+    throw new ControlPlaneError(
+      'REQUEST_INVALID',
+      'allowedIntentIds must contain between 1 and 16 intent ids',
+    );
+  }
+  const snapshotDigest = requiredString(body, 'snapshotDigest');
+  if (
+    !/^fnv1a-[a-f0-9]{1,32}$/i.test(snapshotDigest) &&
+    !/^sha256:[a-f0-9]{64}$/i.test(snapshotDigest)
+  ) {
+    throw new ControlPlaneError('REQUEST_INVALID', 'snapshotDigest is invalid');
+  }
+  const goal = requiredString(body, 'goal');
+  if (goal.length > 500 || containsUnsafeReasoningText(goal)) {
+    throw new ControlPlaneError('REQUEST_INVALID', 'goal is invalid');
+  }
+  const projectRevision = requiredString(body, 'projectRevision');
+  const maxTokens = optionalPositiveInteger(body, 'maxTokens');
+  return {
+    model: requiredString(body, 'model'),
+    goal,
+    snapshotDigest,
+    projectRevision,
+    idempotencyKey: requiredString(body, 'idempotencyKey'),
+    privacyMode: privacyMode as 'local-only' | 'ask-before-remote',
+    approvedRemoteProcessing: body.approvedRemoteProcessing === true,
+    approvedSpend: body.approvedSpend === true,
+    evidence,
+    allowedIntentIds,
+    ...(optionalProviderApprovalGrant(body) === undefined
+      ? {}
+      : { approvalGrant: optionalProviderApprovalGrant(body) }),
+    ...(maxTokens === undefined ? {} : { maxTokens }),
+  };
+}
+
+function requiredJoyCodeEvidence(value: unknown): readonly JoyCodeReasoningEvidence[] {
+  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
+    throw new ControlPlaneError(
+      'REQUEST_INVALID',
+      'evidence must contain between 1 and 12 bounded evidence items',
+    );
+  }
+  return value.map((item, index) => {
+    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
+      throw new ControlPlaneError('REQUEST_INVALID', `evidence[${index}] must be an object`);
+    }
+    const record = item as Record<string, unknown>;
+    const evidenceId = requiredString(record, 'evidenceId');
+    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidenceId)) {
+      throw new ControlPlaneError('REQUEST_INVALID', `evidence[${index}].evidenceId is invalid`);
+    }
+    const kind = record.kind;
+    if (
+      kind !== 'selected-clip' &&
+      kind !== 'attached-asset' &&
+      kind !== 'timeline-range' &&
+      kind !== 'project-summary'
+    ) {
+      throw new ControlPlaneError('REQUEST_INVALID', `evidence[${index}].kind is invalid`);
+    }
+    const label = requiredString(record, 'label');
+    const detail = requiredString(record, 'detail');
+    if (
+      label.length > 160 ||
+      detail.length > 320 ||
+      containsUnsafeReasoningText(label) ||
+      containsUnsafeReasoningText(detail)
+    ) {
+      throw new ControlPlaneError('REQUEST_INVALID', `evidence[${index}] is invalid`);
+    }
+    return { evidenceId, kind, label, detail };
+  });
+}
+
 function optionalPrivacyMode(
   body: Record<string, unknown>,
   field: string,
 ): 'local-only' | 'ask-before-remote' | undefined {
   const value = body[field];
   if (value === undefined) return undefined;
   if (value !== 'local-only' && value !== 'ask-before-remote') {
     throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
   }
   return value;
@@ -1139,20 +1229,29 @@ function optionalProviderApprovalGrant(
     providerId: grant.providerId,
     capability: grant.capability as ProviderApprovalGrant['capability'],
     requestDigest: grant.requestDigest,
     expiresAt: grant.expiresAt,
     status: grant.status,
     ...(costCap === undefined ? {} : { costCap }),
   };
   return parsed;
 }
 
+function containsUnsafeReasoningText(value: string): boolean {
+  return (
+    /\bhttps?:\/\//i.test(value) ||
+    /\bfile:\/\//i.test(value) ||
+    /\b[A-Za-z]:\\/i.test(value) ||
+    /\b(?:api[_-]?key|secret|token|password)\b/i.test(value)
+  );
+}
+
 function optionalPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
   const value = body[field];
   if (value === undefined) return undefined;
   if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a positive integer`);
   return value;
 }
 
 function optionalNonNegativeInteger(
   body: Record<string, unknown>,
diff --git a/apps/api/src/mistral-provider.ts b/apps/api/src/mistral-provider.ts
index 7bfa585..885749f 100644
--- a/apps/api/src/mistral-provider.ts
+++ b/apps/api/src/mistral-provider.ts
@@ -1,44 +1,99 @@
 import type { Pool } from 'pg';
 import {
   createMistralAdapter,
   MISTRAL_PROVIDER_ID,
   MISTRAL_REASONING_MODELS,
   type MistralChatMessage,
 } from '@joy-media/adapter-mistral';
 import {
   computeProviderApprovalPreflight,
+  resolveProviderDecision,
   ProviderLifecycle,
   resolveProvider,
   type CapabilityResult,
   type CapabilityRequest,
   type ProviderApprovalGrant,
+  type ProviderDecisionV1,
   type ProviderStatus,
 } from '@joy-media/provider-sdk';
 import {
   ProviderApprovalError,
   ProviderApprovalService,
   type ProviderApprovalOutcome,
 } from './provider-approval.js';
 
 export interface MistralCompletionRequest {
   readonly model: string;
   readonly messages: readonly MistralChatMessage[];
   readonly idempotencyKey: string;
   readonly privacyMode: 'local-only' | 'ask-before-remote';
   readonly approvedRemoteProcessing: boolean;
   readonly approvedSpend: boolean;
   readonly approvalGrant?: ProviderApprovalGrant | undefined;
   readonly maxTokens?: number;
   readonly temperature?: number;
 }
 
+export interface JoyCodeReasoningEvidence {
+  readonly evidenceId: string;
+  readonly kind: 'selected-clip' | 'attached-asset' | 'timeline-range' | 'project-summary';
+  readonly label: string;
+  readonly detail: string;
+}
+
+export interface JoyCodeReasoningRequest {
+  readonly model: string;
+  readonly goal: string;
+  readonly snapshotDigest: string;
+  readonly projectRevision: string;
+  readonly idempotencyKey: string;
+  readonly privacyMode: 'local-only' | 'ask-before-remote';
+  readonly approvedRemoteProcessing?: boolean;
+  readonly approvedSpend?: boolean;
+  readonly approvalGrant?: ProviderApprovalGrant | undefined;
+  readonly evidence: readonly JoyCodeReasoningEvidence[];
+  readonly allowedIntentIds: readonly string[];
+  readonly maxTokens?: number;
+}
+
+export interface JoyCodeReasoningResponse {
+  readonly responseVersion: 1;
+  readonly requestId: string;
+  readonly brief: {
+    readonly summary: string;
+    readonly rationale: string;
+    readonly evidenceReferences: readonly string[];
+    readonly caution?: string;
+  };
+  readonly proposal?: {
+    readonly intentId: string;
+    readonly summary: string;
+    readonly rationale: string;
+    readonly evidenceReferences: readonly string[];
+  };
+  readonly provider: {
+    readonly providerId: typeof MISTRAL_PROVIDER_ID;
+    readonly modelId: string;
+    readonly decisionRef: string;
+    readonly briefRef: string;
+    readonly requestDigest: string;
+    readonly dataLeavesDevice: boolean;
+    readonly retentionDisclosure?: string;
+    readonly usage?: {
+      readonly inputTokens?: number;
+      readonly outputTokens?: number;
+      readonly budgetReservationId?: string;
+    };
+  };
+}
+
 export interface MistralProviderSummary {
   readonly providerId: typeof MISTRAL_PROVIDER_ID;
   readonly state: ProviderStatus['state'];
   readonly models: readonly {
     readonly id: string;
     readonly displayName: string;
     readonly version?: string;
   }[];
   readonly adapterVersion: string;
 }
@@ -131,20 +186,24 @@ export class PostgresMistralInvocationLedger implements MistralInvocationLedger
     const existing = await this.find(actorId, result.provenance.idempotencyKey);
     if (existing === undefined) throw new Error('provider invocation record was not persisted');
     return existing;
   }
 }
 
 export class MistralProviderRegistry {
   readonly #provider;
   readonly #lifecycle = new ProviderLifecycle();
   readonly #approvals: ProviderApprovalService;
+  readonly #reasoningResults = new Map<
+    string,
+    { readonly requestDigest: string; readonly response: JoyCodeReasoningResponse }
+  >();
 
   constructor(
     apiKey: string | undefined,
     private readonly ledger: MistralInvocationLedger = new MemoryMistralInvocationLedger(),
     approvalsOrFetch?: ProviderApprovalService | typeof fetch,
     fetchImpl?: typeof fetch,
   ) {
     const approvals =
       typeof approvalsOrFetch === 'function' || approvalsOrFetch === undefined
         ? new ProviderApprovalService()
@@ -289,20 +348,155 @@ export class MistralProviderRegistry {
       this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
       this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
       await this.#approvals.recordFailed(
         approvalVerification,
         approval.reservation,
         'provider-unavailable',
       );
       throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
     }
   }
+
+  async joyCodeReason(
+    actorId: string,
+    input: JoyCodeReasoningRequest,
+  ): Promise<JoyCodeReasoningResponse> {
+    const request = joyCodeCapabilityRequest(input);
+    const preflight = computeProviderApprovalPreflight(actorId, request, this.#provider);
+    const approvalVerification = {
+      actorId,
+      idempotencyKey: input.idempotencyKey,
+      preflight,
+      privacyMode: input.privacyMode,
+      grant: input.approvalGrant,
+      fallbackCostCap: input.approvalGrant?.costCap ?? { amount: '0.00', currency: 'USD' },
+    } as const;
+    const resultKey = `${actorId}:${input.idempotencyKey}`;
+    const previous = this.#reasoningResults.get(resultKey);
+    if (previous !== undefined) {
+      if (previous.requestDigest !== preflight.requestDigest) {
+        await this.#approvals.recordFailed(
+          approvalVerification,
+          undefined,
+          'idempotency-request-digest-conflict',
+        );
+        throw new ProviderApprovalError(
+          'PROVIDER_APPROVAL_REPLAY_REJECTED',
+          'Idempotent retry does not match the original request digest.',
+          preflight,
+        );
+      }
+      await this.#approvals.recordSucceeded(approvalVerification, undefined);
+      return previous.response;
+    }
+
+    const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
+    if (status.state === 'unconfigured') {
+      await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
+      throw new MistralProviderError(
+        'PROVIDER_UNCONFIGURED',
+        'Mistral is not configured on this server.',
+      );
+    }
+
+    const providerDecision = resolveProviderDecision(request, [this.#provider], {
+      allowRemote: true,
+      blockedProviders: [],
+      blockedCapabilities: [],
+      requireLocalFor: [],
+    });
+    if (providerDecision.status !== 'selected') {
+      await this.#approvals.recordUnavailable(
+        approvalVerification,
+        providerDecision.reason ?? 'provider-not-eligible',
+      );
+      throw new MistralProviderError(
+        'REMOTE_PROCESSING_BLOCKED',
+        providerDecision.reason ?? 'Mistral is not eligible for this request.',
+      );
+    }
+
+    let approval: ProviderApprovalOutcome;
+    try {
+      approval = await this.#approvals.verify(approvalVerification);
+    } catch (error) {
+      if (error instanceof ProviderApprovalError) {
+        if (error.code === 'REMOTE_PROCESSING_BLOCKED') {
+          throw new MistralProviderError('REMOTE_PROCESSING_BLOCKED', error.message);
+        }
+        if (error.code === 'PROVIDER_APPROVAL_REQUIRED') {
+          throw error;
+        }
+        if (error.code === 'PROVIDER_SPEND_CAP_EXCEEDED') {
+          throw new MistralProviderError('PROVIDER_SPEND_APPROVAL_REQUIRED', error.message);
+        }
+      }
+      throw error;
+    }
+
+    this.#lifecycle.recordJobStart(MISTRAL_PROVIDER_ID);
+    try {
+      const providerResult = await this.#provider.invoke(
+        'llm.complete',
+        {
+          model: input.model,
+          messages: joyCodeReasoningMessages(input),
+          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
+          decisionId: providerDecision.decisionId,
+          responseFormat: joyCodeResponseFormat(),
+        },
+        request,
+      );
+      if (providerResult.status !== 'succeeded') {
+        const code = providerResult.diagnostics[0]?.code;
+        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
+        await this.#approvals.recordFailed(
+          approvalVerification,
+          approval.reservation,
+          code ?? 'provider-request-failed',
+        );
+        throw new MistralProviderError('MISTRAL_REQUEST_FAILED', 'Mistral completion failed.');
+      }
+      const approvedResult = withApprovalProvenance(
+        providerResult,
+        preflight.requestDigest,
+        approval,
+      );
+      const response = joyCodeResponseFromProviderResult(
+        input,
+        approvedResult,
+        providerDecision,
+        preflight,
+      );
+      this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
+      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
+      await this.#approvals.recordSucceeded(
+        approvalVerification,
+        approval.reservation,
+        approvedResult.usage?.cost,
+      );
+      this.#reasoningResults.set(resultKey, { requestDigest: preflight.requestDigest, response });
+      return response;
+    } catch (error) {
+      if (error instanceof MistralProviderError || error instanceof ProviderApprovalError) {
+        throw error;
+      }
+      this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
+      this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
+      await this.#approvals.recordFailed(
+        approvalVerification,
+        approval.reservation,
+        'provider-unavailable',
+      );
+      throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
+    }
+  }
 }
 
 export function createRuntimeMistralProviderRegistry(
   options: {
     readonly apiKey?: string;
     readonly ledger?: MistralInvocationLedger;
     readonly approvals?: ProviderApprovalService;
     readonly fetchImpl?: typeof fetch;
   } = {},
 ): MistralProviderRegistry {
@@ -322,20 +516,260 @@ function mistralCapabilityRequest(input: MistralCompletionRequest): CapabilityRe
       model: input.model,
       messages: input.messages,
       ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
       ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
     },
     constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
     idempotencyKey: input.idempotencyKey,
   };
 }
 
+function joyCodeCapabilityRequest(input: JoyCodeReasoningRequest): CapabilityRequest {
+  return {
+    requestVersion: 1,
+    capability: 'llm.complete',
+    input: {
+      model: input.model,
+      messages: joyCodeReasoningMessages(input),
+      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
+    },
+    constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
+    idempotencyKey: input.idempotencyKey,
+  };
+}
+
+function joyCodeReasoningMessages(input: JoyCodeReasoningRequest): readonly MistralChatMessage[] {
+  return [
+    {
+      role: 'system',
+      content:
+        'You are JOY Code reasoning. Return JSON only. Stay bounded to the provided evidence. Do not invent tools, commands, URLs, secrets, filesystem paths, or unsupported intents.',
+    },
+    {
+      role: 'user',
+      content: JSON.stringify({
+        goal: input.goal,
+        snapshotDigest: input.snapshotDigest,
+        projectRevision: input.projectRevision,
+        evidence: input.evidence,
+        allowedIntentIds: input.allowedIntentIds,
+      }),
+    },
+  ];
+}
+
+function joyCodeResponseFormat(): {
+  readonly type: 'json_schema';
+  readonly name: string;
+  readonly schema: Record<string, unknown>;
+  readonly strict: true;
+} {
+  return {
+    type: 'json_schema',
+    name: 'joy_code_reasoning',
+    strict: true,
+    schema: {
+      type: 'object',
+      additionalProperties: false,
+      required: ['brief'],
+      properties: {
+        brief: {
+          type: 'object',
+          additionalProperties: false,
+          required: ['summary', 'rationale', 'evidenceReferences'],
+          properties: {
+            summary: { type: 'string' },
+            rationale: { type: 'string' },
+            evidenceReferences: {
+              type: 'array',
+              items: { type: 'string' },
+            },
+            caution: { type: 'string' },
+          },
+        },
+        proposal: {
+          type: 'object',
+          additionalProperties: false,
+          required: ['intentId', 'summary', 'rationale', 'evidenceReferences'],
+          properties: {
+            intentId: { type: 'string' },
+            summary: { type: 'string' },
+            rationale: { type: 'string' },
+            evidenceReferences: {
+              type: 'array',
+              items: { type: 'string' },
+            },
+          },
+        },
+      },
+    },
+  };
+}
+
+function joyCodeResponseFromProviderResult(
+  input: JoyCodeReasoningRequest,
+  result: CapabilityResult,
+  decision: ProviderDecisionV1,
+  preflight: ReturnType<typeof computeProviderApprovalPreflight>,
+): JoyCodeReasoningResponse {
+  const rawText = result.outputs[0]?.metadata?.text;
+  if (typeof rawText !== 'string' || rawText.length === 0) {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      'Mistral structured output was empty.',
+    );
+  }
+  let parsed: unknown;
+  try {
+    parsed = JSON.parse(rawText);
+  } catch {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      'Mistral structured output was not valid JSON.',
+    );
+  }
+  if (!isRecord(parsed)) {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      'Mistral structured output was not an object.',
+    );
+  }
+  const knownEvidence = new Set(input.evidence.map((item) => item.evidenceId));
+  const brief = parseReasoningBrief(parsed.brief, knownEvidence, 'brief');
+  const proposal =
+    parsed.proposal === undefined
+      ? undefined
+      : parseReasoningProposal(parsed.proposal, knownEvidence, input.allowedIntentIds, 'proposal');
+  return {
+    responseVersion: 1,
+    requestId: result.requestId,
+    brief,
+    ...(proposal === undefined ? {} : { proposal }),
+    provider: {
+      providerId: MISTRAL_PROVIDER_ID,
+      modelId: input.model,
+      decisionRef: decision.decisionId,
+      briefRef: `reasoning-brief-${result.provenance.idempotencyKey}`,
+      requestDigest: preflight.requestDigest,
+      dataLeavesDevice: preflight.dataLeavesDevice,
+      ...(preflight.retentionDisclosure === undefined
+        ? {}
+        : { retentionDisclosure: preflight.retentionDisclosure }),
+      ...(result.usage === undefined
+        ? {}
+        : {
+            usage: {
+              ...(result.usage.inputTokens === undefined
+                ? {}
+                : { inputTokens: result.usage.inputTokens }),
+              ...(result.usage.outputTokens === undefined
+                ? {}
+                : { outputTokens: result.usage.outputTokens }),
+              ...(result.usage.budgetReservationId === undefined
+                ? {}
+                : { budgetReservationId: result.usage.budgetReservationId }),
+            },
+          }),
+    },
+  };
+}
+
+function parseReasoningBrief(
+  value: unknown,
+  knownEvidence: ReadonlySet<string>,
+  path: string,
+): JoyCodeReasoningResponse['brief'] {
+  if (!isRecord(value)) {
+    throw new MistralProviderError('MISTRAL_REQUEST_FAILED', `${path} must be an object.`);
+  }
+  const summary = boundedString(value.summary, `${path}.summary`, 400);
+  const rationale = boundedString(value.rationale, `${path}.rationale`, 800);
+  const evidenceReferences = parseEvidenceReferences(
+    value.evidenceReferences,
+    knownEvidence,
+    `${path}.evidenceReferences`,
+  );
+  const caution =
+    value.caution === undefined ? undefined : boundedString(value.caution, `${path}.caution`, 400);
+  return {
+    summary,
+    rationale,
+    evidenceReferences,
+    ...(caution === undefined ? {} : { caution }),
+  };
+}
+
+function parseReasoningProposal(
+  value: unknown,
+  knownEvidence: ReadonlySet<string>,
+  allowedIntentIds: readonly string[],
+  path: string,
+): NonNullable<JoyCodeReasoningResponse['proposal']> {
+  if (!isRecord(value)) {
+    throw new MistralProviderError('MISTRAL_REQUEST_FAILED', `${path} must be an object.`);
+  }
+  const intentId = boundedString(value.intentId, `${path}.intentId`, 128);
+  if (!allowedIntentIds.includes(intentId)) {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      `${path}.intentId must be in the bounded allowlist.`,
+    );
+  }
+  return {
+    intentId,
+    summary: boundedString(value.summary, `${path}.summary`, 400),
+    rationale: boundedString(value.rationale, `${path}.rationale`, 800),
+    evidenceReferences: parseEvidenceReferences(
+      value.evidenceReferences,
+      knownEvidence,
+      `${path}.evidenceReferences`,
+    ),
+  };
+}
+
+function parseEvidenceReferences(
+  value: unknown,
+  knownEvidence: ReadonlySet<string>,
+  path: string,
+): readonly string[] {
+  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      `${path} must contain between 1 and 8 evidence references.`,
+    );
+  }
+  const refs = value.map((item) => boundedString(item, path, 128));
+  for (const ref of refs) {
+    if (!knownEvidence.has(ref)) {
+      throw new MistralProviderError(
+        'MISTRAL_REQUEST_FAILED',
+        `${path} contains unknown evidence ${ref}.`,
+      );
+    }
+  }
+  return refs;
+}
+
+function boundedString(value: unknown, path: string, maxLength: number): string {
+  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
+    throw new MistralProviderError(
+      'MISTRAL_REQUEST_FAILED',
+      `${path} must be a non-empty string of at most ${String(maxLength)} characters.`,
+    );
+  }
+  return value.trim();
+}
+
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return value !== null && typeof value === 'object' && !Array.isArray(value);
+}
+
 function withApprovalProvenance(
   result: CapabilityResult,
   requestDigest: string,
   approval: ProviderApprovalOutcome,
 ): CapabilityResult {
   return {
     ...result,
     provenance: {
       ...result.provenance,
       requestHash: requestDigest,
diff --git a/apps/editor-web/src/AgentPanel.tsx b/apps/editor-web/src/AgentPanel.tsx
index 5e59eed..944c521 100644
--- a/apps/editor-web/src/AgentPanel.tsx
+++ b/apps/editor-web/src/AgentPanel.tsx
@@ -15,30 +15,36 @@ import {
   dryRunPlan,
   buildEditorContext,
   runPlanAtomically,
   RevisionConflictError,
 } from '@joy-media/agent-tools';
 import type { AgentActor, AtomicRunResult, ProjectRevisionId } from '@joy-media/agent-tools';
 import {
   AGENT_INTENTS,
   buildShortenIntroRecipe,
   buildSplitTrimRecipe,
+  findClipLocation,
   type AgentIntent,
 } from './agent-panel-intents.js';
 import { AgentTimelineCanvas } from './AgentTimelineCanvas.js';
 import { extractPendingChanges } from './agent-plan-visualizer.js';
 import { saveWorkflow } from './workflow-recorder.js';
 import type { EditorSession } from './editor-session.js';
 import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import type { AgentSettings } from './agent-settings.js';
 import { approvalPolicyForAgentSettings } from './agent-settings.js';
+import {
+  BrowserControlPlaneClient,
+  type BrowserJoyCodeReasoningRequest,
+  type BrowserJoyCodeReasoningResponse,
+} from './control-plane-client.js';
 import { JoyCodeLogo } from './JoyCodeLogo.js';
 import { JoyCode3DViewer } from './JoyCode3DViewer.js';
 import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
 import {
   addJoyCodeMessage,
   createJoyCodeThread,
   loadJoyCodeThreads,
   matchJoyCodeIntentId,
   saveJoyCodeThreads,
   setJoyCodeThreadStatus,
@@ -57,36 +63,39 @@ const TABS: readonly PanelTabSpec[] = [
 ];
 
 interface PendingPlan {
   readonly threadId: string;
   readonly intent: AgentIntent;
   readonly plan: AgentEditPlan;
   readonly baseRevision: ProjectRevisionId;
   readonly baseProject: SpikeProject;
   readonly dryRun: DryRunResult;
   readonly approval: ApprovalDecision;
+  readonly reasoning?: BrowserJoyCodeReasoningResponse;
 }
 
 interface LastRun {
   readonly threadId: string;
   readonly intent: AgentIntent;
   readonly plan: AgentEditPlan;
   readonly executionResult: ExecutionResult;
   readonly reverted: boolean;
   readonly savedWorkflowId?: string;
 }
 
 interface JoyCodeState {
   readonly threads: readonly JoyCodeThread[];
   readonly activeThreadId: string;
 }
 
+export type JoyCodeReasoningResponse = BrowserJoyCodeReasoningResponse;
+
 export interface KiloCodeAttachedAsset {
   readonly assetId: string;
   readonly kind: 'image' | 'video' | 'markdown';
   readonly displayName: string;
   /** Present when the file lives under OPFS joy-media-assets/joycode/. */
   readonly source?: 'joycode-folder';
 }
 
 export type AgentPanelCommandType = 'new-task' | 'activity' | 'stop';
 export interface AgentPanelCommand {
@@ -189,20 +198,199 @@ export function ProviderApprovalDetails({ approval }: { readonly approval: Appro
         </div>
       )}
       <div>
         <dt>Approval</dt>
         <dd>{provider.requestDigest}</dd>
       </div>
     </dl>
   );
 }
 
+export function JoyCodeReasoningDetails({
+  reasoning,
+}: {
+  readonly reasoning: BrowserJoyCodeReasoningResponse;
+}) {
+  const usage = reasoning.provider.usage;
+  return (
+    <dl className="joy-code-provider-approval" aria-label="Joy Code reasoning details">
+      <div>
+        <dt>Provider</dt>
+        <dd>{reasoning.provider.providerId}</dd>
+      </div>
+      <div>
+        <dt>Model</dt>
+        <dd>{reasoning.provider.modelId}</dd>
+      </div>
+      <div>
+        <dt>Decision</dt>
+        <dd>{reasoning.provider.decisionRef}</dd>
+      </div>
+      <div>
+        <dt>Brief</dt>
+        <dd>{reasoning.provider.briefRef}</dd>
+      </div>
+      {usage !== undefined && (
+        <div>
+          <dt>Usage</dt>
+          <dd>
+            {(usage.inputTokens ?? 0).toLocaleString()} in /{' '}
+            {(usage.outputTokens ?? 0).toLocaleString()} out
+          </dd>
+        </div>
+      )}
+    </dl>
+  );
+}
+
+function shortHash(value: unknown): string {
+  const text = stableJson(value);
+  let hash = 0x811c9dc5;
+  for (let index = 0; index < text.length; index++) {
+    hash ^= text.charCodeAt(index);
+    hash = Math.imul(hash, 0x01000193);
+  }
+  return `fnv1a-${(hash >>> 0).toString(16)}`;
+}
+
+function stableJson(value: unknown): string {
+  if (value === null || typeof value !== 'object') return JSON.stringify(value);
+  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
+  const record = value as Record<string, unknown>;
+  return `{${Object.keys(record)
+    .sort()
+    .filter((key) => record[key] !== undefined)
+    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
+    .join(',')}}`;
+}
+
+function selectedClipEvidence(
+  project: SpikeProject,
+  selectedClipIds: readonly string[],
+): ReadonlyArray<BrowserJoyCodeReasoningRequest['evidence'][number]> {
+  return selectedClipIds.flatMap((clipId) => {
+    const location = findClipLocation(project, clipId);
+    if (location === undefined) return [];
+    return [
+      {
+        evidenceId: `clip:${clipId}`,
+        kind: 'selected-clip' as const,
+        label: location.clip.id,
+        detail: `${location.compositionId}/${location.trackId} from ${location.clip.startUs}us for ${location.clip.durationUs}us`,
+      },
+    ];
+  });
+}
+
+export function buildJoyCodeReasoningRequest(args: {
+  readonly project: SpikeProject;
+  readonly selectedClipIds: readonly string[];
+  readonly playheadUs: number;
+  readonly attachedAssets: readonly KiloCodeAttachedAsset[];
+  readonly settings: Pick<AgentSettings, 'reasoningModel' | 'privacyMode'>;
+  readonly projectRevision: ProjectRevisionId;
+  readonly goal: string;
+}): BrowserJoyCodeReasoningRequest {
+  const evidence = [
+    ...selectedClipEvidence(args.project, args.selectedClipIds),
+    ...args.attachedAssets.map((asset) => ({
+      evidenceId: `asset:${asset.assetId}`,
+      kind: 'attached-asset' as const,
+      label: asset.displayName,
+      detail: `${asset.kind} asset ${asset.assetId}`,
+    })),
+    {
+      evidenceId: `playhead:${args.playheadUs}`,
+      kind: 'timeline-range' as const,
+      label: 'Playhead',
+      detail: `Current playhead at ${args.playheadUs}us`,
+    },
+  ];
+  return {
+    model: args.settings.reasoningModel || 'mistral-small-latest',
+    goal: args.goal.trim(),
+    snapshotDigest: shortHash({
+      projectId: args.project.id,
+      projectRevision: args.projectRevision,
+      selectedClipIds: args.selectedClipIds,
+      playheadUs: args.playheadUs,
+      evidence,
+    }),
+    projectRevision: args.projectRevision,
+    idempotencyKey: makeJoyCodeId('reasoning'),
+    privacyMode: args.settings.privacyMode,
+    evidence,
+    allowedIntentIds: AGENT_INTENTS.map((intent) => intent.id),
+    maxTokens: 600,
+  };
+}
+
+export function buildPendingPlanFromJoyCodeProposal(args: {
+  readonly response: BrowserJoyCodeReasoningResponse;
+  readonly project: SpikeProject;
+  readonly selectedClipIds: readonly string[];
+  readonly playheadUs: number;
+  readonly baseRevision: ProjectRevisionId;
+  readonly registry: ReturnType<typeof createToolRegistry>;
+  readonly approvalEngine: ApprovalEngine;
+  readonly agentContext: EditorContext;
+}): PendingPlan | undefined {
+  const intentId = args.response.proposal?.intentId;
+  if (intentId === undefined) return undefined;
+  const intent = AGENT_INTENTS.find((candidate) => candidate.id === intentId);
+  if (intent === undefined) return undefined;
+  const built =
+    intent.id === 'recipe-split-trim'
+      ? buildSplitTrimRecipe(args.project, args.selectedClipIds, args.playheadUs)
+      : intent.id === 'shorten-intro'
+        ? buildShortenIntroRecipe(args.project)
+        : (() => {
+            const single = intent.buildStep(args.project, args.selectedClipIds, args.playheadUs);
+            if (!single.ok) return single;
+            return { ok: true as const, steps: [single.step], goal: intent.label };
+          })();
+  if (!built.ok) return undefined;
+  const plan = createPlan(built.goal, [...built.steps]);
+  const dryRun = dryRunPlan(plan, args.registry, buildEditorContext(args.project));
+  const approval =
+    selectJoyCodePendingApproval(
+      args.approvalEngine.evaluatePlan(
+        plan,
+        args.agentContext,
+        (toolName) => args.registry.tools.get(toolName)?.scope,
+      ),
+    ) ??
+    ({
+      decision: 'blocked',
+      reason: 'No approval decision was produced.',
+      request: {
+        id: 'approval-missing',
+        stepId: 'plan',
+        reason: 'unresolved-assumptions',
+        description: 'No approval decision was produced.',
+        privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
+        isReversible: true,
+        status: 'pending',
+      },
+    } satisfies ApprovalDecision);
+  return {
+    threadId: 'reasoning-proposal',
+    intent,
+    plan,
+    baseRevision: args.baseRevision,
+    baseProject: args.project,
+    dryRun,
+    approval,
+    reasoning: args.response,
+  };
+}
+
 function threadTimestamp(value: string): string {
   const date = new Date(value);
   if (Number.isNaN(date.getTime())) return '';
   return new Intl.DateTimeFormat(undefined, {
     month: 'short',
     day: 'numeric',
     hour: '2-digit',
     minute: '2-digit',
   }).format(date);
 }
@@ -231,27 +419,31 @@ export function AgentPanel({
   readonly agentContext: EditorContext;
   readonly onUndo: () => void;
   readonly session: EditorSession;
   readonly attachedAssets?: readonly KiloCodeAttachedAsset[];
   readonly onDetachAsset?: (assetId: string) => void;
   readonly onAttachAsset?: (asset: KiloCodeAttachedAsset) => void;
   readonly settings: AgentSettings;
   readonly command?: AgentPanelCommand;
 }) {
   const registry = useMemo(() => createToolRegistry(), []);
+  const controlPlaneClient = useMemo(() => new BrowserControlPlaneClient(), []);
   const auditRef = useRef(createAuditTrail());
   const handledCommandRef = useRef<number | undefined>(undefined);
   const thinkingTimerRef = useRef<number | undefined>(undefined);
   const messagesEndRef = useRef<HTMLDivElement>(null);
   const attachInputRef = useRef<HTMLInputElement>(null);
   const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
   const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
+  const [lastReasoning, setLastReasoning] = useState<BrowserJoyCodeReasoningResponse | undefined>(
+    undefined,
+  );
   const [thinkingThreadId, setThinkingThreadId] = useState<string | undefined>(undefined);
   const [tab, setTab] = useState('composer');
   const [draft, setDraft] = useState('');
   const [attachError, setAttachError] = useState<string | undefined>(undefined);
   const [attaching, setAttaching] = useState(false);
   const [joyCode, setJoyCode] = useState<JoyCodeState>(() => initialJoyCodeState(project.id));
 
   const approvalEngine = useMemo(
     () => new ApprovalEngine(approvalPolicyForAgentSettings(settings)),
     [settings],
@@ -308,20 +500,21 @@ export function AgentPanel({
       thinkingTimerRef.current = undefined;
     }
     const now = new Date().toISOString();
     const thread = createJoyCodeThread(makeJoyCodeId('task'), now);
     setJoyCode((current) => ({
       threads: [thread, ...current.threads],
       activeThreadId: thread.id,
     }));
     setPending(undefined);
     setLastRun(undefined);
+    setLastReasoning(undefined);
     setThinkingThreadId(undefined);
     setDraft('');
     setTab('composer');
   }
 
   function appendMessage(threadId: string, role: 'user' | 'assistant', body: string): void {
     const now = new Date().toISOString();
     setJoyCode((current) => ({
       ...current,
       threads: addJoyCodeMessage(current.threads, threadId, {
@@ -353,21 +546,25 @@ export function AgentPanel({
             if (!recipe.ok) return recipe;
             return { ok: true as const, steps: recipe.steps, goal: recipe.goal };
           })()
         : (() => {
             const single = intent.buildStep(project, selectedClipIds, playheadUs);
             if (!single.ok) return single;
             return { ok: true as const, steps: [single.step], goal: intent.label };
           })();
   }
 
-  function plan(intent: AgentIntent, threadId: string) {
+  function plan(
+    intent: AgentIntent,
+    threadId: string,
+    reasoning?: BrowserJoyCodeReasoningResponse,
+  ) {
     const baseRevision = session.projectRevisionId;
     const baseProject = project;
     const built = buildIntent(intent);
     if (!built.ok) {
       appendMessage(threadId, 'assistant', built.reason);
       return;
     }
     const agentPlan = createPlan(built.goal, [...built.steps]);
     const dryRun = dryRunPlan(agentPlan, registry, buildEditorContext(baseProject));
     const decisions = approvalEngine.evaluatePlan(
@@ -393,25 +590,86 @@ export function AgentPanel({
       userId: 'local-owner',
       metadata: { summary: dryRun.aggregateDiff.summary, decision: approval.decision },
     });
     appendMessage(
       threadId,
       'assistant',
       approval.decision === 'blocked'
         ? `برنامه آماده شد، اما سیاست اجرایی آن را مسدود کرد: ${approval.reason}`
         : `برنامهٔ «${intent.label}» آماده شد. اجرای آزمایشی: ${dryRun.aggregateDiff.summary}. تغییر زیر را بررسی کنید.`,
     );
-    setPending({ threadId, intent, plan: agentPlan, baseRevision, baseProject, dryRun, approval });
+    setPending({
+      threadId,
+      intent,
+      plan: agentPlan,
+      baseRevision,
+      baseProject,
+      dryRun,
+      approval,
+      ...(reasoning === undefined ? {} : { reasoning }),
+    });
+    if (reasoning !== undefined) setLastReasoning(reasoning);
     setLastRun(undefined);
     updateThreadStatus(threadId, 'planning');
   }
 
+  async function requestReasoning(prompt: string, threadId: string): Promise<void> {
+    if (settings.reasoningModel === '') {
+      appendMessage(
+        threadId,
+        'assistant',
+        'Joy Code اکنون درخواست‌های مستقیم تایم‌لاین را می‌پذیرد. برای نقد یا پیشنهاد bounded، ابتدا یک مدل reasoning را در Agent Settings انتخاب کنید.',
+      );
+      return;
+    }
+    const request = buildJoyCodeReasoningRequest({
+      project,
+      selectedClipIds,
+      playheadUs,
+      attachedAssets,
+      settings,
+      projectRevision: session.projectRevisionId,
+      goal: prompt,
+    });
+    try {
+      const reasoning = await controlPlaneClient.joyCodeReasoning(request);
+      setLastReasoning(reasoning);
+      appendMessage(threadId, 'assistant', reasoning.brief.summary);
+      if (reasoning.proposal !== undefined) {
+        const proposalPlan = buildPendingPlanFromJoyCodeProposal({
+          response: reasoning,
+          project,
+          selectedClipIds,
+          playheadUs,
+          baseRevision: session.projectRevisionId,
+          registry,
+          approvalEngine,
+          agentContext,
+        });
+        if (proposalPlan !== undefined) {
+          setPending({ ...proposalPlan, threadId });
+          setLastRun(undefined);
+          updateThreadStatus(threadId, 'planning');
+          return;
+        }
+      }
+      updateThreadStatus(threadId, 'draft');
+    } catch (error) {
+      appendMessage(
+        threadId,
+        'assistant',
+        error instanceof Error ? error.message : 'Bounded reasoning is unavailable right now.',
+      );
+      updateThreadStatus(threadId, 'failed');
+    }
+  }
+
   function submitPrompt(prompt: string) {
     const body = prompt.trim();
     if (body.length === 0 || activeThread === undefined || thinkingThreadId !== undefined) return;
     const threadId = activeThread.id;
     setDraft('');
     setTab('composer');
     appendMessage(threadId, 'user', body);
     if (pending !== undefined) {
       appendMessage(
         threadId,
@@ -427,23 +685,32 @@ export function AgentPanel({
         threadId,
         'assistant',
         'Joy Code اکنون درخواست‌های مستقیم تایم‌لاین مانند کوتاه‌کردن مقدمه، برش، جابه‌جایی، اتصال، افزودن یا حذف کلیپ را می‌پذیرد. پس از اتصال آداپتور نشست سرور، پاسخ آزاد KiloCode نیز اینجا نمایش داده می‌شود.',
       );
       return;
     }
     setThinkingThreadId(threadId);
     thinkingTimerRef.current = window.setTimeout(() => {
       thinkingTimerRef.current = undefined;
       try {
-        plan(intent, threadId);
+        if (intent !== undefined) {
+          plan(intent, threadId);
+          return;
+        }
+        void requestReasoning(body, threadId).finally(() => {
+          setThinkingThreadId((current) => (current === threadId ? undefined : current));
+        });
+        return;
       } finally {
-        setThinkingThreadId((current) => (current === threadId ? undefined : current));
+        if (intent !== undefined) {
+          setThinkingThreadId((current) => (current === threadId ? undefined : current));
+        }
       }
     }, THINKING_REVEAL_MS);
   }
 
   function reject() {
     if (pending === undefined) return;
     auditRef.current.record({
       planId: pending.plan.planId,
       action: 'plan-rejected',
       userId: 'local-owner',
@@ -773,20 +1040,28 @@ export function AgentPanel({
                     pendingChanges={pendingChanges}
                     width={400}
                     height={120}
                   />
                   {pending.dryRun.errors.length > 0 && (
                     <p className="agent-error">
                       Dry-run errors: {pending.dryRun.errors.join(', ')}
                     </p>
                   )}
                   <span className="joy-code-plan-reason">{pending.approval.reason}</span>
+                  {pending.reasoning !== undefined && (
+                    <>
+                      <p>
+                        {pending.reasoning.proposal?.summary ?? pending.reasoning.brief.summary}
+                      </p>
+                      <JoyCodeReasoningDetails reasoning={pending.reasoning} />
+                    </>
+                  )}
                   <ProviderApprovalDetails approval={pending.approval} />
                   <div className="joy-code-plan-actions">
                     {pending.approval.decision === 'blocked' && (
                       <button type="button" onClick={reject}>
                         Dismiss
                       </button>
                     )}
                     {pending.approval.decision === 'requires-manual' && (
                       <>
                         <button
@@ -848,20 +1123,32 @@ export function AgentPanel({
                     <p className="agent-error">{lastRun.executionResult.errors.join(', ')}</p>
                   )}
                   {lastRun.reverted && <p lang="fa">بازگردانی شد.</p>}
                   {lastRun.savedWorkflowId !== undefined && (
                     <p lang="fa">
                       با شناسهٔ <bdi>{lastRun.savedWorkflowId}</bdi> ذخیره شد.
                     </p>
                   )}
                 </section>
               )}
+              {lastReasoning !== undefined &&
+                lastReasoning.proposal === undefined &&
+                pending?.threadId !== activeThread?.id && (
+                  <section className="joy-code-run-card" aria-label="Last Joy Code critique">
+                    <div>
+                      <strong>Bounded critique</strong>
+                      <span>{lastReasoning.brief.summary}</span>
+                    </div>
+                    <p>{lastReasoning.brief.rationale}</p>
+                    <JoyCodeReasoningDetails reasoning={lastReasoning} />
+                  </section>
+                )}
               <div ref={messagesEndRef} />
             </div>
 
             <div className="joy-code-compose-dock">
               {attachedAssets.length > 0 && (
                 <ul className="joy-code-attachments" aria-label="Attached media">
                   {attachedAssets.map((asset) => (
                     <li key={asset.assetId}>
                       <span>{asset.kind}</span>
                       <strong title={asset.assetId}>{asset.displayName}</strong>
diff --git a/apps/editor-web/src/control-plane-client.ts b/apps/editor-web/src/control-plane-client.ts
index 2e97aa6..ed5d8f1 100644
--- a/apps/editor-web/src/control-plane-client.ts
+++ b/apps/editor-web/src/control-plane-client.ts
@@ -120,20 +120,71 @@ export interface BrowserReasoningProvider {
   readonly state:
     'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';
   readonly models: readonly {
     readonly id: string;
     readonly displayName: string;
     readonly version?: string;
   }[];
   readonly adapterVersion: string;
 }
 
+export interface BrowserJoyCodeReasoningEvidence {
+  readonly evidenceId: string;
+  readonly kind: 'selected-clip' | 'attached-asset' | 'timeline-range' | 'project-summary';
+  readonly label: string;
+  readonly detail: string;
+}
+
+export interface BrowserJoyCodeReasoningRequest {
+  readonly model: string;
+  readonly goal: string;
+  readonly snapshotDigest: string;
+  readonly projectRevision: string;
+  readonly idempotencyKey: string;
+  readonly privacyMode: 'local-only' | 'ask-before-remote';
+  readonly evidence: readonly BrowserJoyCodeReasoningEvidence[];
+  readonly allowedIntentIds: readonly string[];
+  readonly providerApprovalGrant?: Record<string, unknown>;
+  readonly maxTokens?: number;
+}
+
+export interface BrowserJoyCodeReasoningResponse {
+  readonly responseVersion: 1;
+  readonly requestId: string;
+  readonly brief: {
+    readonly summary: string;
+    readonly rationale: string;
+    readonly evidenceReferences: readonly string[];
+    readonly caution?: string;
+  };
+  readonly proposal?: {
+    readonly intentId: string;
+    readonly summary: string;
+    readonly rationale: string;
+    readonly evidenceReferences: readonly string[];
+  };
+  readonly provider: {
+    readonly providerId: string;
+    readonly modelId: string;
+    readonly decisionRef: string;
+    readonly briefRef: string;
+    readonly requestDigest: string;
+    readonly dataLeavesDevice: boolean;
+    readonly retentionDisclosure?: string;
+    readonly usage?: {
+      readonly inputTokens?: number;
+      readonly outputTokens?: number;
+      readonly budgetReservationId?: string;
+    };
+  };
+}
+
 export interface BrowserAssetRegistration {
   readonly id: string;
   readonly kind: BrowserAsset['kind'];
   readonly displayName: string;
   readonly sha256: string;
   readonly bytes: number;
   readonly descriptor: BrowserMediaDescriptor;
   readonly locations: readonly { readonly kind: 'opfs-cache'; readonly ref: string }[];
 }
 
@@ -188,20 +239,25 @@ export class BrowserControlPlaneClient {
   async myAssets(): Promise<readonly BrowserAsset[]> {
     return this.get('/v1/library/my-assets');
   }
   /** Safe catalog only: model IDs and lifecycle state, never secret references or values. */
   async reasoningProviders(): Promise<readonly BrowserReasoningProvider[]> {
     const data = await this.get<{ readonly providers: readonly BrowserReasoningProvider[] }>(
       '/v1/providers/reasoning',
     );
     return data.providers;
   }
+  async joyCodeReasoning(
+    input: BrowserJoyCodeReasoningRequest,
+  ): Promise<BrowserJoyCodeReasoningResponse> {
+    return this.post('/v1/providers/reasoning/joy-code', input);
+  }
   /** Fetch cloud-backed original bytes for any logged-in Joy user. */
   async sharedCloudOriginalBytes(assetId: string): Promise<Blob> {
     const token = await this.assertion();
     const response = await fetch(
       `${this.apiUrl.replace(/\/$/, '')}/v1/library/cloud-assets/${encodeURIComponent(assetId)}/content`,
       { method: 'GET', headers: { authorization: `Bearer ${token}` } },
     );
     if (response.status === 401 || response.status === 403)
       throw new DerivativeAuthorityRevokedError();
     if (!response.ok) throw new Error(`cloud original request failed (${response.status})`);
diff --git a/apps/editor-web/src/joy-code-critique.test.tsx b/apps/editor-web/src/joy-code-critique.test.tsx
new file mode 100644
index 0000000..a6eec10
--- /dev/null
+++ b/apps/editor-web/src/joy-code-critique.test.tsx
@@ -0,0 +1,162 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
+import {
+  ApprovalEngine,
+  buildEditorContext,
+  createIdempotencyStore,
+  createPreviewAndApprovePolicy,
+  createToolRegistry,
+  runPlanAtomically,
+} from '@joy-media/agent-tools';
+import {
+  JoyCodeReasoningDetails,
+  buildJoyCodeReasoningRequest,
+  buildPendingPlanFromJoyCodeProposal,
+  type JoyCodeReasoningResponse,
+} from './AgentPanel.js';
+
+describe('Joy Code critique helpers', () => {
+  it('keeps read-only critique responses bounded to evidence and leaves the revision unchanged', () => {
+    const project = buildReferenceSpikeProject();
+    const revision = 'local-revision:v1:project:timeline=1:document=1:graph=0:artifacts=0';
+    const request = buildJoyCodeReasoningRequest({
+      project,
+      selectedClipIds: ['intro'],
+      playheadUs: 5_000_000,
+      attachedAssets: [],
+      settings: {
+        reasoningModel: 'mistral-small-latest',
+        privacyMode: 'ask-before-remote',
+      },
+      projectRevision: revision,
+      goal: 'Critique the opening pacing only.',
+    });
+
+    expect(request.evidence).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          evidenceId: 'clip:intro',
+          kind: 'selected-clip',
+        }),
+        expect.objectContaining({
+          evidenceId: 'playhead:5000000',
+          kind: 'timeline-range',
+        }),
+      ]),
+    );
+    expect(request.snapshotDigest).toMatch(/^fnv1a-[a-f0-9]+$/);
+
+    const response: JoyCodeReasoningResponse = {
+      responseVersion: 1,
+      requestId: 'joy-code-critique-1',
+      brief: {
+        summary: 'The opening repeats setup beats before the product arrives.',
+        rationale: 'The cited intro evidence supports a read-only pacing critique.',
+        evidenceReferences: ['clip:intro'],
+      },
+      provider: {
+        providerId: 'mistral',
+        modelId: 'mistral-small-latest',
+        decisionRef: 'provider-decision-joy-code-critique-1',
+        briefRef: 'reasoning-brief-joy-code-critique-1',
+        requestDigest: 'sha256:critique',
+        dataLeavesDevice: true,
+        retentionDisclosure: 'Prompt text is sent to Mistral for remote processing.',
+        usage: { inputTokens: 9, outputTokens: 7 },
+      },
+    };
+
+    const html = renderToStaticMarkup(<JoyCodeReasoningDetails reasoning={response} />);
+    expect(html).toContain('mistral-small-latest');
+    expect(html).toContain('provider-decision-joy-code-critique-1');
+    expect(html).toContain('reasoning-brief-joy-code-critique-1');
+    expect(html).toContain('9 in / 7 out');
+
+    expect(
+      buildPendingPlanFromJoyCodeProposal({
+        response,
+        project,
+        selectedClipIds: ['intro'],
+        playheadUs: 5_000_000,
+        baseRevision: revision,
+        registry: createToolRegistry(),
+        approvalEngine: new ApprovalEngine(createPreviewAndApprovePolicy()),
+        agentContext: buildEditorContext(project),
+      }),
+    ).toBeUndefined();
+    expect(revision).toBe(request.projectRevision);
+  });
+
+  it('keeps proposed edits as a dry-run plan until approval, then commits them as one transaction', () => {
+    const project = buildReferenceSpikeProject();
+    const registry = createToolRegistry();
+    const approvalEngine = new ApprovalEngine(createPreviewAndApprovePolicy());
+    const response: JoyCodeReasoningResponse = {
+      responseVersion: 1,
+      requestId: 'joy-code-proposal-1',
+      brief: {
+        summary: 'The intro can be shortened while keeping the narrative intact.',
+        rationale: 'The bounded intro evidence supports a small pacing trim.',
+        evidenceReferences: ['clip:intro'],
+      },
+      proposal: {
+        intentId: 'shorten-intro',
+        summary: 'Shorten the intro by 2 seconds.',
+        rationale: 'Trim only the intro section cited in evidence.',
+        evidenceReferences: ['clip:intro'],
+      },
+      provider: {
+        providerId: 'mistral',
+        modelId: 'mistral-small-latest',
+        decisionRef: 'provider-decision-joy-code-proposal-1',
+        briefRef: 'reasoning-brief-joy-code-proposal-1',
+        requestDigest: 'sha256:proposal',
+        dataLeavesDevice: true,
+        usage: { inputTokens: 12, outputTokens: 10 },
+      },
+    };
+
+    const pending = buildPendingPlanFromJoyCodeProposal({
+      response,
+      project,
+      selectedClipIds: ['intro'],
+      playheadUs: 5_000_000,
+      baseRevision: 'rev-joy-code-1',
+      registry,
+      approvalEngine,
+      agentContext: buildEditorContext(project),
+    });
+
+    expect(pending).toBeDefined();
+    expect(pending?.intent.id).toBe('shorten-intro');
+    expect(pending?.dryRun.aggregateDiff.summary).toContain('clip(s) modified');
+    expect(pending?.approval.decision).toBe('requires-manual');
+    expect(pending?.reasoning?.proposal?.intentId).toBe('shorten-intro');
+
+    const commits: { label: string; commands: readonly unknown[] }[] = [];
+    const atomic = runPlanAtomically(pending!.plan, {
+      registry,
+      approvalEngine,
+      actor: { type: 'agent', id: 'kilocode' },
+      projectId: project.id,
+      baseRevision: pending!.baseRevision,
+      baseProject: project,
+      contextFor: (staged) => buildEditorContext(staged),
+      currentRevision: () => pending!.baseRevision,
+      idempotency: createIdempotencyStore(),
+      manualApproval: {
+        planId: pending!.plan.planId,
+        approvedAt: '2026-08-22T00:00:00.000Z',
+      },
+      commit: (transaction) => {
+        commits.push(transaction);
+        return { success: true };
+      },
+    });
+
+    expect(atomic.committed).toBe(true);
+    expect(commits).toHaveLength(1);
+    expect(commits[0]?.commands.length).toBeGreaterThan(1);
+  });
+});
diff --git a/packages/adapter-mistral/src/index.test.ts b/packages/adapter-mistral/src/index.test.ts
index 8a598de..4296a6e 100644
--- a/packages/adapter-mistral/src/index.test.ts
+++ b/packages/adapter-mistral/src/index.test.ts
@@ -31,20 +31,72 @@ describe('Mistral adapter', () => {
       },
     );
 
     expect(result.status).toBe('succeeded');
     expect(result.provenance.idempotencyKey).toBe('key-1');
     expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 5 });
     expect(await request?.text()).not.toContain('test-only-secret');
     expect(JSON.stringify(adapter.manifest)).not.toContain('test-only-secret');
   });
 
+  it('passes bounded json-schema formatting through to Mistral and keeps provider decision ids in provenance', async () => {
+    let request: Request | undefined;
+    const adapter = createMistralAdapter({
+      apiKey: 'test-only-secret',
+      fetchImpl: async (input, init) => {
+        request = new Request(input, init);
+        return new Response(
+          JSON.stringify({
+            choices: [{ message: { content: '{"ok":true}' } }],
+            usage: { prompt_tokens: 12, completion_tokens: 9 },
+          }),
+        );
+      },
+    });
+
+    const result = await adapter.invoke(
+      'llm.complete',
+      {
+        model: MISTRAL_REASONING_MODELS[0]!.id,
+        messages: [{ role: 'user', content: 'Return structured JSON only.' }],
+        decisionId: 'provider-decision-joy-code-1',
+        responseFormat: {
+          type: 'json_schema',
+          name: 'joy_code_reasoning',
+          schema: {
+            type: 'object',
+            additionalProperties: false,
+            properties: {
+              ok: { type: 'boolean' },
+            },
+            required: ['ok'],
+          },
+          strict: true,
+        },
+      },
+      {
+        requestVersion: 1,
+        capability: 'llm.complete',
+        input: {},
+        constraints: {},
+        idempotencyKey: 'key-structured-1',
+      },
+    );
+
+    expect(result.status).toBe('succeeded');
+    expect(result.provenance.providerDecisionId).toBe('provider-decision-joy-code-1');
+    const requestBody = await request?.text();
+    expect(requestBody).toContain('"response_format"');
+    expect(requestBody).toContain('"json_schema"');
+    expect(requestBody).toContain('"joy_code_reasoning"');
+  });
+
   it('fails closed before network access for an unallowlisted model', async () => {
     const adapter = createMistralAdapter({
       apiKey: 'test-only-secret',
       fetchImpl: async () => {
         throw new Error('network must not be reached');
       },
     });
     const result = await adapter.invoke('llm.complete', {
       model: 'not-allowed',
       messages: [{ role: 'user', content: 'hello' }],
diff --git a/packages/adapter-mistral/src/index.ts b/packages/adapter-mistral/src/index.ts
index 652c6c6..04b2e89 100644
--- a/packages/adapter-mistral/src/index.ts
+++ b/packages/adapter-mistral/src/index.ts
@@ -1,16 +1,17 @@
 import type {
   CapabilityDeclaration,
   CapabilityId,
   CapabilityRequest,
   CapabilityResult,
   Diagnostic,
+  JsonSchema,
   ModelDescriptor,
   ProviderManifestV2,
   ProviderUsage,
   ProviderV2,
 } from '@joy-media/provider-sdk';
 
 export const MISTRAL_PROVIDER_ID = 'mistral' as const;
 export const MISTRAL_ADAPTER_VERSION = '1.0.0' as const;
 
 /** The initial, deliberately small allowlist for JOY Code reasoning. */
@@ -25,20 +26,27 @@ export const MISTRAL_REASONING_MODELS: readonly ModelDescriptor[] = [
 export interface MistralChatMessage {
   readonly role: 'system' | 'user' | 'assistant';
   readonly content: string;
 }
 
 export interface MistralCompletionInput {
   readonly model: string;
   readonly messages: readonly MistralChatMessage[];
   readonly maxTokens?: number;
   readonly temperature?: number;
+  readonly decisionId?: string;
+  readonly responseFormat?: {
+    readonly type: 'json_schema';
+    readonly name: string;
+    readonly schema: JsonSchema;
+    readonly strict?: boolean;
+  };
 }
 
 export interface MistralAdapterOptions {
   /** Resolved by the API process only. Never pass this across a browser boundary. */
   readonly apiKey: string;
   readonly fetchImpl?: typeof fetch;
   readonly endpoint?: string;
   readonly timeoutMs?: number;
 }
 
@@ -74,30 +82,34 @@ export function createMistralAdapter(options: MistralAdapterOptions): ProviderV2
     manifest,
     async invoke(
       capability: CapabilityId,
       input: unknown,
       request?: CapabilityRequest,
     ): Promise<CapabilityResult> {
       const startedAt = Date.now();
       const requestId = `mistral-${crypto.randomUUID()}`;
       const idempotencyKey = request?.idempotencyKey ?? requestId;
       const parsed = parseInput(input);
-      const provenance = (modelId: string) => ({
-        providerId: MISTRAL_PROVIDER_ID,
-        modelId,
-        adapterVersion: MISTRAL_ADAPTER_VERSION,
-        createdAt: new Date().toISOString(),
-        requestHash: hashRequest({ input, idempotencyKey }),
-        idempotencyKey,
-        processingTimeMs: Date.now() - startedAt,
-        execution: 'remote-api' as const,
-      });
+      const provenance = (modelId: string) =>
+        withProviderDecisionId(
+          {
+            providerId: MISTRAL_PROVIDER_ID,
+            modelId,
+            adapterVersion: MISTRAL_ADAPTER_VERSION,
+            createdAt: new Date().toISOString(),
+            requestHash: hashRequest({ input, idempotencyKey }),
+            idempotencyKey,
+            processingTimeMs: Date.now() - startedAt,
+            execution: 'remote-api' as const,
+          },
+          decisionIdFromInput(input),
+        );
 
       if (capability !== 'llm.complete') {
         return failed(
           requestId,
           provenance('unknown'),
           'UNSUPPORTED_CAPABILITY',
           'Only llm.complete is supported.',
         );
       }
       if ('error' in parsed) {
@@ -114,20 +126,34 @@ export function createMistralAdapter(options: MistralAdapterOptions): ProviderV2
             'content-type': 'application/json',
             'idempotency-key': idempotencyKey,
           },
           body: JSON.stringify({
             model: parsed.value.model,
             messages: parsed.value.messages,
             ...(parsed.value.maxTokens === undefined ? {} : { max_tokens: parsed.value.maxTokens }),
             ...(parsed.value.temperature === undefined
               ? {}
               : { temperature: parsed.value.temperature }),
+            ...(parsed.value.responseFormat === undefined
+              ? {}
+              : {
+                  response_format: {
+                    type: parsed.value.responseFormat.type,
+                    json_schema: {
+                      name: parsed.value.responseFormat.name,
+                      schema: parsed.value.responseFormat.schema,
+                      ...(parsed.value.responseFormat.strict === undefined
+                        ? {}
+                        : { strict: parsed.value.responseFormat.strict }),
+                    },
+                  },
+                }),
           }),
           signal: controller.signal,
         });
         if (!response.ok) {
           const code =
             response.status === 401 || response.status === 403
               ? 'MISTRAL_UNAUTHORIZED'
               : 'MISTRAL_REQUEST_FAILED';
           return failed(
             requestId,
@@ -182,20 +208,22 @@ function completionCapability(): CapabilityDeclaration {
     id: 'llm.complete',
     inputSchema: {
       type: 'object',
       additionalProperties: false,
       required: ['model', 'messages'],
       properties: {
         model: { type: 'string', enum: MISTRAL_REASONING_MODELS.map((model) => model.id) },
         messages: { type: 'array', minItems: 1 },
         maxTokens: { type: 'integer', minimum: 1, maximum: 4096 },
         temperature: { type: 'number', minimum: 0, maximum: 2 },
+        decisionId: { type: 'string' },
+        responseFormat: { type: 'object' },
       },
     },
     outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
     models: MISTRAL_REASONING_MODELS,
     supportsCancel: true,
     estimatedResources: { estimatedDurationMs: DEFAULT_TIMEOUT_MS },
     policyFlags: ['remote-processing', 'provider.spend', 'privacy-approval-required'],
   };
 }
 
@@ -228,26 +256,68 @@ function parseInput(
   const rawTemperature = input.temperature;
   if (
     rawTemperature !== undefined &&
     (typeof rawTemperature !== 'number' ||
       !Number.isFinite(rawTemperature) ||
       rawTemperature < 0 ||
       rawTemperature > 2)
   )
     return { error: 'temperature must be a number from 0 to 2.' };
   const temperature = rawTemperature as number | undefined;
+  const decisionId =
+    typeof input.decisionId === 'string' && input.decisionId.length > 0
+      ? input.decisionId
+      : undefined;
+  const responseFormatResult = parseResponseFormat(input.responseFormat);
+  if ('error' in responseFormatResult) return responseFormatResult;
   return {
     value: {
       model,
       messages: messages as readonly MistralChatMessage[],
       ...(maxTokens === undefined ? {} : { maxTokens }),
       ...(temperature === undefined ? {} : { temperature }),
+      ...(decisionId === undefined ? {} : { decisionId }),
+      ...(responseFormatResult.value === undefined
+        ? {}
+        : { responseFormat: responseFormatResult.value }),
+    },
+  };
+}
+
+function parseResponseFormat(value: unknown):
+  | {
+      readonly value:
+        | {
+            readonly type: 'json_schema';
+            readonly name: string;
+            readonly schema: JsonSchema;
+            readonly strict?: boolean;
+          }
+        | undefined;
+    }
+  | { readonly error: string } {
+  if (value === undefined) return { value: undefined };
+  if (!isRecord(value)) return { error: 'responseFormat must be an object.' };
+  if (value.type !== 'json_schema') return { error: 'responseFormat.type must be json_schema.' };
+  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 128) {
+    return { error: 'responseFormat.name must be a non-empty string.' };
+  }
+  if (!isRecord(value.schema)) return { error: 'responseFormat.schema must be an object.' };
+  if (value.strict !== undefined && typeof value.strict !== 'boolean') {
+    return { error: 'responseFormat.strict must be a boolean.' };
+  }
+  return {
+    value: {
+      type: 'json_schema',
+      name: value.name,
+      schema: value.schema,
+      ...(value.strict === undefined ? {} : { strict: value.strict }),
     },
   };
 }
 
 function validMessage(value: unknown): value is MistralChatMessage {
   return (
     isRecord(value) &&
     (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
     typeof value.content === 'string' &&
     value.content.length > 0
@@ -295,19 +365,35 @@ function failed(
   message: string,
 ): CapabilityResult {
   const diagnostics: readonly Diagnostic[] = [{ severity: 'error', code, message }];
   return { requestId, status: 'failed', outputs: [], provenance, diagnostics };
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return value !== null && typeof value === 'object' && !Array.isArray(value);
 }
 
+function decisionIdFromInput(value: unknown): string | undefined {
+  return value !== null &&
+    typeof value === 'object' &&
+    typeof (value as { decisionId?: unknown }).decisionId === 'string'
+    ? (value as { decisionId: string }).decisionId
+    : undefined;
+}
+
+function withProviderDecisionId<T extends CapabilityResult['provenance']>(
+  provenance: T,
+  providerDecisionId: string | undefined,
+): T {
+  if (providerDecisionId === undefined) return provenance;
+  return { ...provenance, providerDecisionId };
+}
+
 function hashRequest(value: unknown): string {
   const text = JSON.stringify(value);
   let hash = 0x811c9dc5;
   for (let index = 0; index < text.length; index++) {
     hash ^= text.charCodeAt(index);
     hash = Math.imul(hash, 0x01000193);
   }
   return `fnv1a-${(hash >>> 0).toString(16)}`;
 }
