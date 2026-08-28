# Review package: c561e4e..f45b9b7

## Commits
f45b9b7 feat(api): enforce shared provider privacy spend approvals

## Files changed
 apps/api/src/http-server.test.ts          | 104 ++++++++-
 apps/api/src/http-server.ts               | 205 +++++++++++++++++-
 apps/api/src/mistral-provider.ts          | 180 ++++++++++++----
 apps/api/src/provider-approval.test.ts    | 204 ++++++++++++++++++
 apps/api/src/provider-approval.ts         | 346 ++++++++++++++++++++++++++++++
 apps/api/src/spectral-denoise.ts          |  57 +++++
 apps/api/src/speech-synthesize.ts         |  80 ++++++-
 packages/agent-tools/src/approval.ts      |  32 +++
 packages/provider-sdk/src/index.ts        |  11 +-
 packages/provider-sdk/src/privacy.test.ts |  40 +++-
 packages/provider-sdk/src/privacy.ts      |  66 ++++++
 11 files changed, 1255 insertions(+), 70 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index a782574..b7a92df 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -1,20 +1,21 @@
 import { createHash } from 'node:crypto';
 import type { Server } from 'node:http';
 import { once } from 'node:events';
 import type { Pool } from 'pg';
 import { newDb } from 'pg-mem';
 import { afterEach, describe, expect, it } from 'vitest';
 import { LocalControlPlane, type ControlPlane } from './control-plane.js';
 import { createControlPlaneHttpServer, type ApiAuthentication } from './http-server.js';
 import { DisabledMediaAuth } from './media-auth.js';
 import { MemoryMistralInvocationLedger, MistralProviderRegistry } from './mistral-provider.js';
+import { ProviderApprovalService } from './provider-approval.js';
 import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
 import type { WorkerResultReceiptV1, WorkerJobType } from '@joy-media/job-protocol';
 import { PostgresControlPlane } from './postgres-control-plane.js';
 import type { ProductionRunAuthority, ProductionRunRecordV1 } from './production-runs.js';
 
 const servers: Server[] = [];
 
 afterEach(async () => {
   await Promise.all(
     servers
@@ -66,71 +67,152 @@ describe('control-plane HTTP transport', () => {
         idempotencyKey: 'unconfigured-1',
         privacyMode: 'ask-before-remote',
         approvedRemoteProcessing: true,
         approvedSpend: true,
       }),
     ).toMatchObject({ status: 503, body: { error: { code: 'PROVIDER_UNCONFIGURED' } } });
   });
 
   it('requires remote/spend approval and records an idempotent Mistral completion without secrets or prompts', async () => {
     let calls = 0;
+    const approvals = new ProviderApprovalService();
     const registry = new MistralProviderRegistry(
       'test-only-mistral-secret',
       new MemoryMistralInvocationLedger(),
+      approvals,
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
-    const origin = await start({ authenticate: () => ({ id: 'owner' }) }, undefined, registry);
+    const origin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      registry,
+      undefined,
+      approvals,
+    );
     const base = {
       model: 'mistral-small-latest',
       messages: [{ role: 'user', content: 'Do not persist this prompt.' }],
       idempotencyKey: 'mistral-1',
       privacyMode: 'ask-before-remote',
       approvedRemoteProcessing: true,
       approvedSpend: true,
     };
-    expect(
-      await request(origin, 'POST', '/v1/providers/mistral/complete', {
-        ...base,
-        approvedSpend: false,
-      }),
-    ).toMatchObject({
+    const approvalRequired = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
+    expect(approvalRequired).toMatchObject({
       status: 409,
-      body: { error: { code: 'PROVIDER_SPEND_APPROVAL_REQUIRED' } },
+      body: { error: { code: 'PROVIDER_APPROVAL_REQUIRED', preflight: { providerId: 'mistral' } } },
+    });
+    const preflight = (
+      approvalRequired.body as {
+        error: {
+          preflight: {
+            actorId?: string;
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
+      grantId: 'grant-mistral-1',
     });
-    const first = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
+    const approved = { ...base, providerApprovalGrant };
+    const first = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
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
-    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', base);
+    const retried = await request(origin, 'POST', '/v1/providers/mistral/complete', approved);
     expect(retried).toEqual(first);
+    expect(
+      await request(origin, 'POST', '/v1/providers/mistral/complete', {
+        ...approved,
+        messages: [{ role: 'user', content: 'Different prompt.' }],
+      }),
+    ).toMatchObject({
+      status: 409,
+      body: { error: { code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' } },
+    });
     expect(calls).toBe(1);
     expect(JSON.stringify(first.body)).not.toContain('test-only-mistral-secret');
     expect(JSON.stringify(first.body)).not.toContain('Do not persist this prompt.');
+    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
+    expect(audit).toMatchObject({
+      status: 200,
+      body: {
+        data: expect.arrayContaining([
+          expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
+          expect.objectContaining({ status: 'succeeded', approvalGrantId: 'grant-mistral-1' }),
+        ]),
+      },
+    });
+    expect(JSON.stringify(audit.body)).not.toContain('Do not persist this prompt.');
+  });
+
+  it('requires shared remote approval before Edge TTS can run', async () => {
+    const approvals = new ProviderApprovalService();
+    const origin = await start(
+      { authenticate: () => ({ id: 'owner' }) },
+      undefined,
+      undefined,
+      undefined,
+      approvals,
+    );
+
+    const blocked = await request(origin, 'POST', '/v1/providers/speech/synthesize', {
+      text: 'Do not send before approval.',
+      language: 'en-US',
+      engine: 'edge-tts',
+      idempotencyKey: 'tts-edge-1',
+      privacyMode: 'ask-before-remote',
+    });
+
+    expect(blocked).toMatchObject({
+      status: 409,
+      body: {
+        error: {
+          code: 'PROVIDER_APPROVAL_REQUIRED',
+          preflight: { providerId: 'edge-tts', capability: 'speech.synthesize' },
+        },
+      },
+    });
+    const audit = await request(origin, 'GET', '/v1/providers/approvals/audit');
+    expect(audit).toMatchObject({
+      status: 200,
+      body: { data: [expect.objectContaining({ status: 'denied', reason: 'approval-required' })] },
+    });
+    expect(JSON.stringify(audit.body)).not.toContain('Do not send before approval.');
   });
 
   it('preserves project, Worker lease, completion, and cursor event semantics over v1', async () => {
     const origin = await start({ authenticate: () => ({ id: 'owner' }) });
 
     expect(
       await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' }),
     ).toMatchObject({
       status: 201,
       body: { data: { id: 'p', revision: 0 } },
@@ -1024,27 +1106,29 @@ describe('control-plane HTTP transport', () => {
       body: { error: { code: 'REQUEST_INVALID' } },
     });
   });
 });
 
 async function start(
   authentication: ApiAuthentication,
   privateObjectStore?: PrivateObjectStore,
   mistral?: MistralProviderRegistry,
   controlPlane?: ControlPlane,
+  providerApprovals?: ProviderApprovalService,
 ): Promise<string> {
   const server = createControlPlaneHttpServer({
     controlPlane: controlPlane ?? new LocalControlPlane(),
     authentication,
     mediaAuth: new DisabledMediaAuth(),
     ...(privateObjectStore === undefined ? {} : { privateObjectStore }),
     ...(mistral === undefined ? {} : { mistral }),
+    ...(providerApprovals === undefined ? {} : { providerApprovals }),
   });
   servers.push(server);
   server.listen(0, '127.0.0.1');
   await once(server, 'listening');
   const address = server.address();
   if (address === null || typeof address === 'string') throw new Error('test API did not bind TCP');
   return `http://127.0.0.1:${address.port}`;
 }
 
 class MemoryPrivateObjectStore implements PrivateObjectStore {
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 941d46f..69dd47d 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -11,67 +11,81 @@ import {
   DisabledMediaAuth,
   MediaAuthError,
   type MediaAuthApi,
   type MediaAuthMethod,
 } from './media-auth.js';
 import {
   createRuntimeMistralProviderRegistry,
   MistralProviderError,
   type MistralProviderRegistry,
 } from './mistral-provider.js';
+import {
+  ProviderApprovalError,
+  ProviderApprovalService,
+  providerApprovalRequiredPayload,
+} from './provider-approval.js';
 import {
   type ProductionRunAuthority,
   type ProductionRunRecordV1,
   type ProductionRunStateV1,
   type ProductionRunStore,
 } from './production-runs.js';
 import type { PrivateObjectStore } from './private-object-store.js';
 import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
 import type { WorkerJobV1, WorkerResultReceiptV1 } from '@joy-media/job-protocol';
+import {
+  computeProviderApprovalPreflight,
+  type ProviderApprovalGrant,
+} from '@joy-media/provider-sdk';
 
 export interface ApiAuthentication {
   authenticate(request: IncomingMessage): Actor | undefined | Promise<Actor | undefined>;
 }
 
 export interface ControlPlaneHttpServerOptions {
   readonly controlPlane: ControlPlane;
   readonly authentication: ApiAuthentication;
   readonly mediaAuth?: MediaAuthApi;
   readonly privateObjectStore?: PrivateObjectStore;
   /** Server-only provider registry; it never serializes a credential. */
   readonly mistral?: MistralProviderRegistry;
+  readonly providerApprovals?: ProviderApprovalService;
 }
 
 /**
  * Versioned transport boundary for the control-plane contract. Authentication
  * is injected so the public service can use the shared JOY identity boundary;
  * this module deliberately does not contain a header/token fallback.
  */
 export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
+  const providerApprovals = options.providerApprovals ?? new ProviderApprovalService();
   const resolvedOptions = {
     ...options,
     mediaAuth: options.mediaAuth ?? new DisabledMediaAuth(),
-    mistral: options.mistral ?? createRuntimeMistralProviderRegistry(),
+    providerApprovals,
+    mistral:
+      options.mistral ?? createRuntimeMistralProviderRegistry({ approvals: providerApprovals }),
   };
   return createServer(async (request, response) => {
     try {
       await route(resolvedOptions, request, response);
     } catch (error) {
       respondError(response, error);
     }
   });
 }
 
 async function route(
   options: ControlPlaneHttpServerOptions & {
     readonly mistral: MistralProviderRegistry;
     readonly mediaAuth: MediaAuthApi;
+    readonly providerApprovals: ProviderApprovalService;
   },
   request: IncomingMessage,
   response: ServerResponse,
 ): Promise<void> {
   const url = new URL(request.url ?? '/', 'http://joy-media.invalid');
   if (request.method === 'GET' && url.pathname === '/health') {
     respondJson(response, 200, { ok: true, service: 'joy-media-api', controlPlane: true });
     return;
   }
   if (!url.pathname.startsWith('/v1/')) {
@@ -300,20 +314,25 @@ async function route(
   }
 
   const actor = await options.authentication.authenticate(request);
   if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');
 
   if (request.method === 'GET' && url.pathname === '/v1/providers/reasoning') {
     respondJson(response, 200, { data: { providers: [options.mistral.summary()] } });
     return;
   }
 
+  if (request.method === 'GET' && url.pathname === '/v1/providers/approvals/audit') {
+    respondJson(response, 200, { data: await options.providerApprovals.auditRows(actor.id) });
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
@@ -551,52 +570,121 @@ async function route(
           providerId: 'joy.faster-whisper',
           modelId: transcript.modelId,
           createdAt: new Date().toISOString(),
         },
       },
     });
     return;
   }
 
   if (request.method === 'POST' && url.pathname === '/v1/providers/speech/synthesize') {
-    const { runSpeechSynthesis, resolveSpeechEngine } = await import('./speech-synthesize.js');
+    const {
+      runSpeechSynthesis,
+      resolveSpeechEngine,
+      speechSynthesisCapabilityRequest,
+      speechSynthesisProvider,
+    } = await import('./speech-synthesize.js');
     const body = await readJson(request);
     const text = requiredString(body, 'text');
     const language = typeof body.language === 'string' ? body.language : undefined;
     const voiceId = typeof body.voiceId === 'string' ? body.voiceId : undefined;
     const speed = typeof body.speed === 'number' ? body.speed : undefined;
     const engine = resolveSpeechEngine(body.engine);
-    const synthesized = runSpeechSynthesis({
+    const idempotencyKey =
+      optionalString(body, 'idempotencyKey') ??
+      providerRouteIdempotencyKey({
+        capability: 'speech.synthesize',
+        text,
+        language,
+        voiceId,
+        speed,
+        engine,
+      });
+    const synthesisRequest = {
       text,
       engine,
+      idempotencyKey,
       ...(language !== undefined ? { language } : {}),
       ...(voiceId !== undefined ? { voiceId } : {}),
       ...(speed !== undefined ? { speed } : {}),
-    });
-    respondJson(response, 200, { data: synthesized });
+    };
+    const capabilityRequest = speechSynthesisCapabilityRequest(synthesisRequest);
+    const preflight = computeProviderApprovalPreflight(
+      actor.id,
+      capabilityRequest,
+      speechSynthesisProvider(engine),
+    );
+    const approvalInput = {
+      actorId: actor.id,
+      idempotencyKey,
+      preflight,
+      privacyMode:
+        optionalPrivacyMode(body, 'privacyMode') ??
+        (engine === 'edge-tts' ? 'ask-before-remote' : 'local-only'),
+      grant: optionalProviderApprovalGrant(body),
+      fallbackCostCap: { amount: '0.00', currency: 'USD' },
+    } as const;
+    const approval = await options.providerApprovals.verify(approvalInput);
+    try {
+      const synthesized = runSpeechSynthesis(synthesisRequest);
+      await options.providerApprovals.recordSucceeded(approvalInput, approval.reservation);
+      respondJson(response, 200, { data: synthesized, preflight });
+    } catch (error) {
+      await options.providerApprovals.recordFailed(
+        approvalInput,
+        approval.reservation,
+        error instanceof Error ? error.message : 'speech-synthesis-failed',
+      );
+      throw error;
+    }
     return;
   }
 
   if (request.method === 'POST' && url.pathname === '/v1/providers/audio/denoise') {
-    const { runSpectralDenoise } = await import('./spectral-denoise.js');
+    const { runSpectralDenoise, spectralDenoiseCapabilityRequest, spectralDenoiseProvider } =
+      await import('./spectral-denoise.js');
     const body = await readJson(request);
     const assetId = requiredString(body, 'assetId');
     const mediaBase64 = requiredString(body, 'mediaBase64');
     const sampleRate = typeof body.sampleRate === 'number' ? body.sampleRate : undefined;
     const strength = typeof body.strength === 'number' ? body.strength : undefined;
-    const denoised = runSpectralDenoise({
+    const idempotencyKey =
+      optionalString(body, 'idempotencyKey') ??
+      providerRouteIdempotencyKey({
+        capability: 'audio.denoise',
+        assetId,
+        mediaDigest: secretHash(mediaBase64),
+        sampleRate,
+        strength,
+      });
+    const denoiseRequest = {
       assetId,
       mediaBase64,
+      idempotencyKey,
       ...(sampleRate !== undefined ? { sampleRate } : {}),
       ...(strength !== undefined ? { strength } : {}),
+    };
+    const capabilityRequest = spectralDenoiseCapabilityRequest(denoiseRequest);
+    const preflight = computeProviderApprovalPreflight(
+      actor.id,
+      capabilityRequest,
+      spectralDenoiseProvider(),
+    );
+    await options.providerApprovals.verify({
+      actorId: actor.id,
+      idempotencyKey,
+      preflight,
+      privacyMode: 'local-only',
+      fallbackCostCap: { amount: '0.00', currency: 'USD' },
     });
-    respondJson(response, 200, { data: denoised });
+    const denoised = runSpectralDenoise(denoiseRequest);
+    respondJson(response, 200, { data: denoised, preflight });
     return;
   }
 
   const assetSyncMatch = /^\/v1\/projects\/([^/]+)\/asset-sync$/.exec(url.pathname);
   if (request.method === 'POST' && assetSyncMatch !== null) {
     const body = await readJson(request);
     if (typeof body.enabled !== 'boolean')
       throw new ControlPlaneError('REQUEST_INVALID', 'enabled must be boolean');
     respondJson(response, 200, {
       data: await options.controlPlane.setAssetSync(
@@ -932,20 +1020,28 @@ function requiredAuthMethod(body: Record<string, unknown>): MediaAuthMethod {
   return value;
 }
 
 function requiredString(body: Record<string, unknown>, field: string): string {
   const value = body[field];
   if (typeof value !== 'string' || value.length === 0)
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
   return value;
 }
 
+function optionalString(body: Record<string, unknown>, field: string): string | undefined {
+  const value = body[field];
+  if (value === undefined) return undefined;
+  if (typeof value !== 'string' || value.length === 0)
+    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
+  return value;
+}
+
 function mistralCompletionRequest(body: Record<string, unknown>) {
   const messages = body.messages;
   if (!Array.isArray(messages) || messages.length === 0 || messages.length > 64)
     throw new ControlPlaneError(
       'REQUEST_INVALID',
       'messages must contain between 1 and 64 entries',
     );
   const parsedMessages = messages.map((message) => {
     if (message === null || typeof message !== 'object' || Array.isArray(message))
       throw new ControlPlaneError('REQUEST_INVALID', 'message must be an object');
@@ -971,25 +1067,90 @@ function mistralCompletionRequest(body: Record<string, unknown>) {
     throw new ControlPlaneError('REQUEST_INVALID', 'privacyMode is invalid');
   const maxTokens = optionalNumber('maxTokens');
   const temperature = optionalNumber('temperature');
   return {
     model: requiredString(body, 'model'),
     messages: parsedMessages,
     idempotencyKey: requiredString(body, 'idempotencyKey'),
     privacyMode: privacyMode as 'local-only' | 'ask-before-remote',
     approvedRemoteProcessing: body.approvedRemoteProcessing === true,
     approvedSpend: body.approvedSpend === true,
+    ...(optionalProviderApprovalGrant(body) === undefined
+      ? {}
+      : { approvalGrant: optionalProviderApprovalGrant(body) }),
     ...(maxTokens === undefined ? {} : { maxTokens }),
     ...(temperature === undefined ? {} : { temperature }),
   };
 }
 
+function optionalPrivacyMode(
+  body: Record<string, unknown>,
+  field: string,
+): 'local-only' | 'ask-before-remote' | undefined {
+  const value = body[field];
+  if (value === undefined) return undefined;
+  if (value !== 'local-only' && value !== 'ask-before-remote') {
+    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
+  }
+  return value;
+}
+
+function optionalProviderApprovalGrant(
+  body: Record<string, unknown>,
+): ProviderApprovalGrant | undefined {
+  const value = body.providerApprovalGrant ?? body.approvalGrant;
+  if (value === undefined) return undefined;
+  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
+    throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant must be an object');
+  }
+  const grant = value as Record<string, unknown>;
+  if (
+    grant.grantVersion !== 1 ||
+    typeof grant.grantId !== 'string' ||
+    typeof grant.actorId !== 'string' ||
+    typeof grant.providerId !== 'string' ||
+    typeof grant.capability !== 'string' ||
+    typeof grant.requestDigest !== 'string' ||
+    typeof grant.expiresAt !== 'string' ||
+    (grant.status !== 'approved' && grant.status !== 'denied')
+  ) {
+    throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant is invalid');
+  }
+  let costCap: ProviderApprovalGrant['costCap'];
+  if (grant.costCap !== undefined) {
+    if (
+      grant.costCap === null ||
+      typeof grant.costCap !== 'object' ||
+      Array.isArray(grant.costCap)
+    ) {
+      invalidRequest('providerApprovalGrant.costCap is invalid');
+    }
+    const cap = grant.costCap as Record<string, unknown>;
+    if (typeof cap.amount !== 'string' || typeof cap.currency !== 'string') {
+      invalidRequest('providerApprovalGrant.costCap is invalid');
+    }
+    costCap = { amount: cap.amount, currency: cap.currency };
+  }
+  const parsed: ProviderApprovalGrant = {
+    grantVersion: 1,
+    grantId: grant.grantId,
+    actorId: grant.actorId,
+    providerId: grant.providerId,
+    capability: grant.capability as ProviderApprovalGrant['capability'],
+    requestDigest: grant.requestDigest,
+    expiresAt: grant.expiresAt,
+    status: grant.status,
+    ...(costCap === undefined ? {} : { costCap }),
+  };
+  return parsed;
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
@@ -1463,20 +1624,33 @@ function requiredObject(body: Record<string, unknown>, field: string): Record<st
     throw new ControlPlaneError('REQUEST_INVALID', `${field} must be an object`);
   return value as Record<string, unknown>;
 }
 
 function respondJson(response: ServerResponse, status: number, payload: unknown): void {
   response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
   response.end(JSON.stringify(payload));
 }
 
 function respondError(response: ServerResponse, error: unknown): void {
+  if (error instanceof ProviderApprovalError) {
+    const status =
+      error.code === 'PROVIDER_APPROVAL_REQUIRED' ||
+      error.code === 'REMOTE_PROCESSING_BLOCKED' ||
+      error.code === 'PROVIDER_APPROVAL_EXPIRED' ||
+      error.code === 'PROVIDER_APPROVAL_REPLAY_REJECTED' ||
+      error.code === 'PROVIDER_APPROVAL_DENIED' ||
+      error.code === 'PROVIDER_SPEND_CAP_EXCEEDED'
+        ? 409
+        : 502;
+    respondJson(response, status, { error: providerApprovalRequiredPayload(error) });
+    return;
+  }
   if (error instanceof MistralProviderError) {
     const status =
       error.code === 'PROVIDER_UNCONFIGURED' ||
       error.code === 'MISTRAL_UNAUTHORIZED' ||
       error.code === 'MISTRAL_UNAVAILABLE'
         ? 503
         : error.code.endsWith('APPROVAL_REQUIRED') || error.code === 'REMOTE_PROCESSING_BLOCKED'
           ? 409
           : 502;
     respondJson(response, status, { error: { code: error.code, message: error.message } });
@@ -1511,10 +1685,25 @@ function bearerToken(request: IncomingMessage): string | undefined {
 }
 
 function workerSessionHash(request: IncomingMessage): string {
   const token = bearerToken(request);
   return token === undefined ? '' : secretHash(token);
 }
 
 function secretHash(value: string): string {
   return createHash('sha256').update(value).digest('base64url');
 }
+
+function providerRouteIdempotencyKey(value: unknown): string {
+  return `provider-${createHash('sha256').update(stableJson(value)).digest('base64url')}`;
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
diff --git a/apps/api/src/mistral-provider.ts b/apps/api/src/mistral-provider.ts
index 59421a2..72f1d7b 100644
--- a/apps/api/src/mistral-provider.ts
+++ b/apps/api/src/mistral-provider.ts
@@ -1,32 +1,40 @@
 import type { Pool } from 'pg';
 import {
   createMistralAdapter,
   MISTRAL_PROVIDER_ID,
   MISTRAL_REASONING_MODELS,
   type MistralChatMessage,
 } from '@joy-media/adapter-mistral';
 import {
-  computePrivacyPreflight,
+  computeProviderApprovalPreflight,
   ProviderLifecycle,
   resolveProvider,
   type CapabilityResult,
+  type CapabilityRequest,
+  type ProviderApprovalGrant,
   type ProviderStatus,
 } from '@joy-media/provider-sdk';
+import {
+  ProviderApprovalError,
+  ProviderApprovalService,
+  type ProviderApprovalOutcome,
+} from './provider-approval.js';
 
 export interface MistralCompletionRequest {
   readonly model: string;
   readonly messages: readonly MistralChatMessage[];
   readonly idempotencyKey: string;
   readonly privacyMode: 'local-only' | 'ask-before-remote';
   readonly approvedRemoteProcessing: boolean;
   readonly approvedSpend: boolean;
+  readonly approvalGrant?: ProviderApprovalGrant | undefined;
   readonly maxTokens?: number;
   readonly temperature?: number;
 }
 
 export interface MistralProviderSummary {
   readonly providerId: typeof MISTRAL_PROVIDER_ID;
   readonly state: ProviderStatus['state'];
   readonly models: readonly {
     readonly id: string;
     readonly displayName: string;
@@ -122,144 +130,226 @@ export class PostgresMistralInvocationLedger implements MistralInvocationLedger
     if (stored.rows[0] !== undefined) return stored.rows[0].result;
     const existing = await this.find(actorId, result.provenance.idempotencyKey);
     if (existing === undefined) throw new Error('provider invocation record was not persisted');
     return existing;
   }
 }
 
 export class MistralProviderRegistry {
   readonly #provider;
   readonly #lifecycle = new ProviderLifecycle();
+  readonly #approvals: ProviderApprovalService;
 
   constructor(
     apiKey: string | undefined,
     private readonly ledger: MistralInvocationLedger = new MemoryMistralInvocationLedger(),
+    approvalsOrFetch?: ProviderApprovalService | typeof fetch,
     fetchImpl?: typeof fetch,
   ) {
+    const approvals =
+      typeof approvalsOrFetch === 'function' || approvalsOrFetch === undefined
+        ? new ProviderApprovalService()
+        : approvalsOrFetch;
+    const resolvedFetch = typeof approvalsOrFetch === 'function' ? approvalsOrFetch : fetchImpl;
+    this.#approvals = approvals;
     // An empty value is used only to construct the manifest for the
     // unconfigured state. invoke() is guarded before this adapter can run.
     this.#provider = createMistralAdapter({
       apiKey: apiKey?.trim() ?? '',
-      ...(fetchImpl === undefined ? {} : { fetchImpl }),
+      ...(resolvedFetch === undefined ? {} : { fetchImpl: resolvedFetch }),
     });
     this.#lifecycle.register(this.#provider);
     if (apiKey === undefined || apiKey.trim().length === 0)
       this.#lifecycle.markUnconfigured(MISTRAL_PROVIDER_ID);
   }
 
   summary(): MistralProviderSummary {
     const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
     const configured = status.state === 'configured' || status.state === 'healthy';
     return {
       providerId: MISTRAL_PROVIDER_ID,
       state: status.state,
       models: configured ? MISTRAL_REASONING_MODELS : [],
       adapterVersion: status.adapterVersion,
     };
   }
 
   async complete(actorId: string, input: MistralCompletionRequest): Promise<CapabilityResult> {
+    const request = mistralCapabilityRequest(input);
+    const preflight = computeProviderApprovalPreflight(actorId, request, this.#provider);
+    const approvalVerification = {
+      actorId,
+      idempotencyKey: input.idempotencyKey,
+      preflight,
+      privacyMode: input.privacyMode,
+      grant: input.approvalGrant,
+      fallbackCostCap: input.approvalGrant?.costCap ?? { amount: '0.00', currency: 'USD' },
+    } as const;
     const status = this.#lifecycle.getStatus(MISTRAL_PROVIDER_ID);
     if (status.state === 'unconfigured') {
+      await this.#approvals.recordUnavailable(approvalVerification, 'provider-unconfigured');
       throw new MistralProviderError(
         'PROVIDER_UNCONFIGURED',
         'Mistral is not configured on this server.',
       );
     }
-    if (input.privacyMode === 'local-only') {
-      throw new MistralProviderError(
-        'REMOTE_PROCESSING_BLOCKED',
-        'Local-only policy blocks Mistral remote processing.',
-      );
-    }
-    if (!input.approvedRemoteProcessing) {
-      throw new MistralProviderError(
-        'REMOTE_PROCESSING_APPROVAL_REQUIRED',
-        'Remote processing requires explicit approval.',
-      );
-    }
-    if (!input.approvedSpend) {
-      throw new MistralProviderError(
-        'PROVIDER_SPEND_APPROVAL_REQUIRED',
-        'Provider spend requires explicit approval.',
-      );
-    }
-    const previous = await this.ledger.find(actorId, input.idempotencyKey);
-    if (previous !== undefined) return previous;
 
-    const request = {
-      requestVersion: 1 as const,
-      capability: 'llm.complete' as const,
-      input: {
-        model: input.model,
-        messages: input.messages,
-        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
-        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
-      },
-      constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
-      idempotencyKey: input.idempotencyKey,
-    };
     const resolution = resolveProvider(request, [this.#provider], {
       allowRemote: true,
       blockedProviders: [],
       blockedCapabilities: [],
       requireLocalFor: [],
     });
     if (resolution.status !== 'resolved' || resolution.provider === undefined) {
+      await this.#approvals.recordUnavailable(
+        approvalVerification,
+        resolution.reason ?? 'provider-not-eligible',
+      );
       throw new MistralProviderError(
         'REMOTE_PROCESSING_BLOCKED',
         resolution.reason ?? 'Mistral is not eligible for this request.',
       );
     }
-    // Compute the SDK preflight here, before egress. Approval was verified above;
-    // no prompt/body is written to logs or the durable invocation ledger.
-    const preflight = computePrivacyPreflight(request, resolution.provider);
-    if (preflight.requiresUserApproval && !input.approvedRemoteProcessing) {
-      throw new MistralProviderError(
-        'REMOTE_PROCESSING_APPROVAL_REQUIRED',
-        'Remote processing requires explicit approval.',
-      );
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
+    const previous = await this.ledger.find(actorId, input.idempotencyKey);
+    if (previous !== undefined) {
+      if (previous.provenance.requestHash !== preflight.requestDigest) {
+        await this.#approvals.recordFailed(
+          approvalVerification,
+          approval.reservation,
+          'idempotency-request-digest-conflict',
+        );
+        throw new ProviderApprovalError(
+          'PROVIDER_APPROVAL_REPLAY_REJECTED',
+          'Idempotent retry does not match the original request digest.',
+          preflight,
+        );
+      }
+      await this.#approvals.recordSucceeded(approvalVerification, approval.reservation);
+      return previous;
     }
 
     this.#lifecycle.recordJobStart(MISTRAL_PROVIDER_ID);
     try {
       const result = await this.#provider.invoke('llm.complete', request.input, request);
       if (result.status === 'succeeded') {
         this.#lifecycle.markHealthy(MISTRAL_PROVIDER_ID);
         this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, true);
-        return this.ledger.record(actorId, result);
+        const approvedResult = withApprovalProvenance(result, preflight.requestDigest, approval);
+        await this.#approvals.recordSucceeded(
+          approvalVerification,
+          approval.reservation,
+          approvedResult.usage?.cost,
+        );
+        return this.ledger.record(actorId, approvedResult);
       }
       const code = result.diagnostics[0]?.code;
       this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
+      await this.#approvals.recordFailed(
+        approvalVerification,
+        approval.reservation,
+        code ?? 'provider-request-failed',
+      );
       if (code === 'MISTRAL_UNAUTHORIZED') {
         this.#lifecycle.markUnauthorized(
           MISTRAL_PROVIDER_ID,
           'Mistral authentication failed.',
           false,
         );
         throw new MistralProviderError('MISTRAL_UNAUTHORIZED', 'Mistral authorization failed.');
       }
       this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
       throw new MistralProviderError(
         code === 'MISTRAL_UNAVAILABLE' || code === 'MISTRAL_TIMEOUT'
           ? 'MISTRAL_UNAVAILABLE'
           : 'MISTRAL_REQUEST_FAILED',
         'Mistral completion failed.',
       );
     } catch (error) {
-      if (error instanceof MistralProviderError) throw error;
+      if (error instanceof MistralProviderError || error instanceof ProviderApprovalError) {
+        throw error;
+      }
       this.#lifecycle.recordJobEnd(MISTRAL_PROVIDER_ID, false);
       this.#lifecycle.markDegraded(MISTRAL_PROVIDER_ID, 'Mistral completion failed.', false);
+      await this.#approvals.recordFailed(
+        approvalVerification,
+        approval.reservation,
+        'provider-unavailable',
+      );
       throw new MistralProviderError('MISTRAL_UNAVAILABLE', 'Mistral is unavailable.');
     }
   }
 }
 
 export function createRuntimeMistralProviderRegistry(
   options: {
     readonly apiKey?: string;
     readonly ledger?: MistralInvocationLedger;
+    readonly approvals?: ProviderApprovalService;
     readonly fetchImpl?: typeof fetch;
   } = {},
 ): MistralProviderRegistry {
-  return new MistralProviderRegistry(options.apiKey, options.ledger, options.fetchImpl);
+  return new MistralProviderRegistry(
+    options.apiKey,
+    options.ledger,
+    options.approvals ?? options.fetchImpl,
+    options.approvals === undefined ? undefined : options.fetchImpl,
+  );
+}
+
+function mistralCapabilityRequest(input: MistralCompletionRequest): CapabilityRequest {
+  return {
+    requestVersion: 1,
+    capability: 'llm.complete',
+    input: {
+      model: input.model,
+      messages: input.messages,
+      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
+      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
+    },
+    constraints: { executionPreference: ['remote'] as const, modelAllowlist: [input.model] },
+    idempotencyKey: input.idempotencyKey,
+  };
+}
+
+function withApprovalProvenance(
+  result: CapabilityResult,
+  requestDigest: string,
+  approval: ProviderApprovalOutcome,
+): CapabilityResult {
+  return {
+    ...result,
+    provenance: {
+      ...result.provenance,
+      requestHash: requestDigest,
+      ...(approval.reservation === undefined
+        ? {}
+        : { budgetReservationId: approval.reservation.reservationId }),
+    },
+    ...(result.usage === undefined || approval.reservation === undefined
+      ? {}
+      : {
+          usage: {
+            ...result.usage,
+            budgetReservationId: approval.reservation.reservationId,
+          },
+        }),
+  };
 }
diff --git a/apps/api/src/provider-approval.test.ts b/apps/api/src/provider-approval.test.ts
new file mode 100644
index 0000000..c496712
--- /dev/null
+++ b/apps/api/src/provider-approval.test.ts
@@ -0,0 +1,204 @@
+import { describe, expect, it } from 'vitest';
+import {
+  computeProviderApprovalPreflight,
+  createMockProvider,
+  type CapabilityRequest,
+  type ProviderApprovalGrant,
+} from '@joy-media/provider-sdk';
+import {
+  MemoryProviderApprovalStore,
+  ProviderApprovalError,
+  ProviderApprovalService,
+} from './provider-approval.js';
+
+describe('ProviderApprovalService', () => {
+  it('denies no-egress policy before approval can allow remote processing', async () => {
+    const { service, request, preflight } = fixture();
+    const grant = grantFor(service, preflight);
+
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight,
+        privacyMode: 'local-only',
+        grant,
+      }),
+    ).rejects.toMatchObject({ code: 'REMOTE_PROCESSING_BLOCKED' });
+
+    await expect(service.auditRows('actor-1')).resolves.toEqual([
+      expect.objectContaining({
+        status: 'denied',
+        reason: 'remote-processing-blocked',
+        requestDigest: preflight.requestDigest,
+      }),
+    ]);
+  });
+
+  it('requires a grant and records a denied audit row without raw prompt text', async () => {
+    const { service, request, preflight } = fixture();
+
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight,
+        privacyMode: 'ask-before-remote',
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REQUIRED' });
+
+    const rows = await service.auditRows('actor-1');
+    expect(rows).toEqual([
+      expect.objectContaining({ status: 'denied', reason: 'approval-required' }),
+    ]);
+    expect(JSON.stringify(rows)).not.toContain('private prompt');
+  });
+
+  it('rejects cross-prompt and cross-provider approval replay', async () => {
+    const { service, request, preflight } = fixture();
+    const grant = grantFor(service, preflight);
+    const otherPrompt = fixture({ prompt: 'changed prompt' }).preflight;
+    const otherProvider = fixture({ providerId: 'other-provider' }).preflight;
+
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight: otherPrompt,
+        privacyMode: 'ask-before-remote',
+        grant,
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
+
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight: otherProvider,
+        privacyMode: 'ask-before-remote',
+        grant,
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_REPLAY_REJECTED' });
+  });
+
+  it('rejects expired grants and grants over their spend cap', async () => {
+    const { service, request, preflight } = fixture();
+    const expired = grantFor(service, preflight, { expiresAt: '2026-01-01T00:00:00.000Z' });
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: request.idempotencyKey,
+        preflight,
+        privacyMode: 'ask-before-remote',
+        grant: expired,
+        now: new Date('2026-08-21T00:00:00.000Z'),
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_EXPIRED' });
+
+    const overCap = {
+      ...preflight,
+      estimatedCost: { amount: '0.20', currency: 'USD' },
+    };
+    await expect(
+      service.verify({
+        actorId: 'actor-1',
+        idempotencyKey: 'over-cap',
+        preflight: overCap,
+        privacyMode: 'ask-before-remote',
+        grant: grantFor(service, overCap, { costCap: { amount: '0.10', currency: 'USD' } }),
+      }),
+    ).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CAP_EXCEEDED' });
+  });
+
+  it('reserves spend idempotently and records succeeded outcomes', async () => {
+    const { service, request, preflight } = fixture();
+    const grant = grantFor(service, preflight);
+    const input = {
+      actorId: 'actor-1',
+      idempotencyKey: request.idempotencyKey,
+      preflight,
+      privacyMode: 'ask-before-remote' as const,
+      grant,
+    };
+
+    const first = await service.verify(input);
+    const retry = await service.verify(input);
+
+    expect(retry.reservation).toEqual(first.reservation);
+    await service.recordSucceeded(input, first.reservation);
+    await expect(service.auditRows('actor-1')).resolves.toContainEqual(
+      expect.objectContaining({
+        status: 'succeeded',
+        approvalGrantId: grant.grantId,
+        budgetReservationId: first.reservation?.reservationId,
+      }),
+    );
+  });
+
+  it('records unavailable and failed outcomes without secrets', async () => {
+    const store = new MemoryProviderApprovalStore();
+    const service = new ProviderApprovalService(store);
+    const { request, preflight } = fixture({ service });
+    const grant = grantFor(service, preflight);
+    const input = {
+      actorId: 'actor-1',
+      idempotencyKey: request.idempotencyKey,
+      preflight,
+      privacyMode: 'ask-before-remote' as const,
+      grant,
+    };
+    const outcome = await service.verify(input);
+
+    await service.recordFailed(input, outcome.reservation, 'provider-failed-secret-token');
+    await service.recordUnavailable(input, 'provider-unavailable');
+
+    const serialized = JSON.stringify(await service.auditRows());
+    expect(serialized).toContain('provider-unavailable');
+    expect(serialized).toContain('provider-failed-secret-redacted');
+    expect(serialized).not.toContain('provider-failed-secret-token');
+    expect(serialized).not.toContain('private prompt');
+  });
+});
+
+function fixture(
+  options: {
+    readonly service?: ProviderApprovalService;
+    readonly providerId?: string;
+    readonly prompt?: string;
+  } = {},
+) {
+  const service = options.service ?? new ProviderApprovalService();
+  const provider = createMockProvider(options.providerId ?? 'remote-provider', ['llm.complete'], {
+    execution: 'remote-api',
+    privacy: { dataLeavesDevice: true },
+  });
+  const request: CapabilityRequest = {
+    requestVersion: 1,
+    capability: 'llm.complete',
+    input: { prompt: options.prompt ?? 'private prompt' },
+    constraints: { executionPreference: ['remote'] },
+    idempotencyKey: 'idem-1',
+  };
+  return {
+    service,
+    request,
+    preflight: computeProviderApprovalPreflight('actor-1', request, provider),
+  };
+}
+
+function grantFor(
+  service: ProviderApprovalService,
+  preflight: ReturnType<typeof computeProviderApprovalPreflight>,
+  overrides: Partial<ProviderApprovalGrant> = {},
+): ProviderApprovalGrant {
+  return service.createGrant({
+    actorId: overrides.actorId ?? 'actor-1',
+    providerId: overrides.providerId ?? preflight.providerId,
+    capability: overrides.capability ?? preflight.capability,
+    requestDigest: overrides.requestDigest ?? preflight.requestDigest,
+    expiresAt: overrides.expiresAt ?? '2026-12-31T00:00:00.000Z',
+    costCap: overrides.costCap ?? { amount: '0.10', currency: 'USD' },
+    grantId: overrides.grantId,
+    status: overrides.status,
+  });
+}
diff --git a/apps/api/src/provider-approval.ts b/apps/api/src/provider-approval.ts
new file mode 100644
index 0000000..54a0bf9
--- /dev/null
+++ b/apps/api/src/provider-approval.ts
@@ -0,0 +1,346 @@
+import type { CapabilityId, Money, ProviderApprovalGrant } from '@joy-media/provider-sdk';
+import {
+  createProviderBudgetLedger,
+  reconcileProviderBudget,
+  reserveProviderBudget,
+  type ProviderApprovalPreflight,
+  type ProviderBudgetLedgerV1,
+  type ProviderBudgetReservationV1,
+} from '@joy-media/provider-sdk';
+
+export type ProviderApprovalAuditStatus = 'denied' | 'unavailable' | 'failed' | 'succeeded';
+
+export interface ProviderApprovalAuditRow {
+  readonly rowVersion: 1;
+  readonly decisionId: string;
+  readonly actorId: string;
+  readonly providerId: string;
+  readonly capability: CapabilityId;
+  readonly requestDigest: string;
+  readonly idempotencyKey: string;
+  readonly status: ProviderApprovalAuditStatus;
+  readonly reason: string;
+  readonly createdAt: string;
+  readonly approvalGrantId?: string;
+  readonly budgetReservationId?: string;
+  readonly estimatedCost?: Money;
+  readonly costCap?: Money;
+}
+
+export interface ProviderApprovalStore {
+  append(row: ProviderApprovalAuditRow): Promise<void>;
+  list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]>;
+}
+
+export interface ProviderApprovalVerification {
+  readonly actorId: string;
+  readonly idempotencyKey: string;
+  readonly preflight: ProviderApprovalPreflight;
+  readonly privacyMode: 'local-only' | 'ask-before-remote';
+  readonly grant?: ProviderApprovalGrant | undefined;
+  readonly fallbackCostCap?: Money | undefined;
+  readonly now?: Date | undefined;
+}
+
+export interface ProviderApprovalOutcome {
+  readonly grant: ProviderApprovalGrant;
+  readonly reservation?: ProviderBudgetReservationV1;
+}
+
+export class ProviderApprovalError extends Error {
+  constructor(
+    readonly code:
+      | 'PROVIDER_APPROVAL_REQUIRED'
+      | 'PROVIDER_APPROVAL_DENIED'
+      | 'PROVIDER_APPROVAL_EXPIRED'
+      | 'PROVIDER_APPROVAL_REPLAY_REJECTED'
+      | 'PROVIDER_SPEND_CAP_EXCEEDED'
+      | 'REMOTE_PROCESSING_BLOCKED',
+    message: string,
+    readonly preflight?: ProviderApprovalPreflight,
+  ) {
+    super(message);
+    this.name = 'ProviderApprovalError';
+  }
+}
+
+export class MemoryProviderApprovalStore implements ProviderApprovalStore {
+  readonly #rows: ProviderApprovalAuditRow[] = [];
+
+  async append(row: ProviderApprovalAuditRow): Promise<void> {
+    this.#rows.push(row);
+  }
+
+  async list(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
+    return actorId === undefined
+      ? [...this.#rows]
+      : this.#rows.filter((row) => row.actorId === actorId);
+  }
+}
+
+export class ProviderApprovalService {
+  #budgetLedger: ProviderBudgetLedgerV1;
+
+  constructor(
+    private readonly store: ProviderApprovalStore = new MemoryProviderApprovalStore(),
+    budgetLedger: ProviderBudgetLedgerV1 = createProviderBudgetLedger(),
+  ) {
+    this.#budgetLedger = budgetLedger;
+  }
+
+  createGrant(
+    input: Omit<ProviderApprovalGrant, 'grantVersion' | 'grantId' | 'status'> & {
+      readonly grantId?: string | undefined;
+      readonly status?: ProviderApprovalGrant['status'] | undefined;
+    },
+  ): ProviderApprovalGrant {
+    return {
+      grantVersion: 1,
+      grantId: input.grantId ?? `grant-${crypto.randomUUID()}`,
+      actorId: input.actorId,
+      providerId: input.providerId,
+      capability: input.capability,
+      requestDigest: input.requestDigest,
+      expiresAt: input.expiresAt,
+      status: input.status ?? 'approved',
+      ...(input.costCap === undefined ? {} : { costCap: input.costCap }),
+    };
+  }
+
+  async verify(input: ProviderApprovalVerification): Promise<ProviderApprovalOutcome> {
+    const estimatedCost = input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap);
+    const costCap = input.grant?.costCap ?? input.fallbackCostCap;
+
+    if (input.privacyMode === 'local-only' && input.preflight.requiresUserApproval) {
+      await this.audit(input, 'denied', 'remote-processing-blocked', { estimatedCost, costCap });
+      throw new ProviderApprovalError(
+        'REMOTE_PROCESSING_BLOCKED',
+        'Local-only policy blocks remote provider processing.',
+        input.preflight,
+      );
+    }
+
+    if (!input.preflight.requiresUserApproval && estimatedCost.amount === '0.00') {
+      return {
+        grant: this.createGrant({
+          actorId: input.actorId,
+          providerId: input.preflight.providerId,
+          capability: input.preflight.capability,
+          requestDigest: input.preflight.requestDigest,
+          expiresAt: new Date(Date.now() + 60_000).toISOString(),
+          costCap: estimatedCost,
+          status: 'approved',
+        }),
+      };
+    }
+
+    if (input.grant === undefined) {
+      await this.audit(input, 'denied', 'approval-required', { estimatedCost, costCap });
+      throw new ProviderApprovalError(
+        'PROVIDER_APPROVAL_REQUIRED',
+        'Provider processing requires an approval grant bound to this request.',
+        input.preflight,
+      );
+    }
+
+    const mismatch =
+      input.grant.actorId !== input.actorId ||
+      input.grant.providerId !== input.preflight.providerId ||
+      input.grant.capability !== input.preflight.capability ||
+      input.grant.requestDigest !== input.preflight.requestDigest;
+    if (mismatch) {
+      await this.audit(input, 'denied', 'approval-replay-rejected', {
+        estimatedCost,
+        costCap,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_APPROVAL_REPLAY_REJECTED',
+        'Approval grant does not match this actor, provider, capability, or request digest.',
+        input.preflight,
+      );
+    }
+
+    if (input.grant.status !== 'approved') {
+      await this.audit(input, 'denied', 'approval-denied', {
+        estimatedCost,
+        costCap,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_APPROVAL_DENIED',
+        'Provider processing was denied by approval policy.',
+        input.preflight,
+      );
+    }
+
+    if (Date.parse(input.grant.expiresAt) <= (input.now ?? new Date()).getTime()) {
+      await this.audit(input, 'denied', 'approval-expired', {
+        estimatedCost,
+        costCap,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_APPROVAL_EXPIRED',
+        'Provider approval grant has expired.',
+        input.preflight,
+      );
+    }
+
+    if (costCap === undefined) {
+      await this.audit(input, 'denied', 'spend-cap-required', {
+        estimatedCost,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_SPEND_CAP_EXCEEDED',
+        'Provider spend requires an explicit approval cost cap.',
+        input.preflight,
+      );
+    }
+
+    const reserved = reserveProviderBudget(this.#budgetLedger, {
+      reservationId: `reserve-${input.idempotencyKey}`,
+      idempotencyKey: input.idempotencyKey,
+      providerId: input.preflight.providerId,
+      capability: input.preflight.capability,
+      estimatedCost,
+      cap: costCap,
+    });
+    if (!reserved.ok) {
+      await this.audit(input, 'denied', `budget-${reserved.reason}`, {
+        estimatedCost,
+        costCap,
+        grant: input.grant,
+      });
+      throw new ProviderApprovalError(
+        'PROVIDER_SPEND_CAP_EXCEEDED',
+        `Provider budget reservation failed: ${reserved.reason}.`,
+        input.preflight,
+      );
+    }
+    this.#budgetLedger = reserved.ledger;
+    return { grant: input.grant, reservation: reserved.reservation };
+  }
+
+  async recordUnavailable(input: ProviderApprovalVerification, reason: string): Promise<void> {
+    await this.audit(input, 'unavailable', reason, {
+      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
+      costCap: input.grant?.costCap ?? input.fallbackCostCap,
+      grant: input.grant,
+    });
+  }
+
+  async recordFailed(
+    input: ProviderApprovalVerification,
+    reservation: ProviderBudgetReservationV1 | undefined,
+    reason: string,
+  ): Promise<void> {
+    await this.reconcile(
+      input.idempotencyKey,
+      reservation,
+      zeroMoney(reservation?.reserved),
+      reason,
+    );
+    await this.audit(input, 'failed', reason, {
+      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
+      costCap: input.grant?.costCap ?? input.fallbackCostCap,
+      grant: input.grant,
+      reservation,
+    });
+  }
+
+  async recordSucceeded(
+    input: ProviderApprovalVerification,
+    reservation: ProviderBudgetReservationV1 | undefined,
+    actualCost?: Money,
+  ): Promise<void> {
+    await this.reconcile(
+      input.idempotencyKey,
+      reservation,
+      actualCost ?? input.preflight.estimatedCost ?? zeroMoney(reservation?.reserved),
+      'succeeded',
+    );
+    await this.audit(input, 'succeeded', 'succeeded', {
+      estimatedCost: input.preflight.estimatedCost ?? zeroMoney(input.fallbackCostCap),
+      costCap: input.grant?.costCap ?? input.fallbackCostCap,
+      grant: input.grant,
+      reservation,
+    });
+  }
+
+  auditRows(actorId?: string): Promise<readonly ProviderApprovalAuditRow[]> {
+    return this.store.list(actorId);
+  }
+
+  private async reconcile(
+    idempotencyKey: string,
+    reservation: ProviderBudgetReservationV1 | undefined,
+    actualCost: Money,
+    providerUsageId: string,
+  ): Promise<void> {
+    if (reservation === undefined) return;
+    const reconciled = reconcileProviderBudget(this.#budgetLedger, {
+      reservationId: reservation.reservationId,
+      idempotencyKey: `usage-${idempotencyKey}`,
+      kind: 'final',
+      actualCost,
+      providerUsageId,
+    });
+    if (reconciled.ok) this.#budgetLedger = reconciled.ledger;
+  }
+
+  private async audit(
+    input: ProviderApprovalVerification,
+    status: ProviderApprovalAuditStatus,
+    reason: string,
+    options: {
+      readonly estimatedCost?: Money;
+      readonly costCap?: Money | undefined;
+      readonly grant?: ProviderApprovalGrant | undefined;
+      readonly reservation?: ProviderBudgetReservationV1 | undefined;
+    },
+  ): Promise<void> {
+    await this.store.append({
+      rowVersion: 1,
+      decisionId: `decision-${crypto.randomUUID()}`,
+      actorId: input.actorId,
+      providerId: input.preflight.providerId,
+      capability: input.preflight.capability,
+      requestDigest: input.preflight.requestDigest,
+      idempotencyKey: input.idempotencyKey,
+      status,
+      reason: redactAuditReason(reason),
+      createdAt: (input.now ?? new Date()).toISOString(),
+      ...(options.grant === undefined ? {} : { approvalGrantId: options.grant.grantId }),
+      ...(options.reservation === undefined
+        ? {}
+        : { budgetReservationId: options.reservation.reservationId }),
+      ...(options.estimatedCost === undefined ? {} : { estimatedCost: options.estimatedCost }),
+      ...(options.costCap === undefined ? {} : { costCap: options.costCap }),
+    });
+  }
+}
+
+export function providerApprovalRequiredPayload(error: ProviderApprovalError): {
+  readonly code: ProviderApprovalError['code'];
+  readonly message: string;
+  readonly preflight?: ProviderApprovalPreflight;
+} {
+  return {
+    code: error.code,
+    message: error.message,
+    ...(error.preflight === undefined ? {} : { preflight: error.preflight }),
+  };
+}
+
+function zeroMoney(reference?: Money): Money {
+  return { amount: '0.00', currency: reference?.currency ?? 'USD' };
+}
+
+function redactAuditReason(reason: string): string {
+  return reason.replace(
+    /(secret|token|api[-_]?key|authorization)[A-Za-z0-9._:=/-]*/gi,
+    '$1-redacted',
+  );
+}
diff --git a/apps/api/src/spectral-denoise.ts b/apps/api/src/spectral-denoise.ts
index 17d7603..9512e46 100644
--- a/apps/api/src/spectral-denoise.ts
+++ b/apps/api/src/spectral-denoise.ts
@@ -1,22 +1,24 @@
 import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { spawnSync } from 'node:child_process';
 import { randomUUID } from 'node:crypto';
 import { ControlPlaneError } from './control-plane.js';
+import type { CapabilityRequest, ProviderV2 } from '@joy-media/provider-sdk';
 
 export interface SpectralDenoiseRequest {
   readonly assetId: string;
   readonly mediaBase64: string;
   readonly sampleRate?: number;
   readonly strength?: number;
+  readonly idempotencyKey?: string;
 }
 
 export interface SpectralDenoiseResult {
   readonly assetId: string;
   readonly mimeType: string;
   readonly bytesBase64: string;
   readonly method: 'ffmpeg-afftdn';
   readonly strength: number;
 }
 
@@ -79,10 +81,65 @@ export function runSpectralDenoise(request: SpectralDenoiseRequest): SpectralDen
       assetId: `${request.assetId}-denoised-${randomUUID().slice(0, 8)}`,
       mimeType: 'audio/wav',
       bytesBase64: out.toString('base64'),
       method: 'ffmpeg-afftdn',
       strength,
     };
   } finally {
     rmSync(dir, { recursive: true, force: true });
   }
 }
+
+export function spectralDenoiseProvider(): ProviderV2 {
+  return {
+    manifest: {
+      protocolVersion: 2,
+      id: 'ffmpeg-afftdn',
+      displayName: 'ffmpeg spectral denoise',
+      adapterVersion: '1.0.0',
+      execution: 'server',
+      capabilities: [
+        {
+          id: 'audio.denoise',
+          inputSchema: { type: 'object' },
+          outputSchema: { type: 'object' },
+          models: [{ id: 'ffmpeg-afftdn', displayName: 'ffmpeg afftdn' }],
+        },
+      ],
+      configurationSchema: { type: 'object' },
+      secretFields: [],
+      privacy: {
+        dataLeavesDevice: false,
+        retentionDisclosure: 'Audio denoise runs locally with ffmpeg afftdn on this host',
+      },
+    },
+    invoke: async () => {
+      throw new Error('spectral denoise provider descriptor is preflight-only');
+    },
+  };
+}
+
+export function spectralDenoiseCapabilityRequest(
+  request: SpectralDenoiseRequest & { readonly idempotencyKey: string },
+): CapabilityRequest {
+  return {
+    requestVersion: 1,
+    capability: 'audio.denoise',
+    input: {
+      assetId: request.assetId,
+      mediaDigest: createMediaDigest(request.mediaBase64),
+      ...(request.sampleRate === undefined ? {} : { sampleRate: request.sampleRate }),
+      ...(request.strength === undefined ? {} : { strength: request.strength }),
+    },
+    constraints: { executionPreference: ['local'] },
+    idempotencyKey: request.idempotencyKey,
+  };
+}
+
+function createMediaDigest(mediaBase64: string): string {
+  let hash = 0x811c9dc5;
+  for (let index = 0; index < mediaBase64.length; index++) {
+    hash ^= mediaBase64.charCodeAt(index);
+    hash = Math.imul(hash, 0x01000193);
+  }
+  return `fnv1a-${(hash >>> 0).toString(16)}`;
+}
diff --git a/apps/api/src/speech-synthesize.ts b/apps/api/src/speech-synthesize.ts
index ec75feb..8ab172e 100644
--- a/apps/api/src/speech-synthesize.ts
+++ b/apps/api/src/speech-synthesize.ts
@@ -1,52 +1,62 @@
 import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { spawnSync } from 'node:child_process';
 import { createHash, randomUUID } from 'node:crypto';
 import { ControlPlaneError } from './control-plane.js';
+import type { CapabilityRequest, ProviderV2 } from '@joy-media/provider-sdk';
 
 export type SpeechEngineId = 'edge-tts' | 'piper';
 
 export interface SpeechSynthesisRequest {
   readonly text: string;
   readonly language?: string;
   readonly voiceId?: string;
   readonly speed?: number;
   /** Default: JOY_MEDIA_TTS_ENGINE env, else edge-tts. */
   readonly engine?: SpeechEngineId;
+  readonly idempotencyKey?: string;
 }
 
 export interface SpeechSynthesisResult {
   readonly assetId: string;
   readonly mimeType: string;
   readonly bytesBase64: string;
   readonly voiceId: string;
   readonly engine: SpeechEngineId;
   readonly modelId: string;
   readonly dataLeavesDevice: boolean;
   readonly retentionDisclosure: string;
   readonly durationUs: number;
 }
 
-export function resolveEdgeVoice(language: string | undefined, voiceId: string | undefined): string {
+export function resolveEdgeVoice(
+  language: string | undefined,
+  voiceId: string | undefined,
+): string {
   if (voiceId !== undefined && voiceId.length > 0 && !voiceId.startsWith('stock:')) {
     return voiceId;
   }
   const lang = (language ?? 'en').toLowerCase();
   if (lang.startsWith('fa')) return 'fa-IR-DilaraNeural';
   if (lang.startsWith('en')) return 'en-US-EmmaMultilingualNeural';
   return 'en-US-EmmaMultilingualNeural';
 }
 
 function resolvePiperModel(language: string | undefined, voiceId: string | undefined): string {
-  if (voiceId !== undefined && voiceId.length > 0 && voiceId.endsWith('.onnx') && existsSync(voiceId)) {
+  if (
+    voiceId !== undefined &&
+    voiceId.length > 0 &&
+    voiceId.endsWith('.onnx') &&
+    existsSync(voiceId)
+  ) {
     return voiceId;
   }
   const voicesDir =
     process.env.JOY_MEDIA_PIPER_VOICES_DIR?.trim() || '/opt/joy-media/data/piper/voices';
   const lang = (language ?? 'en').toLowerCase();
   const preferred = lang.startsWith('fa')
     ? join(voicesDir, 'fa_IR-gyro-medium.onnx')
     : join(voicesDir, 'en_US-lessac-medium.onnx');
   if (existsSync(preferred)) return preferred;
   const fallback = join(voicesDir, 'en_US-lessac-medium.onnx');
@@ -112,22 +122,21 @@ export function runEdgeSpeechSynthesis(request: SpeechSynthesisRequest): SpeechS
   }
 }
 
 /**
  * Local Piper ONNX TTS — text stays on this host (no egress).
  */
 export function runPiperSpeechSynthesis(request: SpeechSynthesisRequest): SpeechSynthesisResult {
   if (typeof request.text !== 'string' || request.text.trim().length === 0) {
     throw new ControlPlaneError('REQUEST_INVALID', 'text is required');
   }
-  const command =
-    process.env.JOY_MEDIA_PIPER?.trim() || '/opt/joy-media/data/piper/piper/piper';
+  const command = process.env.JOY_MEDIA_PIPER?.trim() || '/opt/joy-media/data/piper/piper/piper';
   if (!existsSync(command)) {
     throw new ControlPlaneError(
       'PROVIDER_UNAVAILABLE',
       `Piper binary not found at ${command}; set JOY_MEDIA_PIPER`,
     );
   }
   const model = resolvePiperModel(request.language, request.voiceId);
   const dir = mkdtempSync(join(tmpdir(), 'joy-piper-tts-'));
   const mediaPath = join(dir, 'speech.wav');
   try {
@@ -150,31 +159,92 @@ export function runPiperSpeechSynthesis(request: SpeechSynthesisRequest): Speech
     }
     const bytes = readFileSync(mediaPath);
     return {
       assetId: assetIdFor(request.text),
       mimeType: 'audio/wav',
       bytesBase64: bytes.toString('base64'),
       voiceId: model,
       engine: 'piper',
       modelId: 'piper-onnx',
       dataLeavesDevice: false,
-      retentionDisclosure: 'Text is synthesized locally with Piper ONNX; it does not leave this host',
+      retentionDisclosure:
+        'Text is synthesized locally with Piper ONNX; it does not leave this host',
       durationUs: estimateDurationUs(request.text),
     };
   } finally {
     rmSync(dir, { recursive: true, force: true });
   }
 }
 
 export function resolveSpeechEngine(requested: unknown): SpeechEngineId {
   if (requested === 'piper' || requested === 'edge-tts') return requested;
   const fromEnv = (process.env.JOY_MEDIA_TTS_ENGINE ?? 'edge-tts').trim().toLowerCase();
   if (fromEnv === 'piper') return 'piper';
   return 'edge-tts';
 }
 
 /** Dispatch TTS by engine (piper = local; edge-tts = remote egress). */
 export function runSpeechSynthesis(request: SpeechSynthesisRequest): SpeechSynthesisResult {
   const engine = resolveSpeechEngine(request.engine);
   if (engine === 'piper') return runPiperSpeechSynthesis(request);
   return runEdgeSpeechSynthesis(request);
 }
+
+export function speechSynthesisProvider(engine: SpeechEngineId): ProviderV2 {
+  return {
+    manifest: {
+      protocolVersion: 2,
+      id: engine === 'edge-tts' ? 'edge-tts' : 'piper',
+      displayName: engine === 'edge-tts' ? 'Microsoft Edge TTS' : 'Piper TTS',
+      adapterVersion: '1.0.0',
+      execution: engine === 'edge-tts' ? 'remote-api' : 'server',
+      capabilities: [
+        {
+          id: 'speech.synthesize',
+          inputSchema: { type: 'object' },
+          outputSchema: { type: 'object' },
+          models: [{ id: engine, displayName: engine === 'edge-tts' ? 'Edge TTS' : 'Piper ONNX' }],
+          ...(engine === 'edge-tts'
+            ? {
+                pricing: { model: 'per-character' as const, rate: '0.00', currency: 'USD' },
+                policyFlags: ['remote-processing', 'privacy-approval-required'],
+              }
+            : {}),
+        },
+      ],
+      configurationSchema: { type: 'object' },
+      secretFields: [],
+      privacy: {
+        dataLeavesDevice: engine === 'edge-tts',
+        retentionDisclosure:
+          engine === 'edge-tts'
+            ? 'Text is sent to Microsoft Edge online TTS for synthesis'
+            : 'Text is synthesized locally with Piper ONNX; it does not leave this host',
+      },
+    },
+    invoke: async () => {
+      throw new Error('speech synthesis provider descriptor is preflight-only');
+    },
+  };
+}
+
+export function speechSynthesisCapabilityRequest(
+  request: SpeechSynthesisRequest & { readonly idempotencyKey: string },
+): CapabilityRequest {
+  return {
+    requestVersion: 1,
+    capability: 'speech.synthesize',
+    input: {
+      text: request.text,
+      ...(request.language === undefined ? {} : { language: request.language }),
+      ...(request.voiceId === undefined ? {} : { voiceId: request.voiceId }),
+      ...(request.speed === undefined ? {} : { speed: request.speed }),
+      engine: resolveSpeechEngine(request.engine),
+    },
+    constraints: {
+      executionPreference: [
+        resolveSpeechEngine(request.engine) === 'edge-tts' ? 'remote' : 'local',
+      ],
+    },
+    idempotencyKey: request.idempotencyKey,
+  };
+}
diff --git a/packages/agent-tools/src/approval.ts b/packages/agent-tools/src/approval.ts
index 64c025c..34867cf 100644
--- a/packages/agent-tools/src/approval.ts
+++ b/packages/agent-tools/src/approval.ts
@@ -1,20 +1,21 @@
 import type { EditorContext } from './context.js';
 import type {
   AgentEditPlan,
   AgentPlanStep,
   ApprovalReason,
   ApprovalRequest,
   Money,
   PrivacyImpact,
 } from './plan.js';
 import type { ToolCapability, ToolScope } from './types.js';
+import type { ProviderApprovalPreflight } from '@joy-media/provider-sdk';
 
 export type AgentExecutionMode =
   'suggest-only' | 'preview-and-approve' | 'auto-apply-low-risk' | 'full-auto-limited';
 
 export const ALL_TOOL_CAPABILITIES: readonly ToolCapability[] = [
   'timeline.read',
   'timeline.write',
   'assets.read',
   'assets.import',
   'filesystem.read',
@@ -312,20 +313,51 @@ export class ApprovalEngine {
       reason,
       description,
       privacyImpact,
       isReversible,
       status: 'pending',
       ...(estimatedCost !== undefined ? { estimatedCost } : {}),
     };
   }
 }
 
+export function approvalRequestFromProviderPreflight(
+  preflight: ProviderApprovalPreflight,
+  stepId: string,
+  options: {
+    readonly id?: string;
+    readonly description?: string;
+  } = {},
+): ApprovalRequest {
+  const reason: ApprovalReason =
+    preflight.estimatedCost !== undefined ? 'paid-generation' : 'remote-upload';
+  return {
+    id: options.id ?? `approval-provider-${preflight.requestDigest.slice(-16)}`,
+    stepId,
+    reason,
+    description:
+      options.description ??
+      `Approval required for ${preflight.providerId} ${preflight.capability}`,
+    ...(preflight.estimatedCost === undefined ? {} : { estimatedCost: preflight.estimatedCost }),
+    privacyImpact: {
+      dataLeavesDevice: preflight.dataLeavesDevice,
+      providerId: preflight.providerId,
+      dataTypes: preflight.dataBeingSent,
+      ...(preflight.retentionDisclosure === undefined
+        ? {}
+        : { retentionDisclosure: preflight.retentionDisclosure }),
+    },
+    isReversible: true,
+    status: 'pending',
+  };
+}
+
 export function createSuggestOnlyApprovalPolicy(): ApprovalPolicy {
   return {
     ...basePolicy(),
     executionMode: 'suggest-only',
     blockRemoteUploads: true,
     blockVoiceCloning: true,
     blockDestructiveEdits: true,
     maxPlanSteps: 50,
   };
 }
diff --git a/packages/provider-sdk/src/index.ts b/packages/provider-sdk/src/index.ts
index 77d7df5..3b32a6c 100644
--- a/packages/provider-sdk/src/index.ts
+++ b/packages/provider-sdk/src/index.ts
@@ -71,21 +71,30 @@ export type {
   ReconcileProviderBudgetInput,
   ReserveProviderBudgetResult,
   ReconcileProviderBudgetResult,
 } from './budget.js';
 export {
   createProviderBudgetLedger,
   reserveProviderBudget,
   reconcileProviderBudget,
 } from './budget.js';
 export { ProviderLifecycle } from './lifecycle.js';
-export { computePrivacyPreflight } from './privacy.js';
+export {
+  computePrivacyPreflight,
+  computeProviderApprovalPreflight,
+  computeProviderRequestDigest,
+} from './privacy.js';
+export type {
+  ProviderApprovalBinding,
+  ProviderApprovalGrant,
+  ProviderApprovalPreflight,
+} from './privacy.js';
 export { createMemorySecretStore } from './secrets.js';
 export type { AgentHostManifestValidation } from './agent-host.js';
 export { validateAgentHostManifest } from './agent-host.js';
 export { aggregateUsage, linkUsageToProviderDecision } from './provenance.js';
 export {
   createMockProvider,
   validateManifest,
   createTestRequest,
   assertResultSucceeded,
   simulateProviderFailure,
diff --git a/packages/provider-sdk/src/privacy.test.ts b/packages/provider-sdk/src/privacy.test.ts
index 60bffbc..070c2a2 100644
--- a/packages/provider-sdk/src/privacy.test.ts
+++ b/packages/provider-sdk/src/privacy.test.ts
@@ -1,12 +1,16 @@
 import { describe, expect, it } from 'vitest';
-import { computePrivacyPreflight } from './privacy.js';
+import {
+  computePrivacyPreflight,
+  computeProviderApprovalPreflight,
+  computeProviderRequestDigest,
+} from './privacy.js';
 import { createMockProvider } from './testing.js';
 import type { CapabilityRequest } from './types.js';
 
 describe('computePrivacyPreflight', () => {
   const createRequest = (overrides?: Partial<CapabilityRequest>): CapabilityRequest => ({
     requestVersion: 1,
     capability: 'speech.transcribe',
     input: { assetId: 'test' },
     constraints: {},
     idempotencyKey: 'test-key',
@@ -119,11 +123,45 @@ describe('computePrivacyPreflight', () => {
 
   it('returns correct data types for different capabilities', () => {
     const provider = createMockProvider('test', ['image.generate']);
     const request = createRequest({ capability: 'image.generate' });
 
     const preflight = computePrivacyPreflight(request, provider);
 
     expect(preflight.dataBeingSent).toContain('text prompt');
     expect(preflight.purpose).toBe('Generate image from prompt');
   });
+
+  it('binds approval preflight digests to actor and request payload without exposing input', () => {
+    const provider = createMockProvider('remote-provider', ['llm.complete'], {
+      execution: 'remote-api',
+      privacy: { dataLeavesDevice: true },
+    });
+    const request = createRequest({
+      capability: 'llm.complete',
+      input: { prompt: 'private prompt' },
+    });
+
+    const first = computeProviderApprovalPreflight('actor-1', request, provider);
+    const same = computeProviderApprovalPreflight('actor-1', { ...request }, provider);
+    const otherActor = computeProviderApprovalPreflight('actor-2', request, provider);
+    const otherPrompt = computeProviderApprovalPreflight(
+      'actor-1',
+      { ...request, input: { prompt: 'different prompt' } },
+      provider,
+    );
+
+    expect(first.requestDigest).toBe(same.requestDigest);
+    expect(first.requestDigest).not.toBe(otherActor.requestDigest);
+    expect(first.requestDigest).not.toBe(otherPrompt.requestDigest);
+    expect(first.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
+    expect(first.requiresUserApproval).toBe(true);
+    expect(JSON.stringify(first)).not.toContain('private prompt');
+  });
+
+  it('computes stable request digests independent of object key insertion order', () => {
+    const left = createRequest({ input: { b: 2, a: 1 } });
+    const right = createRequest({ input: { a: 1, b: 2 } });
+
+    expect(computeProviderRequestDigest(left)).toBe(computeProviderRequestDigest(right));
+  });
 });
diff --git a/packages/provider-sdk/src/privacy.ts b/packages/provider-sdk/src/privacy.ts
index 7bad25c..9bbce3c 100644
--- a/packages/provider-sdk/src/privacy.ts
+++ b/packages/provider-sdk/src/privacy.ts
@@ -1,10 +1,11 @@
+import { createHash } from 'node:crypto';
 import type {
   AnyProvider,
   CapabilityId,
   CapabilityRequest,
   Money,
   PrivacyPreflight,
 } from './types.js';
 import {
   getProviderId,
   getDataLeavesDevice,
@@ -72,20 +73,40 @@ const DEFAULT_SIZE_ESTIMATES: Record<CapabilityId, number> = {
   'image.upscale': 2_000_000,
   'video.generate': 1_000,
   'video.animate': 5_000_000,
   'video.interpolate': 50_000_000,
   'video.removeBackground': 50_000_000,
   'llm.complete': 5_000,
   'embedding.create': 5_000,
   'vision.analyze': 2_000_000,
 };
 
+export interface ProviderApprovalBinding {
+  readonly actorId: string;
+  readonly providerId: string;
+  readonly capability: CapabilityId;
+  readonly requestDigest: string;
+  readonly expiresAt: string;
+  readonly costCap?: Money;
+}
+
+export interface ProviderApprovalGrant extends ProviderApprovalBinding {
+  readonly grantVersion: 1;
+  readonly grantId: string;
+  readonly status: 'approved' | 'denied';
+}
+
+export interface ProviderApprovalPreflight extends PrivacyPreflight {
+  readonly requestDigest: string;
+  readonly approvalRequiredReason?: 'remote-processing' | 'provider-spend';
+}
+
 export function computePrivacyPreflight(
   request: CapabilityRequest,
   provider: AnyProvider,
 ): PrivacyPreflight {
   const providerId = getProviderId(provider);
   const dataLeavesDeviceRaw = getDataLeavesDevice(provider);
   const execution = getExecution(provider);
   const isRemote = isRemoteExecution(execution);
 
   const dataLeavesDevice =
@@ -129,10 +150,55 @@ export function computePrivacyPreflight(
 
   if (estimatedCost !== undefined) {
     (result as { estimatedCost?: Money }).estimatedCost = estimatedCost;
   }
   if (retentionDisclosure !== undefined) {
     (result as { retentionDisclosure?: string }).retentionDisclosure = retentionDisclosure;
   }
 
   return result;
 }
+
+export function computeProviderRequestDigest(request: CapabilityRequest): string {
+  return `sha256:${createHash('sha256').update(stableJson(request)).digest('hex')}`;
+}
+
+export function computeProviderApprovalPreflight(
+  actorId: string,
+  request: CapabilityRequest,
+  provider: AnyProvider,
+): ProviderApprovalPreflight {
+  const preflight = computePrivacyPreflight(request, provider);
+  return {
+    ...preflight,
+    requestDigest: computeProviderRequestDigest(requestForApprovalDigest(actorId, request)),
+    ...(preflight.requiresUserApproval
+      ? { approvalRequiredReason: 'remote-processing' as const }
+      : preflight.estimatedCost !== undefined
+        ? { approvalRequiredReason: 'provider-spend' as const }
+        : {}),
+  };
+}
+
+function requestForApprovalDigest(
+  actorId: string,
+  request: CapabilityRequest,
+): CapabilityRequest<{ readonly actorId: string; readonly input: unknown }> {
+  return {
+    ...request,
+    input: {
+      actorId,
+      input: request.input,
+    },
+  };
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
