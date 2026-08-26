/* global process */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const runtime = join(desktop, '.runtime');
const node = process.execPath;
const bin = (name) =>
  join(root, 'node_modules', name === 'tsc' ? 'typescript/bin/tsc' : 'esbuild/bin/esbuild');
const build = spawnSync(node, [bin('tsc'), '-b', 'packages/visual-effects', 'apps/worker'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (build.status !== 0) process.exit(build.status ?? 1);
const worker = join(root, 'apps', 'worker', 'dist', 'index.js');
if (!existsSync(worker)) throw new Error(`Worker build output is missing: ${worker}`);

rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
const bundle = spawnSync(
  node,
  [
    bin('esbuild'),
    worker,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--sourcemap=external',
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    `--outfile=${join(runtime, 'worker.js')}`,
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (bundle.status !== 0) process.exit(bundle.status ?? 1);
const workerBundle = join(runtime, 'worker.js');
const sha256 = createHash('sha256').update(readFileSync(workerBundle)).digest('hex');
writeFileSync(
  join(runtime, 'worker-integrity.json'),
  `${JSON.stringify({ algorithm: 'sha256', file: 'worker.js', sha256 }, null, 2)}\n`,
  'utf8',
);
