# Review package: 1971a90..c561e4e

## Commits
c561e4e fix(worker): reject unsupported AI video derivatives

## Files changed
 apps/worker/src/local-ai.test.ts |  6 ++++++
 apps/worker/src/local-ai.ts      |  3 +++
 apps/worker/src/runtime.test.ts  | 24 ++++++++++++++++++++++++
 apps/worker/src/runtime.ts       | 21 ++++++++++++++++++++-
 4 files changed, 53 insertions(+), 1 deletion(-)

## Diff
diff --git a/apps/worker/src/local-ai.test.ts b/apps/worker/src/local-ai.test.ts
index 7eb2be6..ad4ccd6 100644
--- a/apps/worker/src/local-ai.test.ts
+++ b/apps/worker/src/local-ai.test.ts
@@ -8,20 +8,26 @@ const ONE_BY_ONE_PNG = Uint8Array.from(
   ),
 );
 
 describe('local AI media descriptors', () => {
   it('normalizes video outputs to protocol-compatible descriptors', () => {
     expect(descriptorForLocalAiOutput('video', 'video/mp4', new Uint8Array([0, 1, 2]))).toEqual({
       mimeType: 'video/mp4',
     });
   });
 
+  it('fails closed on unsupported video formats', () => {
+    expect(() =>
+      descriptorForLocalAiOutput('video', 'video/webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])),
+    ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
+  });
+
   it('extracts PNG dimensions for image outputs', () => {
     expect(descriptorForLocalAiOutput('image', 'image/png', ONE_BY_ONE_PNG)).toEqual({
       mimeType: 'image/png',
       width: 1,
       height: 1,
     });
   });
 
   it('fails closed on unsupported image formats', () => {
     expect(() =>
diff --git a/apps/worker/src/local-ai.ts b/apps/worker/src/local-ai.ts
index c62f6b4..817ed94 100644
--- a/apps/worker/src/local-ai.ts
+++ b/apps/worker/src/local-ai.ts
@@ -107,20 +107,23 @@ function pngDimensions(
 
 export function descriptorForLocalAiOutput(
   kind: 'image' | 'video',
   mimeType: string,
   bytes: Uint8Array,
 ): NonNullable<LocalAiReceipt['descriptor']> {
   if (kind === 'video') {
     if (!mimeType.startsWith('video/')) {
       aiOutputUnavailable(`expected video output, received ${mimeType}`);
     }
+    if (mimeType !== 'video/mp4') {
+      aiOutputUnavailable(`unsupported video output ${mimeType}`);
+    }
     return { mimeType };
   }
   if (!mimeType.startsWith('image/')) {
     aiOutputUnavailable(`expected image output, received ${mimeType}`);
   }
   if (mimeType === 'image/png') {
     const dimensions = pngDimensions(bytes);
     if (dimensions === undefined) {
       aiOutputUnavailable('PNG output dimensions are unavailable');
     }
diff --git a/apps/worker/src/runtime.test.ts b/apps/worker/src/runtime.test.ts
index 9b4ed84..2adab88 100644
--- a/apps/worker/src/runtime.test.ts
+++ b/apps/worker/src/runtime.test.ts
@@ -293,11 +293,35 @@ describe('Worker runtime', () => {
           jobId: 'job-edit-video',
           provider: 'higgsfield',
           sha256: 'c'.repeat(64),
           bytes: 2048,
           localRef: 'ai-job-edit-video-cccccccccccccccc',
           descriptor: { mimeType: 'video/mp4' },
         },
       ),
     ).toThrow(/AI_OUTPUT_UNAVAILABLE/);
   });
+
+  it('fails closed on unsupported retained AI derivative mime types', () => {
+    const runtime = new WorkerRuntime(
+      { workerId: 'worker-ai', createdAt: '2026-08-21T00:00:00.000Z' },
+      {
+        ffmpeg: true,
+        ffprobe: true,
+        comfy: false,
+        mlDenoise: false,
+        aiProviders: ['runway', 'higgsfield'],
+      },
+    );
+
+    expect(() =>
+      runtime.readDerivative({
+        kind: 'video.runway',
+        assetId: 'ai-job-video',
+        sha256: 'd'.repeat(64),
+        bytes: 1024,
+        localRef: 'ai-job-video-dddddddddddddddd',
+        descriptor: { mimeType: 'video/webm' },
+      }),
+    ).toThrow(/unsupported retained AI derivative mime type/i);
+  });
 });
diff --git a/apps/worker/src/runtime.ts b/apps/worker/src/runtime.ts
index 3c4c104..3737782 100644
--- a/apps/worker/src/runtime.ts
+++ b/apps/worker/src/runtime.ts
@@ -489,21 +489,21 @@ export class WorkerRuntime {
   readDerivative(result: WorkerDerivativeReceipt): Uint8Array {
     if (result.kind === 'image.comfy' || result.kind === 'audio.ml-denoise') {
       const directory =
         this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
       return readGpuDerivative(directory, result);
     }
     if (result.kind === 'text.lm-studio' || result.kind === 'text.openrouter') {
       throw new Error('AI text receipts do not retain derivative bytes');
     }
     if (result.kind === 'video.runway' || result.kind === 'edit.higgsfield') {
-      const ext = result.descriptor.mimeType === 'video/mp4' ? 'mp4' : 'png';
+      const ext = retainedAiDerivativeExtension(result);
       const directory =
         this.options.derivativeDirectory ?? join(homedir(), '.joy-media', 'derivatives');
       const bytes = readFileSync(join(directory, `${result.localRef}.${ext}`));
       if (
         bytes.length !== result.bytes ||
         createHash('sha256').update(bytes).digest('hex') !== result.sha256
       )
         throw new Error('retained AI derivative integrity check failed');
       return bytes;
     }
@@ -515,20 +515,39 @@ export class WorkerRuntime {
     const bytes = readFileSync(join(directory, `${result.localRef}.jpg`));
     if (
       bytes.length !== result.bytes ||
       createHash('sha256').update(bytes).digest('hex') !== result.sha256
     )
       throw new Error('retained derivative integrity check failed');
     return bytes;
   }
 }
 
+function retainedAiDerivativeExtension(
+  result: Extract<WorkerDerivativeReceipt, { readonly kind: 'video.runway' | 'edit.higgsfield' }>,
+): 'mp4' | 'png' {
+  if (result.kind === 'video.runway') {
+    if (result.descriptor.mimeType !== 'video/mp4') {
+      throw new Error(
+        `unsupported retained AI derivative mime type for ${result.kind}: ${result.descriptor.mimeType}`,
+      );
+    }
+    return 'mp4';
+  }
+  if (result.descriptor.mimeType !== 'image/png') {
+    throw new Error(
+      `unsupported retained AI derivative mime type for ${result.kind}: ${result.descriptor.mimeType}`,
+    );
+  }
+  return 'png';
+}
+
 export type WorkerDerivativeReceipt =
   RealThumbnailReceipt | LocalGpuReceipt | ProtocolAiReceipt | RenderExportReceiptV1;
 
 export type ProtocolAiReceipt =
   | {
       readonly kind: 'text.lm-studio' | 'text.openrouter';
       readonly resultRef: string;
       readonly sha256: string;
       readonly bytes: number;
       readonly model?: string;
