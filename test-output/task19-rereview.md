# Review package: 6ff590b..03d94f5

## Commits
03d94f5 fix(providers): preserve decision audits and strict budget replay
de3cb2f fix(providers): remove fixture success from production adapters

## Files changed
 apps/api/src/http-server.test.ts                   |  97 +++++++++++-
 apps/api/src/http-server.ts                        |  20 +++
 apps/worker/src/local-gpu.ts                       |  68 +-------
 apps/worker/src/runtime.test.ts                    |  42 +++++
 apps/worker/src/runtime.ts                         |  22 +++
 packages/adapter-tts/src/consent-tts.test.ts       |   4 +-
 packages/adapter-tts/src/index.test.ts             |  20 +--
 packages/adapter-tts/src/index.ts                  | 171 ++++++++++++---------
 packages/adapter-tts/src/production-mode.test.ts   |  44 ++++++
 packages/adapter-voice-isolation/src/index.test.ts |  70 ++++++++-
 packages/adapter-voice-isolation/src/index.ts      | 124 +++++++++------
 packages/provider-sdk/src/budget.test.ts           |  29 ++++
 packages/provider-sdk/src/budget.ts                |  46 ++++--
 packages/provider-sdk/src/decision.test.ts         |  36 ++++-
 packages/provider-sdk/src/decision.ts              |   8 +-
 15 files changed, 580 insertions(+), 221 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index d12defc..82e4fb9 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -703,37 +703,76 @@ describe('control-plane HTTP transport', () => {
     });
     expect(
       JSON.stringify(await request(origin, 'GET', '/v1/projects/p/production-runs/run-api')),
     ).not.toMatch(/C:\\|mediaBase64|https?:\/\//);
     await pool.end();
   });
 
   it('accepts every AI Worker receipt variant through the completion route', async () => {
     const origin = await start({ authenticate: () => ({ id: 'owner' }) });
     await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
+    await request(origin, 'POST', '/v1/projects/p/assets', {
+      id: 'asset-source-1',
+      kind: 'image',
+      displayName: 'source.png',
+      sha256: '2'.repeat(64),
+      bytes: 2048,
+      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
+      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
+    });
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
-        'text.lm-studio' | 'text.openrouter' | 'video.runway' | 'edit.higgsfield'
+        | 'image.comfy'
+        | 'audio.ml-denoise'
+        | 'text.lm-studio'
+        | 'text.openrouter'
+        | 'video.runway'
+        | 'edit.higgsfield'
       >;
       readonly receipt: WorkerResultReceiptV1;
+      readonly assetId?: string;
     }[] = [
+      {
+        type: 'image.comfy',
+        assetId: 'asset-source-1',
+        receipt: {
+          kind: 'image.comfy',
+          assetId: 'asset-source-1',
+          sha256: '9'.repeat(64),
+          bytes: 1024,
+          localRef: 'gpu-image-comfy-1',
+          descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
+        },
+      },
+      {
+        type: 'audio.ml-denoise',
+        assetId: 'asset-source-1',
+        receipt: {
+          kind: 'audio.ml-denoise',
+          assetId: 'asset-source-1',
+          sha256: '8'.repeat(64),
+          bytes: 1536,
+          localRef: 'gpu-audio-denoise-1',
+          descriptor: { mimeType: 'audio/wav' },
+        },
+      },
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
@@ -777,23 +816,24 @@ describe('control-plane HTTP transport', () => {
       'POST',
       '/v1/workers/w/hello',
       { capabilities: variants.map((variant) => variant.type) },
       workerToken,
     );
 
     for (const [index, variant] of variants.entries()) {
       const job = {
         id: `ai-job-${index + 1}`,
         type: variant.type,
+        ...(variant.assetId === undefined ? {} : { assetId: variant.assetId }),
         payload: {
           prompt: `Generate variant ${index + 1}`,
-          ...(variant.type === 'edit.higgsfield' ? { imageAssetId: 'source-image-1' } : {}),
+          ...(variant.type === 'edit.higgsfield' ? { imageAssetId: 'asset-source-1' } : {}),
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
@@ -817,20 +857,73 @@ describe('control-plane HTTP transport', () => {
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
+
+  it('rejects mismatched AI media receipts over HTTP', async () => {
+    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
+    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
+    await request(origin, 'POST', '/v1/worker-pair/offers', {
+      workerId: 'w',
+      pairingCode: 'pairing-code',
+    });
+    await request(origin, 'POST', '/v1/workers/w/pair', { pairingCode: 'pairing-code' });
+    const claim = await request(origin, 'POST', '/v1/worker-pair/claim', {
+      workerId: 'w',
+      pairingCode: 'pairing-code',
+    });
+    const workerToken = (claim.body as { data: { sessionToken: string } }).data.sessionToken;
+    await request(
+      origin,
+      'POST',
+      '/v1/workers/w/hello',
+      { capabilities: ['video.runway'] },
+      workerToken,
+    );
+    await request(origin, 'POST', '/v1/projects/p/jobs', {
+      id: 'ai-mismatch-1',
+      type: 'video.runway',
+      payload: { prompt: 'Generate a video' },
+      requirements: { capabilities: ['video.runway'], privacy: 'remote-api' },
+      idempotencyKey: 'idem-ai-mismatch-1',
+      maxAttempts: 2,
+    });
+    await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken);
+
+    expect(
+      await request(
+        origin,
+        'POST',
+        '/v1/workers/w/jobs/ai-mismatch-1/complete',
+        {
+          result: {
+            kind: 'video.runway',
+            assetId: 'asset-video-mismatch-1',
+            sha256: '7'.repeat(64),
+            bytes: 4096,
+            localRef: 'ai-mismatch-video-1',
+            descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
+          },
+        },
+        workerToken,
+      ),
+    ).toMatchObject({
+      status: 400,
+      body: { error: { code: 'REQUEST_INVALID' } },
+    });
+  });
 });
 
 async function start(
   authentication: ApiAuthentication,
   privateObjectStore?: PrivateObjectStore,
   mistral?: MistralProviderRegistry,
   controlPlane?: ControlPlane,
 ): Promise<string> {
   const server = createControlPlaneHttpServer({
     controlPlane: controlPlane ?? new LocalControlPlane(),
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index 180bc04..c5ff8a6 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -1141,20 +1141,40 @@ function optionalWorkerResult(body: Record<string, unknown>): WorkerResultReceip
   ) {
     const mimeType = (descriptor as Record<string, unknown>).mimeType as string;
     const width = (descriptor as Record<string, unknown>).width;
     const height = (descriptor as Record<string, unknown>).height;
     if (
       (width !== undefined && (!Number.isSafeInteger(width) || (width as number) < 1)) ||
       (height !== undefined && (!Number.isSafeInteger(height) || (height as number) < 1))
     ) {
       throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
     }
+    if (result.kind === 'image.comfy') {
+      if (!mimeType.startsWith('image/') || width === undefined || height === undefined) {
+        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
+      }
+    }
+    if (result.kind === 'audio.ml-denoise') {
+      if (!mimeType.startsWith('audio/') || width !== undefined || height !== undefined) {
+        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
+      }
+    }
+    if (result.kind === 'video.runway') {
+      if (!mimeType.startsWith('video/')) {
+        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
+      }
+    }
+    if (result.kind === 'edit.higgsfield') {
+      if (!mimeType.startsWith('image/') || width === undefined || height === undefined) {
+        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
+      }
+    }
     return {
       kind: result.kind,
       assetId: result.assetId,
       sha256: result.sha256,
       bytes: result.bytes,
       localRef: result.localRef,
       descriptor: {
         mimeType,
         ...(width === undefined ? {} : { width: width as number }),
         ...(height === undefined ? {} : { height: height as number }),
diff --git a/apps/worker/src/local-gpu.ts b/apps/worker/src/local-gpu.ts
index ed60050..72f824f 100644
--- a/apps/worker/src/local-gpu.ts
+++ b/apps/worker/src/local-gpu.ts
@@ -65,25 +65,21 @@ async function ensureComfyReachable(base: string, fetchFn: typeof fetch): Promis
   if (!response.ok) throw new Error(`ComfyUI system_stats failed (${response.status})`);
 }
 
 async function uploadComfyImage(
   base: string,
   filePath: string,
   fetchFn: typeof fetch,
 ): Promise<string> {
   const bytes = readFileSync(filePath);
   const form = new FormData();
-  form.append(
-    'image',
-    new Blob([Uint8Array.from(bytes)], { type: 'image/png' }),
-    'joy-input.png',
-  );
+  form.append('image', new Blob([Uint8Array.from(bytes)], { type: 'image/png' }), 'joy-input.png');
   form.append('overwrite', 'true');
   const response = await fetchFn(`${base}/upload/image`, { method: 'POST', body: form });
   if (!response.ok) throw new Error(`ComfyUI image upload failed (${response.status})`);
   const json = (await response.json()) as { name?: string };
   if (typeof json.name !== 'string' || json.name.length === 0)
     throw new Error('ComfyUI upload did not return an image name');
   return json.name;
 }
 
 async function runComfyPrompt(
@@ -130,30 +126,21 @@ async function runComfyPrompt(
       throw new Error('ComfyUI history completed without image outputs');
     }
     await new Promise((resolve) => setTimeout(resolve, 250));
   }
   throw new Error('ComfyUI prompt timed out');
 }
 
 function writeSolidPng(path: string): void {
   const result = spawnSync(
     'ffmpeg',
-    [
-      '-y',
-      '-f',
-      'lavfi',
-      '-i',
-      'color=c=#e9b949:s=64x64:d=0.04',
-      '-frames:v',
-      '1',
-      path,
-    ],
+    ['-y', '-f', 'lavfi', '-i', 'color=c=#e9b949:s=64x64:d=0.04', '-frames:v', '1', path],
     { encoding: 'utf8' },
   );
   if (result.status !== 0 || !existsSync(path))
     throw new Error(`ffmpeg solid PNG failed: ${(result.stderr || '').slice(0, 200)}`);
 }
 
 function convertSourceToPng(sourcePath: string, outPath: string): void {
   const result = spawnSync(
     'ffmpeg',
     ['-y', '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=512:-2', outPath],
@@ -172,67 +159,24 @@ function retainDerivative(
   mkdirSync(derivativeDirectory, { recursive: true });
   const finalOutput = join(derivativeDirectory, `${localRef}.${extension}`);
   const temp = `${finalOutput}.tmp`;
   writeFileSync(temp, bytes);
   rmSync(finalOutput, { force: true });
   renameSync(temp, finalOutput);
   return finalOutput;
 }
 
 export async function runImageComfyJob(options: LocalGpuRunOptions): Promise<LocalGpuReceipt> {
-  const base = (process.env.JOY_MEDIA_LOCAL_COMFY_URL ?? '').trim().replace(/\/$/, '');
-  if (base.length === 0) throw new Error('JOY_MEDIA_LOCAL_COMFY_URL is not set');
-  const fetchFn = options.fetch ?? fetch;
-  const tempDir = mkdtempSync(join(tmpdir(), `joy-comfy-${options.jobId}-`));
-  try {
-    await options.progress(5);
-    await ensureComfyReachable(base, fetchFn);
-    if (options.cancelled()) throw new Error('canceled');
-    await options.progress(15);
-    const inputPng = join(tempDir, 'input.png');
-    if (options.sourcePath !== undefined) convertSourceToPng(options.sourcePath, inputPng);
-    else writeSolidPng(inputPng);
-    await options.progress(30);
-    const imageName = await uploadComfyImage(base, inputPng, fetchFn);
-    await options.progress(45);
-    const { filename, subfolder } = await runComfyPrompt(
-      base,
-      identityComfyWorkflow(imageName),
-      fetchFn,
-      options.cancelled,
-    );
-    await options.progress(75);
-    const viewUrl = new URL(`${base}/view`);
-    viewUrl.searchParams.set('filename', filename);
-    if (subfolder.length > 0) viewUrl.searchParams.set('subfolder', subfolder);
-    viewUrl.searchParams.set('type', 'output');
-    const viewResponse = await fetchFn(viewUrl);
-    if (!viewResponse.ok) throw new Error(`ComfyUI view failed (${viewResponse.status})`);
-    const arrayBuffer = await viewResponse.arrayBuffer();
-    const bytes = Buffer.from(arrayBuffer);
-    if (bytes.length < 1) throw new Error('ComfyUI output is empty');
-    const sha256 = createHash('sha256').update(bytes).digest('hex');
-    const assetId = options.assetId ?? `comfy-${options.jobId}`;
-    const localRef = `gpu-${options.jobId}-${sha256.slice(0, 16)}`;
-    retainDerivative(options.derivativeDirectory, localRef, 'png', bytes);
-    await options.progress(100);
-    return {
-      kind: 'image.comfy',
-      assetId,
-      sha256,
-      bytes: bytes.length,
-      localRef,
-      descriptor: { mimeType: 'image/png', width: 64, height: 64 },
-    };
-  } finally {
-    rmSync(tempDir, { recursive: true, force: true });
-  }
+  void options;
+  throw new Error(
+    'COMFYUI_UNAVAILABLE: identity Comfy workflows and solid PNG fallbacks are fixture-only; production image.comfy is not wired yet.',
+  );
 }
 
 function writeNoisyFixtureWav(path: string): void {
   const result = spawnSync(
     'ffmpeg',
     [
       '-y',
       '-f',
       'lavfi',
       '-i',
diff --git a/apps/worker/src/runtime.test.ts b/apps/worker/src/runtime.test.ts
index e47a6d3..9b4ed84 100644
--- a/apps/worker/src/runtime.test.ts
+++ b/apps/worker/src/runtime.test.ts
@@ -218,20 +218,34 @@ describe('Worker runtime', () => {
       { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: true, aiProviders: [] },
     );
     expect(runtime.hello('linux', 'x64').capabilities).toEqual([
       'asset.thumbnail',
       'render.export',
       'image.comfy',
       'audio.ml-denoise',
     ]);
   });
 
+  it('fails image.comfy honestly until a non-fixture workflow is wired', async () => {
+    const runtime = new WorkerRuntime(
+      { workerId: 'worker-comfy', createdAt: '2026-08-21T00:00:00.000Z' },
+      { ffmpeg: true, ffprobe: true, comfy: true, mlDenoise: false, aiProviders: [] },
+    );
+
+    await expect(
+      runtime.run(
+        { id: 'job-comfy', type: 'image.comfy' },
+        { cancelled: () => false, progress: async () => undefined },
+      ),
+    ).rejects.toThrow(/COMFYUI_UNAVAILABLE/i);
+  });
+
   it('maps AI provider results to protocol-compatible receipt kinds', () => {
     expect(
       workerReceiptFromAiResult(
         { id: 'job-text', type: 'text.lm-studio' },
         { kind: 'text', jobId: 'job-text', provider: 'lm-studio', text: 'hello', model: 'local' },
       ),
     ).toMatchObject({
       kind: 'text.lm-studio',
       resultRef: 'ai-job-text',
       model: 'local',
@@ -250,12 +264,40 @@ describe('Worker runtime', () => {
           descriptor: { mimeType: 'video/mp4' },
           model: 'gen4',
         },
       ),
     ).toMatchObject({
       kind: 'video.runway',
       assetId: 'ai-job-video',
       localRef: 'ai-job-video-aaaaaaaaaaaaaaaa',
       descriptor: { mimeType: 'video/mp4' },
     });
+    expect(() =>
+      workerReceiptFromAiResult(
+        { id: 'job-video-image', type: 'video.runway' },
+        {
+          kind: 'image',
+          jobId: 'job-video-image',
+          provider: 'runway',
+          sha256: 'b'.repeat(64),
+          bytes: 512,
+          localRef: 'ai-job-video-image-bbbbbbbbbbbbbbbb',
+          descriptor: { mimeType: 'image/png', width: 512, height: 512 },
+        },
+      ),
+    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
+    expect(() =>
+      workerReceiptFromAiResult(
+        { id: 'job-edit-video', type: 'edit.higgsfield' },
+        {
+          kind: 'video',
+          jobId: 'job-edit-video',
+          provider: 'higgsfield',
+          sha256: 'c'.repeat(64),
+          bytes: 2048,
+          localRef: 'ai-job-edit-video-cccccccccccccccc',
+          descriptor: { mimeType: 'video/mp4' },
+        },
+      ),
+    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
   });
 });
diff --git a/apps/worker/src/runtime.ts b/apps/worker/src/runtime.ts
index b2908e8..3c4c104 100644
--- a/apps/worker/src/runtime.ts
+++ b/apps/worker/src/runtime.ts
@@ -355,20 +355,27 @@ export class WorkerRuntime {
       const provider = job.type.replace(/^(text\.|video\.|edit\.)/, '') as AiProvider;
       const derivativeDirectory =
         this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
       this.log.write(`job ${job.id} started (${job.type})`);
       try {
         const result = await runAiJob({
           jobId: job.id,
           provider,
           model: job.payload?.model ?? '',
           prompt: job.payload?.prompt ?? '',
+          ...(job.payload?.negativePrompt === undefined
+            ? {}
+            : { negativePrompt: job.payload.negativePrompt }),
+          ...(job.payload?.imageAssetId === undefined
+            ? {}
+            : { imageAssetId: job.payload.imageAssetId }),
+          ...(job.payload?.params === undefined ? {} : { params: job.payload.params }),
           derivativeDirectory,
           cancelled: options.cancelled,
           progress: options.progress,
         });
         this.log.write(`job ${job.id} completed`);
         return { state: 'completed', result: workerReceiptFromAiResult(job, result) };
       } catch (error) {
         if (error instanceof Error && error.message === 'canceled') {
           this.log.write(`job ${job.id} canceled`);
           return { state: 'canceled' };
@@ -551,39 +558,54 @@ export interface RealThumbnailReceipt {
     readonly width: number;
     readonly height: number;
   };
 }
 
 export function workerReceiptFromAiResult(
   job: { readonly id: string; readonly type: string },
   result: LocalAiReceipt,
 ): ProtocolAiReceipt {
   if (job.type === 'text.lm-studio' || job.type === 'text.openrouter') {
+    if (result.kind !== 'text') {
+      throw new Error(`AI_OUTPUT_UNAVAILABLE: ${job.type} only supports text outputs`);
+    }
     const text = result.text ?? '';
     const bytes = Buffer.from(text, 'utf8');
     return {
       kind: job.type,
       resultRef: `ai-${job.id}`,
       sha256: createHash('sha256').update(bytes).digest('hex'),
       bytes: bytes.length,
       ...(result.model === undefined ? {} : { model: result.model }),
     };
   }
   if (job.type === 'video.runway' || job.type === 'edit.higgsfield') {
+    if (job.type === 'video.runway' && result.kind !== 'video') {
+      throw new Error('AI_OUTPUT_UNAVAILABLE: video.runway only supports video outputs');
+    }
+    if (job.type === 'edit.higgsfield' && result.kind !== 'image') {
+      throw new Error('AI_OUTPUT_UNAVAILABLE: edit.higgsfield only supports image outputs');
+    }
     if (
       result.sha256 === undefined ||
       result.bytes === undefined ||
       result.localRef === undefined ||
       result.descriptor === undefined
     ) {
       throw new Error(`AI provider result is incomplete for ${job.type}`);
     }
+    if (job.type === 'video.runway' && !result.descriptor.mimeType.startsWith('video/')) {
+      throw new Error('AI_OUTPUT_UNAVAILABLE: video.runway returned a non-video descriptor');
+    }
+    if (job.type === 'edit.higgsfield' && !result.descriptor.mimeType.startsWith('image/')) {
+      throw new Error('AI_OUTPUT_UNAVAILABLE: edit.higgsfield returned a non-image descriptor');
+    }
     return {
       kind: job.type,
       assetId: result.assetId ?? `ai-${job.id}`,
       sha256: result.sha256,
       bytes: result.bytes,
       localRef: result.localRef,
       descriptor: { ...result.descriptor },
       ...(result.model === undefined ? {} : { model: result.model }),
     };
   }
diff --git a/packages/adapter-tts/src/consent-tts.test.ts b/packages/adapter-tts/src/consent-tts.test.ts
index 1d39bd2..884f0a5 100644
--- a/packages/adapter-tts/src/consent-tts.test.ts
+++ b/packages/adapter-tts/src/consent-tts.test.ts
@@ -1,19 +1,19 @@
 import { describe, expect, it } from 'vitest';
-import { createTTSAdapter } from './index.js';
+import { createFixtureTTSAdapter } from './index.js';
 import { createVoiceConsentManager } from '@joy-media/provider-sdk';
 import { createSynthesisAuditLog } from '@joy-media/provider-sdk';
 import { synthesizeWithConsent, VoiceConsentError } from './consent-tts.js';
 
 describe('TTS with Consent', () => {
   const createTestSetup = async () => {
-    const ttsAdapter = createTTSAdapter({
+    const ttsAdapter = createFixtureTTSAdapter({
       execution: 'worker-local',
       engine: 'kokoro',
     });
     const consentManager = createVoiceConsentManager();
     const auditLog = createSynthesisAuditLog();
     return { ttsAdapter, consentManager, auditLog };
   };
 
   describe('synthesizeWithConsent', () => {
     it('allows synthesis when consent is granted', async () => {
diff --git a/packages/adapter-tts/src/index.test.ts b/packages/adapter-tts/src/index.test.ts
index 4bb860e..8facdc4 100644
--- a/packages/adapter-tts/src/index.test.ts
+++ b/packages/adapter-tts/src/index.test.ts
@@ -1,12 +1,12 @@
 import { describe, expect, it } from 'vitest';
-import { createTTSAdapter } from './index.js';
+import { createFixtureTTSAdapter, createTTSAdapter } from './index.js';
 import type { TTSConfig } from './index.js';
 import {
   validateManifest,
   createTestRequest,
   assertResultSucceeded,
   computePrivacyPreflight,
 } from '@joy-media/provider-sdk';
 
 const LOCAL_CONFIG: TTSConfig = {
   execution: 'worker-local',
@@ -101,21 +101,21 @@ describe('createTTSAdapter', () => {
 
   it('uses engine name as modelId when modelId not provided', () => {
     const adapter = createTTSAdapter(FISH_SPEECH_CONFIG);
     const capability = adapter.manifest.capabilities[0]!;
     expect(capability.models![0]!.id).toBe('fish-speech');
   });
 });
 
 describe('TTS adapter invoke', () => {
   it('handles speech.synthesize successfully', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello world',
     });
 
     assertResultSucceeded(result);
     expect(result.outputs).toHaveLength(1);
     expect(result.outputs[0]!.kind).toBe('audio');
     expect(result.outputs[0]!.mimeType).toBe('audio/wav');
     expect(result.outputs[0]!.bytes).toBeInstanceOf(Uint8Array);
   });
@@ -160,114 +160,114 @@ describe('TTS adapter invoke', () => {
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello',
       pitch: 20,
     });
 
     expect(result.status).toBe('failed');
     expect(result.diagnostics.some((d) => d.code === 'INVALID_PITCH')).toBe(true);
   });
 
   it('includes word timing metadata', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello world test',
     });
 
     assertResultSucceeded(result);
     const metadata = result.outputs[0]!.metadata!;
     expect(metadata.wordTimings).toBeDefined();
     expect(Array.isArray(metadata.wordTimings)).toBe(true);
     const timings = metadata.wordTimings as Array<{ word: string; startUs: number; endUs: number }>;
     expect(timings).toHaveLength(3);
     expect(timings[0]!.word).toBe('Hello');
     expect(timings[1]!.word).toBe('world');
     expect(timings[2]!.word).toBe('test');
     expect(timings[0]!.startUs).toBe(0);
     expect(timings[0]!.endUs).toBeGreaterThan(0);
   });
 
   it('includes full provenance', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello',
     });
 
     expect(result.provenance.providerId).toBe('joy.tts-kokoro');
     expect(result.provenance.modelId).toBe('kokoro-v1');
     expect(result.provenance.adapterVersion).toBe('1.0.0');
     expect(result.provenance.execution).toBe('worker-local');
     expect(result.provenance.createdAt).toBeDefined();
     expect(result.provenance.requestHash).toBeDefined();
     expect(result.provenance.idempotencyKey).toBeDefined();
     expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
   });
 
   it('includes metadata in output', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello',
       language: 'ja',
       speed: 1.5,
       pitch: 2,
     });
 
     const metadata = result.outputs[0]!.metadata!;
     expect(metadata.engine).toBe('kokoro');
     expect(metadata.language).toBe('ja');
     expect(metadata.speed).toBe(1.5);
     expect(metadata.pitch).toBe(2);
     expect(metadata.sampleRate).toBe(24000);
   });
 
   it('uses voiceId from config when not in input', async () => {
-    const adapter = createTTSAdapter({
+    const adapter = createFixtureTTSAdapter({
       ...LOCAL_CONFIG,
       voiceId: 'config-voice',
     });
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello',
     });
 
     expect(result.outputs[0]!.metadata!.voiceId).toBe('config-voice');
   });
 
   it('input voiceId overrides config voiceId', async () => {
-    const adapter = createTTSAdapter({
+    const adapter = createFixtureTTSAdapter({
       ...LOCAL_CONFIG,
       voiceId: 'config-voice',
     });
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello',
       voiceId: 'input-voice',
     });
 
     expect(result.outputs[0]!.metadata!.voiceId).toBe('input-voice');
   });
 
   it('generates unique asset IDs', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result1 = await adapter.invoke('speech.synthesize', { text: 'Hello' });
     const result2 = await adapter.invoke('speech.synthesize', { text: 'World' });
 
     expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
   });
 
   it('supports all valid engines', async () => {
     const engines: Array<'fish-speech' | 'f5-tts' | 'kokoro' | 'chatterbox'> = [
       'fish-speech',
       'f5-tts',
       'kokoro',
       'chatterbox',
     ];
 
     for (const engine of engines) {
-      const adapter = createTTSAdapter({ execution: 'worker-local', engine });
+      const adapter = createFixtureTTSAdapter({ execution: 'worker-local', engine });
       const result = await adapter.invoke('speech.synthesize', { text: 'Test' });
       assertResultSucceeded(result);
       expect(result.outputs[0]!.metadata!.engine).toBe(engine);
     }
   });
 });
 
 describe('TTS adapter privacy', () => {
   it('computes privacy preflight for local execution', () => {
     const adapter = createTTSAdapter(LOCAL_CONFIG);
@@ -283,20 +283,20 @@ describe('TTS adapter privacy', () => {
     const request = createTestRequest('speech.synthesize', { text: 'Hello' });
 
     const preflight = computePrivacyPreflight(request, adapter);
     expect(preflight.dataLeavesDevice).toBe(true);
     expect(preflight.requiresUserApproval).toBe(true);
   });
 });
 
 describe('TTS adapter voice cloning support', () => {
   it('accepts voiceId for future voice cloning integration', async () => {
-    const adapter = createTTSAdapter(LOCAL_CONFIG);
+    const adapter = createFixtureTTSAdapter(LOCAL_CONFIG);
     const result = await adapter.invoke('speech.synthesize', {
       text: 'Hello with cloned voice',
       voiceId: 'voice-identity-123',
     });
 
     assertResultSucceeded(result);
     expect(result.outputs[0]!.metadata!.voiceId).toBe('voice-identity-123');
   });
 });
diff --git a/packages/adapter-tts/src/index.ts b/packages/adapter-tts/src/index.ts
index 0eecf89..97b22c4 100644
--- a/packages/adapter-tts/src/index.ts
+++ b/packages/adapter-tts/src/index.ts
@@ -1,36 +1,31 @@
 import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { spawnSync } from 'node:child_process';
 import type {
   CapabilityDeclaration,
   CapabilityId,
+  CapabilityRequest,
   CapabilityResult,
   Diagnostic,
   GeneratedOutput,
   GenerationProvenance,
   ProviderManifestV2,
   ProviderV2,
 } from '@joy-media/provider-sdk';
 
 export type { TTSRequestWithConsent } from './consent-tts.js';
 export { synthesizeWithConsent, VoiceConsentError } from './consent-tts.js';
 
 export type TTSEngine =
-  | 'fish-speech'
-  | 'f5-tts'
-  | 'kokoro'
-  | 'chatterbox'
-  | 'elevenlabs'
-  | 'edge-tts'
-  | 'piper';
+  'fish-speech' | 'f5-tts' | 'kokoro' | 'chatterbox' | 'elevenlabs' | 'edge-tts' | 'piper';
 
 export interface TTSConfig {
   readonly execution: 'worker-local' | 'remote-api';
   readonly engine: TTSEngine;
   readonly modelId?: string;
   readonly voiceId?: string;
   readonly apiKey?: string;
   /** Override path to the edge-tts binary (default: edge-tts on PATH). */
   readonly edgeTtsCommand?: string;
   /** Override path to the Piper binary (default: JOY_MEDIA_PIPER / stock path). */
@@ -38,20 +33,21 @@ export interface TTSConfig {
   /** Override directory containing Piper `.onnx` voice models. */
   readonly piperVoicesDir?: string;
 }
 
 export interface TTSInput {
   readonly text: string;
   readonly language?: string;
   readonly voiceId?: string;
   readonly speed?: number;
   readonly pitch?: number;
+  readonly decisionId?: string;
 }
 
 interface WordTiming {
   readonly word: string;
   readonly startUs: number;
   readonly endUs: number;
 }
 
 let requestCounter = 0;
 
@@ -165,21 +161,24 @@ function generateWordTimings(text: string, speed: number): WordTiming[] {
       startUs: currentTimeUs,
       endUs: currentTimeUs + durationUs,
     });
     currentTimeUs += durationUs + gapUs;
   }
 
   return timings;
 }
 
 /** Map BCP-47 / short language codes to Edge neural voices. */
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
 
 function synthesizeWithEdgeTts(
@@ -187,30 +186,21 @@ function synthesizeWithEdgeTts(
   input: TTSInput,
 ): { audioData: Uint8Array; timings: WordTiming[]; mimeType: string; sampleRate: number } {
   const command = config.edgeTtsCommand ?? process.env.JOY_MEDIA_EDGE_TTS ?? 'edge-tts';
   const voice = resolveEdgeVoice(input.language, input.voiceId ?? config.voiceId);
   const speed = input.speed ?? 1.0;
   const ratePercent = Math.round((speed - 1) * 100);
   const rate = `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`;
   const dir = mkdtempSync(join(tmpdir(), 'joy-edge-tts-'));
   const mediaPath = join(dir, 'speech.mp3');
   try {
-    const args = [
-      '-t',
-      input.text,
-      '-v',
-      voice,
-      '--rate',
-      rate,
-      '--write-media',
-      mediaPath,
-    ];
+    const args = ['-t', input.text, '-v', voice, '--rate', rate, '--write-media', mediaPath];
     const result = spawnSync(command, args, {
       encoding: 'utf8',
       timeout: Number(process.env.JOY_MEDIA_TTS_TIMEOUT_MS ?? 60_000),
     });
     if (result.status !== 0 || !existsSync(mediaPath)) {
       throw new Error(
         `edge-tts failed: ${(result.stderr || result.stdout || 'no output').slice(0, 400)}`,
       );
     }
     const audioData = new Uint8Array(readFileSync(mediaPath));
@@ -219,21 +209,26 @@ function synthesizeWithEdgeTts(
   } finally {
     rmSync(dir, { recursive: true, force: true });
   }
 }
 
 function resolvePiperModel(
   config: TTSConfig,
   language: string | undefined,
   voiceId: string | undefined,
 ): string {
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
     config.piperVoicesDir ??
     process.env.JOY_MEDIA_PIPER_VOICES_DIR?.trim() ??
     '/opt/joy-media/data/piper/voices';
   const lang = (language ?? 'en').toLowerCase();
   const preferred = lang.startsWith('fa')
     ? join(voicesDir, 'fa_IR-gyro-medium.onnx')
     : join(voicesDir, 'en_US-lessac-medium.onnx');
@@ -267,23 +262,26 @@ function synthesizeWithPiper(
       );
     }
     const audioData = new Uint8Array(readFileSync(mediaPath));
     const timings = generateWordTimings(input.text, speed);
     return { audioData, timings, mimeType: 'audio/wav', sampleRate: 22_050 };
   } finally {
     rmSync(dir, { recursive: true, force: true });
   }
 }
 
-function synthesizeSineFixture(
-  input: TTSInput,
-): { audioData: Uint8Array; timings: WordTiming[]; mimeType: string; sampleRate: number } {
+function synthesizeSineFixture(input: TTSInput): {
+  audioData: Uint8Array;
+  timings: WordTiming[];
+  mimeType: string;
+  sampleRate: number;
+} {
   const speed = input.speed ?? 1.0;
   const timings = generateWordTimings(input.text, speed);
   const totalDurationUs = timings.length > 0 ? timings[timings.length - 1]!.endUs : 1_000_000;
   const sampleRate = 24000;
   const numSamples = Math.round((totalDurationUs / 1_000_000) * sampleRate);
   const audioData = new Uint8Array(numSamples * 2);
 
   for (let i = 0; i < numSamples; i++) {
     const t = i / sampleRate;
     const sample = Math.sin(2 * Math.PI * 440 * t) * 0.3;
@@ -291,32 +289,76 @@ function synthesizeSineFixture(
     audioData[i * 2] = intSample & 0xff;
     audioData[i * 2 + 1] = (intSample >> 8) & 0xff;
   }
 
   return { audioData, timings, mimeType: 'audio/wav', sampleRate };
 }
 
 function synthesizeSpeech(
   config: TTSConfig,
   input: TTSInput,
+  allowFixtureFallback: boolean,
 ): { audioData: Uint8Array; timings: WordTiming[]; mimeType: string; sampleRate: number } {
   if (config.engine === 'edge-tts') {
     return synthesizeWithEdgeTts(config, input);
   }
   if (config.engine === 'piper') {
     return synthesizeWithPiper(config, input);
   }
-  // Other engines remain fixture sine until a local binary is wired.
+  if (!allowFixtureFallback) {
+    throw new Error(
+      `TTS_UNAVAILABLE: engine '${config.engine}' is not wired in production; use createFixtureTTSAdapter only in explicit tests.`,
+    );
+  }
   return synthesizeSineFixture(input);
 }
 
-export function createTTSAdapter(config: TTSConfig): ProviderV2 {
+function callerDecisionId(input: unknown): string | undefined {
+  return input !== null &&
+    typeof input === 'object' &&
+    typeof (input as { decisionId?: unknown }).decisionId === 'string'
+    ? (input as { decisionId: string }).decisionId
+    : undefined;
+}
+
+function buildProvenance(
+  manifest: ProviderManifestV2,
+  modelId: string,
+  input: unknown,
+  startTime: number,
+  requestId: string,
+  request?: CapabilityRequest,
+): GenerationProvenance {
+  const idempotencyKey = request?.idempotencyKey ?? requestId;
+  const decisionId = callerDecisionId(input);
+  return {
+    providerId: manifest.id,
+    modelId,
+    adapterVersion: manifest.adapterVersion,
+    createdAt: new Date().toISOString(),
+    requestHash: hashRequest({ input, idempotencyKey, decisionId }),
+    idempotencyKey,
+    processingTimeMs: Date.now() - startTime,
+    execution: manifest.execution,
+    ...(decisionId === undefined ? {} : { decisionId }),
+  };
+}
+
+function unavailableDiagnostic(message: string): Diagnostic {
+  return {
+    severity: 'error',
+    code: 'PROVIDER_UNAVAILABLE',
+    message,
+  };
+}
+
+function createTTSAdapterInternal(config: TTSConfig, allowFixtureFallback: boolean): ProviderV2 {
   validateConfig(config);
 
   const isLocal = config.execution === 'worker-local';
   const modelId = config.modelId ?? config.engine;
 
   const capability: CapabilityDeclaration = {
     id: 'speech.synthesize',
     inputSchema: {
       type: 'object',
       properties: {
@@ -396,73 +438,64 @@ export function createTTSAdapter(config: TTSConfig): ProviderV2 {
             retentionDisclosure:
               config.engine === 'edge-tts'
                 ? 'Text is sent to Microsoft Edge online TTS for synthesis'
                 : 'Text sent to remote TTS service for synthesis',
           }),
     },
   };
 
   return {
     manifest,
-    invoke: async (capabilityId: CapabilityId, input: unknown): Promise<CapabilityResult> => {
+    invoke: async (
+      capabilityId: CapabilityId,
+      input: unknown,
+      request?: CapabilityRequest,
+    ): Promise<CapabilityResult> => {
       const startTime = Date.now();
       const requestId = generateRequestId();
+      const provenance = buildProvenance(manifest, modelId, input, startTime, requestId, request);
 
       if (capabilityId !== 'speech.synthesize') {
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId,
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
+          provenance,
           diagnostics: [
             {
               severity: 'error',
               code: 'UNSUPPORTED_CAPABILITY',
               message: `Capability '${capabilityId}' not supported. This adapter only supports 'speech.synthesize'.`,
             },
           ],
         };
       }
 
       const validation = validateInput(input);
       if (!validation.valid) {
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId,
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
+          provenance,
           diagnostics: validation.diagnostics,
         };
       }
 
       const ttsInput = input as TTSInput;
 
       try {
-        const { audioData, timings, mimeType, sampleRate } = synthesizeSpeech(config, ttsInput);
+        const { audioData, timings, mimeType, sampleRate } = synthesizeSpeech(
+          config,
+          ttsInput,
+          allowFixtureFallback,
+        );
         const assetId = generateAssetId();
 
         const output: GeneratedOutput = {
           kind: 'audio',
           assetId,
           mimeType,
           bytes: audioData,
           metadata: {
             engine: config.engine,
             modelId,
@@ -470,57 +503,45 @@ export function createTTSAdapter(config: TTSConfig): ProviderV2 {
             voiceId:
               ttsInput.voiceId ?? config.voiceId ?? resolveEdgeVoice(ttsInput.language, undefined),
             speed: ttsInput.speed ?? 1.0,
             pitch: ttsInput.pitch ?? 0,
             wordTimings: timings,
             sampleRate,
             durationUs: timings.length > 0 ? timings[timings.length - 1]!.endUs : 0,
           },
         };
 
-        const provenance: GenerationProvenance = {
-          providerId: manifest.id,
-          modelId,
-          adapterVersion: manifest.adapterVersion,
-          createdAt: new Date().toISOString(),
-          requestHash: hashRequest(input),
-          idempotencyKey: requestId,
-          processingTimeMs: Date.now() - startTime,
-          execution: manifest.execution,
-        };
-
         return {
           requestId,
           status: 'succeeded',
           outputs: [output],
           provenance,
           diagnostics: validation.diagnostics,
         };
       } catch (error) {
         const errorMessage = error instanceof Error ? error.message : 'Unknown error';
+        const code = errorMessage.startsWith('TTS_UNAVAILABLE:')
+          ? unavailableDiagnostic(errorMessage)
+          : {
+              severity: 'error' as const,
+              code: 'SYNTHESIS_FAILED',
+              message: errorMessage,
+            };
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId,
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
-          diagnostics: [
-            ...validation.diagnostics,
-            {
-              severity: 'error',
-              code: 'SYNTHESIS_FAILED',
-              message: errorMessage,
-            },
-          ],
+          provenance,
+          diagnostics: [...validation.diagnostics, code],
         };
       }
     },
   };
 }
+
+export function createTTSAdapter(config: TTSConfig): ProviderV2 {
+  return createTTSAdapterInternal(config, false);
+}
+
+export function createFixtureTTSAdapter(config: TTSConfig): ProviderV2 {
+  return createTTSAdapterInternal(config, true);
+}
diff --git a/packages/adapter-tts/src/production-mode.test.ts b/packages/adapter-tts/src/production-mode.test.ts
new file mode 100644
index 0000000..f4ddc2c
--- /dev/null
+++ b/packages/adapter-tts/src/production-mode.test.ts
@@ -0,0 +1,44 @@
+import { describe, expect, it } from 'vitest';
+import { createTTSAdapter } from './index.js';
+
+describe('TTS adapter production mode', () => {
+  it.each([
+    { execution: 'worker-local' as const, engine: 'fish-speech' as const },
+    { execution: 'worker-local' as const, engine: 'f5-tts' as const },
+    { execution: 'worker-local' as const, engine: 'kokoro' as const },
+    { execution: 'worker-local' as const, engine: 'chatterbox' as const },
+    { execution: 'remote-api' as const, engine: 'elevenlabs' as const },
+  ])('fails closed for unwired production engine $engine', async (config) => {
+    const adapter = createTTSAdapter(config);
+    const result = await adapter.invoke('speech.synthesize', { text: 'Hello world' });
+
+    expect(result.status).toBe('failed');
+    expect(result.outputs).toEqual([]);
+    expect(result.diagnostics).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          code: 'PROVIDER_UNAVAILABLE',
+          message: expect.stringContaining('TTS_UNAVAILABLE'),
+        }),
+      ]),
+    );
+  });
+
+  it('carries caller idempotency and decision ids through failed provenance', async () => {
+    const adapter = createTTSAdapter({ execution: 'worker-local', engine: 'kokoro' });
+    const input = { text: 'Hello world', decisionId: 'decision-tts-1' };
+
+    const result = await adapter.invoke('speech.synthesize', input, {
+      requestVersion: 1,
+      capability: 'speech.synthesize',
+      input,
+      constraints: {},
+      idempotencyKey: 'idem-tts-1',
+    });
+
+    expect(result.provenance.idempotencyKey).toBe('idem-tts-1');
+    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
+      'decision-tts-1',
+    );
+  });
+});
diff --git a/packages/adapter-voice-isolation/src/index.test.ts b/packages/adapter-voice-isolation/src/index.test.ts
index 65b0f84..7c0c38c 100644
--- a/packages/adapter-voice-isolation/src/index.test.ts
+++ b/packages/adapter-voice-isolation/src/index.test.ts
@@ -1,12 +1,12 @@
 import { describe, expect, it } from 'vitest';
-import { createVoiceIsolationAdapter } from './index.js';
+import { createFixtureVoiceIsolationAdapter, createVoiceIsolationAdapter } from './index.js';
 import type { VoiceIsolationConfig } from './index.js';
 import {
   validateManifest,
   createTestRequest,
   assertResultSucceeded,
   computePrivacyPreflight,
 } from '@joy-media/provider-sdk';
 
 const ISOLATE_CONFIG: VoiceIsolationConfig = {
   execution: 'worker-local',
@@ -55,55 +55,55 @@ describe('createVoiceIsolationAdapter', () => {
   it('includes model in capability declaration when modelPath provided', () => {
     const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
     const capability = adapter.manifest.capabilities[0]!;
     expect(capability.models).toBeDefined();
     expect(capability.models![0]!.id).toBe('/models/demucs-v3.pth');
   });
 });
 
 describe('VoiceIsolation adapter invoke - isolate-voice', () => {
   it('handles audio.separate successfully', async () => {
-    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
 
     const result = await adapter.invoke('audio.separate', {
       assetId: 'audio-123',
       data: audioData,
     });
 
     assertResultSucceeded(result);
     expect(result.outputs).toHaveLength(1);
     expect(result.outputs[0]!.kind).toBe('audio');
     expect(result.outputs[0]!.mimeType).toBe('audio/wav');
     expect(result.outputs[0]!.metadata!.stem).toBe('voice');
   });
 });
 
 describe('VoiceIsolation adapter invoke - remove-voice', () => {
   it('handles audio.separate successfully', async () => {
-    const adapter = createVoiceIsolationAdapter(REMOVE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(REMOVE_CONFIG);
     const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
 
     const result = await adapter.invoke('audio.separate', {
       assetId: 'audio-123',
       data: audioData,
     });
 
     assertResultSucceeded(result);
     expect(result.outputs).toHaveLength(1);
     expect(result.outputs[0]!.metadata!.stem).toBe('no-voice');
   });
 });
 
 describe('VoiceIsolation adapter invoke - separate-stems', () => {
   it('handles audio.separate successfully with multiple stems', async () => {
-    const adapter = createVoiceIsolationAdapter(SEPARATE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(SEPARATE_CONFIG);
     const audioData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
 
     const result = await adapter.invoke('audio.separate', {
       assetId: 'audio-123',
       data: audioData,
     });
 
     assertResultSucceeded(result);
     expect(result.outputs).toHaveLength(4);
     expect(result.outputs[0]!.metadata!.stem).toBe('vocals');
@@ -145,55 +145,111 @@ describe('VoiceIsolation adapter error handling', () => {
     const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
     const result = await adapter.invoke('audio.separate', null);
 
     expect(result.status).toBe('failed');
     expect(result.diagnostics.some((d) => d.code === 'INVALID_INPUT')).toBe(true);
   });
 });
 
 describe('VoiceIsolation adapter provenance', () => {
   it('includes full provenance', async () => {
-    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const result = await adapter.invoke('audio.separate', {
       assetId: 'audio-123',
       data: new Uint8Array([1, 2, 3]),
     });
 
     expect(result.provenance.providerId).toBe('joy.voice-isolation');
     expect(result.provenance.modelId).toBe('/models/demucs-v3.pth');
     expect(result.provenance.adapterVersion).toBe('1.0.0');
     expect(result.provenance.execution).toBe('worker-local');
     expect(result.provenance.createdAt).toBeDefined();
     expect(result.provenance.requestHash).toBeDefined();
     expect(result.provenance.idempotencyKey).toBeDefined();
     expect(result.provenance.processingTimeMs).toBeGreaterThanOrEqual(0);
   });
 
   it('includes metadata in outputs', async () => {
-    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const result = await adapter.invoke('audio.separate', {
       assetId: 'audio-123',
       data: new Uint8Array([1, 2, 3]),
     });
 
     expect(result.outputs[0]!.metadata).toBeDefined();
     expect(result.outputs[0]!.metadata!.sourceAssetId).toBe('audio-123');
     expect(result.outputs[0]!.metadata!.mode).toBe('isolate-voice');
   });
 
   it('generates unique asset IDs', async () => {
-    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const result1 = await adapter.invoke('audio.separate', { assetId: 'audio-1' });
     const result2 = await adapter.invoke('audio.separate', { assetId: 'audio-2' });
 
     expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
   });
+
+  it('carries caller idempotency and decision ids through fixture provenance', async () => {
+    const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const input = {
+      assetId: 'audio-123',
+      data: new Uint8Array([1, 2, 3]),
+      decisionId: 'decision-voice-1',
+    };
+
+    const result = await adapter.invoke('audio.separate', input, {
+      requestVersion: 1,
+      capability: 'audio.separate',
+      input,
+      constraints: {},
+      idempotencyKey: 'idem-voice-1',
+    });
+
+    expect(result.provenance.idempotencyKey).toBe('idem-voice-1');
+    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
+      'decision-voice-1',
+    );
+  });
+});
+
+describe('VoiceIsolation adapter production mode', () => {
+  it('fails closed without the explicit fixture constructor', async () => {
+    const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
+    const input = {
+      assetId: 'audio-123',
+      data: new Uint8Array([1, 2, 3]),
+      decisionId: 'decision-voice-prod-1',
+    };
+
+    const result = await adapter.invoke('audio.separate', input, {
+      requestVersion: 1,
+      capability: 'audio.separate',
+      input,
+      constraints: {},
+      idempotencyKey: 'idem-voice-prod-1',
+    });
+
+    expect(result.status).toBe('failed');
+    expect(result.outputs).toEqual([]);
+    expect(result.diagnostics).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({
+          code: 'PROVIDER_UNAVAILABLE',
+          message: expect.stringContaining('VOICE_ISOLATION_UNAVAILABLE'),
+        }),
+      ]),
+    );
+    expect(result.provenance.idempotencyKey).toBe('idem-voice-prod-1');
+    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
+      'decision-voice-prod-1',
+    );
+  });
 });
 
 describe('VoiceIsolation adapter privacy', () => {
   it('computes privacy preflight for local execution', () => {
     const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
     const request = createTestRequest('audio.separate', { assetId: 'audio-123' });
 
     const preflight = computePrivacyPreflight(request, adapter);
     expect(preflight.dataLeavesDevice).toBe(false);
     expect(preflight.requiresUserApproval).toBe(false);
diff --git a/packages/adapter-voice-isolation/src/index.ts b/packages/adapter-voice-isolation/src/index.ts
index 958d1da..64bea02 100644
--- a/packages/adapter-voice-isolation/src/index.ts
+++ b/packages/adapter-voice-isolation/src/index.ts
@@ -1,31 +1,33 @@
 import type {
   CapabilityDeclaration,
   CapabilityId,
+  CapabilityRequest,
   CapabilityResult,
   Diagnostic,
   GeneratedOutput,
   GenerationProvenance,
   ProviderManifestV2,
   ProviderV2,
 } from '@joy-media/provider-sdk';
 
 export interface VoiceIsolationConfig {
   readonly execution: 'worker-local' | 'remote-api';
   readonly modelPath?: string;
   readonly mode: 'isolate-voice' | 'remove-voice' | 'separate-stems';
 }
 
 export interface VoiceIsolationInput {
   readonly assetId: string;
   readonly data?: Uint8Array;
   readonly sampleRate?: number;
+  readonly decisionId?: string;
 }
 
 let requestCounter = 0;
 
 function generateRequestId(): string {
   requestCounter++;
   return `voice-isolation-${Date.now()}-${requestCounter}`;
 }
 
 function generateAssetId(inputAssetId: string, stem: string): string {
@@ -161,22 +163,66 @@ function processVoiceIsolation(
           },
         },
       );
       break;
     }
   }
 
   return outputs;
 }
 
-export function createVoiceIsolationAdapter(config: VoiceIsolationConfig): ProviderV2 {
+function callerDecisionId(input: unknown): string | undefined {
+  return input !== null &&
+    typeof input === 'object' &&
+    typeof (input as { decisionId?: unknown }).decisionId === 'string'
+    ? (input as { decisionId: string }).decisionId
+    : undefined;
+}
+
+function buildProvenance(
+  manifest: ProviderManifestV2,
+  modelId: string,
+  input: unknown,
+  startTime: number,
+  requestId: string,
+  request?: CapabilityRequest,
+): GenerationProvenance {
+  const idempotencyKey = request?.idempotencyKey ?? requestId;
+  const decisionId = callerDecisionId(input);
+  return {
+    providerId: manifest.id,
+    modelId,
+    adapterVersion: manifest.adapterVersion,
+    createdAt: new Date().toISOString(),
+    requestHash: hashRequest({ input, idempotencyKey, decisionId }),
+    idempotencyKey,
+    processingTimeMs: Date.now() - startTime,
+    execution: manifest.execution,
+    ...(decisionId === undefined ? {} : { decisionId }),
+  };
+}
+
+function unavailableDiagnostic(): Diagnostic {
+  return {
+    severity: 'error',
+    code: 'PROVIDER_UNAVAILABLE',
+    message:
+      'VOICE_ISOLATION_UNAVAILABLE: production voice isolation is not wired; use createFixtureVoiceIsolationAdapter only in explicit tests.',
+  };
+}
+
+function createVoiceIsolationAdapterInternal(
+  config: VoiceIsolationConfig,
+  fixtureMode: boolean,
+): ProviderV2 {
   const isLocal = config.execution === 'worker-local';
+  const modelId = config.modelPath ?? 'default';
 
   const capability: CapabilityDeclaration = {
     id: 'audio.separate',
     inputSchema: {
       type: 'object',
       properties: {
         assetId: { type: 'string', description: 'Input audio asset ID' },
         data: { type: 'string', format: 'binary', description: 'Audio data bytes' },
         sampleRate: { type: 'number', description: 'Sample rate in Hz' },
       },
@@ -191,23 +237,23 @@ export function createVoiceIsolationAdapter(config: VoiceIsolationConfig): Provi
             type: 'object',
             properties: {
               assetId: { type: 'string' },
               mimeType: { type: 'string' },
               stem: { type: 'string' },
             },
           },
         },
       },
     },
-    models: config.modelPath
-      ? [{ id: config.modelPath, displayName: 'Voice Isolation Model' }]
-      : undefined,
+    ...(config.modelPath === undefined
+      ? {}
+      : { models: [{ id: config.modelPath, displayName: 'Voice Isolation Model' }] }),
     estimatedResources: {
       estimatedDurationMs: 5000,
       estimatedMemoryMb: isLocal ? 512 : 0,
       estimatedGpuMb: isLocal ? 256 : 0,
     },
   };
 
   const manifest: ProviderManifestV2 = {
     protocolVersion: 2,
     id: 'joy.voice-isolation',
@@ -223,117 +269,101 @@ export function createVoiceIsolationAdapter(config: VoiceIsolationConfig): Provi
         mode: {
           type: 'string',
           enum: ['isolate-voice', 'remove-voice', 'separate-stems'],
         },
       },
       required: ['execution', 'mode'],
     },
     secretFields: [],
     privacy: {
       dataLeavesDevice: !isLocal,
-      retentionDisclosure: isLocal ? undefined : 'Audio sent to remote API for processing',
+      ...(isLocal ? {} : { retentionDisclosure: 'Audio sent to remote API for processing' }),
     },
   };
 
   return {
     manifest,
-    invoke: async (capabilityId: CapabilityId, input: unknown): Promise<CapabilityResult> => {
+    invoke: async (
+      capabilityId: CapabilityId,
+      input: unknown,
+      request?: CapabilityRequest,
+    ): Promise<CapabilityResult> => {
       const startTime = Date.now();
       const requestId = generateRequestId();
+      const provenance = buildProvenance(manifest, modelId, input, startTime, requestId, request);
 
       if (capabilityId !== 'audio.separate') {
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId: config.modelPath ?? 'default',
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
+          provenance,
           diagnostics: [
             {
               severity: 'error',
               code: 'UNSUPPORTED_CAPABILITY',
               message: `Capability '${capabilityId}' not supported. This adapter only supports 'audio.separate'.`,
             },
           ],
         };
       }
 
       const validation = validateInput(input);
       if (!validation.valid) {
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId: config.modelPath ?? 'default',
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
+          provenance,
           diagnostics: validation.diagnostics,
         };
       }
 
       const voiceInput = input as VoiceIsolationInput;
+      if (!fixtureMode) {
+        return {
+          requestId,
+          status: 'failed',
+          outputs: [],
+          provenance,
+          diagnostics: [...validation.diagnostics, unavailableDiagnostic()],
+        };
+      }
 
       try {
         const outputs = processVoiceIsolation(config, voiceInput);
 
-        const provenance: GenerationProvenance = {
-          providerId: manifest.id,
-          modelId: config.modelPath ?? 'default',
-          adapterVersion: manifest.adapterVersion,
-          createdAt: new Date().toISOString(),
-          requestHash: hashRequest(input),
-          idempotencyKey: requestId,
-          processingTimeMs: Date.now() - startTime,
-          execution: manifest.execution,
-        };
-
         return {
           requestId,
           status: 'succeeded',
           outputs,
           provenance,
           diagnostics: validation.diagnostics,
         };
       } catch (error) {
         const errorMessage = error instanceof Error ? error.message : 'Unknown error';
         return {
           requestId,
           status: 'failed',
           outputs: [],
-          provenance: {
-            providerId: manifest.id,
-            modelId: config.modelPath ?? 'default',
-            adapterVersion: manifest.adapterVersion,
-            createdAt: new Date().toISOString(),
-            requestHash: hashRequest(input),
-            idempotencyKey: requestId,
-            processingTimeMs: Date.now() - startTime,
-            execution: manifest.execution,
-          },
+          provenance,
           diagnostics: [
             ...validation.diagnostics,
             {
               severity: 'error',
               code: 'PROCESSING_FAILED',
               message: errorMessage,
             },
           ],
         };
       }
     },
   };
 }
+
+export function createVoiceIsolationAdapter(config: VoiceIsolationConfig): ProviderV2 {
+  return createVoiceIsolationAdapterInternal(config, false);
+}
+
+export function createFixtureVoiceIsolationAdapter(config: VoiceIsolationConfig): ProviderV2 {
+  return createVoiceIsolationAdapterInternal(config, true);
+}
diff --git a/packages/provider-sdk/src/budget.test.ts b/packages/provider-sdk/src/budget.test.ts
index f988bdd..3dfc5dd 100644
--- a/packages/provider-sdk/src/budget.test.ts
+++ b/packages/provider-sdk/src/budget.test.ts
@@ -97,37 +97,55 @@ describe('provider budget ledger', () => {
   });
 
   it('is idempotent for reservation and reconciliation replay', () => {
     const first = reserveProviderBudget(createProviderBudgetLedger(), {
       reservationId: 'reservation-1',
       idempotencyKey: 'reserve-1',
       providerId: 'remote',
       capability: 'speech.transcribe',
       estimatedCost: { amount: '1.00', currency: 'USD' },
       cap: { amount: '2.00', currency: 'USD' },
+      providerDecisionId: 'decision-1',
+      productionRunId: 'run-1',
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
+      providerDecisionId: 'decision-1',
+      productionRunId: 'run-1',
     });
     expect(reservationReplay.ok).toBe(true);
     if (!reservationReplay.ok) expect.unreachable('reservation replay should succeed');
     expect(reservationReplay.replay).toBe(true);
     expect(reservationReplay.ledger).toBe(first.ledger);
 
+    const reservationConflict = reserveProviderBudget(first.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'reserve-1',
+      providerId: 'remote',
+      capability: 'image.generate',
+      estimatedCost: { amount: '1.00', currency: 'USD' },
+      cap: { amount: '1.50', currency: 'USD' },
+      providerDecisionId: 'decision-2',
+      productionRunId: 'run-2',
+    });
+    expect(reservationConflict.ok).toBe(false);
+    if (reservationConflict.ok) expect.unreachable('changed replay inputs should conflict');
+    expect(reservationConflict.reason).toBe('idempotency-conflict');
+
     const usage = reconcileProviderBudget(first.ledger, {
       reservationId: 'reservation-1',
       idempotencyKey: 'usage-1',
       kind: 'partial',
       actualCost: { amount: '0.20', currency: 'USD' },
       providerUsageId: 'usage-1',
     });
     expect(usage.ok).toBe(true);
     if (!usage.ok) expect.unreachable('usage reconciliation should succeed');
 
@@ -135,12 +153,23 @@ describe('provider budget ledger', () => {
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
+
+    const usageConflict = reconcileProviderBudget(usage.ledger, {
+      reservationId: 'reservation-1',
+      idempotencyKey: 'usage-1',
+      kind: 'partial',
+      actualCost: { amount: '0.20', currency: 'USD' },
+      providerUsageId: 'usage-2',
+    });
+    expect(usageConflict.ok).toBe(false);
+    if (usageConflict.ok) expect.unreachable('changed usage replay inputs should conflict');
+    expect(usageConflict.reason).toBe('idempotency-conflict');
   });
 });
diff --git a/packages/provider-sdk/src/budget.ts b/packages/provider-sdk/src/budget.ts
index 75315ff..98ae6b8 100644
--- a/packages/provider-sdk/src/budget.ts
+++ b/packages/provider-sdk/src/budget.ts
@@ -93,26 +93,21 @@ export function createProviderBudgetLedger(): ProviderBudgetLedgerV1 {
 }
 
 export function reserveProviderBudget(
   ledger: ProviderBudgetLedgerV1,
   input: ReserveProviderBudgetInput,
 ): ReserveProviderBudgetResult {
   const replay = ledger.reservations.find(
     (reservation) => reservation.idempotencyKey === input.idempotencyKey,
   );
   if (replay !== undefined) {
-    if (
-      replay.reservationId !== input.reservationId ||
-      replay.providerId !== input.providerId ||
-      replay.reserved.amount !== input.estimatedCost.amount ||
-      replay.reserved.currency !== input.estimatedCost.currency
-    ) {
+    if (!sameReservationReplay(replay, input)) {
       return { ok: false, ledger, reason: 'idempotency-conflict' };
     }
     return { ok: true, ledger, reservation: replay, replay: true };
   }
 
   if (input.estimatedCost.currency !== input.cap.currency) {
     return { ok: false, ledger, reason: 'currency-mismatch' };
   }
   if (compareMoney(input.estimatedCost, input.cap) > 0) {
     return { ok: false, ledger, reason: 'cap-exceeded' };
@@ -151,27 +146,21 @@ export function reconcileProviderBudget(
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
-    if (
-      replay.reservationId !== input.reservationId ||
-      replay.kind !== input.kind ||
-      replay.actualCost.amount !== input.actualCost.amount ||
-      replay.actualCost.currency !== input.actualCost.currency ||
-      reservation === undefined
-    ) {
+    if (reservation === undefined || !sameReconciliationReplay(replay, input)) {
       return { ok: false, ledger, reason: 'idempotency-conflict' };
     }
     return { ok: true, ledger, reservation, reconciliation: replay, replay: true };
   }
 
   const reservation = ledger.reservations.find(
     (candidate) => candidate.reservationId === input.reservationId,
   );
   if (reservation === undefined) {
     return { ok: false, ledger, reason: 'reservation-not-found' };
@@ -217,20 +206,51 @@ export function reconcileProviderBudget(
     reservation: nextReservation,
     reconciliation,
     replay: false,
   };
 }
 
 function zeroMoney(currency: string): Money {
   return currency === 'USD' ? ZERO_USD : { amount: '0.00', currency };
 }
 
+function sameReservationReplay(
+  reservation: ProviderBudgetReservationV1,
+  input: ReserveProviderBudgetInput,
+): boolean {
+  return (
+    reservation.reservationId === input.reservationId &&
+    reservation.providerId === input.providerId &&
+    reservation.capability === input.capability &&
+    sameMoney(reservation.reserved, input.estimatedCost) &&
+    sameMoney(reservation.cap, input.cap) &&
+    reservation.providerDecisionId === input.providerDecisionId &&
+    reservation.productionRunId === input.productionRunId
+  );
+}
+
+function sameReconciliationReplay(
+  reconciliation: ProviderBudgetReconciliationV1,
+  input: ReconcileProviderBudgetInput,
+): boolean {
+  return (
+    reconciliation.reservationId === input.reservationId &&
+    reconciliation.kind === input.kind &&
+    sameMoney(reconciliation.actualCost, input.actualCost) &&
+    reconciliation.providerUsageId === input.providerUsageId
+  );
+}
+
+function sameMoney(left: Money, right: Money): boolean {
+  return left.amount === right.amount && left.currency === right.currency;
+}
+
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
diff --git a/packages/provider-sdk/src/decision.test.ts b/packages/provider-sdk/src/decision.test.ts
index 01fff05..84141bc 100644
--- a/packages/provider-sdk/src/decision.test.ts
+++ b/packages/provider-sdk/src/decision.test.ts
@@ -117,31 +117,65 @@ describe('decideProvider', () => {
     const decision = decideProvider(request(), [remote, local], policy());
 
     expect(decision.status).toBe('selected');
     expect(decision.selectedProviderId).toBe('local');
     expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
       'local',
       'remote',
     ]);
   });
 
+  it('preserves rejected hard-gate audit entries on selected decisions', () => {
+    const local = pricedProvider('local', { execution: 'worker-local', dataLeavesDevice: false });
+    const imageOnly = createMockProvider('image-only', ['image.generate']);
+    const remote = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
+
+    const decision = decideProvider(
+      request({ constraints: { requiredPrivacy: 'local-only' } }),
+      [remote, imageOnly, local],
+      policy(),
+    );
+
+    expect(decision.status).toBe('selected');
+    expect(decision.selectedProviderId).toBe('local');
+    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
+      'local',
+      'remote',
+      'image-only',
+    ]);
+    expect(decision.candidates).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({ providerId: 'remote', rejectedBy: 'privacy' }),
+        expect.objectContaining({ providerId: 'image-only', rejectedBy: 'capability' }),
+      ]),
+    );
+  });
+
   it('requires manual choice for an exact top-score tie when configured', () => {
     const first = pricedProvider('first');
     const second = pricedProvider('second');
+    const imageOnly = createMockProvider('image-only', ['image.generate']);
 
-    const decision = decideProvider(request(), [first, second], policy(), {
+    const decision = decideProvider(request(), [first, imageOnly, second], policy(), {
       requireManualChoiceOnTie: true,
     });
 
     expect(decision.status).toBe('manual-choice-required');
     expect(decision.selectedProviderId).toBeUndefined();
     expect(decision.reason).toContain('tie');
+    expect(decision.candidates).toEqual(
+      expect.arrayContaining([
+        expect.objectContaining({ providerId: 'first', status: 'eligible' }),
+        expect.objectContaining({ providerId: 'second', status: 'eligible' }),
+        expect.objectContaining({ providerId: 'image-only', rejectedBy: 'capability' }),
+      ]),
+    );
   });
 
   it('reports unavailable and denied outcomes', () => {
     const provider = pricedProvider('remote', { execution: 'remote-api', dataLeavesDevice: true });
 
     expect(
       decideProvider(request(), [provider], policy(), {
         unavailableProviderIds: ['remote'],
       }).status,
     ).toBe('unavailable');
diff --git a/packages/provider-sdk/src/decision.ts b/packages/provider-sdk/src/decision.ts
index 2d43af5..28a951e 100644
--- a/packages/provider-sdk/src/decision.ts
+++ b/packages/provider-sdk/src/decision.ts
@@ -81,35 +81,39 @@ export function decideProvider(
         status === 'unavailable'
           ? `No available providers can satisfy '${request.capability}'`
           : `Provider policy denied '${request.capability}'`,
     };
   }
 
   const top = eligible[0]!;
   const tied = eligible.filter(
     (candidate) => candidate.scoreBreakdown?.total === top.scoreBreakdown?.total,
   );
+  const rankedCandidates = [
+    ...eligible,
+    ...candidates.filter((candidate) => candidate.status === 'rejected'),
+  ];
 
   if (options.requireManualChoiceOnTie === true && tied.length > 1) {
     return {
       ...base,
-      candidates: eligible,
+      candidates: rankedCandidates,
       status: 'manual-choice-required',
       reason: `Top provider tie requires manual choice: ${tied
         .map((candidate) => candidate.providerId)
         .join(', ')}`,
     };
   }
 
   return {
     ...base,
-    candidates: eligible,
+    candidates: rankedCandidates,
     status: 'selected',
     selectedProviderId: top.providerId,
     reason: `Selected '${top.providerId}' for '${request.capability}'`,
   };
 }
 
 function decideCandidate(
   provider: AnyProvider,
   request: CapabilityRequest,
   policy: ProviderPolicy,
