# Review package: b7327e5..abf18e3

## Commits
abf18e3 fix(reference): ignore silent audio beats

## Files changed
 apps/worker/src/reference-analysis.test.ts | 55 +++++++++++++++++++++++++++++-
 apps/worker/src/reference-analysis.ts      |  4 +++
 2 files changed, 58 insertions(+), 1 deletion(-)

## Diff
diff --git a/apps/worker/src/reference-analysis.test.ts b/apps/worker/src/reference-analysis.test.ts
index 30ada04..1b56ea7 100644
--- a/apps/worker/src/reference-analysis.test.ts
+++ b/apps/worker/src/reference-analysis.test.ts
@@ -147,21 +147,21 @@ describe('reference analysis', () => {
         cancelled: () => cancelled,
         progress: async (progress) => {
           if (progress >= 35) cancelled = true;
         },
       }),
     ).rejects.toMatchObject({
       code: 'REFERENCE_ANALYSIS_CANCELED',
     });
   });
 
-  it('tolerates silent videos and reports zero audio beats', async () => {
+  it('tolerates videos with no audio track and reports zero audio beats', async () => {
     const directory = mkdtempSync(join(tmpdir(), 'joy-media-reference-silent-'));
     const sourcePath = join(directory, 'silent-reference.mp4');
     try {
       const rendered = spawnSync(
         'ffmpeg',
         [
           '-v',
           'error',
           '-f',
           'lavfi',
@@ -203,20 +203,73 @@ describe('reference analysis', () => {
           expect.objectContaining({ kind: 'composition' }),
           expect.objectContaining({ kind: 'text-safe-zone' }),
           expect.objectContaining({ kind: 'transcript' }),
         ]),
       );
     } finally {
       rmSync(directory, { recursive: true, force: true });
     }
   });
 
+  it('treats silent audio tracks as zero audio beats', async () => {
+    const directory = mkdtempSync(join(tmpdir(), 'joy-media-reference-silent-track-'));
+    const sourcePath = join(directory, 'silent-audio-reference.mp4');
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
+          '-f',
+          'lavfi',
+          '-i',
+          'anullsrc=r=8000:cl=mono',
+          '-shortest',
+          '-c:v',
+          'libx264',
+          '-pix_fmt',
+          'yuv420p',
+          '-c:a',
+          'aac',
+          sourcePath,
+        ],
+        { shell: false, encoding: 'utf8' },
+      );
+      expect(rendered.status).toBe(0);
+      expect(existsSync(sourcePath)).toBe(true);
+
+      const receipt = await analyzeReferenceVideo({
+        jobId: 'reference-silent-track-1',
+        assetId: 'asset-silent-track',
+        sourcePath,
+        payload: {
+          assetId: 'asset-silent-track',
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
+      expect(receipt.evidence.filter((entry) => entry.kind === 'audio-beat')).toEqual([]);
+    } finally {
+      rmSync(directory, { recursive: true, force: true });
+    }
+  });
+
   it('kills a running subprocess when cancellation is requested', async () => {
     let cancelled = false;
     let childPid: number | undefined;
     const running = runReferenceTool({
       command: process.execPath,
       args: ['-e', 'setInterval(() => {}, 1000)'],
       cancelled: () => cancelled,
       maxStdoutBytes: 1_024,
       onSpawn: (pid) => {
         childPid = pid;
diff --git a/apps/worker/src/reference-analysis.ts b/apps/worker/src/reference-analysis.ts
index a6831bf..ebc33ae 100644
--- a/apps/worker/src/reference-analysis.ts
+++ b/apps/worker/src/reference-analysis.ts
@@ -8,20 +8,21 @@ import type {
   ReferenceAnalysisFinding,
   VideoReferenceAnalyzePayload,
   VideoReferenceAnalyzeReceipt,
 } from '@joy-media/job-protocol';
 
 const FRAME_WIDTH = 64;
 const FRAME_HEIGHT = 36;
 const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;
 const AUDIO_SAMPLE_RATE = 8_000;
 const AUDIO_WINDOW_US = 500_000;
+const AUDIO_SILENCE_RMS_THRESHOLD = 1;
 
 export class ReferenceAnalysisError extends Error {
   readonly code: string;
 
   constructor(code: string, message: string) {
     super(message);
     this.name = 'ReferenceAnalysisError';
     this.code = code;
   }
 }
@@ -606,21 +607,24 @@ function buildAudioBeatEvidence(
     let count = 0;
     const start = windowIndex * samplesPerWindow;
     const end = Math.min(pcm.length, start + samplesPerWindow);
     for (let index = start; index < end; index++) {
       const sample = pcm[index] ?? 0;
       energy += sample * sample;
       count++;
     }
     energies.push(count === 0 ? 0 : Math.sqrt(energy / count));
   }
+  const peakEnergy = Math.max(...energies);
+  if (peakEnergy <= AUDIO_SILENCE_RMS_THRESHOLD) return [];
   const averageEnergy = energies.reduce((total, value) => total + value, 0) / energies.length;
+  if (averageEnergy <= AUDIO_SILENCE_RMS_THRESHOLD) return [];
   const candidates = energies
     .map((energy, index) => ({ energy, index }))
     .filter(({ energy, index }) => {
       const previous = energies[index - 1] ?? -Infinity;
       const next = energies[index + 1] ?? -Infinity;
       return energy >= previous && energy >= next && energy >= averageEnergy * 1.05;
     })
     .sort((left, right) => right.energy - left.energy || left.index - right.index)
     .slice(0, maxAudioBeats)
     .sort((left, right) => left.index - right.index);
