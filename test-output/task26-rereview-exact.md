# Review package: 977a676..b655ab1

## Commits
b655ab1 fix(reasoning): restore Joy Code approval and durable replay

## Files changed
 apps/api/src/http-server.test.ts               | 155 +++++++++++++--
 apps/api/src/http-server.ts                    |  60 ++++++
 apps/api/src/mistral-provider.ts               |  51 +++--
 apps/editor-web/src/AgentPanel.tsx             | 264 ++++++++++++++++++++-----
 apps/editor-web/src/control-plane-client.ts    |  45 ++++-
 apps/editor-web/src/joy-code-critique.test.tsx | 139 ++++++++++++-
 6 files changed, 626 insertions(+), 88 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index 5aded0a..ed3ed1e 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -278,33 +278,33 @@ describe('control-plane HTTP transport', () => {
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
-    const providerApprovalGrant = approvals.createGrant({
-      actorId: 'owner',
-      providerId: preflight.providerId,
-      capability: preflight.capability,
-      requestDigest: preflight.requestDigest,
-      expiresAt: '2026-12-31T00:00:00.000Z',
-      costCap: { amount: '0.00', currency: 'USD' },
-      grantId: 'grant-joy-code-1',
-    });
+    const providerApprovalGrant = (
+      await request(origin, 'POST', '/v1/providers/approvals/grants', {
+        providerId: preflight.providerId,
+        capability: preflight.capability,
+        requestDigest: preflight.requestDigest,
+        expiresAt: '2026-12-31T00:00:00.000Z',
+        costCap: { amount: '0.00', currency: 'USD' },
+      })
+    ).body as { data: { grantId: string } };
 
     const approved = await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
       ...base,
-      providerApprovalGrant,
+      providerApprovalGrant: providerApprovalGrant.data,
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
@@ -324,27 +324,136 @@ describe('control-plane HTTP transport', () => {
     expect(calls).toBe(1);
     expect(JSON.stringify(approved.body)).not.toContain('test-only-mistral-secret');
     expect(JSON.stringify(approved.body)).not.toContain(base.goal);
 
     const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
     expect(audit).toMatchObject({
       status: 200,
       body: {
         data: expect.arrayContaining([
           expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
-          expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-joy-code-1' }),
+          expect.objectContaining({
+            status: 'succeeded',
+            approvalGrantId: providerApprovalGrant.data.grantId,
+          }),
         ]),
       },
     });
     expect(JSON.stringify(audit.body)).not.toContain(base.goal);
   });
 
+  it('replays bounded Joy Code reasoning from the shared invocation ledger across registry restarts', async () => {
+    const ledger = new MemoryMistralInvocationLedger();
+    const firstApprovals = new ProviderApprovalService();
+    let calls = 0;
+    const firstRegistry = new MistralProviderRegistry(
+      'test-only-mistral-secret',
+      ledger,
+      firstApprovals,
+      async () => {
+        calls++;
+        return new Response(
+          JSON.stringify({
+            choices: [
+              {
+                message: {
+                  content: JSON.stringify({
+                    brief: {
+                      summary: 'Shared ledger replay works.',
+                      rationale: 'The stored completion can be replayed after restart.',
+                      evidenceReferences: ['clip:intro'],
+                    },
+                  }),
+                },
+              },
+            ],
+            usage: { prompt_tokens: 7, completion_tokens: 6 },
+          }),
+        );
+      },
+    );
+    const firstOrigin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      firstRegistry,
+      undefined,
+      firstApprovals,
+    );
+    const base = {
+      model: 'mistral-small-latest',
+      goal: 'Review the intro for pacing.',
+      snapshotDigest: `fnv1a-${'d'.repeat(8)}`,
+      projectRevision: 'rev-replay',
+      idempotencyKey: 'joy-code-replay-shared-1',
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
+    const firstApproval = await request(
+      firstOrigin,
+      'POST',
+      '/v1/providers/reasoning/joy-code',
+      base,
+    );
+    const firstPreflight = (
+      firstApproval.body as {
+        error: {
+          preflight: {
+            providerId: string;
+            capability: 'llm.complete';
+            requestDigest: string;
+          };
+        };
+      }
+    ).error.preflight;
+    const firstGrant = await request(firstOrigin, 'POST', '/v1/providers/approvals/grants', {
+      providerId: firstPreflight.providerId,
+      capability: firstPreflight.capability,
+      requestDigest: firstPreflight.requestDigest,
+      costCap: { amount: '0.00', currency: 'USD' },
+    });
+    const firstResult = await request(firstOrigin, 'POST', '/v1/providers/reasoning/joy-code', {
+      ...base,
+      providerApprovalGrant: (firstGrant.body as { data: unknown }).data,
+    });
+
+    const secondApprovals = new ProviderApprovalService();
+    const secondRegistry = new MistralProviderRegistry(
+      'test-only-mistral-secret',
+      ledger,
+      secondApprovals,
+      async () => {
+        calls++;
+        throw new Error('network must not be reached after replay');
+      },
+    );
+    const secondOrigin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      secondRegistry,
+      undefined,
+      secondApprovals,
+    );
+
+    expect(await request(secondOrigin, 'POST', '/v1/providers/reasoning/joy-code', base)).toEqual(
+      firstResult,
+    );
+    expect(calls).toBe(1);
+  });
+
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
@@ -399,38 +508,56 @@ describe('control-plane HTTP transport', () => {
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
-    const providerApprovalGrant = approvals.createGrant({
-      actorId: 'owner',
+    const providerApprovalGrant = await request(origin, 'POST', '/v1/providers/approvals/grants', {
       providerId: preflight.providerId,
       capability: preflight.capability,
       requestDigest: preflight.requestDigest,
       expiresAt: '2026-12-31T00:00:00.000Z',
       costCap: { amount: '0.00', currency: 'USD' },
     });
 
     expect(
       await request(origin, 'POST', '/v1/providers/reasoning/joy-code', {
         ...base,
-        providerApprovalGrant,
+        providerApprovalGrant: (providerApprovalGrant.body as { data: unknown }).data,
       }),
     ).toMatchObject({
       status: 502,
       body: { error: { code: 'MISTRAL_REQUEST_FAILED' } },
     });
+
+    expect(await request(origin, 'GET', '/v1/providers/reasoning')).toMatchObject({
+      status: 200,
+      body: {
+        data: {
+          providers: [expect.objectContaining({ providerId: 'mistral', state: 'degraded' })],
+        },
+      },
+    });
+    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
+    expect(audit).toMatchObject({
+      status: 200,
+      body: {
+        data: expect.arrayContaining([
+          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
+          expect.objectContaining({ status: 'failed', reason: 'invalid-structured-output' }),
+        ]),
+      },
+    });
   });
 
   it('rejects forged provider approval grants at the HTTP boundary', async () => {
     const approvals = new ProviderApprovalService();
     const registry = new MistralProviderRegistry(
       'test-only-mistral-secret',
       new MemoryMistralInvocationLedger(),
       approvals,
       async () =>
         new Response(
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 88b4afe..5153269 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -327,20 +327,36 @@ async function route(
     const result = await options.mistral.joyCodeReason(actor.id, joyCodeReasoningRequest(body));
     respondJson(response, 200, { data: result });
     return;
   }
 
   if (request.method === 'GET' && url.pathname === '/v1/providers/approvals/audit') {
     respondJson(response, 200, { data: await options.providerApprovals.auditRows(actor.id) });
     return;
   }
 
+  if (request.method === 'POST' && url.pathname === '/v1/providers/approvals/grants') {
+    const body = await readJson(request);
+    const grantRequest = providerApprovalGrantRequest(body);
+    respondJson(response, 201, {
+      data: options.providerApprovals.createGrant({
+        actorId: actor.id,
+        providerId: grantRequest.providerId,
+        capability: grantRequest.capability,
+        requestDigest: grantRequest.requestDigest,
+        expiresAt: grantRequest.expiresAt,
+        ...(grantRequest.costCap === undefined ? {} : { costCap: grantRequest.costCap }),
+      }),
+    });
+    return;
+  }
+
   if (request.method === 'POST' && url.pathname === '/v1/providers/mistral/complete') {
     const body = await readJson(request);
     const result = await options.mistral.complete(actor.id, mistralCompletionRequest(body));
     respondJson(response, 200, { data: result });
     return;
   }
 
   if (request.method === 'GET' && url.pathname === '/v1/workers') {
     respondJson(response, 200, { data: await options.controlPlane.workersForOwner(actor) });
     return;
@@ -1126,20 +1142,48 @@ function joyCodeReasoningRequest(body: Record<string, unknown>) {
     approvedSpend: body.approvedSpend === true,
     evidence,
     allowedIntentIds,
     ...(optionalProviderApprovalGrant(body) === undefined
       ? {}
       : { approvalGrant: optionalProviderApprovalGrant(body) }),
     ...(maxTokens === undefined ? {} : { maxTokens }),
   };
 }
 
+function providerApprovalGrantRequest(body: Record<string, unknown>): {
+  readonly providerId: string;
+  readonly capability: ProviderApprovalGrant['capability'];
+  readonly requestDigest: string;
+  readonly expiresAt: string;
+  readonly costCap?: NonNullable<ProviderApprovalGrant['costCap']>;
+} {
+  const providerId = requiredString(body, 'providerId');
+  const capability = requiredString(body, 'capability') as ProviderApprovalGrant['capability'];
+  const requestDigest = requiredString(body, 'requestDigest');
+  if (!/^sha256:[a-f0-9]{64}$/i.test(requestDigest)) {
+    throw new ControlPlaneError('REQUEST_INVALID', 'requestDigest is invalid');
+  }
+  const expiresAtValue = body.expiresAt;
+  const expiresAt =
+    typeof expiresAtValue === 'string' && !Number.isNaN(Date.parse(expiresAtValue))
+      ? expiresAtValue
+      : new Date(Date.now() + 5 * 60_000).toISOString();
+  const costCap = optionalMoney(body, 'costCap');
+  return {
+    providerId,
+    capability,
+    requestDigest,
+    expiresAt,
+    ...(costCap === undefined ? {} : { costCap }),
+  };
+}
+
 function requiredJoyCodeEvidence(value: unknown): readonly JoyCodeReasoningEvidence[] {
   if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
     throw new ControlPlaneError(
       'REQUEST_INVALID',
       'evidence must contain between 1 and 12 bounded evidence items',
     );
   }
   return value.map((item, index) => {
     if (item === null || typeof item !== 'object' || Array.isArray(item)) {
       throw new ControlPlaneError('REQUEST_INVALID', `evidence[${index}] must be an object`);
@@ -1229,20 +1273,36 @@ function optionalProviderApprovalGrant(
     providerId: grant.providerId,
     capability: grant.capability as ProviderApprovalGrant['capability'],
     requestDigest: grant.requestDigest,
     expiresAt: grant.expiresAt,
     status: grant.status,
     ...(costCap === undefined ? {} : { costCap }),
   };
   return parsed;
 }
 
+function optionalMoney(
+  body: Record<string, unknown>,
+  field: string,
+): NonNullable<ProviderApprovalGrant['costCap']> | undefined {
+  const value = body[field];
+  if (value === undefined) return undefined;
+  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
+    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
+  }
+  const money = value as Record<string, unknown>;
+  if (typeof money.amount !== 'string' || typeof money.currency !== 'string') {
+    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
+  }
+  return { amount: money.amount, currency: money.currency };
+}
+
 function containsUnsafeReasoningText(value: string): boolean {
   return (
     /\bhttps?:\/\//i.test(value) ||
     /\bfile:\/\//i.test(value) ||
     /\b[A-Za-z]:\\/i.test(value) ||
     /\b(?:api[_-]?key|secret|token|password)\b/i.test(value)
   );
 }
 
 function optionalPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
diff --git a/apps/api/src/mistral-provider.ts b/apps/api/src/mistral-provider.ts
index 885749f..f2c6868 100644
--- a/apps/api/src/mistral-provider.ts
+++ b/apps/api/src/mistral-provider.ts
@@ -6,21 +6,20 @@ import {
   type MistralChatMessage,
 } from '@joy-media/adapter-mistral';
 import {
   computeProviderApprovalPreflight,
   resolveProviderDecision,
   ProviderLifecycle,
   resolveProvider,
   type CapabilityResult,
   type CapabilityRequest,
   type ProviderApprovalGrant,
-  type ProviderDecisionV1,
   type ProviderStatus,
 } from '@joy-media/provider-sdk';
 import {
   ProviderApprovalError,
   ProviderApprovalService,
   type ProviderApprovalOutcome,
 } from './provider-approval.js';
 
 export interface MistralCompletionRequest {
   readonly model: string;
@@ -186,24 +185,20 @@ export class PostgresMistralInvocationLedger implements MistralInvocationLedger
     const existing = await this.find(actorId, result.provenance.idempotencyKey);
     if (existing === undefined) throw new Error('provider invocation record was not persisted');
     return existing;
   }
 }
 
 export class MistralProviderRegistry {
   readonly #provider;
   readonly #lifecycle = new ProviderLifecycle();
   readonly #approvals: ProviderApprovalService;
-  readonly #reasoningResults = new Map<
-    string,
-    { readonly requestDigest: string; readonly response: JoyCodeReasoningResponse }
-  >();
 
   constructor(
     apiKey: string | undefined,
     private readonly ledger: MistralInvocationLedger = new MemoryMistralInvocationLedger(),
     approvalsOrFetch?: ProviderApprovalService | typeof fetch,
     fetchImpl?: typeof fetch,
   ) {
     const approvals =
       typeof approvalsOrFetch === 'function' || approvalsOrFetch === undefined
         ? new ProviderApprovalService()
@@ -363,37 +358,41 @@ export class MistralProviderRegistry {
     const request = joyCodeCapabilityRequest(input);
     const preflight = computeProviderApprovalPreflight(actorId, request, this.#provider);
     const approvalVerification = {
       actorId,
       idempotencyKey: input.idempotencyKey,
       preflight,
       privacyMode: input.privacyMode,
       grant: input.approvalGrant,
       fallbackCostCap: input.approvalGrant?.costCap ?? { amount: '0.00', currency: 'USD' },
     } as const;
-    const resultKey = `${actorId}:${input.idempotencyKey}`;
-    const previous = this.#reasoningResults.get(resultKey);
+    const previous = await this.ledger.find(actorId, input.idempotencyKey);
     if (previous !== undefined) {
-      if (previous.requestDigest !== preflight.requestDigest) {
+      if (previous.provenance.requestHash !== preflight.requestDigest) {
         await this.#approvals.recordFailed(
           approvalVerification,
           undefined,
           'idempotency-request-digest-conflict',
         );
         throw new ProviderApprovalError(
           'PROVIDER_APPROVAL_REPLAY_REJECTED',
           'Idempotent retry does not match the original request digest.',
           preflight,
         );
       }
       await this.#approvals.recordSucceeded(approvalVerification, undefined);
-      return previous.response;
+      return joyCodeResponseFromProviderResult(
+        input,
+        previous,
+        previous.provenance.providerDecisionId ?? 'provider-decision-replay',
+        preflight,
+      );
     }
 
     const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
     if (status.state === 'unconfigured') {
       await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
       throw new MistralProviderError(
         'PROVIDER_UNCONFIGURED',
         'Mistral is not configured on this server.',
       );
     }
@@ -454,34 +453,50 @@ export class MistralProviderRegistry {
           approval.reservation,
           code ?? 'provider-request-failed',
         );
         throw new MistralProviderError('MISTRAL_REQUEST_FAILED', 'Mistral completion failed.');
       }
       const approvedResult = withApprovalProvenance(
         providerResult,
         preflight.requestDigest,
         approval,
       );
-      const response = joyCodeResponseFromProviderResult(
-        input,
-        approvedResult,
-        providerDecision,
-        preflight,
-      );
+      let response: JoyCodeReasoningResponse;
+      try {
+        response = joyCodeResponseFromProviderResult(
+          input,
+          approvedResult,
+          providerDecision.decisionId,
+          preflight,
+        );
+      } catch (error) {
+        this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
+        this.#lifecycle.markDegraded(
+          MISTRAL_PROVIDER_ID,
+          'Mistral bounded reasoning response was invalid.',
+          false,
+        );
+        await this.#approvals.recordFailed(
+          approvalVerification,
+          approval.reservation,
+          'invalid-structured-output',
+        );
+        throw error;
+      }
+      await this.ledger.record(actorId, approvedResult);
       this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
       this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
       await this.#approvals.recordSucceeded(
         approvalVerification,
         approval.reservation,
         approvedResult.usage?.cost,
       );
-      this.#reasoningResults.set(resultKey, { requestDigest: preflight.requestDigest, response });
       return response;
     } catch (error) {
       if (error instanceof MistralProviderError || error instanceof ProviderApprovalError) {
         throw error;
       }
       this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
       this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
       await this.#approvals.recordFailed(
         approvalVerification,
         approval.reservation,
@@ -601,21 +616,21 @@ function joyCodeResponseFormat(): {
           },
         },
       },
     },
   };
 }
 
 function joyCodeResponseFromProviderResult(
   input: JoyCodeReasoningRequest,
   result: CapabilityResult,
-  decision: ProviderDecisionV1,
+  decisionRef: string,
   preflight: ReturnType<typeof computeProviderApprovalPreflight>,
 ): JoyCodeReasoningResponse {
   const rawText = result.outputs[0]?.metadata?.text;
   if (typeof rawText !== 'string' || rawText.length === 0) {
     throw new MistralProviderError(
       'MISTRAL_REQUEST_FAILED',
       'Mistral structured output was empty.',
     );
   }
   let parsed: unknown;
@@ -640,21 +655,21 @@ function joyCodeResponseFromProviderResult(
       ? undefined
       : parseReasoningProposal(parsed.proposal, knownEvidence, input.allowedIntentIds, 'proposal');
   return {
     responseVersion: 1,
     requestId: result.requestId,
     brief,
     ...(proposal === undefined ? {} : { proposal }),
     provider: {
       providerId: MISTRAL_PROVIDER_ID,
       modelId: input.model,
-      decisionRef: decision.decisionId,
+      decisionRef,
       briefRef: `reasoning-brief-${result.provenance.idempotencyKey}`,
       requestDigest: preflight.requestDigest,
       dataLeavesDevice: preflight.dataLeavesDevice,
       ...(preflight.retentionDisclosure === undefined
         ? {}
         : { retentionDisclosure: preflight.retentionDisclosure }),
       ...(result.usage === undefined
         ? {}
         : {
             usage: {
diff --git a/apps/editor-web/src/AgentPanel.tsx b/apps/editor-web/src/AgentPanel.tsx
index 944c521..f5affd8 100644
--- a/apps/editor-web/src/AgentPanel.tsx
+++ b/apps/editor-web/src/AgentPanel.tsx
@@ -27,21 +27,23 @@ import {
 } from './agent-panel-intents.js';
 import { AgentTimelineCanvas } from './AgentTimelineCanvas.js';
 import { extractPendingChanges } from './agent-plan-visualizer.js';
 import { saveWorkflow } from './workflow-recorder.js';
 import type { EditorSession } from './editor-session.js';
 import { JOY_MEDIA_ASSET_DND } from './TimelinePanel.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import type { AgentSettings } from './agent-settings.js';
 import { approvalPolicyForAgentSettings } from './agent-settings.js';
 import {
+  BrowserControlPlaneError,
   BrowserControlPlaneClient,
+  type BrowserProviderApprovalPreflight,
   type BrowserJoyCodeReasoningRequest,
   type BrowserJoyCodeReasoningResponse,
 } from './control-plane-client.js';
 import { JoyCodeLogo } from './JoyCodeLogo.js';
 import { JoyCode3DViewer } from './JoyCode3DViewer.js';
 import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
 import {
   addJoyCodeMessage,
   createJoyCodeThread,
   loadJoyCodeThreads,
@@ -75,20 +77,26 @@ interface PendingPlan {
 
 interface LastRun {
   readonly threadId: string;
   readonly intent: AgentIntent;
   readonly plan: AgentEditPlan;
   readonly executionResult: ExecutionResult;
   readonly reverted: boolean;
   readonly savedWorkflowId?: string;
 }
 
+interface PendingReasoningApproval {
+  readonly threadId: string;
+  readonly request: BrowserJoyCodeReasoningRequest;
+  readonly preflight: BrowserProviderApprovalPreflight;
+}
+
 interface JoyCodeState {
   readonly threads: readonly JoyCodeThread[];
   readonly activeThreadId: string;
 }
 
 export type JoyCodeReasoningResponse = BrowserJoyCodeReasoningResponse;
 
 export interface KiloCodeAttachedAsset {
   readonly assetId: string;
   readonly kind: 'image' | 'video' | 'markdown';
@@ -96,20 +104,23 @@ export interface KiloCodeAttachedAsset {
   /** Present when the file lives under OPFS joy-media-assets/joycode/. */
   readonly source?: 'joycode-folder';
 }
 
 export type AgentPanelCommandType = 'new-task' | 'activity' | 'stop';
 export interface AgentPanelCommand {
   readonly serial: number;
   readonly type: AgentPanelCommandType;
 }
 
+export type JoyCodePromptRoute =
+  { readonly kind: 'intent'; readonly intent: AgentIntent } | { readonly kind: 'reasoning' };
+
 /**
  * Maps the atomic runner into the result shape used by the run summary UI.
  */
 function toExecutionResult(run: AtomicRunResult): ExecutionResult {
   return {
     planId: run.planId,
     success: run.committed || run.replayed,
     transactionLabel: run.transactionLabel,
     stepResults: run.steps.map((step) => ({
       stepId: step.stepId,
@@ -235,20 +246,60 @@ export function JoyCodeReasoningDetails({
           <dd>
             {(usage.inputTokens ?? 0).toLocaleString()} in /{' '}
             {(usage.outputTokens ?? 0).toLocaleString()} out
           </dd>
         </div>
       )}
     </dl>
   );
 }
 
+export function JoyCodeReasoningApprovalDetails({
+  preflight,
+}: {
+  readonly preflight: BrowserProviderApprovalPreflight;
+}) {
+  return (
+    <dl className="joy-code-provider-approval" aria-label="Joy Code reasoning approval details">
+      <div>
+        <dt>Provider</dt>
+        <dd>{preflight.providerId}</dd>
+      </div>
+      <div>
+        <dt>Capability</dt>
+        <dd>{preflight.capability}</dd>
+      </div>
+      <div>
+        <dt>Approval</dt>
+        <dd>{preflight.requestDigest}</dd>
+      </div>
+      {preflight.estimatedCost !== undefined && (
+        <div>
+          <dt>Cost cap</dt>
+          <dd>
+            {preflight.estimatedCost.amount} {preflight.estimatedCost.currency}
+          </dd>
+        </div>
+      )}
+    </dl>
+  );
+}
+
+export function routeJoyCodePrompt(prompt: string): JoyCodePromptRoute {
+  const intentId = matchJoyCodeIntentId(prompt.trim());
+  const intent =
+    intentId === undefined
+      ? undefined
+      : AGENT_INTENTS.find((candidate) => candidate.id === intentId);
+  return intent === undefined ? { kind: 'reasoning' } : { kind: 'intent', intent };
+}
+
 function shortHash(value: unknown): string {
   const text = stableJson(value);
   let hash = 0x811c9dc5;
   for (let index = 0; index < text.length; index++) {
     hash ^= text.charCodeAt(index);
     hash = Math.imul(hash, 0x01000193);
   }
   return `fnv1a-${(hash >>> 0).toString(16)}`;
 }
 
@@ -426,20 +477,23 @@ export function AgentPanel({
   readonly command?: AgentPanelCommand;
 }) {
   const registry = useMemo(() => createToolRegistry(), []);
   const controlPlaneClient = useMemo(() => new BrowserControlPlaneClient(), []);
   const auditRef = useRef(createAuditTrail());
   const handledCommandRef = useRef<number | undefined>(undefined);
   const thinkingTimerRef = useRef<number | undefined>(undefined);
   const messagesEndRef = useRef<HTMLDivElement>(null);
   const attachInputRef = useRef<HTMLInputElement>(null);
   const [pending, setPending] = useState<PendingPlan | undefined>(undefined);
+  const [pendingReasoningApproval, setPendingReasoningApproval] = useState<
+    PendingReasoningApproval | undefined
+  >(undefined);
   const [lastRun, setLastRun] = useState<LastRun | undefined>(undefined);
   const [lastReasoning, setLastReasoning] = useState<BrowserJoyCodeReasoningResponse | undefined>(
     undefined,
   );
   const [thinkingThreadId, setThinkingThreadId] = useState<string | undefined>(undefined);
   const [tab, setTab] = useState('composer');
   const [draft, setDraft] = useState('');
   const [attachError, setAttachError] = useState<string | undefined>(undefined);
   const [attaching, setAttaching] = useState(false);
   const [joyCode, setJoyCode] = useState<JoyCodeState>(() => initialJoyCodeState(project.id));
@@ -455,21 +509,28 @@ export function AgentPanel({
   useEffect(() => {
     try {
       saveJoyCodeThreads(window.localStorage, project.id, joyCode.threads);
     } catch {
       // History persistence is optional; never block editing when storage is unavailable.
     }
   }, [joyCode.threads, project.id]);
 
   useEffect(() => {
     messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
-  }, [activeThread?.messages.length, pending, lastRun, tab, thinkingThreadId]);
+  }, [
+    activeThread?.messages.length,
+    pending,
+    pendingReasoningApproval,
+    lastRun,
+    tab,
+    thinkingThreadId,
+  ]);
 
   useEffect(
     () => () => {
       if (thinkingTimerRef.current !== undefined) {
         window.clearTimeout(thinkingTimerRef.current);
       }
     },
     [],
   );
 
@@ -483,36 +544,46 @@ export function AgentPanel({
     if (command.type === 'stop' && pending !== undefined) {
       auditRef.current.record({
         planId: pending.plan.planId,
         action: 'plan-rejected',
         userId: 'local-owner',
         metadata: { source: 'agent-menu-stop' },
       });
       appendMessage(pending.threadId, 'assistant', 'متوقف شد. ویرایش پیشنهادی اعمال نشد.');
       updateThreadStatus(pending.threadId, 'draft');
     }
+    if (command.type === 'stop' && pendingReasoningApproval !== undefined) {
+      appendMessage(
+        pendingReasoningApproval.threadId,
+        'assistant',
+        'تأیید پردازش راه‌دور لغو شد. هیچ داده‌ای ارسال نشد.',
+      );
+      updateThreadStatus(pendingReasoningApproval.threadId, 'draft');
+    }
     setPending(undefined);
+    setPendingReasoningApproval(undefined);
     if (command.type === 'new-task') startNewTask();
-  }, [command, pending]);
+  }, [command, pending, pendingReasoningApproval]);
 
   function startNewTask() {
     if (thinkingTimerRef.current !== undefined) {
       window.clearTimeout(thinkingTimerRef.current);
       thinkingTimerRef.current = undefined;
     }
     const now = new Date().toISOString();
     const thread = createJoyCodeThread(makeJoyCodeId('task'), now);
     setJoyCode((current) => ({
       threads: [thread, ...current.threads],
       activeThreadId: thread.id,
     }));
     setPending(undefined);
+    setPendingReasoningApproval(undefined);
     setLastRun(undefined);
     setLastReasoning(undefined);
     setThinkingThreadId(undefined);
     setDraft('');
     setTab('composer');
   }
 
   function appendMessage(threadId: string, role: 'user' | 'assistant', body: string): void {
     const now = new Date().toISOString();
     setJoyCode((current) => ({
@@ -605,40 +676,27 @@ export function AgentPanel({
       baseProject,
       dryRun,
       approval,
       ...(reasoning === undefined ? {} : { reasoning }),
     });
     if (reasoning !== undefined) setLastReasoning(reasoning);
     setLastRun(undefined);
     updateThreadStatus(threadId, 'planning');
   }
 
-  async function requestReasoning(prompt: string, threadId: string): Promise<void> {
-    if (settings.reasoningModel === '') {
-      appendMessage(
-        threadId,
-        'assistant',
-        'Joy Code اکنون درخواست‌های مستقیم تایم‌لاین را می‌پذیرد. برای نقد یا پیشنهاد bounded، ابتدا یک مدل reasoning را در Agent Settings انتخاب کنید.',
-      );
-      return;
-    }
-    const request = buildJoyCodeReasoningRequest({
-      project,
-      selectedClipIds,
-      playheadUs,
-      attachedAssets,
-      settings,
-      projectRevision: session.projectRevisionId,
-      goal: prompt,
-    });
+  async function runReasoningRequest(
+    request: BrowserJoyCodeReasoningRequest,
+    threadId: string,
+  ): Promise<void> {
     try {
       const reasoning = await controlPlaneClient.joyCodeReasoning(request);
+      setPendingReasoningApproval(undefined);
       setLastReasoning(reasoning);
       appendMessage(threadId, 'assistant', reasoning.brief.summary);
       if (reasoning.proposal !== undefined) {
         const proposalPlan = buildPendingPlanFromJoyCodeProposal({
           response: reasoning,
           project,
           selectedClipIds,
           playheadUs,
           baseRevision: session.projectRevisionId,
           registry,
@@ -647,84 +705,142 @@ export function AgentPanel({
         });
         if (proposalPlan !== undefined) {
           setPending({ ...proposalPlan, threadId });
           setLastRun(undefined);
           updateThreadStatus(threadId, 'planning');
           return;
         }
       }
       updateThreadStatus(threadId, 'draft');
     } catch (error) {
+      if (
+        error instanceof BrowserControlPlaneError &&
+        error.code === 'PROVIDER_APPROVAL_REQUIRED' &&
+        error.preflight !== undefined &&
+        request.privacyMode === 'ask-before-remote'
+      ) {
+        setPendingReasoningApproval({ threadId, request, preflight: error.preflight });
+        appendMessage(
+          threadId,
+          'assistant',
+          'Remote reasoning needs your approval before this bounded request leaves the device.',
+        );
+        updateThreadStatus(threadId, 'planning');
+        return;
+      }
       appendMessage(
         threadId,
         'assistant',
         error instanceof Error ? error.message : 'Bounded reasoning is unavailable right now.',
       );
       updateThreadStatus(threadId, 'failed');
     }
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
+    await runReasoningRequest(
+      buildJoyCodeReasoningRequest({
+        project,
+        selectedClipIds,
+        playheadUs,
+        attachedAssets,
+        settings,
+        projectRevision: session.projectRevisionId,
+        goal: prompt,
+      }),
+      threadId,
+    );
+  }
+
+  async function approveReasoning(): Promise<void> {
+    if (pendingReasoningApproval === undefined) return;
+    const { threadId, request, preflight } = pendingReasoningApproval;
+    setThinkingThreadId(threadId);
+    try {
+      const grant = await controlPlaneClient.issueProviderApprovalGrant({
+        providerId: preflight.providerId,
+        capability: preflight.capability,
+        requestDigest: preflight.requestDigest,
+        ...(preflight.estimatedCost === undefined ? {} : { costCap: preflight.estimatedCost }),
+      });
+      await runReasoningRequest({ ...request, providerApprovalGrant: grant }, threadId);
+    } finally {
+      setThinkingThreadId((current) => (current === threadId ? undefined : current));
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
         'assistant',
         'پیش از شروع ویرایش تازه، برنامهٔ فعلی را بررسی، اجرا یا رد کنید.',
       );
       return;
     }
-    const intentId = matchJoyCodeIntentId(body);
-    const intent = AGENT_INTENTS.find((candidate) => candidate.id === intentId);
-    if (intent === undefined) {
+    if (pendingReasoningApproval !== undefined) {
       appendMessage(
         threadId,
         'assistant',
-        'Joy Code اکنون درخواست‌های مستقیم تایم‌لاین مانند کوتاه‌کردن مقدمه، برش، جابه‌جایی، اتصال، افزودن یا حذف کلیپ را می‌پذیرد. پس از اتصال آداپتور نشست سرور، پاسخ آزاد KiloCode نیز اینجا نمایش داده می‌شود.',
+        'پیش از شروع درخواست تازه، تأیید پردازش راه‌دور فعلی را تأیید یا رد کنید.',
       );
       return;
     }
+    const route = routeJoyCodePrompt(body);
     setThinkingThreadId(threadId);
     thinkingTimerRef.current = window.setTimeout(() => {
       thinkingTimerRef.current = undefined;
-      try {
-        if (intent !== undefined) {
-          plan(intent, threadId);
-          return;
-        }
-        void requestReasoning(body, threadId).finally(() => {
-          setThinkingThreadId((current) => (current === threadId ? undefined : current));
-        });
-        return;
-      } finally {
-        if (intent !== undefined) {
-          setThinkingThreadId((current) => (current === threadId ? undefined : current));
-        }
-      }
+      const action =
+        route.kind === 'intent'
+          ? Promise.resolve().then(() => plan(route.intent, threadId))
+          : requestReasoning(body, threadId);
+      void action.finally(() => {
+        setThinkingThreadId((current) => (current === threadId ? undefined : current));
+      });
     }, THINKING_REVEAL_MS);
   }
 
   function reject() {
-    if (pending === undefined) return;
-    auditRef.current.record({
-      planId: pending.plan.planId,
-      action: 'plan-rejected',
-      userId: 'local-owner',
-    });
-    appendMessage(pending.threadId, 'assistant', 'رد شد. هیچ تغییری روی تایم‌لاین اعمال نشد.');
-    updateThreadStatus(pending.threadId, 'draft');
-    setPending(undefined);
+    if (pending !== undefined) {
+      auditRef.current.record({
+        planId: pending.plan.planId,
+        action: 'plan-rejected',
+        userId: 'local-owner',
+      });
+      appendMessage(pending.threadId, 'assistant', 'رد شد. هیچ تغییری روی تایم‌لاین اعمال نشد.');
+      updateThreadStatus(pending.threadId, 'draft');
+      setPending(undefined);
+      return;
+    }
+    if (pendingReasoningApproval !== undefined) {
+      appendMessage(
+        pendingReasoningApproval.threadId,
+        'assistant',
+        'پردازش راه‌دور رد شد. هیچ داده‌ای برای reasoning ارسال نشد.',
+      );
+      updateThreadStatus(pendingReasoningApproval.threadId, 'draft');
+      setPendingReasoningApproval(undefined);
+    }
   }
 
   async function executePending(manualApprovalGranted: boolean) {
     if (pending === undefined) return;
     const { threadId, intent, plan: agentPlan, baseRevision, baseProject } = pending;
     auditRef.current.record({
       planId: agentPlan.planId,
       action: 'execution-started',
       userId: 'local-owner',
     });
@@ -843,20 +959,21 @@ export function AgentPanel({
     });
     appendMessage(lastRun.threadId, 'assistant', 'کل اجرا با یک Undo بازگردانی شد.');
     updateThreadStatus(lastRun.threadId, 'draft');
     setLastRun({ ...lastRun, reverted: true });
   }
 
   const pendingChanges = useMemo(() => {
     if (pending === undefined) return [];
     return extractPendingChanges(pending.plan, project);
   }, [pending, project]);
+  const hasBlockingPending = pending !== undefined || pendingReasoningApproval !== undefined;
   const isThinking = thinkingThreadId === activeThread?.id;
 
   const uploadJoyCodeFiles = async (fileList: FileList | null) => {
     if (fileList === null || fileList.length === 0 || onAttachAsset === undefined) return;
     setAttaching(true);
     setAttachError(undefined);
     try {
       const cache = await openJoyCodeOpfsAssetCache();
       for (const file of Array.from(fileList)) {
         const meta = await cache.put(file);
@@ -1084,20 +1201,61 @@ export function AgentPanel({
                         className="is-primary"
                         onClick={() => void executePending(false)}
                       >
                         <PlayIcon />
                         Apply edit
                       </button>
                     )}
                   </div>
                 </section>
               )}
+              {pendingReasoningApproval !== undefined &&
+                pendingReasoningApproval.threadId === activeThread?.id && (
+                  <section
+                    className="joy-code-plan-card"
+                    aria-label="Joy Code remote reasoning approval"
+                  >
+                    <div className="joy-code-plan-head">
+                      <div>
+                        <span>Remote reasoning approval</span>
+                        <strong>{pendingReasoningApproval.request.model}</strong>
+                      </div>
+                      <span className="agent-decision agent-decision-requires-manual">
+                        requires manual
+                      </span>
+                    </div>
+                    <p>
+                      Approve this bounded request before Joy Code sends it to the remote model.
+                    </p>
+                    <span className="joy-code-plan-reason">
+                      {pendingReasoningApproval.preflight.retentionDisclosure ??
+                        'The bounded prompt will be sent to the configured remote reasoning provider.'}
+                    </span>
+                    <JoyCodeReasoningApprovalDetails
+                      preflight={pendingReasoningApproval.preflight}
+                    />
+                    <div className="joy-code-plan-actions">
+                      <button
+                        type="button"
+                        className="is-primary"
+                        onClick={() => void approveReasoning()}
+                      >
+                        <CheckIcon />
+                        Allow remote reasoning
+                      </button>
+                      <button type="button" onClick={reject}>
+                        <CloseIcon />
+                        Reject
+                      </button>
+                    </div>
+                  </section>
+                )}
 
               {lastRun !== undefined && lastRun.threadId === activeThread?.id && (
                 <section
                   className={`joy-code-run-card ${
                     lastRun.executionResult.success ? 'is-success' : 'is-failed'
                   }`}
                   aria-label="Last Joy Code run"
                 >
                   <div>
                     <strong>
@@ -1205,32 +1363,32 @@ export function AgentPanel({
                       submitPrompt(draft);
                     }
                   }}
                 />
                 <button
                   type="button"
                   className="joy-code-send"
                   aria-label={
                     isThinking
                       ? 'Joy Code is thinking'
-                      : pending === undefined
+                      : !hasBlockingPending
                         ? 'Send message'
-                        : 'Stop current plan'
+                        : 'Stop current request'
                   }
-                  title={isThinking ? 'Thinking…' : pending === undefined ? 'Send' : 'Stop'}
-                  disabled={isThinking || (pending === undefined && draft.trim().length === 0)}
+                  title={isThinking ? 'Thinking…' : !hasBlockingPending ? 'Send' : 'Stop'}
+                  disabled={isThinking || (!hasBlockingPending && draft.trim().length === 0)}
                   onClick={() => {
-                    if (pending !== undefined) reject();
+                    if (hasBlockingPending) reject();
                     else submitPrompt(draft);
                   }}
                 >
-                  {pending === undefined ? <PlayIcon /> : <CloseIcon />}
+                  {!hasBlockingPending ? <PlayIcon /> : <CloseIcon />}
                 </button>
               </div>
             </div>
           </section>
         )}
 
         {tab === '3d' && <JoyCode3DViewer />}
       </div>
     </PanelShell>
   );
diff --git a/apps/editor-web/src/control-plane-client.ts b/apps/editor-web/src/control-plane-client.ts
index ed5d8f1..cf03d3a 100644
--- a/apps/editor-web/src/control-plane-client.ts
+++ b/apps/editor-web/src/control-plane-client.ts
@@ -4,20 +4,26 @@ import {
   type VideoReferenceAnalyzePayload,
 } from '@joy-media/job-protocol';
 import type {
   ProductionRunAuthority,
   ProductionRunCheckpointUpdateResultV1,
   ProductionRunCheckpointUpdateV1,
   ProductionRunRecordV1,
   RecordProductionApprovalResponseInput,
   RecordProductionApprovalResponseResult,
 } from '@joy-media/workflow-engine';
+import type {
+  CapabilityId,
+  Money,
+  ProviderApprovalGrant,
+  ProviderApprovalPreflight,
+} from '@joy-media/provider-sdk';
 import { DerivativeAuthorityRevokedError } from './asset-resolver.js';
 import { getStoredMediaToken } from './media-session.js';
 
 export interface BrowserWorker {
   readonly id: string;
   readonly paired: boolean;
   readonly revoked: boolean;
   readonly capabilities: readonly string[];
   readonly lastSeenAt?: number;
 }
@@ -120,37 +126,52 @@ export interface BrowserReasoningProvider {
   readonly state:
     'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'offline' | 'unauthorized';
   readonly models: readonly {
     readonly id: string;
     readonly displayName: string;
     readonly version?: string;
   }[];
   readonly adapterVersion: string;
 }
 
+export type BrowserProviderApprovalPreflight = ProviderApprovalPreflight;
+export type BrowserProviderApprovalGrant = ProviderApprovalGrant;
+
+export class BrowserControlPlaneError extends Error {
+  constructor(
+    readonly code: string,
+    message: string,
+    readonly status: number,
+    readonly preflight?: BrowserProviderApprovalPreflight,
+  ) {
+    super(message);
+    this.name = 'BrowserControlPlaneError';
+  }
+}
+
 export interface BrowserJoyCodeReasoningEvidence {
   readonly evidenceId: string;
   readonly kind: 'selected-clip' | 'attached-asset' | 'timeline-range' | 'project-summary';
   readonly label: string;
   readonly detail: string;
 }
 
 export interface BrowserJoyCodeReasoningRequest {
   readonly model: string;
   readonly goal: string;
   readonly snapshotDigest: string;
   readonly projectRevision: string;
   readonly idempotencyKey: string;
   readonly privacyMode: 'local-only' | 'ask-before-remote';
   readonly evidence: readonly BrowserJoyCodeReasoningEvidence[];
   readonly allowedIntentIds: readonly string[];
-  readonly providerApprovalGrant?: Record<string, unknown>;
+  readonly providerApprovalGrant?: BrowserProviderApprovalGrant;
   readonly maxTokens?: number;
 }
 
 export interface BrowserJoyCodeReasoningResponse {
   readonly responseVersion: 1;
   readonly requestId: string;
   readonly brief: {
     readonly summary: string;
     readonly rationale: string;
     readonly evidenceReferences: readonly string[];
@@ -244,20 +265,29 @@ export class BrowserControlPlaneClient {
     const data = await this.get<{ readonly providers: readonly BrowserReasoningProvider[] }>(
       '/v1/providers/reasoning',
     );
     return data.providers;
   }
   async joyCodeReasoning(
     input: BrowserJoyCodeReasoningRequest,
   ): Promise<BrowserJoyCodeReasoningResponse> {
     return this.post('/v1/providers/reasoning/joy-code', input);
   }
+  async issueProviderApprovalGrant(input: {
+    readonly providerId: string;
+    readonly capability: CapabilityId;
+    readonly requestDigest: string;
+    readonly costCap?: Money;
+    readonly expiresAt?: string;
+  }): Promise<BrowserProviderApprovalGrant> {
+    return this.post('/v1/providers/approvals/grants', input);
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
@@ -635,40 +665,51 @@ export class BrowserControlPlaneClient {
       maxAttempts: 3,
     });
   }
   private async request<T>(path: string, init: RequestInit): Promise<T> {
     const token = await this.assertion();
     const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}${path}`, {
       ...init,
       headers: { ...init.headers, authorization: `Bearer ${token}` },
     });
     const body = await responseBody(response);
-    if (!response.ok) throw new Error(errorMessage(body, response.status));
+    if (!response.ok) throw controlPlaneError(body, response.status);
     if (!isRecord(body) || !('data' in body))
       throw new Error('JOY Media API returned an invalid response');
     return body.data as T;
   }
   private assertion(): string {
     const token = this.tokenProvider();
     if (token === undefined) throw new Error('JOY Media session required');
     return token;
   }
 }
 
 function errorMessage(body: unknown, status: number): string {
   if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
     const code = typeof body.error.code === 'string' ? `${body.error.code}: ` : '';
     return `${code}${body.error.message}`;
   }
   if (isRecord(body) && typeof body.error === 'string') return body.error;
   return `JOY Media request failed (${status})`;
 }
+
+function controlPlaneError(body: unknown, status: number): Error {
+  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
+    const code = typeof body.error.code === 'string' ? body.error.code : 'REQUEST_FAILED';
+    const preflight = isRecord(body.error.preflight)
+      ? (body.error.preflight as unknown as BrowserProviderApprovalPreflight)
+      : undefined;
+    return new BrowserControlPlaneError(code, body.error.message, status, preflight);
+  }
+  return new Error(errorMessage(body, status));
+}
 async function responseBody(response: Response): Promise<unknown> {
   const text = await response.text();
   if (text.length === 0) return {};
   try {
     return JSON.parse(text) as unknown;
   } catch {
     return { error: text };
   }
 }
 function isRecord(value: unknown): value is Record<string, unknown> {
diff --git a/apps/editor-web/src/joy-code-critique.test.tsx b/apps/editor-web/src/joy-code-critique.test.tsx
index a6eec10..c08b3f7 100644
--- a/apps/editor-web/src/joy-code-critique.test.tsx
+++ b/apps/editor-web/src/joy-code-critique.test.tsx
@@ -1,27 +1,33 @@
 import { renderToStaticMarkup } from 'react-dom/server';
-import { describe, expect, it } from 'vitest';
+import { describe, expect, it, vi } from 'vitest';
 import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
 import {
   ApprovalEngine,
   buildEditorContext,
   createIdempotencyStore,
   createPreviewAndApprovePolicy,
   createToolRegistry,
   runPlanAtomically,
 } from '@joy-media/agent-tools';
 import {
+  routeJoyCodePrompt,
   JoyCodeReasoningDetails,
   buildJoyCodeReasoningRequest,
   buildPendingPlanFromJoyCodeProposal,
   type JoyCodeReasoningResponse,
 } from './AgentPanel.js';
+import {
+  BrowserControlPlaneClient,
+  BrowserControlPlaneError,
+  type BrowserProviderApprovalGrant,
+} from './control-plane-client.js';
 
 describe('Joy Code critique helpers', () => {
   it('keeps read-only critique responses bounded to evidence and leaves the revision unchanged', () => {
     const project = buildReferenceSpikeProject();
     const revision = 'local-revision:v1:project:timeline=1:document=1:graph=0:artifacts=0';
     const request = buildJoyCodeReasoningRequest({
       project,
       selectedClipIds: ['intro'],
       playheadUs: 5_000_000,
       attachedAssets: [],
@@ -152,11 +158,142 @@ describe('Joy Code critique helpers', () => {
       commit: (transaction) => {
         commits.push(transaction);
         return { success: true };
       },
     });
 
     expect(atomic.committed).toBe(true);
     expect(commits).toHaveLength(1);
     expect(commits[0]?.commands.length).toBeGreaterThan(1);
   });
+
+  it('routes unmatched Joy Code prompts to bounded reasoning instead of rejecting them', () => {
+    expect(routeJoyCodePrompt('shorten the intro')).toMatchObject({ kind: 'intent' });
+    expect(routeJoyCodePrompt('make the opening feel more cinematic')).toEqual({
+      kind: 'reasoning',
+    });
+  });
+
+  it('preserves provider approval preflight in the client and resubmits reasoning with the signed grant', async () => {
+    const originalFetch = globalThis.fetch;
+    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
+    const signedGrant: BrowserProviderApprovalGrant = {
+      grantVersion: 1,
+      grantId: 'grant-joy-code-browser-1',
+      grantSignature: 'signed-grant',
+      actorId: 'owner',
+      providerId: 'mistral',
+      capability: 'llm.complete',
+      requestDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
+      expiresAt: '2026-08-22T00:05:00.000Z',
+      status: 'approved',
+      costCap: { amount: '0.00', currency: 'USD' },
+    };
+    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
+      const url = String(input);
+      const body = typeof init?.body === 'string' ? init.body : undefined;
+      requests.push({ url, ...(body === undefined ? {} : { body }) });
+      if (url.endsWith('/v1/providers/reasoning/joy-code') && requests.length === 1) {
+        return new Response(
+          JSON.stringify({
+            error: {
+              code: 'PROVIDER_APPROVAL_REQUIRED',
+              message: 'Provider processing requires an approval grant bound to this request.',
+              preflight: {
+                providerId: 'mistral',
+                capability: 'llm.complete',
+                requestDigest: signedGrant.requestDigest,
+                dataLeavesDevice: true,
+                dataBeingSent: ['text prompt'],
+                purpose: 'Complete text generation',
+                estimatedSizeBytes: 5000,
+                transformations: ['remote API call'],
+                requiresUserApproval: true,
+                estimatedCost: { amount: '0.00', currency: 'USD' },
+              },
+            },
+          }),
+          { status: 409, headers: { 'content-type': 'application/json' } },
+        );
+      }
+      if (url.endsWith('/v1/providers/approvals/grants')) {
+        return new Response(JSON.stringify({ data: signedGrant }), {
+          status: 201,
+          headers: { 'content-type': 'application/json' },
+        });
+      }
+      return new Response(
+        JSON.stringify({
+          data: {
+            responseVersion: 1,
+            requestId: 'joy-code-approved-1',
+            brief: {
+              summary: 'Approved bounded critique.',
+              rationale: 'Approved for remote reasoning.',
+              evidenceReferences: ['clip:intro'],
+            },
+            provider: {
+              providerId: 'mistral',
+              modelId: 'mistral-small-latest',
+              decisionRef: 'provider-decision-approved-1',
+              briefRef: 'reasoning-brief-approved-1',
+              requestDigest: signedGrant.requestDigest,
+              dataLeavesDevice: true,
+            },
+          },
+        }),
+        { status: 200, headers: { 'content-type': 'application/json' } },
+      );
+    });
+    try {
+      const client = new BrowserControlPlaneClient('https://media.joyteam.ir/api', () => 'session');
+      const request = {
+        model: 'mistral-small-latest',
+        goal: 'Critique the opening pacing only.',
+        snapshotDigest: 'fnv1a-abc123',
+        projectRevision: 'rev-1',
+        idempotencyKey: 'joy-code-browser-1',
+        privacyMode: 'ask-before-remote' as const,
+        evidence: [
+          {
+            evidenceId: 'clip:intro',
+            kind: 'selected-clip' as const,
+            label: 'Intro',
+            detail: '0s to 10s',
+          },
+        ],
+        allowedIntentIds: ['shorten-intro'],
+      };
+
+      const error = await client.joyCodeReasoning(request).catch((reason) => reason);
+      expect(error).toBeInstanceOf(BrowserControlPlaneError);
+      expect(error).toMatchObject({
+        code: 'PROVIDER_APPROVAL_REQUIRED',
+        preflight: {
+          providerId: 'mistral',
+          capability: 'llm.complete',
+          requestDigest: signedGrant.requestDigest,
+        },
+      });
+
+      const grant = await client.issueProviderApprovalGrant({
+        providerId: error.preflight.providerId,
+        capability: error.preflight.capability,
+        requestDigest: error.preflight.requestDigest,
+        costCap: error.preflight.estimatedCost,
+      });
+      const approved = await client.joyCodeReasoning({ ...request, providerApprovalGrant: grant });
+
+      expect(approved.brief.summary).toBe('Approved bounded critique.');
+      expect(requests.map((entry) => entry.url)).toEqual([
+        'https://media.joyteam.ir/api/v1/providers/reasoning/joy-code',
+        'https://media.joyteam.ir/api/v1/providers/approvals/grants',
+        'https://media.joyteam.ir/api/v1/providers/reasoning/joy-code',
+      ]);
+      expect(requests[1]?.body).toContain(`"requestDigest":"${signedGrant.requestDigest}"`);
+      expect(requests[2]?.body).toContain('"providerApprovalGrant"');
+      expect(requests[2]?.body).toContain('"grantSignature":"signed-grant"');
+    } finally {
+      globalThis.fetch = originalFetch;
+    }
+  });
 });
