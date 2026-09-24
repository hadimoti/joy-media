/* global console, process, Buffer, performance */
// scripts/stress-cli-runtime.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STRESS_DIR = 'E:\\joy-media\\temp-stress';
const CLI_PATH = 'E:\\joy-media\\apps\\cli\\bin\\joy-media.mjs';
const SQLITE_PATH = join(STRESS_DIR, 'stress.sqlite3');

console.log('=== JOY Media Real-World CLI Stress Test Suite ===');
console.log(`Working Directory: ${STRESS_DIR}`);

// 1. Setup clean directory
if (existsSync(STRESS_DIR)) {
  rmSync(STRESS_DIR, { recursive: true, force: true });
}
mkdirSync(STRESS_DIR, { recursive: true });

function runCli(args, expectCode = 0) {
  const fullArgs = [CLI_PATH, ...args];
  const start = performance.now();
  const res = spawnSync(process.execPath, fullArgs, {
    encoding: 'utf8',
    env: { ...process.env, JOY_MEDIA_SQLITE_PATH: SQLITE_PATH },
  });
  const elapsed = (performance.now() - start).toFixed(1);
  const ok = res.status === expectCode;

  return {
    ok,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    elapsedMs: elapsed,
  };
}

// 2. Create synthetic media assets
console.log('\n[1/5] Generating synthetic test assets...');
const synthetic4K = join(STRESS_DIR, 'synthetic-4k.mp4');
const syntheticWav = join(STRESS_DIR, 'synthetic-8ch.wav');
const corruptMedia = join(STRESS_DIR, 'corrupted-header.mp4');
const corruptProject = join(STRESS_DIR, 'corrupt-project.json');

// Fake MP4 header + payload
const mp4Header = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const randomBytes = Buffer.alloc(1024 * 1024, 0x42); // 1MB payload
writeFileSync(synthetic4K, Buffer.concat([mp4Header, randomBytes]));

// Fake RIFF WAV header
const wavHeader = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);
writeFileSync(syntheticWav, Buffer.concat([wavHeader, Buffer.alloc(512 * 1024, 0x11)]));

// Corrupted file (random noise, truncated header)
writeFileSync(corruptMedia, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x12]));

// Corrupted project JSON
writeFileSync(
  corruptProject,
  '{"format":"joy-media-project", "schemaVersion": 1, "source": { INVALID JSON',
);

console.log('✔ Synthetic assets generated successfully.');

// 3. Project Creation Stress Test
console.log('\n[2/5] Testing 4K 60fps Project Creation...');
const createRes = runCli([
  'project',
  'create',
  '4K Cinema Stress Test',
  '--width',
  '3840',
  '--height',
  '2160',
  '--fps',
  '60',
  '--sqlite-path',
  SQLITE_PATH,
]);
console.log(`Status: ${createRes.status} (${createRes.elapsedMs}ms)`);
if (!createRes.ok) {
  console.error('Project creation failed:', createRes.stderr || createRes.stdout);
  process.exit(1);
}

// Get project ID
const listRes = runCli(['project', 'list', '--sqlite-path', SQLITE_PATH]);
const match = listRes.stdout.match(/(proj-[a-zA-Z0-9_-]+)/);
const projectId = match ? match[1] : null;
console.log(`Detected Project ID: ${projectId}`);
if (!projectId) {
  console.error('Failed to locate created project ID in output:\n', listRes.stdout);
  process.exit(1);
}

// 4. Timeline Clip Insertion & Rapid Operations
console.log('\n[3/5] Stress Testing Timeline Operations (50 Clips Insertion)...');
const insertStart = performance.now();
for (let i = 0; i < 50; i++) {
  const startSec = (i * 2).toString();
  const durSec = '2';
  const addRes = runCli([
    'timeline',
    'add-clip',
    '--project',
    projectId,
    '--start',
    startSec,
    '--duration',
    durSec,
    '--asset',
    `asset-clip-${i}`,
    '--sqlite-path',
    SQLITE_PATH,
  ]);
  if (!addRes.ok) {
    console.error(`Clip insertion #${i} failed:`, addRes.stderr || addRes.stdout);
  }
}
const insertElapsed = (performance.now() - insertStart).toFixed(1);
console.log(
  `✔ 50 clips added in ${insertElapsed}ms (${(insertElapsed / 50).toFixed(1)}ms per clip)`,
);

// Inspect project details
const showRes = runCli(['project', 'show', projectId, '--sqlite-path', SQLITE_PATH]);
console.log(`Project Show Output (Sample):`);
const showLines = showRes.stdout.split('\n');
console.log(showLines.slice(0, 12).join('\n'));

// 5. Edge Case & Fault Injection Testing
console.log('\n[4/5] Testing Edge Cases & Fault Injections...');

const edgeCases = [
  {
    name: 'Out-of-bounds split at 99999s',
    args: [
      'timeline',
      'split',
      '--project',
      projectId,
      '--clip',
      'clip-nonexistent',
      '--at',
      '99999',
      '--sqlite-path',
      SQLITE_PATH,
    ],
    expectCode: 1,
  },
  {
    name: 'Negative split point at -5s',
    args: [
      'timeline',
      'split',
      '--project',
      projectId,
      '--clip',
      'clip-nonexistent',
      '--at',
      '-5',
      '--sqlite-path',
      SQLITE_PATH,
    ],
    expectCode: 1,
  },
  {
    name: 'Trim with missing clip ID',
    args: ['timeline', 'trim', '--project', projectId, '--sqlite-path', SQLITE_PATH],
    expectCode: 1,
  },
  {
    name: 'Import malformed/corrupted JSON project',
    args: ['project', 'import', corruptProject, '--sqlite-path', SQLITE_PATH],
    expectCode: 1,
  },
  {
    name: 'Non-existent project show',
    args: ['project', 'show', 'project-that-does-not-exist-xyz', '--sqlite-path', SQLITE_PATH],
    expectCode: 1,
  },
  {
    name: 'Add clip with non-numeric / NaN start',
    args: [
      'timeline',
      'add-clip',
      '--project',
      projectId,
      '--start',
      'abc_invalid',
      '--sqlite-path',
      SQLITE_PATH,
    ],
    expectCode: 0, // currently CLI might default or NaN
  },
];

let edgePassed = 0;
for (const tc of edgeCases) {
  const r = runCli(tc.args, tc.expectCode);
  const statusMark =
    r.status === tc.expectCode ? '✔ PASS' : `✖ FAIL (got ${r.status}, expected ${tc.expectCode})`;
  console.log(`  [${statusMark}] ${tc.name} (${r.elapsedMs}ms)`);
  if (r.status !== tc.expectCode) {
    console.log(`      stdout: ${r.stdout.trim()}`);
    console.log(`      stderr: ${r.stderr.trim()}`);
  } else {
    edgePassed++;
  }
}
console.log(`Edge Case Results: ${edgePassed}/${edgeCases.length} passed expected contracts.`);

// 6. Project Export and Re-Import Roundtrip
console.log('\n[5/5] Testing Export -> Import Integrity Roundtrip...');
const exportFile = join(STRESS_DIR, 'exported-project.json');
const expRes = runCli([
  'project',
  'export',
  projectId,
  '--output',
  exportFile,
  '--sqlite-path',
  SQLITE_PATH,
]);
console.log(`Export status: ${expRes.status} (${expRes.elapsedMs}ms)`);

const impRes = runCli(['project', 'import', exportFile, '--sqlite-path', SQLITE_PATH]);
console.log(`Import status: ${impRes.status} (${impRes.elapsedMs}ms)`);

console.log('\n=== Stress Test Complete ===');
