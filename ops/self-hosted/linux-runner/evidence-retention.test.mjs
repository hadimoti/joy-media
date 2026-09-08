/* global process, Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETAIN = join(dirname(fileURLToPath(import.meta.url)), 'retain-evidence.sh');
const posixOnly = { skip: process.platform === 'win32' ? 'bash/perl harness path' : false };

const FAKE_KEY = 'AKIAF4KE9F3C1B7E2D4A6084';
const FAKE_SECRET = 'sk-fake/9f3c1b7e2d4a6084+ZzTt0198badc0FFEE==';
const FAKE_DBURL = 'postgres://ciuser:s3cr3tp%40ss@db.internal:5432/joy_media_ci';
const FAKE_TOKEN = 'joy-observer-tok-1234567890abcdef';

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
  'retain-evidence: an intentionally failed pass yields an allowlisted, sanitized snapshot',
  posixOnly,
  async () => {
    const ws = await mkdtemp(join(tmpdir(), 'jm-evidence-'));
    const out = join(ws, 'test-output');

    // FAILED-pass shape: observer wrote status "failed"; teardown recorded residue.
    await mkdir(join(out, 'release-performance'), { recursive: true });
    await writeFile(
      join(out, 'release-performance/effects-soak.json'),
      JSON.stringify(
        { status: 'failed', measured: true, metrics: { heapGrowthPercent: 27.4 } },
        null,
        2,
      ),
    );
    await mkdir(join(out, 'operations'), { recursive: true });
    await writeFile(
      join(out, 'operations/teardown.json'),
      JSON.stringify(
        { schemaVersion: 2, clean: false, residue: ['tempRoot /tmp/x still present'] },
        null,
        2,
      ),
    );
    // A file that WRONGLY contains secrets in several encodings.
    await mkdir(join(out, 'delivery'), { recursive: true });
    await writeFile(
      join(out, 'delivery/result.json'),
      JSON.stringify(
        {
          literal: `key ${FAKE_KEY} secret ${FAKE_SECRET}`,
          base64: Buffer.from(FAKE_SECRET).toString('base64'),
          dburl: FAKE_DBURL,
          header: `authorization: Bearer ${FAKE_TOKEN}.longpart.sig`,
          presigned:
            'https://s3.internal/joy/obj?X-Amz-Signature=deadbeefcafe1234&X-Amz-Credential=AKIAF4KE',
        },
        null,
        2,
      ),
    );
    // A file NOT on the allowlist — must not be copied.
    await writeFile(join(out, 'delivery/scratch-notes.txt'), `raw ${FAKE_SECRET}`);

    const dest = join(ws, 'evidence');
    const result = spawnSync('bash', [RETAIN, ws, dest], {
      cwd: ws,
      encoding: 'utf8',
      env: {
        ...process.env,
        JOY_MEDIA_CI_S3_ACCESS_KEY: FAKE_KEY,
        JOY_MEDIA_CI_S3_SECRET_KEY: FAKE_SECRET,
        JOY_MEDIA_CI_DATABASE_URL: FAKE_DBURL,
        JOY_MEDIA_RELEASE_OBSERVER_TOKEN: FAKE_TOKEN,
        JOY_MEDIA_EVIDENCE_PASS: '1',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
      },
    });
    assert.equal(result.status, 0, `retain-evidence.sh failed: ${result.stderr}`);

    // 1. Allowlisted evidence survived, failure signal intact.
    const soak = JSON.parse(
      await readFile(join(dest, 'test-output/release-performance/effects-soak.json'), 'utf8'),
    );
    assert.equal(soak.status, 'failed');
    assert.equal(soak.metrics.heapGrowthPercent, 27.4);
    const teardown = JSON.parse(
      await readFile(join(dest, 'test-output/operations/teardown.json'), 'utf8'),
    );
    assert.equal(teardown.clean, false);

    // 2. Non-allowlisted file was NOT copied.
    const files = await walkFiles(dest);
    assert.ok(
      !files.some((f) => f.endsWith('scratch-notes.txt')),
      'non-allowlisted file must not be in the snapshot',
    );

    // 3. No secret in ANY encoding survives anywhere in the snapshot.
    const b64Secret = Buffer.from(FAKE_SECRET).toString('base64');
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      for (const needle of [
        FAKE_KEY,
        FAKE_SECRET,
        b64Secret,
        FAKE_DBURL,
        FAKE_TOKEN,
        's3cr3tp%40ss',
      ]) {
        assert.ok(!text.includes(needle), `secret (${needle.slice(0, 12)}…) leaked into ${f}`);
      }
      assert.ok(!/X-Amz-Signature=[^&<]+/.test(text), `unredacted presign sig in ${f}`);
    }
    // 4. The delivery file that held secrets is either redacted-in-place or quarantined.
    const deliveryPath = join(dest, 'test-output/delivery/result.json');
    if (files.includes(deliveryPath)) {
      const text = await readFile(deliveryPath, 'utf8');
      assert.ok(text.includes('<redacted'), 'redaction markers expected in the delivery file');
    } else {
      const failures = await readFile(join(dest, 'REDACTION-FAILURES.txt'), 'utf8');
      assert.ok(failures.includes('delivery/result.json'));
    }
  },
);

test(
  'retain-evidence: a pass with no evidence still produces a snapshot dir (no crash)',
  posixOnly,
  async () => {
    const ws = await mkdtemp(join(tmpdir(), 'jm-evidence-empty-'));
    const dest = join(ws, 'evidence');
    const result = spawnSync('bash', [RETAIN, ws, dest], {
      cwd: ws,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    await readFile(join(dest, 'context.txt'), 'utf8');
  },
);
