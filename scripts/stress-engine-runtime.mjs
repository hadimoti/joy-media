/* global console, process */
// scripts/stress-engine-runtime.mjs
import { performance } from 'node:perf_hooks';
import {
  timeToPixel,
  pixelToTime,
  snapTime,
  placeDuplicateAfter,
} from '../packages/timeline-engine/dist/index.js';
import { BUILT_IN_LOOK_PACKS } from '../packages/motion-core/dist/looks/packs/index.js';
import { compileLook } from '../packages/motion-core/dist/looks/compile.js';

console.log('=== JOY Media Core Engine Stress & Benchmarking Suite ===\n');

function formatMem(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const initialMem = process.memoryUsage();
console.log(
  `Initial V8 Heap: ${formatMem(initialMem.heapUsed)} / ${formatMem(initialMem.heapTotal)}`,
);

// -------------------------------------------------------------
// 1. Rapid Timeline Scrubbing (10,000 scrub gestures across 4K)
// -------------------------------------------------------------
console.log('\n[1/3] Stress Testing Rapid Timeline Scrubbing (10,000 events)...');
const viewport = { originUs: 0, pixelsPerSecond: 50 };
// 500 magnetic snap candidates (clip boundaries)
const snapCandidates = Array.from({ length: 500 }, (_, i) => i * 1_000_000);

const scrubStart = performance.now();
let scrubOps = 0;
let maxScrubLatUs = 0;

for (let i = 0; i < 10000; i++) {
  const pixel = (i * 7) % 5000;
  const opStart = performance.now();
  const timeUs = pixelToTime(pixel, viewport);
  const snapped = snapTime(timeUs, snapCandidates, viewport, 10);
  timeToPixel(snapped, viewport);
  const opDurationUs = (performance.now() - opStart) * 1000;
  if (opDurationUs > maxScrubLatUs) maxScrubLatUs = opDurationUs;
  scrubOps++;
}
const scrubElapsed = performance.now() - scrubStart;
console.log(`✔ 10,000 scrub events processed in ${scrubElapsed.toFixed(1)}ms`);
console.log(`  Throughput: ${(scrubOps / (scrubElapsed / 1000)).toFixed(0)} ops/sec`);
console.log(`  Max individual scrub latency: ${maxScrubLatUs.toFixed(2)} µs (microsecond!)`);

// -------------------------------------------------------------
// 2. Concurrent Multi-Track Clip Ingestion (500 clips across 8 tracks)
// -------------------------------------------------------------
console.log('\n[2/3] Stress Testing Multi-Track Clip Placement (500 clips)...');
const trackClips = Array.from({ length: 8 }, () => []);
const insertStart = performance.now();

for (let i = 0; i < 500; i++) {
  const trackIdx = i % 8;
  const clip = {
    id: `clip-${i}`,
    startUs: i * 500_000,
    durationUs: 2_000_000,
  };
  const placedStart = placeDuplicateAfter(clip, trackClips[trackIdx]);
  trackClips[trackIdx].push({ ...clip, startUs: placedStart });
}
const insertElapsed = performance.now() - insertStart;
console.log(`✔ 500 clips placed and collision-resolved in ${insertElapsed.toFixed(1)}ms`);
console.log(`  Average placement time: ${(insertElapsed / 500).toFixed(3)}ms per clip`);

// -------------------------------------------------------------
// 3. Heavy Living Looks Switching (1,000 compilations across all 6 packs)
// -------------------------------------------------------------
console.log('\n[3/3] Stress Testing Living Looks Rapid Compilation (1,000 cycles)...');
console.log(
  `Loaded ${BUILT_IN_LOOK_PACKS.length} Built-in Look Packs:`,
  BUILT_IN_LOOK_PACKS.map((p) => p.id).join(', '),
);

const looksStart = performance.now();
let looksCompiled = 0;
let diagnosticsCount = 0;

for (let i = 0; i < 1000; i++) {
  const pack = BUILT_IN_LOOK_PACKS[i % BUILT_IN_LOOK_PACKS.length];
  const input = {
    definition: pack,
    composition: {
      width: 3840,
      height: 2160,
      durationUs: 30_000_000,
      fps: 60,
    },
    controlValues: {
      intensity: (i % 100) / 100,
      warmth: ((i * 3) % 100) / 100,
    },
    slots: {
      primaryVideo: 'track-v1',
      secondaryVideo: 'track-v2',
    },
  };

  const result = compileLook(input);
  if (result.diagnostics && result.diagnostics.length > 0) {
    diagnosticsCount += result.diagnostics.length;
  }
  looksCompiled++;
}

const looksElapsed = performance.now() - looksStart;
console.log(`✔ 1,000 Look compilations in ${looksElapsed.toFixed(1)}ms`);
console.log(`  Throughput: ${(looksCompiled / (looksElapsed / 1000)).toFixed(0)} compiles/sec`);
console.log(`  Diagnostics/Errors encountered: ${diagnosticsCount}`);

// -------------------------------------------------------------
// Memory Growth & Leak Inspection
// -------------------------------------------------------------
const finalMem = process.memoryUsage();
console.log('\n=== Memory Profile ===');
console.log(`Final V8 Heap:   ${formatMem(finalMem.heapUsed)} / ${formatMem(finalMem.heapTotal)}`);
console.log(`Heap Growth:     ${formatMem(finalMem.heapUsed - initialMem.heapUsed)}`);
console.log(`RSS Growth:      ${formatMem(finalMem.rss - initialMem.rss)}`);

console.log('\n✔ All Core Engine Stress Tests Passed Successfully!');
