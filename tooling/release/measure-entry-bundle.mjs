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
 * Usage: measure-entry-bundle.mjs <dist-dir> <out-json> [--max-graph-gzip N] [--max-entry-raw N]
 * Exit non-zero if a budget is exceeded (budgets are generous — a real
 * regression, not noise).
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [distDir, outJson, ...rest] = process.argv.slice(2);
if (!distDir || !outJson) {
  console.error(
    'usage: measure-entry-bundle.mjs <dist-dir> <out-json> [--max-graph-gzip N] [--max-entry-raw N]',
  );
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? Number(rest[i + 1]) : dflt;
};
// Baseline on candidate 83daea2f: entry raw 451,373 / gzip 133,077; eager graph
// raw ~3.11 MB / gzip ~885 KB. Budgets sit well above that.
const MAX_GRAPH_GZIP = opt('--max-graph-gzip', 1_200_000);
const MAX_ENTRY_RAW = opt('--max-entry-raw', 600_000);

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
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  measures: 'shipped production `vite build` — dist/index.html entry + modulepreload graph',
  bytes:
    'raw = uncompressed; gzip = zlib level 9 (conservative "downloaded" size; brotli would be smaller)',
  scope: {
    entry: 'the <script type="module" src> chunk only',
    eagerGraph: 'entry + every <link rel="modulepreload"> chunk — fetched before interactive',
  },
  entry,
  eagerGraph: { chunks: graph, totals, chunkCount: graph.length },
  budgets: { maxEntryRaw: MAX_ENTRY_RAW, maxEagerGraphGzip: MAX_GRAPH_GZIP },
  pass: entry.raw <= MAX_ENTRY_RAW && totals.gzip <= MAX_GRAPH_GZIP,
};

await mkdir(dirname(resolve(outJson)), { recursive: true });
await writeFile(outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await stat(outJson);

console.log(
  `entry ${entry.file}: raw ${entry.raw} / gzip ${entry.gzip}  (budget raw <= ${MAX_ENTRY_RAW})`,
);
console.log(
  `eager graph (${graph.length} chunks): raw ${totals.raw} / gzip ${totals.gzip}  (budget gzip <= ${MAX_GRAPH_GZIP})`,
);
if (!report.pass) {
  console.error('ENTRY-BUNDLE BUDGET EXCEEDED — see', outJson);
  process.exit(1);
}
console.log('entry-bundle budget OK');
