# Review package: f45b9b7..6dd55a7

## Commits
6dd55a7 fix(api): harden provider approval grants

## Files changed
 apps/api/src/http-server.test.ts       | 68 +++++++++++++++++++++++++++-
 apps/api/src/http-server.ts            |  2 +
 apps/api/src/mistral-provider.ts       | 36 +++++++--------
 apps/api/src/provider-approval.test.ts | 65 +++++++++++++++++++++++++++
 apps/api/src/provider-approval.ts      | 81 +++++++++++++++++++++++++++++++---
 apps/api/src/server.ts                 |  4 ++
 packages/agent-tools/src/approval.ts   | 44 ++++++++++++++++++
 packages/agent-tools/src/index.ts      |  1 +
 packages/agent-tools/src/wp06.test.ts  | 47 ++++++++++++++++++++
 packages/provider-sdk/src/privacy.ts   |  1 +
 10 files changed, 324 insertions(+), 25 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index b7a92df..980fb98 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -139,25 +139,25 @@ describe('control-plane HTTP transport', () => {
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
-    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
+    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
     expect(retried).toEqual(first);
     expect(
       await request(origin, 'POST', '/v1/providers/mistral/complete', {
-        ...approved,
+        ...base,
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
@@ -166,20 +166,84 @@ describe('control-plane HTTP transport', () => {
       body: {
         data: expect.arrayContaining([
           expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
           expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-mistral-1' }),
         ]),
       },
     });
     expect(JSON.stringify(audit.body)).not.toContain('Do not persist this prompt.');
   });
 
+  it('rejects forged provider approval grants at the HTTP boundary', async () => {
+    const approvals = new ProviderApprovalService();
+    const registry = new MistralProviderRegistry(
+      'test-only-mistral-secret',
+      new MemoryMistralInvocationLedger(),
+      approvals,
+      async () =>
+        new Response(
+          JSON.stringify({
+            choices: [{ message: { content: 'should not run' } }],
+            usage: { prompt_tokens: 1, completion_tokens: 1 },
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
+    const base = {
+      model: 'mistral-small-latest',
+      messages: [{ role: 'user', content: 'Private forged grant prompt.' }],
+      idempotencyKey: 'mistral-forged-1',
+      privacyMode: 'ask-before-remote',
+      approvedRemoteProcessing: true,
+      approvedSpend: true,
+    };
+    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
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
+
+    expect(
+      await request(origin, 'POST', '/v1/providers/mistral/complete', {
+        ...base,
+        providerApprovalGrant: {
+          grantVersion: 1,
+          grantId: 'grant-forged-http',
+          grantSignature: 'forged-signature',
+          actorId: 'owner',
+          providerId: preflight.providerId,
+          capability: preflight.capability,
+          requestDigest: preflight.requestDigest,
+          expiresAt: '2026-12-31T00:00:00.000Z',
+          status: 'approved',
+          costCap: { amount: '0.00', currency: 'USD' },
+        },
+      }),
+    ).toMatchObject({
+      status: 409,
+      body: { error: { code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' } },
+    });
+  });
+
   it('requires shared remote approval before Edge TTS can run', async () => {
     const approvals = new ProviderApprovalService();
     const origin = await start(
       { authenticate: () => ({ id: 'owner' }) },
       undefined,
       undefined,
       undefined,
       approvals,
     );
 
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 69dd47d..44e7fc5 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -1099,20 +1099,21 @@ function optionalProviderApprovalGrant(
 ): ProviderApprovalGrant | undefined {
   const value = body.providerApprovalGrant ?? body.approvalGrant;
   if (value === undefined) return undefined;
   if (value === null || typeof value !== 'object' || Array.isArray(value)) {
     throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant must be an object');
   }
   const grant = value as Record<string, unknown>;
   if (
     grant.grantVersion !== 1 ||
     typeof grant.grantId !== 'string' ||
+    typeof grant.grantSignature !== 'string' ||
     typeof grant.actorId !== 'string' ||
     typeof grant.providerId !== 'string' ||
     typeof grant.capability !== 'string' ||
     typeof grant.requestDigest !== 'string' ||
     typeof grant.expiresAt !== 'string' ||
     (grant.status !== 'approved' && grant.status !== 'denied')
   ) {
     throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant is invalid');
   }
   let costCap: ProviderApprovalGrant['costCap'];
@@ -1126,20 +1127,21 @@ function optionalProviderApprovalGrant(
     }
     const cap = grant.costCap as Record<string, unknown>;
     if (typeof cap.amount !== 'string' || typeof cap.currency !== 'string') {
       invalidRequest('providerApprovalGrant.costCap is invalid');
     }
     costCap = { amount: cap.amount, currency: cap.currency };
   }
   const parsed: ProviderApprovalGrant = {
     grantVersion: 1,
     grantId: grant.grantId,
+    grantSignature: grant.grantSignature,
     actorId: grant.actorId,
     providerId: grant.providerId,
     capability: grant.capability as ProviderApprovalGrant['capability'],
     requestDigest: grant.requestDigest,
     expiresAt: grant.expiresAt,
     status: grant.status,
     ...(costCap === undefined ? {} : { costCap }),
   };
   return parsed;
 }
diff --git a/apps/api/src/mistral-provider.ts b/apps/api/src/mistral-provider.ts
index 72f1d7b..7bfa585 100644
--- a/apps/api/src/mistral-provider.ts
+++ b/apps/api/src/mistral-provider.ts
@@ -177,20 +177,38 @@ export class MistralProviderRegistry {
     const request = mistralCapabilityRequest(input);
     const preflight = computeProviderApprovalPreflight(actorId, request, this.#provider);
     const approvalVerification = {
       actorId,
       idempotencyKey: input.idempotencyKey,
       preflight,
       privacyMode: input.privacyMode,
       grant: input.approvalGrant,
       fallbackCostCap: input.approvalGrant?.costCap ?? { amount: '0.00', currency: 'USD' },
     } as const;
+    const previous = await this.ledger.find(actorId, input.idempotencyKey);
+    if (previous !== undefined) {
+      if (previous.provenance.requestHash !== preflight.requestDigest) {
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
+      return previous;
+    }
+
     const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
     if (status.state === 'unconfigured') {
       await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
       throw new MistralProviderError(
         'PROVIDER_UNCONFIGURED',
         'Mistral is not configured on this server.',
       );
     }
 
     const resolution = resolveProvider(request, [this.#provider], {
@@ -221,38 +239,20 @@ export class MistralProviderRegistry {
         if (error.code === 'PROVIDER_APPROVAL_REQUIRED') {
           throw error;
         }
         if (error.code === 'PROVIDER_SPEND_CAP_EXCEEDED') {
           throw new MistralProviderError('PROVIDER_SPEND_APPROVAL_REQUIRED', error.message);
         }
       }
       throw error;
     }
 
-    const previous = await this.ledger.find(actorId, input.idempotencyKey);
-    if (previous !== undefined) {
-      if (previous.provenance.requestHash !== preflight.requestDigest) {
-        await this.#approvals.recordFailed(
-          approvalVerification,
-          approval.reservation,
-          'idempotency-request-digest-conflict',
-        );
-        throw new ProviderApprovalError(
-          'PROVIDER_APPROVAL_REPLAY_REJECTED',
-          'Idempotent retry does not match the original request digest.',
-          preflight,
-        );
-      }
-      await this.#approvals.recordSucceeded(approvalVerification, approval.reservation);
-      return previous;
-    }
-
     this.#lifecycle.recordJobStart(MISTRAL_PROVIDER_ID);
     try {
       const result = await this.#provider.invoke('llm.complete', request.input, request);
       if (result.status === 'succeeded') {
         this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
         this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
         const approvedResult = withApprovalProvenance(result, preflight.requestDigest, approval);
         await this.#approvals.recordSucceeded(
           approvalVerification,
           approval.reservation,
diff --git a/apps/api/src/provider-approval.test.ts b/apps/api/src/provider-approval.test.ts
index c496712..18ecaa1 100644
--- a/apps/api/src/provider-approval.test.ts
+++ b/apps/api/src/provider-approval.test.ts
@@ -74,20 +74,50 @@ describe('ProviderApprovalService', () => {
       service.verify({
         actorId: 'actor-1',
         idempotencyKey: request.idempotencyKey,
         preflight: otherProvider,
         privacyMode: 'ask-before-remote',
         grant,
       }),
     ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
   });
 
+  it('rejects self-made grants that were not signed by the approval service', async () => {
+    const { service, request, preflight } = fixture();
+    const forged: ProviderApprovalGrant = {
+      grantVersion: 1,
+      grantId: 'grant-forged',
+      grantSignature: 'forged-signature',
+      actorId: 'actor-1',
+      providerId: preflight.providerId,
+      capability: preflight.capability,
+      requestDigest: preflight.requestDigest,
+      expiresAt: '2026-12-31T00:00:00.000Z',
+      status: 'approved',
+      costCap: { amount: '0.10', currency: 'USD' },
+    };
+
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight,
+        privacyMode: 'ask-before-remote',
+        grant: forged,
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
+
+    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
+      expect.objectContaining({ status: 'denied', reason: 'approval-forgery-rejected' }),
+    );
+  });
+
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
@@ -128,20 +158,55 @@ describe('ProviderApprovalService', () => {
     await service.recordSucceeded(input, first.reservation);
     await expect(service.auditRows('actor-1')).resolves.toContainEqual(
       expect.objectContaining({
         status: 'succeeded',
         approvalGrantId: grant.grantId,
         budgetReservationId: first.reservation?.reservationId,
       }),
     );
   });
 
+  it('scopes budget idempotency by actor and request digest', async () => {
+    const service = new ProviderApprovalService();
+    const first = fixture({ service });
+    const secondRequest: CapabilityRequest = {
+      ...first.request,
+      input: { prompt: 'private prompt for another actor' },
+    };
+    const provider = createMockProvider('remote-provider', ['llm.complete'], {
+      execution: 'remote-api',
+      privacy: { dataLeavesDevice: true },
+    });
+    const secondPreflight = computeProviderApprovalPreflight('actor-2', secondRequest, provider);
+
+    const firstOutcome = await service.verify({
+      actorId: 'actor-1',
+      idempotencyKey: 'shared-idem',
+      preflight: first.preflight,
+      privacyMode: 'ask-before-remote',
+      grant: grantFor(service, first.preflight),
+    });
+    const secondOutcome = await service.verify({
+      actorId: 'actor-2',
+      idempotencyKey: 'shared-idem',
+      preflight: secondPreflight,
+      privacyMode: 'ask-before-remote',
+      grant: grantFor(service, secondPreflight, { actorId: 'actor-2' }),
+    });
+
+    expect(firstOutcome.reservation?.reservationId).toBeDefined();
+    expect(secondOutcome.reservation?.reservationId).toBeDefined();
+    expect(secondOutcome.reservation?.reservationId).not.toBe(
+      firstOutcome.reservation?.reservationId,
+    );
+  });
+
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
diff --git a/apps/api/src/provider-approval.ts b/apps/api/src/provider-approval.ts
index 54a0bf9..1740ffa 100644
--- a/apps/api/src/provider-approval.ts
+++ b/apps/api/src/provider-approval.ts
@@ -1,10 +1,11 @@
+import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
 import type { CapabilityId, Money, ProviderApprovalGrant } from '@joy-media/provider-sdk';
 import {
   createProviderBudgetLedger,
   reconcileProviderBudget,
   reserveProviderBudget,
   type ProviderApprovalPreflight,
   type ProviderBudgetLedgerV1,
   type ProviderBudgetReservationV1,
 } from '@joy-media/provider-sdk';
 
@@ -77,41 +78,46 @@ export class MemoryProviderApprovalStore implements ProviderApprovalStore {
       : this.#rows.filter((row) => row.actorId === actorId);
   }
 }
 
 export class ProviderApprovalService {
   #budgetLedger: ProviderBudgetLedgerV1;
 
   constructor(
     private readonly store: ProviderApprovalStore = new MemoryProviderApprovalStore(),
     budgetLedger: ProviderBudgetLedgerV1 = createProviderBudgetLedger(),
+    private readonly signingSecret: string = randomBytes(32).toString('base64url'),
   ) {
     this.#budgetLedger = budgetLedger;
   }
 
   createGrant(
-    input: Omit<ProviderApprovalGrant, 'grantVersion' | 'grantId' | 'status'> & {
+    input: Omit<ProviderApprovalGrant, 'grantVersion' | 'grantId' | 'grantSignature' | 'status'> & {
       readonly grantId?: string | undefined;
       readonly status?: ProviderApprovalGrant['status'] | undefined;
     },
   ): ProviderApprovalGrant {
-    return {
+    const unsigned: Omit<ProviderApprovalGrant, 'grantSignature'> = {
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
+    return {
+      ...unsigned,
+      grantSignature: this.signGrant(unsigned),
+    };
   }
 
   async verify(input: ProviderApprovalVerification): Promise<ProviderApprovalOutcome> {
     const estimatedCost = input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap);
     const costCap = input.grant?.costCap ?? input.fallbackCostCap;
 
     if (input.privacyMode === 'local-only' && input.preflight.requiresUserApproval) {
       await this.audit(input, 'denied', 'remote-processing-blocked', { estimatedCost, costCap });
       throw new ProviderApprovalError(
         'REMOTE_PROCESSING_BLOCKED',
@@ -136,20 +142,33 @@ export class ProviderApprovalService {
 
     if (input.grant === undefined) {
       await this.audit(input, 'denied', 'approval-required', { estimatedCost, costCap });
       throw new ProviderApprovalError(
         'PROVIDER_APPROVAL_REQUIRED',
         'Provider processing requires an approval grant bound to this request.',
         input.preflight,
       );
     }
 
+    if (!this.isAuthenticGrant(input.grant)) {
+      await this.audit(input, 'denied', 'approval-forgery-rejected', {
+        estimatedCost,
+        costCap,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_APPROVAL_REPLAY_REJECTED',
+        'Approval grant was not issued by this server.',
+        input.preflight,
+      );
+    }
+
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
@@ -192,23 +211,24 @@ export class ProviderApprovalService {
         estimatedCost,
         grant: input.grant,
       });
       throw new ProviderApprovalError(
         'PROVIDER_SPEND_CAP_EXCEEDED',
         'Provider spend requires an explicit approval cost cap.',
         input.preflight,
       );
     }
 
+    const scopedKey = scopedBudgetKey(input);
     const reserved = reserveProviderBudget(this.#budgetLedger, {
-      reservationId: `reserve-${input.idempotencyKey}`,
-      idempotencyKey: input.idempotencyKey,
+      reservationId: `reserve-${scopedKey}`,
+      idempotencyKey: scopedKey,
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
@@ -273,23 +293,24 @@ export class ProviderApprovalService {
     return this.store.list(actorId);
   }
 
   private async reconcile(
     idempotencyKey: string,
     reservation: ProviderBudgetReservationV1 | undefined,
     actualCost: Money,
     providerUsageId: string,
   ): Promise<void> {
     if (reservation === undefined) return;
+    const scopedKey = scopedReconciliationKey(idempotencyKey, reservation);
     const reconciled = reconcileProviderBudget(this.#budgetLedger, {
       reservationId: reservation.reservationId,
-      idempotencyKey: `usage-${idempotencyKey}`,
+      idempotencyKey: scopedKey,
       kind: 'final',
       actualCost,
       providerUsageId,
     });
     if (reconciled.ok) this.#budgetLedger = reconciled.ledger;
   }
 
   private async audit(
     input: ProviderApprovalVerification,
     status: ProviderApprovalAuditStatus,
@@ -313,20 +334,37 @@ export class ProviderApprovalService {
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
+
+  private signGrant(
+    grant: Omit<ProviderApprovalGrant, 'grantSignature'>,
+  ): ProviderApprovalGrant['grantSignature'] {
+    return createHmac('sha256', this.signingSecret).update(stableJson(grant)).digest('base64url');
+  }
+
+  private isAuthenticGrant(grant: ProviderApprovalGrant): boolean {
+    const { grantSignature: provided, ...unsigned } = grant;
+    const expected = this.signGrant(unsigned);
+    const expectedBytes = Buffer.from(expected);
+    const providedBytes = Buffer.from(provided);
+    return (
+      expectedBytes.byteLength === providedBytes.byteLength &&
+      timingSafeEqual(expectedBytes, providedBytes)
+    );
+  }
 }
 
 export function providerApprovalRequiredPayload(error: ProviderApprovalError): {
   readonly code: ProviderApprovalError['code'];
   readonly message: string;
   readonly preflight?: ProviderApprovalPreflight;
 } {
   return {
     code: error.code,
     message: error.message,
@@ -337,10 +375,43 @@ export function providerApprovalRequiredPayload(error: ProviderApprovalError): {
 function zeroMoney(reference?: Money): Money {
   return { amount: '0.00', currency: reference?.currency ?? 'USD' };
 }
 
 function redactAuditReason(reason: string): string {
   return reason.replace(
     /(secret|token|api[-_]?key|authorization)[A-Za-z0-9._:=/-]*/gi,
     '$1-redacted',
   );
 }
+
+function scopedBudgetKey(input: ProviderApprovalVerification): string {
+  return hashKey({
+    actorId: input.actorId,
+    requestDigest: input.preflight.requestDigest,
+    idempotencyKey: input.idempotencyKey,
+  });
+}
+
+function scopedReconciliationKey(
+  idempotencyKey: string,
+  reservation: ProviderBudgetReservationV1,
+): string {
+  return hashKey({
+    idempotencyKey,
+    reservationId: reservation.reservationId,
+  });
+}
+
+function hashKey(value: unknown): string {
+  return createHash('sha256').update(stableJson(value)).digest('base64url');
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
diff --git a/apps/api/src/server.ts b/apps/api/src/server.ts
index af5678b..848e6d6 100644
--- a/apps/api/src/server.ts
+++ b/apps/api/src/server.ts
@@ -3,57 +3,61 @@ import { LocalControlPlane } from './control-plane.js';
 import { createControlPlaneHttpServer } from './http-server.js';
 import { DisabledMediaAuth, MediaAuthService } from './media-auth.js';
 import { MediaMailer } from './media-mailer.js';
 import { MediaTelegramSender } from './media-telegram.js';
 import { PostgresControlPlane } from './postgres-control-plane.js';
 import { RclonePrivateObjectStore } from './private-object-store.js';
 import {
   createRuntimeMistralProviderRegistry,
   PostgresMistralInvocationLedger,
 } from './mistral-provider.js';
+import { ProviderApprovalService } from './provider-approval.js';
 
 await start();
 
 async function start(): Promise<void> {
   const host = process.env.JOY_MEDIA_API_HOST ?? '127.0.0.1';
   const port = Number(process.env.JOY_MEDIA_API_PORT ?? 8790);
   const databaseUrl = process.env.JOY_MEDIA_DATABASE_URL;
   const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
   const durableControlPlane = pool === undefined ? undefined : new PostgresControlPlane(pool);
   if (durableControlPlane !== undefined) await durableControlPlane.initialize();
   const mistralLedger = pool === undefined ? undefined : new PostgresMistralInvocationLedger(pool);
   if (mistralLedger !== undefined) await mistralLedger.initialize();
+  const providerApprovals = new ProviderApprovalService();
   const mailer = createMailer();
   const telegram = createTelegramSender();
   const mediaAuth =
     pool === undefined
       ? new DisabledMediaAuth()
       : new MediaAuthService({
           pool,
           ...(mailer === undefined ? {} : { mailer }),
           ...(telegram === undefined ? {} : { telegram }),
         });
   createControlPlaneHttpServer({
     controlPlane: durableControlPlane ?? new LocalControlPlane(),
     // Public /v1 (project/job/asset routes) stays disabled unless durable state
     // is configured; /v1/auth is served by mediaAuth regardless (it owns its
     // own allow-list/session tables independently of the control plane).
     authentication: {
       authenticate: (request) =>
         durableControlPlane === undefined ? undefined : mediaAuth.authenticate(request),
     },
     mediaAuth,
+    providerApprovals,
     mistral: createRuntimeMistralProviderRegistry({
       ...(process.env.JOY_MEDIA_MISTRAL_API_KEY === undefined
         ? {}
         : { apiKey: process.env.JOY_MEDIA_MISTRAL_API_KEY }),
       ...(mistralLedger === undefined ? {} : { ledger: mistralLedger }),
+      approvals: providerApprovals,
     }),
     ...(process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX === undefined
       ? {}
       : {
           privateObjectStore: new RclonePrivateObjectStore({
             remotePrefix: process.env.JOY_MEDIA_OBJECT_STORE_REMOTE_PREFIX,
             ...(process.env.JOY_MEDIA_RCLONE_COMMAND === undefined
               ? {}
               : { command: process.env.JOY_MEDIA_RCLONE_COMMAND }),
           }),
diff --git a/packages/agent-tools/src/approval.ts b/packages/agent-tools/src/approval.ts
index 34867cf..6342c99 100644
--- a/packages/agent-tools/src/approval.ts
+++ b/packages/agent-tools/src/approval.ts
@@ -210,20 +210,29 @@ export class ApprovalEngine {
   }
 
   evaluatePlan(
     plan: AgentEditPlan,
     context: EditorContext,
     scopeFor?: (toolName: string) => ToolScope | undefined,
   ): readonly ApprovalDecision[] {
     const decisions = plan.steps.map((step) =>
       this.evaluateStep(step, context, scopeFor?.(step.tool)),
     );
+    for (const step of plan.steps) {
+      const preflight = providerPreflightFromStep(step);
+      if (preflight === undefined) continue;
+      decisions.push({
+        request: approvalRequestFromProviderPreflight(preflight, step.id),
+        decision: 'requires-manual',
+        reason: `Provider approval required for ${preflight.providerId} ${preflight.capability}`,
+      });
+    }
 
     if (plan.assumptions.length > 0 && !this.policy.allowUnresolvedAssumptions) {
       decisions.push({
         request: {
           id: `approval-assumptions-${Date.now()}`,
           stepId: 'plan',
           reason: 'unresolved-assumptions',
           description: `Plan has ${plan.assumptions.length} unresolved assumption(s)`,
           privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
           isReversible: true,
@@ -502,10 +511,45 @@ function parseMoney(money: Money): number {
   return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
 }
 
 function formatCapabilities(capabilities: readonly ToolCapability[]): string {
   return capabilities.length > 0 ? capabilities.join(', ') : 'this operation';
 }
 
 function looksLikeCredentialAccess(toolName: string): boolean {
   return /(credential|secret|api[-_]?key|token)/i.test(toolName);
 }
+
+function providerPreflightFromStep(step: AgentPlanStep): ProviderApprovalPreflight | undefined {
+  if (
+    step.arguments === null ||
+    typeof step.arguments !== 'object' ||
+    Array.isArray(step.arguments)
+  ) {
+    return undefined;
+  }
+  const args = step.arguments as Record<string, unknown>;
+  return providerPreflightFromValue(
+    args.providerApprovalPreflight ?? args.providerPreflight ?? args.preflight,
+  );
+}
+
+function providerPreflightFromValue(value: unknown): ProviderApprovalPreflight | undefined {
+  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
+  const record = value as Record<string, unknown>;
+  if (
+    typeof record.providerId !== 'string' ||
+    typeof record.capability !== 'string' ||
+    typeof record.requestDigest !== 'string' ||
+    typeof record.dataLeavesDevice !== 'boolean' ||
+    !Array.isArray(record.dataBeingSent) ||
+    record.dataBeingSent.some((item) => typeof item !== 'string') ||
+    typeof record.purpose !== 'string' ||
+    typeof record.estimatedSizeBytes !== 'number' ||
+    !Array.isArray(record.transformations) ||
+    record.transformations.some((item) => typeof item !== 'string') ||
+    typeof record.requiresUserApproval !== 'boolean'
+  ) {
+    return undefined;
+  }
+  return record as unknown as ProviderApprovalPreflight;
+}
diff --git a/packages/agent-tools/src/index.ts b/packages/agent-tools/src/index.ts
index 9f0575b..b3f2fae 100644
--- a/packages/agent-tools/src/index.ts
+++ b/packages/agent-tools/src/index.ts
@@ -82,20 +82,21 @@ export type { AgentExecutionMode, ApprovalPolicy, ApprovalDecision } from './app
 export {
   ALL_TOOL_CAPABILITIES,
   ApprovalEngine,
   createSuggestOnlyApprovalPolicy,
   createPreviewAndApprovePolicy,
   createAutoApplyLowRiskPolicy,
   createFullAutoWithinLimitsPolicy,
   createDefaultApprovalPolicy,
   createPermissiveApprovalPolicy,
   createStrictApprovalPolicy,
+  approvalRequestFromProviderPreflight,
 } from './approval.js';
 
 export type { PlanEstimation } from './estimation.js';
 export { estimatePlan, estimateStep, isPlanLocalOnly } from './estimation.js';
 
 export type { PlanValidationResult, PlanError } from './plan-validation.js';
 export {
   validatePlanStructure,
   validatePlanAgainstContext,
   validateStepDependencies,
diff --git a/packages/agent-tools/src/wp06.test.ts b/packages/agent-tools/src/wp06.test.ts
index abaaf4c..9f15a57 100644
--- a/packages/agent-tools/src/wp06.test.ts
+++ b/packages/agent-tools/src/wp06.test.ts
@@ -266,20 +266,67 @@ describe('Approval Engine', () => {
       assumptions: ['assumption 1'],
     });
     const context = createMockContext();
 
     const decisions = engine.evaluatePlan(plan, context);
     const assumptionDecision = decisions.find((d) => d.reason.includes('assumptions'));
     expect(assumptionDecision).toBeDefined();
     expect(assumptionDecision?.decision).toBe('requires-manual');
   });
 
+  it('surfaces provider preflight as a pending approval for Joy Code and workflow plans', () => {
+    const policy = createDefaultApprovalPolicy();
+    const engine = new ApprovalEngine(policy);
+    const plan = createPlan('Generate narration', [
+      createTestStep({
+        id: 'tts-step',
+        mode: 'job',
+        tool: 'speechSynthesize',
+        arguments: {
+          providerApprovalPreflight: {
+            providerId: 'edge-tts',
+            capability: 'speech.synthesize',
+            dataLeavesDevice: true,
+            dataBeingSent: ['text data'],
+            purpose: 'Synthesize speech from text',
+            estimatedSizeBytes: 1000,
+            transformations: ['remote API call'],
+            requiresUserApproval: true,
+            requestDigest: 'sha256:abc123',
+            retentionDisclosure: 'Text is sent to Microsoft Edge online TTS for synthesis',
+            estimatedCost: { amount: '0.00', currency: 'USD' },
+          },
+        },
+      }),
+    ]);
+    const context = createMockContext();
+
+    const decisions = engine.evaluatePlan(plan, context);
+
+    expect(decisions).toContainEqual(
+      expect.objectContaining({
+        decision: 'requires-manual',
+        request: expect.objectContaining({
+          id: 'approval-provider-sha256:abc123',
+          stepId: 'tts-step',
+          reason: 'paid-generation',
+          estimatedCost: { amount: '0.00', currency: 'USD' },
+          privacyImpact: expect.objectContaining({
+            dataLeavesDevice: true,
+            providerId: 'edge-tts',
+            dataTypes: ['text data'],
+          }),
+        }),
+      }),
+    );
+  });
+
   it('records approval correctly', () => {
     const policy = createDefaultApprovalPolicy();
     const engine = new ApprovalEngine(policy);
     const steps = [createTestStep()];
     const plan = createPlan('Test goal', steps, {
       requiredApprovals: [
         {
           id: 'approval-1',
           stepId: 'step-1',
           reason: 'paid-generation',
diff --git a/packages/provider-sdk/src/privacy.ts b/packages/provider-sdk/src/privacy.ts
index 9bbce3c..9fda38c 100644
--- a/packages/provider-sdk/src/privacy.ts
+++ b/packages/provider-sdk/src/privacy.ts
@@ -85,20 +85,21 @@ export interface ProviderApprovalBinding {
   readonly providerId: string;
   readonly capability: CapabilityId;
   readonly requestDigest: string;
   readonly expiresAt: string;
   readonly costCap?: Money;
 }
 
 export interface ProviderApprovalGrant extends ProviderApprovalBinding {
   readonly grantVersion: 1;
   readonly grantId: string;
+  readonly grantSignature: string;
   readonly status: 'approved' | 'denied';
 }
 
 export interface ProviderApprovalPreflight extends PrivacyPreflight {
   readonly requestDigest: string;
   readonly approvalRequiredReason?: 'remote-processing' | 'provider-spend';
 }
 
 export function computePrivacyPreflight(
   request: CapabilityRequest,
