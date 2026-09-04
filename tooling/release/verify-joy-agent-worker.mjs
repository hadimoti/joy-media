import { gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const editorDist = resolve(process.cwd(), 'apps/editor-web/dist');
const MAX_RAW_BYTES = 900 * 1024;
const MAX_GZIP_BYTES = 250 * 1024;
const forbidden = [
  /node:/i,
  /child_process/i,
  /fs\/promises/i,
  /process\.cwd/i,
  /__vite-browser-external/i,
  /node_modules[\\/]process[\\/]/i,
  /rollup-plugin-node-polyfills/i,
  /@ai-sdk[\\/]devtools/i,
  /ai-devtools/i,
  /(?:experimental_)?telemetry\s*:/i,
  /registerTelemetry/i,
];

function walk(directory) {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const candidates = walk(editorDist).filter((path) => {
  const name = path.toLowerCase();
  return name.endsWith('.js') && (name.includes('joy-agent') || name.includes('engine.worker'));
});

if (candidates.length === 0) {
  console.error('JOY_AGENT_WORKER_NOT_FOUND: no built JOY Agent Worker chunk exists');
  process.exitCode = 1;
} else {
  let failed = false;
  for (const path of candidates) {
    const source = readFileSync(path);
    const rawBytes = source.byteLength;
    const gzipBytes = gzipSync(source, { level: 9 }).byteLength;
    const relative = path.slice(editorDist.length + 1);
    console.log(`JOY_AGENT_WORKER ${relative}: raw=${rawBytes} bytes gzip=${gzipBytes} bytes`);
    if (rawBytes > MAX_RAW_BYTES || gzipBytes > MAX_GZIP_BYTES) {
      console.error(
        `JOY_AGENT_WORKER_BUDGET_EXCEEDED: ${relative} must remain under 900 KiB raw and 250 KiB gzip`,
      );
      failed = true;
    }
    const match = forbidden.find((pattern) => pattern.test(source.toString('utf8')));
    if (match !== undefined) {
      console.error(`JOY_AGENT_WORKER_FORBIDDEN_IMPORT: ${relative} matched ${match}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
