/* global console, process */
// scripts/profile-waveform-imports.mjs
import { performance } from 'node:perf_hooks';
import { buildWaveform, buildWaveformDirect } from '../packages/audio-core/dist/audio.js';
import { encodeWaveformPeaks } from '../packages/audio-core/dist/peaks.js';

console.log('=== Waveform Generation & Memory Profiling (50 Clips Import) ===\n');

function formatMem(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

if (typeof globalThis !== 'undefined' && typeof globalThis.gc === 'function') {
  globalThis.gc();
}
const initialMem = process.memoryUsage();
console.log(
  `Baseline V8 Heap: ${formatMem(initialMem.heapUsed)} / ${formatMem(initialMem.heapTotal)}`,
);

const CLIP_COUNT = 50;
const SAMPLE_RATE = 48000;
const DURATION_SEC = 60; // 1 minute per clip
const SAMPLE_COUNT = SAMPLE_RATE * DURATION_SEC; // 2,880,000 samples
const BUCKET_COUNT = 2000; // 2000 waveform buckets per clip

console.log(`Simulation parameters:`);
console.log(`  • Clips: ${CLIP_COUNT}`);
console.log(
  `  • Samples per clip: ${SAMPLE_COUNT.toLocaleString()} (${DURATION_SEC}s @ ${SAMPLE_RATE}Hz)`,
);
console.log(`  • Buckets per clip: ${BUCKET_COUNT}`);
console.log(
  `  • Total audio processed: ${((CLIP_COUNT * DURATION_SEC) / 60).toFixed(1)} minutes\n`,
);

const syntheticSamples = new Float32Array(SAMPLE_COUNT);
for (let i = 0; i < SAMPLE_COUNT; i++) {
  syntheticSamples[i] = Math.sin(i * 0.05) * 0.7 + (Math.random() - 0.5) * 0.2;
}

// 1. Standard Allocation Path (Legacy)
console.log('[1/2] Benchmarking Legacy buildWaveform (Allocating Objects)...');
const legacyStart = performance.now();
const legacyWaveforms = [];
for (let i = 0; i < CLIP_COUNT; i++) {
  const buckets = buildWaveform(syntheticSamples, BUCKET_COUNT);
  legacyWaveforms.push(encodeWaveformPeaks(buckets));
}
const legacyElapsed = performance.now() - legacyStart;
const legacyMem = process.memoryUsage();
console.log(
  `✔ Legacy completed in ${legacyElapsed.toFixed(1)}ms (${(legacyElapsed / CLIP_COUNT).toFixed(2)}ms/clip)`,
);
console.log(`  Heap growth: ${formatMem(legacyMem.heapUsed - initialMem.heapUsed)}`);

// 2. Zero-Allocation Direct Path
console.log('\n[2/2] Benchmarking Zero-Allocation buildWaveformDirect (Reusing Buffer)...');
const directStart = performance.now();
const reusableBuffer = new Int16Array(BUCKET_COUNT * 2);
const directWaveforms = [];
for (let i = 0; i < CLIP_COUNT; i++) {
  const peaks = buildWaveformDirect(syntheticSamples, BUCKET_COUNT, reusableBuffer);
  // Clone only the raw bytes if retained
  directWaveforms.push(new Int16Array(peaks));
}
const directElapsed = performance.now() - directStart;
const directMem = process.memoryUsage();
console.log(
  `✔ Zero-Allocation completed in ${directElapsed.toFixed(1)}ms (${(directElapsed / CLIP_COUNT).toFixed(2)}ms/clip)`,
);
console.log(`  Heap growth: ${formatMem(directMem.heapUsed - legacyMem.heapUsed)}`);

const speedup = (legacyElapsed / directElapsed).toFixed(2);
console.log(`\n⚡ Speedup: ${speedup}x faster!`);
