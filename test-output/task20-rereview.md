# Review package: de3cb2f..1971a90

## Commits
1971a90 fix(protocol): fail closed on worker completions
03d94f5 fix(providers): preserve decision audits and strict budget replay

## Files changed
 apps/api/src/http-server.test.ts                   | 109 +++++++++++-
 apps/api/src/http-server.ts                        |   7 +-
 apps/worker/src/local-ai.test.ts                   |  31 ++++
 apps/worker/src/local-ai.ts                        | 191 +++++++++++++++++----
 packages/adapter-tts/src/index.ts                  |   6 +-
 packages/adapter-tts/src/production-mode.test.ts   |   6 +-
 packages/adapter-voice-isolation/src/index.test.ts |  10 +-
 packages/adapter-voice-isolation/src/index.ts      |   6 +-
 packages/job-protocol/src/protocol.test.ts         |   3 +
 packages/job-protocol/src/protocol.ts              |   6 +-
 packages/provider-sdk/src/budget.test.ts           |  29 ++++
 packages/provider-sdk/src/budget.ts                |  46 +++--
 packages/provider-sdk/src/decision.test.ts         |  36 +++-
 packages/provider-sdk/src/decision.ts              |   8 +-
 14 files changed, 420 insertions(+), 74 deletions(-)

## Diff
diff --git a/apps/api/src/http-server.test.ts b/apps/api/src/http-server.test.ts
index 82e4fb9..a782574 100644
--- a/apps/api/src/http-server.test.ts
+++ b/apps/api/src/http-server.test.ts
@@ -808,21 +808,21 @@ describe('control-plane HTTP transport', () => {
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
-      { capabilities: variants.map((variant) => variant.type) },
+      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
       workerToken,
     );
 
     for (const [index, variant] of variants.entries()) {
       const job = {
         id: `ai-job-${index + 1}`,
         type: variant.type,
         ...(variant.assetId === undefined ? {} : { assetId: variant.assetId }),
         payload: {
           prompt: `Generate variant ${index + 1}`,
@@ -858,20 +858,127 @@ describe('control-plane HTTP transport', () => {
           data: {
             id: job.id,
             state: 'completed',
             derivative: { kind: variant.type },
           },
         },
       });
     }
   });
 
+  it('rejects completion without a result for every Worker job type', async () => {
+    const origin = await start({ authenticate: () => ({ id: 'owner' }) });
+    await request(origin, 'POST', '/v1/projects', { id: 'p', title: 'Project' });
+    await request(origin, 'POST', '/v1/projects/p/assets', {
+      id: 'asset-source-1',
+      kind: 'image',
+      displayName: 'source.png',
+      sha256: '2'.repeat(64),
+      bytes: 2048,
+      descriptor: { mimeType: 'image/png', width: 1024, height: 1024 },
+      locations: [{ kind: 'opfs-cache', ref: 'source-image-1' }],
+    });
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
+    const variants: ReadonlyArray<{
+      readonly id: string;
+      readonly type: WorkerJobType;
+      readonly job: Record<string, unknown>;
+    }> = [
+      {
+        id: 'job-thumb',
+        type: 'asset.thumbnail',
+        job: { id: 'job-thumb', type: 'asset.thumbnail', assetId: 'asset-source-1' },
+      },
+      {
+        id: 'job-comfy',
+        type: 'image.comfy',
+        job: { id: 'job-comfy', type: 'image.comfy', assetId: 'asset-source-1' },
+      },
+      {
+        id: 'job-denoise',
+        type: 'audio.ml-denoise',
+        job: { id: 'job-denoise', type: 'audio.ml-denoise', assetId: 'asset-source-1' },
+      },
+      { id: 'job-export', type: 'render.export', job: { id: 'job-export', type: 'render.export' } },
+      {
+        id: 'job-inspect',
+        type: 'render.inspect',
+        job: { id: 'job-inspect', type: 'render.inspect' },
+      },
+      {
+        id: 'job-text-local',
+        type: 'text.lm-studio',
+        job: { id: 'job-text-local', type: 'text.lm-studio' },
+      },
+      {
+        id: 'job-text-remote',
+        type: 'text.openrouter',
+        job: { id: 'job-text-remote', type: 'text.openrouter' },
+      },
+      {
+        id: 'job-video',
+        type: 'video.runway',
+        job: { id: 'job-video', type: 'video.runway' },
+      },
+      {
+        id: 'job-edit',
+        type: 'edit.higgsfield',
+        job: { id: 'job-edit', type: 'edit.higgsfield' },
+      },
+    ];
+    await request(
+      origin,
+      'POST',
+      '/v1/workers/w/hello',
+      { capabilities: variants.map((variant) => variant.type), assetIds: ['asset-source-1'] },
+      workerToken,
+    );
+
+    for (const variant of variants) {
+      expect(await request(origin, 'POST', '/v1/projects/p/jobs', variant.job)).toMatchObject({
+        status: 201,
+        body: { data: { id: variant.id, type: variant.type } },
+      });
+      expect(await request(origin, 'POST', '/v1/workers/w/leases', {}, workerToken)).toMatchObject({
+        status: 200,
+        body: { data: { id: variant.id, type: variant.type } },
+      });
+      expect(
+        await request(origin, 'POST', `/v1/workers/w/jobs/${variant.id}/complete`, {}, workerToken),
+      ).toMatchObject({
+        status: 400,
+        body: { error: { code: 'REQUEST_INVALID' } },
+      });
+      expect(
+        await request(
+          origin,
+          'POST',
+          `/v1/workers/w/jobs/${variant.id}/fail`,
+          { error: 'canceled' },
+          workerToken,
+        ),
+      ).toMatchObject({
+        status: 200,
+        body: { data: { state: 'canceled' } },
+      });
+    }
+  });
+
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
diff --git a/apps/api/src/http-server.ts b/apps/api/src/http-server.ts
index c5ff8a6..941d46f 100644
--- a/apps/api/src/http-server.ts
+++ b/apps/api/src/http-server.ts
@@ -233,21 +233,21 @@ async function route(
         await store.remove(ref).catch(() => undefined);
         throw error;
       }
       return;
     }
     respondJson(response, 200, {
       data: await options.controlPlane.complete(
         decodeURIComponent(workerId),
         decodeURIComponent(workerCompleteMatch![2]!),
         undefined,
-        optionalWorkerResult(await readJson(request)),
+        requiredWorkerResult(await readJson(request)),
       ),
     });
     return;
   }
 
   if (request.method === 'POST' && url.pathname === '/v1/auth/request-otp') {
     const body = await readJson(request);
     const data = await options.mediaAuth.requestOtp(
       requiredString(body, 'contact'),
       requiredAuthMethod(body),
@@ -1052,23 +1052,24 @@ function workerJobEnvelope(
     protocolVersion: WORKER_PROTOCOL_VERSION,
     jobId: requiredString(body, 'id'),
     type: requiredString(body, 'type') as WorkerJobV1['type'],
     payload: requiredObject(body, 'payload') as WorkerJobV1['payload'],
     requirements: requiredObject(body, 'requirements') as WorkerJobV1['requirements'],
     idempotencyKey: requiredString(body, 'idempotencyKey'),
     maxAttempts: requiredPositiveInteger(body, 'maxAttempts'),
   } as WorkerJobV1;
 }
 
-function optionalWorkerResult(body: Record<string, unknown>): WorkerResultReceiptV1 | undefined {
+function requiredWorkerResult(body: Record<string, unknown>): WorkerResultReceiptV1 {
   const value = body.result;
-  if (value === undefined) return undefined;
+  if (value === undefined)
+    throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is required');
   if (value === null || typeof value !== 'object' || Array.isArray(value))
     throw new ControlPlaneError('REQUEST_INVALID', 'result must be an object');
   const result = value as Record<string, unknown>;
   if (
     result.kind === 'fixture.thumbnail' &&
     hasOnlyKeys(result, ['kind', 'sha256', 'bytes']) &&
     isReceiptHashAndBytes(result)
   ) {
     return { kind: result.kind, sha256: result.sha256, bytes: result.bytes };
   }
diff --git a/apps/worker/src/local-ai.test.ts b/apps/worker/src/local-ai.test.ts
new file mode 100644
index 0000000..7eb2be6
--- /dev/null
+++ b/apps/worker/src/local-ai.test.ts
@@ -0,0 +1,31 @@
+import { describe, expect, it } from 'vitest';
+import { descriptorForLocalAiOutput } from './local-ai.js';
+
+const ONE_BY_ONE_PNG = Uint8Array.from(
+  Buffer.from(
+    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5WQAAAAASUVORK5CYII=',
+    'base64',
+  ),
+);
+
+describe('local AI media descriptors', () => {
+  it('normalizes video outputs to protocol-compatible descriptors', () => {
+    expect(descriptorForLocalAiOutput('video', 'video/mp4', new Uint8Array([0, 1, 2]))).toEqual({
+      mimeType: 'video/mp4',
+    });
+  });
+
+  it('extracts PNG dimensions for image outputs', () => {
+    expect(descriptorForLocalAiOutput('image', 'image/png', ONE_BY_ONE_PNG)).toEqual({
+      mimeType: 'image/png',
+      width: 1,
+      height: 1,
+    });
+  });
+
+  it('fails closed on unsupported image formats', () => {
+    expect(() =>
+      descriptorForLocalAiOutput('image', 'image/jpeg', new Uint8Array([0xff, 0xd8, 0xff])),
+    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
+  });
+});
diff --git a/apps/worker/src/local-ai.ts b/apps/worker/src/local-ai.ts
index 1e4f310..c62f6b4 100644
--- a/apps/worker/src/local-ai.ts
+++ b/apps/worker/src/local-ai.ts
@@ -52,169 +52,290 @@ const SECRETS_PATH = join(homedir(), '.joy-media', 'ai-providers.json');
 
 export function loadAiProviderConfigs(): Record<string, AiProviderConfig> {
   if (!existsSync(SECRETS_PATH)) return {};
   try {
     const raw = readFileSync(SECRETS_PATH, 'utf8');
     const parsed = JSON.parse(raw);
     if (typeof parsed !== 'object' || parsed === null) return {};
     const result: Record<string, AiProviderConfig> = {};
     for (const [key, val] of Object.entries(parsed)) {
       const v = val as Record<string, unknown>;
-      if (typeof v.baseUrl === 'string' && typeof v.apiKey === 'string' && typeof v.defaultModel === 'string') {
+      if (
+        typeof v.baseUrl === 'string' &&
+        typeof v.apiKey === 'string' &&
+        typeof v.defaultModel === 'string'
+      ) {
         result[key] = { baseUrl: v.baseUrl, apiKey: v.apiKey, defaultModel: v.defaultModel };
       }
     }
     return result;
   } catch {
     return {};
   }
 }
 
 export function getConfiguredProviders(): readonly AiProvider[] {
   return Object.keys(loadAiProviderConfigs()) as AiProvider[];
 }
 
-async function runLmStudio(options: LocalAiRunOptions, config: AiProviderConfig, fetchFn: typeof fetch): Promise<LocalAiReceipt> {
+function aiOutputUnavailable(message: string): never {
+  throw new Error(`AI_OUTPUT_UNAVAILABLE: ${message}`);
+}
+
+function normalizeResponseMimeType(response: Response, fallbackMimeType: string): string {
+  const header = response.headers.get('content-type');
+  if (header === null) return fallbackMimeType;
+  const mimeType = header.split(';', 1)[0]?.trim();
+  return mimeType === undefined || mimeType.length === 0 ? fallbackMimeType : mimeType;
+}
+
+function pngDimensions(
+  bytes: Uint8Array,
+): { readonly width: number; readonly height: number } | undefined {
+  if (bytes.byteLength < 24) return undefined;
+  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
+  for (const [index, value] of signature.entries()) {
+    if (bytes[index] !== value) return undefined;
+  }
+  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
+    return undefined;
+  }
+  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
+  const width = view.getUint32(16);
+  const height = view.getUint32(20);
+  return width > 0 && height > 0 ? { width, height } : undefined;
+}
+
+export function descriptorForLocalAiOutput(
+  kind: 'image' | 'video',
+  mimeType: string,
+  bytes: Uint8Array,
+): NonNullable<LocalAiReceipt['descriptor']> {
+  if (kind === 'video') {
+    if (!mimeType.startsWith('video/')) {
+      aiOutputUnavailable(`expected video output, received ${mimeType}`);
+    }
+    return { mimeType };
+  }
+  if (!mimeType.startsWith('image/')) {
+    aiOutputUnavailable(`expected image output, received ${mimeType}`);
+  }
+  if (mimeType === 'image/png') {
+    const dimensions = pngDimensions(bytes);
+    if (dimensions === undefined) {
+      aiOutputUnavailable('PNG output dimensions are unavailable');
+    }
+    return { mimeType, ...dimensions };
+  }
+  aiOutputUnavailable(`unsupported image output ${mimeType}`);
+}
+
+async function runLmStudio(
+  options: LocalAiRunOptions,
+  config: AiProviderConfig,
+  fetchFn: typeof fetch,
+): Promise<LocalAiReceipt> {
   await options.progress(10);
   const body = {
     model: options.model || config.defaultModel,
     messages: [{ role: 'user', content: options.prompt }],
     max_tokens: (options.params?.maxTokens as number) ?? 2048,
     temperature: (options.params?.temperature as number) ?? 0.7,
   };
   if (options.cancelled()) throw new Error('canceled');
   const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(body),
   });
   if (!response.ok) throw new Error(`LM Studio error: ${response.status} ${await response.text()}`);
-  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
+  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
   const text = json.choices?.[0]?.message?.content ?? '';
   await options.progress(100);
   return { kind: 'text', jobId: options.jobId, provider: 'lm-studio', text, model: body.model };
 }
 
-async function runOpenRouter(options: LocalAiRunOptions, config: AiProviderConfig, fetchFn: typeof fetch): Promise<LocalAiReceipt> {
+async function runOpenRouter(
+  options: LocalAiRunOptions,
+  config: AiProviderConfig,
+  fetchFn: typeof fetch,
+): Promise<LocalAiReceipt> {
   await options.progress(10);
   const body: Record<string, unknown> = {
     model: options.model || config.defaultModel,
     messages: [{ role: 'user', content: options.prompt }],
     max_tokens: (options.params?.maxTokens as number) ?? 4096,
     temperature: (options.params?.temperature as number) ?? 0.7,
   };
   if (options.cancelled()) throw new Error('canceled');
   const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
-      'Authorization': `Bearer ${config.apiKey}`,
+      Authorization: `Bearer ${config.apiKey}`,
       'HTTP-Referer': 'https://joyst.ir',
       'X-Title': 'JOY Media',
     },
     body: JSON.stringify(body),
   });
-  if (!response.ok) throw new Error(`OpenRouter error: ${response.status} ${await response.text()}`);
-  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
+  if (!response.ok)
+    throw new Error(`OpenRouter error: ${response.status} ${await response.text()}`);
+  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
   const text = json.choices?.[0]?.message?.content ?? '';
   await options.progress(100);
-  return { kind: 'text', jobId: options.jobId, provider: 'openrouter', text, model: String(body.model) };
+  return {
+    kind: 'text',
+    jobId: options.jobId,
+    provider: 'openrouter',
+    text,
+    model: String(body.model),
+  };
 }
 
-async function runRunway(options: LocalAiRunOptions, config: AiProviderConfig, fetchFn: typeof fetch): Promise<LocalAiReceipt> {
+async function runRunway(
+  options: LocalAiRunOptions,
+  config: AiProviderConfig,
+  fetchFn: typeof fetch,
+): Promise<LocalAiReceipt> {
   await options.progress(10);
   if (options.cancelled()) throw new Error('canceled');
   const taskBody: Record<string, unknown> = {
     model: options.model || config.defaultModel || 'gen-4',
     promptText: options.prompt,
   };
   if (options.negativePrompt) taskBody.negativePrompt = options.negativePrompt;
   if (options.params) taskBody.params = options.params;
   const createResponse = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/tasks`, {
     method: 'POST',
-    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
+    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
     body: JSON.stringify(taskBody),
   });
   if (!createResponse.ok) throw new Error(`Runway task creation failed: ${createResponse.status}`);
-  const createJson = await createResponse.json() as { id?: string };
+  const createJson = (await createResponse.json()) as { id?: string };
   const taskId = createJson.id;
   if (!taskId) throw new Error('Runway task ID missing');
   await options.progress(30);
   for (let attempt = 0; attempt < 120; attempt++) {
     if (options.cancelled()) throw new Error('canceled');
     const statusResponse = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/tasks/${taskId}`, {
-      headers: { 'Authorization': `Bearer ${config.apiKey}` },
+      headers: { Authorization: `Bearer ${config.apiKey}` },
     });
     if (!statusResponse.ok) throw new Error(`Runway status check failed: ${statusResponse.status}`);
-    const statusJson = await statusResponse.json() as { status?: string; output?: unknown };
+    const statusJson = (await statusResponse.json()) as { status?: string; output?: unknown };
     if (statusJson.status === 'succeeded' && statusJson.output) {
-      const videoUrl = typeof statusJson.output === 'string' ? statusJson.output :
-        String((statusJson.output as Record<string, unknown>)?.url ?? '');
+      const videoUrl =
+        typeof statusJson.output === 'string'
+          ? statusJson.output
+          : String((statusJson.output as Record<string, unknown>)?.url ?? '');
       if (!videoUrl) throw new Error('Runway succeeded but no output URL');
       await options.progress(70);
       const videoResponse = await fetchFn(videoUrl);
+      if (!videoResponse.ok) throw new Error(`Runway output fetch failed: ${videoResponse.status}`);
       const arrayBuffer = await videoResponse.arrayBuffer();
       const bytes = Buffer.from(arrayBuffer);
       const sha256 = createHash('sha256').update(bytes).digest('hex');
       const localRef = `ai-${options.jobId}-${sha256.slice(0, 16)}`;
+      const mimeType = normalizeResponseMimeType(videoResponse, 'video/mp4');
+      const descriptor = descriptorForLocalAiOutput('video', mimeType, bytes);
       mkdirSync(options.derivativeDirectory, { recursive: true });
       const outPath = join(options.derivativeDirectory, `${localRef}.mp4`);
       writeFileSync(outPath, Buffer.from(bytes));
       await options.progress(100);
-      return { kind: 'video', jobId: options.jobId, provider: 'runway', sha256, bytes: bytes.length, localRef, mimeType: 'video/mp4', model: options.model || 'gen-4' };
+      return {
+        kind: 'video',
+        jobId: options.jobId,
+        provider: 'runway',
+        sha256,
+        bytes: bytes.length,
+        localRef,
+        mimeType,
+        descriptor,
+        model: options.model || 'gen-4',
+      };
     }
-    if (statusJson.status === 'failed') throw new Error(`Runway task failed: ${JSON.stringify(statusJson)}`);
-    await new Promise(resolve => setTimeout(resolve, 2000));
+    if (statusJson.status === 'failed')
+      throw new Error(`Runway task failed: ${JSON.stringify(statusJson)}`);
+    await new Promise((resolve) => setTimeout(resolve, 2000));
     await options.progress(30 + attempt * 0.5);
   }
   throw new Error('Runway task timed out');
 }
 
-async function runHiggsfield(options: LocalAiRunOptions, config: AiProviderConfig, fetchFn: typeof fetch): Promise<LocalAiReceipt> {
+async function runHiggsfield(
+  options: LocalAiRunOptions,
+  config: AiProviderConfig,
+  fetchFn: typeof fetch,
+): Promise<LocalAiReceipt> {
   await options.progress(10);
   if (options.cancelled()) throw new Error('canceled');
   const body: Record<string, unknown> = {
     prompt: options.prompt,
     model: options.model || config.defaultModel || 'default',
   };
   if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
   if (options.params) Object.assign(body, options.params);
   const response = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/edit`, {
     method: 'POST',
-    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
+    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
     body: JSON.stringify(body),
   });
-  if (!response.ok) throw new Error(`Higgsfield error: ${response.status} ${await response.text()}`);
+  if (!response.ok)
+    throw new Error(`Higgsfield error: ${response.status} ${await response.text()}`);
   const text = await response.text();
-  const json = JSON.parse(text) as { output?: { image?: string; video?: string }; image?: string; video?: string };
+  const json = JSON.parse(text) as {
+    output?: { image?: string; video?: string };
+    image?: string;
+    video?: string;
+  };
   const imageUrl = json.output?.image || json.image || '';
   const videoUrl = json.output?.video || json.video || '';
-  const url = videoUrl || imageUrl;
-  const kind = videoUrl ? 'video' : 'image';
-  if (!url) throw new Error('Higgsfield returned no output');
+  if (imageUrl.length === 0 && videoUrl.length > 0) {
+    aiOutputUnavailable('edit.higgsfield returned unsupported video output');
+  }
+  if (imageUrl.length === 0) throw new Error('Higgsfield returned no output');
   await options.progress(60);
-  const mediaResponse = await fetchFn(url);
+  const mediaResponse = await fetchFn(imageUrl);
+  if (!mediaResponse.ok) throw new Error(`Higgsfield output fetch failed: ${mediaResponse.status}`);
   const mediaArrayBuffer = await mediaResponse.arrayBuffer();
   const mediaBytes = Buffer.from(mediaArrayBuffer);
   const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
   const localRef = `ai-${options.jobId}-${sha256.slice(0, 16)}`;
-  const ext = kind === 'video' ? 'mp4' : 'png';
+  const mimeType = normalizeResponseMimeType(mediaResponse, 'image/png');
+  const descriptor = descriptorForLocalAiOutput('image', mimeType, mediaBytes);
   mkdirSync(options.derivativeDirectory, { recursive: true });
-  const outPath = join(options.derivativeDirectory, `${localRef}.${ext}`);
+  const outPath = join(options.derivativeDirectory, `${localRef}.png`);
   writeFileSync(outPath, Buffer.from(mediaBytes));
   await options.progress(100);
-  return { kind, jobId: options.jobId, provider: 'higgsfield', sha256, bytes: mediaBytes.length, localRef, mimeType: kind === 'video' ? 'video/mp4' : 'image/png', model: options.model || 'default' };
+  return {
+    kind: 'image',
+    jobId: options.jobId,
+    provider: 'higgsfield',
+    sha256,
+    bytes: mediaBytes.length,
+    localRef,
+    mimeType,
+    descriptor,
+    model: options.model || 'default',
+  };
 }
 
 export async function runAiJob(options: LocalAiRunOptions): Promise<LocalAiReceipt> {
   const configs = loadAiProviderConfigs();
   const config = configs[options.provider];
-  if (!config) throw new Error(`AI provider "${options.provider}" is not configured. Create ~/.joy-media/ai-providers.json`);
+  if (!config)
+    throw new Error(
+      `AI provider "${options.provider}" is not configured. Create ~/.joy-media/ai-providers.json`,
+    );
   const fetchFn = options.fetch ?? fetch;
   switch (options.provider) {
-    case 'lm-studio': return runLmStudio(options, config, fetchFn);
-    case 'openrouter': return runOpenRouter(options, config, fetchFn);
-    case 'runway': return runRunway(options, config, fetchFn);
-    case 'higgsfield': return runHiggsfield(options, config, fetchFn);
-    default: throw new Error(`Unknown AI provider: ${options.provider}`);
+    case 'lm-studio':
+      return runLmStudio(options, config, fetchFn);
+    case 'openrouter':
+      return runOpenRouter(options, config, fetchFn);
+    case 'runway':
+      return runRunway(options, config, fetchFn);
+    case 'higgsfield':
+      return runHiggsfield(options, config, fetchFn);
+    default:
+      throw new Error(`Unknown AI provider: ${options.provider}`);
   }
 }
diff --git a/packages/adapter-tts/src/index.ts b/packages/adapter-tts/src/index.ts
index 97b22c4..4a99dd0 100644
--- a/packages/adapter-tts/src/index.ts
+++ b/packages/adapter-tts/src/index.ts
@@ -322,31 +322,31 @@ function callerDecisionId(input: unknown): string | undefined {
 
 function buildProvenance(
   manifest: ProviderManifestV2,
   modelId: string,
   input: unknown,
   startTime: number,
   requestId: string,
   request?: CapabilityRequest,
 ): GenerationProvenance {
   const idempotencyKey = request?.idempotencyKey ?? requestId;
-  const decisionId = callerDecisionId(input);
+  const providerDecisionId = callerDecisionId(input);
   return {
     providerId: manifest.id,
     modelId,
     adapterVersion: manifest.adapterVersion,
     createdAt: new Date().toISOString(),
-    requestHash: hashRequest({ input, idempotencyKey, decisionId }),
+    requestHash: hashRequest({ input, idempotencyKey, providerDecisionId }),
     idempotencyKey,
     processingTimeMs: Date.now() - startTime,
     execution: manifest.execution,
-    ...(decisionId === undefined ? {} : { decisionId }),
+    ...(providerDecisionId === undefined ? {} : { providerDecisionId }),
   };
 }
 
 function unavailableDiagnostic(message: string): Diagnostic {
   return {
     severity: 'error',
     code: 'PROVIDER_UNAVAILABLE',
     message,
   };
 }
diff --git a/packages/adapter-tts/src/production-mode.test.ts b/packages/adapter-tts/src/production-mode.test.ts
index f4ddc2c..f25384d 100644
--- a/packages/adapter-tts/src/production-mode.test.ts
+++ b/packages/adapter-tts/src/production-mode.test.ts
@@ -17,28 +17,26 @@ describe('TTS adapter production mode', () => {
     expect(result.diagnostics).toEqual(
       expect.arrayContaining([
         expect.objectContaining({
           code: 'PROVIDER_UNAVAILABLE',
           message: expect.stringContaining('TTS_UNAVAILABLE'),
         }),
       ]),
     );
   });
 
-  it('carries caller idempotency and decision ids through failed provenance', async () => {
+  it('carries caller idempotency and provider decision ids through failed provenance', async () => {
     const adapter = createTTSAdapter({ execution: 'worker-local', engine: 'kokoro' });
     const input = { text: 'Hello world', decisionId: 'decision-tts-1' };
 
     const result = await adapter.invoke('speech.synthesize', input, {
       requestVersion: 1,
       capability: 'speech.synthesize',
       input,
       constraints: {},
       idempotencyKey: 'idem-tts-1',
     });
 
     expect(result.provenance.idempotencyKey).toBe('idem-tts-1');
-    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
-      'decision-tts-1',
-    );
+    expect(result.provenance.providerDecisionId).toBe('decision-tts-1');
   });
 });
diff --git a/packages/adapter-voice-isolation/src/index.test.ts b/packages/adapter-voice-isolation/src/index.test.ts
index 7c0c38c..f887ac0 100644
--- a/packages/adapter-voice-isolation/src/index.test.ts
+++ b/packages/adapter-voice-isolation/src/index.test.ts
@@ -181,40 +181,38 @@ describe('VoiceIsolation adapter provenance', () => {
   });
 
   it('generates unique asset IDs', async () => {
     const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const result1 = await adapter.invoke('audio.separate', { assetId: 'audio-1' });
     const result2 = await adapter.invoke('audio.separate', { assetId: 'audio-2' });
 
     expect(result1.outputs[0]!.assetId).not.toBe(result2.outputs[0]!.assetId);
   });
 
-  it('carries caller idempotency and decision ids through fixture provenance', async () => {
+  it('carries caller idempotency and provider decision ids through fixture provenance', async () => {
     const adapter = createFixtureVoiceIsolationAdapter(ISOLATE_CONFIG);
     const input = {
       assetId: 'audio-123',
       data: new Uint8Array([1, 2, 3]),
       decisionId: 'decision-voice-1',
     };
 
     const result = await adapter.invoke('audio.separate', input, {
       requestVersion: 1,
       capability: 'audio.separate',
       input,
       constraints: {},
       idempotencyKey: 'idem-voice-1',
     });
 
     expect(result.provenance.idempotencyKey).toBe('idem-voice-1');
-    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
-      'decision-voice-1',
-    );
+    expect(result.provenance.providerDecisionId).toBe('decision-voice-1');
   });
 });
 
 describe('VoiceIsolation adapter production mode', () => {
   it('fails closed without the explicit fixture constructor', async () => {
     const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
     const input = {
       assetId: 'audio-123',
       data: new Uint8Array([1, 2, 3]),
       decisionId: 'decision-voice-prod-1',
@@ -232,23 +230,21 @@ describe('VoiceIsolation adapter production mode', () => {
     expect(result.outputs).toEqual([]);
     expect(result.diagnostics).toEqual(
       expect.arrayContaining([
         expect.objectContaining({
           code: 'PROVIDER_UNAVAILABLE',
           message: expect.stringContaining('VOICE_ISOLATION_UNAVAILABLE'),
         }),
       ]),
     );
     expect(result.provenance.idempotencyKey).toBe('idem-voice-prod-1');
-    expect((result.provenance as unknown as Record<string, unknown>).decisionId).toBe(
-      'decision-voice-prod-1',
-    );
+    expect(result.provenance.providerDecisionId).toBe('decision-voice-prod-1');
   });
 });
 
 describe('VoiceIsolation adapter privacy', () => {
   it('computes privacy preflight for local execution', () => {
     const adapter = createVoiceIsolationAdapter(ISOLATE_CONFIG);
     const request = createTestRequest('audio.separate', { assetId: 'audio-123' });
 
     const preflight = computePrivacyPreflight(request, adapter);
     expect(preflight.dataLeavesDevice).toBe(false);
diff --git a/packages/adapter-voice-isolation/src/index.ts b/packages/adapter-voice-isolation/src/index.ts
index 64bea02..0137e59 100644
--- a/packages/adapter-voice-isolation/src/index.ts
+++ b/packages/adapter-voice-isolation/src/index.ts
@@ -180,31 +180,31 @@ function callerDecisionId(input: unknown): string | undefined {
 
 function buildProvenance(
   manifest: ProviderManifestV2,
   modelId: string,
   input: unknown,
   startTime: number,
   requestId: string,
   request?: CapabilityRequest,
 ): GenerationProvenance {
   const idempotencyKey = request?.idempotencyKey ?? requestId;
-  const decisionId = callerDecisionId(input);
+  const providerDecisionId = callerDecisionId(input);
   return {
     providerId: manifest.id,
     modelId,
     adapterVersion: manifest.adapterVersion,
     createdAt: new Date().toISOString(),
-    requestHash: hashRequest({ input, idempotencyKey, decisionId }),
+    requestHash: hashRequest({ input, idempotencyKey, providerDecisionId }),
     idempotencyKey,
     processingTimeMs: Date.now() - startTime,
     execution: manifest.execution,
-    ...(decisionId === undefined ? {} : { decisionId }),
+    ...(providerDecisionId === undefined ? {} : { providerDecisionId }),
   };
 }
 
 function unavailableDiagnostic(): Diagnostic {
   return {
     severity: 'error',
     code: 'PROVIDER_UNAVAILABLE',
     message:
       'VOICE_ISOLATION_UNAVAILABLE: production voice isolation is not wired; use createFixtureVoiceIsolationAdapter only in explicit tests.',
   };
diff --git a/packages/job-protocol/src/protocol.test.ts b/packages/job-protocol/src/protocol.test.ts
index 4a5bbd2..a99edcf 100644
--- a/packages/job-protocol/src/protocol.test.ts
+++ b/packages/job-protocol/src/protocol.test.ts
@@ -209,20 +209,23 @@ describe('Worker pairing and thumbnail job spike', () => {
           reportRef: 'r'.repeat(16_385),
         },
         requirements: { capabilities: ['render.export'], privacy: 'local-only' },
         idempotencyKey: 'idem-render-1',
         maxAttempts: 1,
       }),
     ).toThrow(expect.objectContaining({ code: 'WORKER_PROTOCOL_OVERSIZE' }));
   });
 
   it('requires receipts to match the job type', () => {
+    expect(() => validateWorkerReceiptForJob('render.export', undefined)).toThrow(
+      expect.objectContaining({ code: 'WORKER_RECEIPT_INVALID' }),
+    );
     expect(() =>
       validateWorkerReceiptForJob('render.export', {
         kind: 'render.export',
         reportRef: 'report-1',
         outputRef: 'export-1',
         sha256: 'a'.repeat(64),
         bytes: 1024,
       }),
     ).not.toThrow();
     expect(() =>
diff --git a/packages/job-protocol/src/protocol.ts b/packages/job-protocol/src/protocol.ts
index 4515ef4..d96a5f1 100644
--- a/packages/job-protocol/src/protocol.ts
+++ b/packages/job-protocol/src/protocol.ts
@@ -207,22 +207,24 @@ export function validateWorkerJobV1(job: WorkerJobV1): WorkerJobV1 {
     job.type === 'render.export' && 'bundle' in job.payload ? 1_000_000 : undefined,
   );
   validateJsonBudget(job.requirements, 'requirements');
   assertJsonHasNoPaths(job.payload, 'payload');
   return job;
 }
 
 export function validateWorkerReceiptForJob(
   jobType: WorkerJobType,
   receipt: WorkerResultReceiptV1 | undefined,
-): WorkerResultReceiptV1 | undefined {
-  if (receipt === undefined) return undefined;
+): WorkerResultReceiptV1 {
+  if (receipt === undefined) {
+    throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt is required');
+  }
   validateJsonBudget(
     receipt,
     'receipt',
     jobType === 'render.export' && 'qualityReport' in receipt ? 65_536 : undefined,
   );
   assertJsonHasNoPaths(receipt, 'receipt');
   if (receipt.kind !== jobType) {
     throw new WorkerProtocolError('WORKER_RECEIPT_INVALID', 'receipt kind does not match job type');
   }
   validateWorkerReceiptShape(jobType, receipt);
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
