# Review package: 4500688..b7327e5

## Commits
b7327e5 fix(reference): cancel bounded analysis tooling

## Files changed
 apps/worker/src/reference-analysis.test.ts | 101 ++++++++++++++++
 apps/worker/src/reference-analysis.ts      | 178 ++++++++++++++++++++++++-----
 2 files changed, 250 insertions(+), 29 deletions(-)

## Diff
diff --git a/apps/worker/src/reference-analysis.test.ts b/apps/worker/src/reference-analysis.test.ts
index dfcc6e8..30ada04 100644
--- a/apps/worker/src/reference-analysis.test.ts
+++ b/apps/worker/src/reference-analysis.test.ts
@@ -1,15 +1,19 @@
+import { spawnSync } from 'node:child_process';
+import { existsSync, mkdtempSync, rmSync } from 'node:fs';
+import { tmpdir } from 'node:os';
 import { describe, expect, it } from 'vitest';
 import { join } from 'node:path';
 import {
   analyzeReferenceVideo,
   ReferenceAnalysisError,
+  runReferenceTool,
   validateReferenceAnalysisModelFindings,
 } from './reference-analysis.js';
 import type {
   ReferenceAnalysisFinding,
   VideoReferenceAnalyzeReceipt,
 } from '@joy-media/job-protocol';
 
 const SOURCE = join(
   process.cwd(),
   'apps',
@@ -143,20 +147,99 @@ describe('reference analysis', () => {
         cancelled: () => cancelled,
         progress: async (progress) => {
           if (progress >= 35) cancelled = true;
         },
       }),
     ).rejects.toMatchObject({
       code: 'REFERENCE_ANALYSIS_CANCELED',
     });
   });
 
+  it('tolerates silent videos and reports zero audio beats', async () => {
+    const directory = mkdtempSync(join(tmpdir(), 'joy-media-reference-silent-'));
+    const sourcePath = join(directory, 'silent-reference.mp4');
+    try {
+      const rendered = spawnSync(
+        'ffmpeg',
+        [
+          '-v',
+          'error',
+          '-f',
+          'lavfi',
+          '-i',
+          'color=c=black:s=320x180:d=1',
+          '-an',
+          '-c:v',
+          'libx264',
+          '-pix_fmt',
+          'yuv420p',
+          sourcePath,
+        ],
+        { shell: false, encoding: 'utf8' },
+      );
+      expect(rendered.status).toBe(0);
+      expect(existsSync(sourcePath)).toBe(true);
+
+      const receipt = await analyzeReferenceVideo({
+        jobId: 'reference-silent-1',
+        assetId: 'asset-silent',
+        sourcePath,
+        payload: {
+          assetId: 'asset-silent',
+          maxDurationUs: 5_000_000,
+          maxBytes: 2_000_000,
+          sampleCount: 2,
+          maxAudioBeats: 4,
+        },
+        cancelled: () => false,
+        progress: async () => undefined,
+      });
+
+      expect(receipt.summary.audioBeatCount).toBe(0);
+      expect(receipt.evidence.every((entry) => entry.kind !== 'audio-beat')).toBe(true);
+      expect(receipt.evidence).toEqual(
+        expect.arrayContaining([
+          expect.objectContaining({ kind: 'shot' }),
+          expect.objectContaining({ kind: 'palette' }),
+          expect.objectContaining({ kind: 'composition' }),
+          expect.objectContaining({ kind: 'text-safe-zone' }),
+          expect.objectContaining({ kind: 'transcript' }),
+        ]),
+      );
+    } finally {
+      rmSync(directory, { recursive: true, force: true });
+    }
+  });
+
+  it('kills a running subprocess when cancellation is requested', async () => {
+    let cancelled = false;
+    let childPid: number | undefined;
+    const running = runReferenceTool({
+      command: process.execPath,
+      args: ['-e', 'setInterval(() => {}, 1000)'],
+      cancelled: () => cancelled,
+      maxStdoutBytes: 1_024,
+      onSpawn: (pid) => {
+        childPid = pid;
+      },
+    });
+
+    await new Promise((resolve) => setTimeout(resolve, 60));
+    cancelled = true;
+
+    await expect(running).rejects.toMatchObject({
+      code: 'REFERENCE_ANALYSIS_CANCELED',
+    });
+    expect(childPid).toBeDefined();
+    await waitForProcessExit(childPid!);
+  });
+
   it('rejects model findings that cite missing or empty evidence', () => {
     const receipt: VideoReferenceAnalyzeReceipt = {
       kind: 'video.reference-analyze',
       assetId: 'asset-intro',
       sha256: 'a'.repeat(64),
       bytes: 1_054_138,
       descriptor: {
         mimeType: 'video/mp4',
         width: 320,
         height: 180,
@@ -236,10 +319,28 @@ describe('reference analysis', () => {
 
     expect(receipt.findings).toEqual([
       expect.objectContaining({
         id: 'finding-1',
         source: 'model',
         evidenceIds: expect.arrayContaining(['text-safe-zone-00000000']),
       }),
     ]);
   });
 });
+
+async function waitForProcessExit(pid: number): Promise<void> {
+  const deadline = Date.now() + 2_000;
+  while (Date.now() < deadline) {
+    if (!isProcessAlive(pid)) return;
+    await new Promise((resolve) => setTimeout(resolve, 20));
+  }
+  throw new Error(`process ${pid} remained alive after cancellation`);
+}
+
+function isProcessAlive(pid: number): boolean {
+  try {
+    process.kill(pid, 0);
+    return true;
+  } catch {
+    return false;
+  }
+}
diff --git a/apps/worker/src/reference-analysis.ts b/apps/worker/src/reference-analysis.ts
index a633732..a6831bf 100644
--- a/apps/worker/src/reference-analysis.ts
+++ b/apps/worker/src/reference-analysis.ts
@@ -1,14 +1,15 @@
 import { createHash } from 'node:crypto';
+import { spawn } from 'node:child_process';
 import { readFileSync, statSync } from 'node:fs';
 import { extname } from 'node:path';
-import { spawnSync } from 'node:child_process';
+import { setTimeout as sleep } from 'node:timers/promises';
 import type {
   ReferenceAnalysisEvidence,
   ReferenceAnalysisFinding,
   VideoReferenceAnalyzePayload,
   VideoReferenceAnalyzeReceipt,
 } from '@joy-media/job-protocol';
 
 const FRAME_WIDTH = 64;
 const FRAME_HEIGHT = 36;
 const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;
@@ -28,67 +29,70 @@ export class ReferenceAnalysisError extends Error {
 export async function analyzeReferenceVideo(options: {
   readonly jobId: string;
   readonly assetId: string;
   readonly sourcePath: string;
   readonly payload: VideoReferenceAnalyzePayload;
   readonly cancelled: () => boolean;
   readonly progress: (progress: number) => Promise<void>;
   readonly modelAnalyze?: (
     receipt: VideoReferenceAnalyzeReceipt,
   ) => Promise<readonly ReferenceAnalysisFinding[]>;
+  readonly runTool?: typeof runReferenceTool;
 }): Promise<VideoReferenceAnalyzeReceipt> {
+  const runTool = options.runTool ?? runReferenceTool;
   assertNotCanceled(options.cancelled);
   await options.progress(5);
 
   const sourceStats = statSync(options.sourcePath);
   if (sourceStats.size > options.payload.maxBytes) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_SOURCE_TOO_LARGE',
       `reference source is ${sourceStats.size} bytes, above ${options.payload.maxBytes}`,
     );
   }
 
-  const descriptor = probeVideo(options.sourcePath);
+  const descriptor = await probeVideo(options.sourcePath, options.cancelled, runTool);
   if (descriptor.durationUs > options.payload.maxDurationUs) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_SOURCE_TOO_LONG',
       `reference source is ${descriptor.durationUs}µs, above ${options.payload.maxDurationUs}`,
     );
   }
   await options.progress(15);
 
   assertNotCanceled(options.cancelled);
   const sourceBytes = readFileSync(options.sourcePath);
   const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
   await options.progress(25);
 
   const sampleTimesUs = buildSampleTimes(descriptor.durationUs, options.payload.sampleCount ?? 3);
-  const sampledFrames = sampleTimesUs.map((timeUs, index) => {
+  const sampledFrames: { timeUs: number; rgb: Uint8Array; index: number }[] = [];
+  for (const [index, timeUs] of sampleTimesUs.entries()) {
     assertNotCanceled(options.cancelled);
-    const rgb = sampleFrame(options.sourcePath, timeUs);
-    return { timeUs, rgb, index };
-  });
+    const rgb = await sampleFrame(options.sourcePath, timeUs, options.cancelled, runTool);
+    sampledFrames.push({ timeUs, rgb, index });
+  }
   await options.progress(45);
 
   assertNotCanceled(options.cancelled);
   const shotEvidence = buildShotEvidence(sampledFrames, descriptor.durationUs);
   const paletteEvidence = sampledFrames.map(({ timeUs, rgb }) => buildPaletteEvidence(timeUs, rgb));
   const compositionEvidence = sampledFrames.map(({ timeUs, rgb }) =>
     buildCompositionEvidence(timeUs, rgb),
   );
   const safeZoneEvidence = buildSafeZoneEvidence(sampledFrames[0]?.rgb);
   const transcriptEvidence = buildTranscriptEvidence();
   await options.progress(60);
 
   assertNotCanceled(options.cancelled);
   const audioBeatEvidence = buildAudioBeatEvidence(
-    decodeAudioPcm(options.sourcePath),
+    await decodeAudioPcm(options.sourcePath, descriptor.durationUs, options.cancelled, runTool),
     descriptor.durationUs,
     options.payload.maxAudioBeats ?? 6,
   );
   await options.progress(80);
 
   const cutRhythmEvidence = buildCutRhythmEvidence(shotEvidence);
   const evidence: ReferenceAnalysisEvidence[] = [
     ...shotEvidence,
     cutRhythmEvidence,
     ...paletteEvidence,
@@ -158,43 +162,48 @@ export function validateReferenceAnalysisModelFindings(
 
 function assertNotCanceled(cancelled: () => boolean): void {
   if (cancelled()) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_CANCELED',
       'reference analysis was canceled',
     );
   }
 }
 
-function probeVideo(sourcePath: string): VideoReferenceAnalyzeReceipt['descriptor'] {
-  const probe = spawnSync(
-    'ffprobe',
-    [
+async function probeVideo(
+  sourcePath: string,
+  cancelled: () => boolean,
+  runTool: typeof runReferenceTool,
+): Promise<VideoReferenceAnalyzeReceipt['descriptor']> {
+  const probe = await runTool({
+    command: 'ffprobe',
+    args: [
       '-v',
       'error',
       '-select_streams',
       'v:0',
       '-show_entries',
       'stream=width,height,duration:format=format_name',
       '-of',
       'json',
       sourcePath,
     ],
-    { shell: false, encoding: 'utf8' },
-  );
-  if (probe.status !== 0) {
+    cancelled,
+    maxStdoutBytes: 65_536,
+  });
+  if (probe.code !== 0) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_PROBE_FAILED',
       'ffprobe could not inspect the source video',
     );
   }
-  const parsed = JSON.parse(probe.stdout) as {
+  const parsed = JSON.parse(probe.stdout.toString('utf8')) as {
     readonly streams?: ReadonlyArray<{
       readonly width?: number;
       readonly height?: number;
       readonly duration?: string;
     }>;
     readonly format?: { readonly format_name?: string };
   };
   const stream = parsed.streams?.[0];
   if (
     stream === undefined ||
@@ -215,44 +224,50 @@ function probeVideo(sourcePath: string): VideoReferenceAnalyzeReceipt['descripto
     );
   }
   return {
     mimeType: mimeTypeFromFormat(parsed.format?.format_name, sourcePath),
     width: Number(stream.width),
     height: Number(stream.height),
     durationUs,
   };
 }
 
-function sampleFrame(sourcePath: string, timeUs: number): Uint8Array {
+async function sampleFrame(
+  sourcePath: string,
+  timeUs: number,
+  cancelled: () => boolean,
+  runTool: typeof runReferenceTool,
+): Promise<Uint8Array> {
   const seconds = (timeUs / 1_000_000).toFixed(6);
-  const ffmpeg = spawnSync(
-    'ffmpeg',
-    [
+  const ffmpeg = await runTool({
+    command: 'ffmpeg',
+    args: [
       '-v',
       'error',
       '-ss',
       seconds,
       '-i',
       sourcePath,
       '-frames:v',
       '1',
       '-vf',
       `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
       '-f',
       'rawvideo',
       '-pix_fmt',
       'rgb24',
       '-',
     ],
-    { shell: false, encoding: 'buffer', maxBuffer: FRAME_BYTES * 4 },
-  );
-  if (ffmpeg.status !== 0 || ffmpeg.stdout.length < FRAME_BYTES) {
+    cancelled,
+    maxStdoutBytes: FRAME_BYTES * 4,
+  });
+  if (ffmpeg.code !== 0 || ffmpeg.stdout.length < FRAME_BYTES) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_FRAME_FAILED',
       `ffmpeg could not sample the frame at ${seconds}s`,
     );
   }
   return new Uint8Array(ffmpeg.stdout.subarray(0, FRAME_BYTES));
 }
 
 function buildSampleTimes(durationUs: number, requestedSamples: number): readonly number[] {
   const sampleCount = Math.max(1, Math.min(6, requestedSamples));
@@ -434,48 +449,153 @@ function buildTranscriptEvidence(): Extract<
   return {
     id: 'transcript-00000000',
     kind: 'transcript',
     label: 'Transcript',
     summary:
       'Deterministic analysis does not infer speech text; no transcript segments were produced.',
     segments: [],
   };
 }
 
-function decodeAudioPcm(sourcePath: string): Int16Array {
-  const ffmpeg = spawnSync(
-    'ffmpeg',
-    [
+async function decodeAudioPcm(
+  sourcePath: string,
+  durationUs: number,
+  cancelled: () => boolean,
+  runTool: typeof runReferenceTool,
+): Promise<Int16Array> {
+  const ffmpeg = await runTool({
+    command: 'ffmpeg',
+    args: [
       '-v',
       'error',
       '-i',
       sourcePath,
+      '-map',
+      '0:a:0?',
       '-ac',
       '1',
       '-ar',
       String(AUDIO_SAMPLE_RATE),
       '-f',
       's16le',
       '-',
     ],
-    { shell: false, encoding: 'buffer', maxBuffer: 8_000_000 },
-  );
-  if (ffmpeg.status !== 0 || ffmpeg.stdout.length === 0) {
+    cancelled,
+    maxStdoutBytes: maxAudioOutputBytes(durationUs),
+  });
+  const stderr = ffmpeg.stderr.toString('utf8');
+  if (ffmpeg.stdout.length === 0 && (ffmpeg.code === 0 || isNoAudioMessage(stderr))) {
+    return new Int16Array();
+  }
+  if (ffmpeg.code !== 0 || ffmpeg.stdout.length === 0) {
     throw new ReferenceAnalysisError(
       'REFERENCE_ANALYSIS_AUDIO_FAILED',
       'ffmpeg could not decode the audio track',
     );
   }
   const buffer = ffmpeg.stdout;
   return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
 }
 
+export async function runReferenceTool(options: {
+  readonly command: string;
+  readonly args: readonly string[];
+  readonly cancelled: () => boolean;
+  readonly maxStdoutBytes: number;
+  readonly maxStderrBytes?: number;
+  readonly onSpawn?: (pid: number) => void;
+}): Promise<{
+  readonly code: number | null;
+  readonly stdout: Buffer;
+  readonly stderr: Buffer;
+}> {
+  assertNotCanceled(options.cancelled);
+  const child = spawn(options.command, options.args, {
+    shell: false,
+    stdio: ['ignore', 'pipe', 'pipe'],
+  });
+  if (typeof child.pid === 'number') options.onSpawn?.(child.pid);
+
+  let stdoutBytes = 0;
+  let stderrBytes = 0;
+  let stdoutOverflow = false;
+  let stderrOverflow = false;
+  const stdoutChunks: Buffer[] = [];
+  const stderrChunks: Buffer[] = [];
+  const maxStderrBytes = options.maxStderrBytes ?? 65_536;
+
+  child.stdout?.on('data', (chunk: Buffer | string) => {
+    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
+    stdoutBytes += buffer.length;
+    if (stdoutBytes > options.maxStdoutBytes) {
+      stdoutOverflow = true;
+      child.kill();
+      return;
+    }
+    stdoutChunks.push(buffer);
+  });
+  child.stderr?.on('data', (chunk: Buffer | string) => {
+    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
+    stderrBytes += buffer.length;
+    if (stderrBytes > maxStderrBytes) {
+      stderrOverflow = true;
+      child.kill();
+      return;
+    }
+    stderrChunks.push(buffer);
+  });
+
+  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
+    (resolve, reject) => {
+      child.once('error', reject);
+      child.once('close', (code, signal) => resolve({ code, signal }));
+    },
+  );
+
+  while (child.exitCode === null && child.signalCode === null) {
+    if (options.cancelled()) {
+      child.kill();
+      await completed.catch(() => undefined);
+      assertNotCanceled(options.cancelled);
+    }
+    await sleep(20);
+  }
+  const result = await completed;
+  if (stdoutOverflow) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_TOOL_OUTPUT_TOO_LARGE',
+      `${options.command} stdout exceeded ${options.maxStdoutBytes} bytes`,
+    );
+  }
+  if (stderrOverflow) {
+    throw new ReferenceAnalysisError(
+      'REFERENCE_ANALYSIS_TOOL_OUTPUT_TOO_LARGE',
+      `${options.command} stderr exceeded ${maxStderrBytes} bytes`,
+    );
+  }
+  assertNotCanceled(options.cancelled);
+  return {
+    code: result.code,
+    stdout: Buffer.concat(stdoutChunks),
+    stderr: Buffer.concat(stderrChunks),
+  };
+}
+
+function maxAudioOutputBytes(durationUs: number): number {
+  const expected = Math.ceil((durationUs / 1_000_000) * AUDIO_SAMPLE_RATE * 2);
+  return Math.min(32 * 1_024 * 1_024, Math.max(65_536, expected + 4_096));
+}
+
+function isNoAudioMessage(message: string): boolean {
+  return /does not contain any stream|matches no streams|stream map .* no streams/i.test(message);
+}
+
 function buildAudioBeatEvidence(
   pcm: Int16Array,
   durationUs: number,
   maxAudioBeats: number,
 ): readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'audio-beat' }>[] {
   if (pcm.length === 0 || maxAudioBeats === 0) return [];
   const samplesPerWindow = Math.max(
     1,
     Math.round((AUDIO_SAMPLE_RATE * AUDIO_WINDOW_US) / 1_000_000),
   );
