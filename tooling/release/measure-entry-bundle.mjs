#!/usr/bin/env node
/* global process, console */
/**
 * Measure the SHIPPED editor entry-bundle graph from a production `vite build`.
 *
 * The release-performance observer's `initialEditorJsBytes <= 500_000` budget is
 * measured against the Vite DEV server in the real-service lane, where the
 * "entry" is `/src/main.tsx` (~7.5 KB) — it does not substantiate production
 * bundle size. This script measures the real artifact:
 *
 *   - entry:  the `<script type="module" src>` in dist/index.html
 *   - graph:  entry + every `<link rel="modulepreload" href>` — the JS that is
 *             fetched eagerly before the app is interactive
 *
 * for each chunk it records RAW bytes and GZIP bytes (gzip = what a
 * gzip-serving origin actually sends; browsers also accept brotli, which is
 * smaller — gzip is the conservative "bytes downloaded" number).
 *
 * Usage: measure-entry-bundle.mjs <dist-dir> <out-json>
 *
 * INFORMATIONAL ONLY. This does NOT enforce a budget and never exits non-zero
 * on size (only on a broken build / missing dist). The ENFORCED entry-bundle
 * budget is `bundlePolicy()` in apps/editor-web/vite.config.ts, which errors
 * `pnpm build` per-chunk over `CHUNK_BUDGET_KIB` — every gate lane runs
 * `pnpm build`. Introducing a total-initial-load threshold is a deliberate,
 * separate decision, not a side effect of this measurement.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [distDir, outJson] = process.argv.slice(2);
if (!distDir || !outJson) {
  console.error('usage: measure-entry-bundle.mjs <dist-dir> <out-json>');
  process.exit(2);
}
// Reference numbers on candidate 83daea2f (for the reviewer, NOT a gate):
// entry raw 451,373 / gzip 133,184; eager graph raw 2,908,836 / gzip 846,556.

const html = await readFile(join(distDir, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
if (!entryMatch) {
  console.error('could not find the module entry <script> in dist/index.html');
  process.exit(1);
}
const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(
  (m) => m[1],
);
const toRel = (href) => href.replace(/^\//, '');

async function measure(rel) {
  const abs = join(distDir, rel);
  const bytes = await readFile(abs);
  return {
    file: rel,
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

const entry = await measure(toRel(entryMatch[1]));
const preloadChunks = [];
for (const href of preloads) preloadChunks.push(await measure(toRel(href)));

const graph = [entry, ...preloadChunks];
const totals = graph.reduce((a, c) => ({ raw: a.raw + c.raw, gzip: a.gzip + c.gzip }), {
  raw: 0,
  gzip: 0,
});

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  enforcement:
    'INFORMATIONAL — not a gate. The enforced entry-bundle budget is vite.config.ts bundlePolicy() (per-chunk, at build time).',
  measures: 'shipped production `vite build` — dist/index.html entry + modulepreload graph',
  bytes:
    'raw = uncompressed (parse cost); gzip = zlib level 9 (conservative "downloaded" size; brotli would be smaller)',
  scope: {
    entry: 'the <script type="module" src> chunk only',
    eagerGraph: 'entry + every <link rel="modulepreload"> chunk — fetched before interactive',
  },
  entry,
  eagerGraph: { chunks: graph, totals, chunkCount: graph.length },
};

await mkdir(dirname(resolve(outJson)), { recursive: true });
await writeFile(outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await stat(outJson);

console.log(`[informational] entry ${entry.file}: raw ${entry.raw} / gzip ${entry.gzip}`);
console.log(
  `[informational] eager graph (${graph.length} chunks): raw ${totals.raw} / gzip ${totals.gzip}`,
);
console.log(
  'entry-bundle measurement recorded (NOT a gate — enforcement is vite.config.ts bundlePolicy)',
);
