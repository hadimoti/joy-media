/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETAIN = join(dirname(fileURLToPath(import.meta.url)), 'retain-evidence.sh');
const FAKE_SECRET = 'AKIA-FAKE-CI-SECRET-9f3c1b7e2d4a6084';

async function walkFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(p)));
    else out.push(p);
  }
  return out;
}

test(
  'retain-evidence: an intentionally failed pass still yields a redacted, uploadable snapshot',
  {
    skip: process.platform === 'win32' ? 'bash/perl harness path' : false,
  },
  async () => {
    const ws = await mkdtemp(join(tmpdir(), 'jm-evidence-'));
    const src = join(ws, 'test-output');

    // Shape of a FAILED pass: the observer wrote its per-metric JSON with
    // status "failed", and teardown recorded residue (clean:false).
    await mkdir(join(src, 'release-performance'), { recursive: true });
    await writeFile(
      join(src, 'release-performance/effects-soak.json'),
      JSON.stringify(
        { status: 'failed', measured: true, metrics: { heapGrowthPercent: 27.4 } },
        null,
        2,
      ),
    );
    await mkdir(join(src, 'operations'), { recursive: true });
    await writeFile(
      join(src, 'operations/teardown.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          clean: false,
          residue: ['tempRoot /tmp/joy-media-real-acceptance-XXXX still present'],
        },
        null,
        2,
      ),
    );
    // A file that (wrongly) contains a literal secret — must come out redacted.
    await mkdir(join(src, 'delivery'), { recursive: true });
    await writeFile(
      join(src, 'delivery/result.json'),
      JSON.stringify(
        { note: `connected with key ${FAKE_SECRET} ok`, database: 'postgres://u:p@h/db' },
        null,
        2,
      ),
    );

    const dest = join(ws, 'evidence');
    const result = spawnSync('bash', [RETAIN, 'test-output', dest], {
      cwd: ws,
      encoding: 'utf8',
      env: {
        ...process.env,
        JOY_MEDIA_CI_S3_SECRET_KEY: FAKE_SECRET,
        JOY_MEDIA_CI_DATABASE_URL: 'postgres://u:p@h/db',
        JOY_MEDIA_EVIDENCE_PASS: '1',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    assert.equal(result.status, 0, `retain-evidence.sh failed: ${result.stderr}`);

    // 1. Structured evidence survived, with the failure signal intact.
    const soak = JSON.parse(
      await readFile(join(dest, 'test-output/release-performance/effects-soak.json'), 'utf8'),
    );
    assert.equal(soak.status, 'failed');
    assert.equal(soak.metrics.heapGrowthPercent, 27.4);
    const teardown = JSON.parse(
      await readFile(join(dest, 'test-output/operations/teardown.json'), 'utf8'),
    );
    assert.equal(teardown.clean, false);
    assert.ok(teardown.residue[0].includes('tempRoot'));
    await readFile(join(dest, 'context.txt'), 'utf8');

    // 2. No literal secret anywhere in the snapshot; redaction marker present.
    const files = await walkFiles(dest);
    let sawMarker = false;
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      assert.ok(!text.includes(FAKE_SECRET), `secret leaked into ${f}`);
      assert.ok(!text.includes('postgres://u:p@h/db'), `db url leaked into ${f}`);
      if (text.includes('<redacted:JOY_MEDIA_CI_S3_SECRET_KEY>')) sawMarker = true;
    }
    assert.ok(sawMarker, 'expected a redaction marker in the snapshot');
  },
);

test(
  'retain-evidence: a pass with no test-output still produces a snapshot dir (no crash)',
  {
    skip: process.platform === 'win32' ? 'bash/perl harness path' : false,
  },
  async () => {
    const ws = await mkdtemp(join(tmpdir(), 'jm-evidence-empty-'));
    const dest = join(ws, 'evidence');
    const result = spawnSync('bash', [RETAIN, 'test-output', dest], {
      cwd: ws,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    await readFile(join(dest, 'context.txt'), 'utf8');
  },
);
