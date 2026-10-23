// Fixture tests for retain-release-artifacts.sh. Each case builds a staged artifact tree in a
// temporary directory and runs the real script with bash. The gate runner is Linux, so these tests
// need a bash with sha256sum, find, sed, cut, diff and wc on PATH.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const script = fileURLToPath(new URL('./retain-release-artifacts.sh', import.meta.url));
const candidate = 'a'.repeat(40);
const runId = '12345';
const attempt = '2';
const setupName = 'joy-media-setup.exe';
const zipName = 'joy-media-windows-x64-v1.0.2.zip';
const workerName = 'standalone/resources/app/worker/joy-worker.exe';
const sumsName = 'SHA256SUMS.txt';

// Git Bash and Linux bash both accept forward slashes; the script quotes every path it uses.
const posix = (path) => path.replace(/\\/g, '/');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Builds a staged tree whose manifest lists every file in it, SHA256SUMS.txt included. `sumsText`
// replaces the checksum file's content, and `null` leaves the file out.
function buildStaged(root, { sumsText } = {}) {
  const staged = join(root, 'staged');
  const contents = {
    [setupName]: Buffer.from('setup-bytes'),
    [zipName]: Buffer.from('zip-bytes'),
    [workerName]: Buffer.from('worker-bytes'),
  };
  if (sumsText !== null) {
    contents[sumsName] = Buffer.from(
      sumsText ??
        `${sha256(contents[setupName])}  ${setupName}\n` +
          `${sha256(contents[zipName])}  ${zipName}\n`,
    );
  }
  for (const [name, bytes] of Object.entries(contents)) {
    const path = join(staged, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  }
  const manifest = {
    format: 'joy-media-release-artifacts',
    candidateSha: candidate,
    runId: Number(runId),
    attempt: Number(attempt),
    version: '1.0.2',
    files: Object.entries(contents).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  writeFileSync(join(staged, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return staged;
}

function runScript({ staged, root, candidateSha = candidate, run = runId, attemptNumber = attempt }) {
  return spawnSync(
    'bash',
    [posix(script), posix(staged), candidateSha, run, attemptNumber, posix(root)],
    { encoding: 'utf8', env: { ...process.env, RUNNER_WORKSPACE: '' } },
  );
}

// Each case gets its own temporary directory, removed afterwards even when an assertion fails.
function withWork(body) {
  const work = mkdtempSync(join(tmpdir(), 'retain-release-'));
  try {
    body(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe('retain-release-artifacts.sh', () => {
  it('retains a verified tree byte for byte, and refuses a second write under the same run', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      const evidence = join(work, 'evidence');
      const first = runScript({ staged, root: evidence });
      assert.equal(first.status, 0, first.stderr);
      const retained = join(evidence, candidate, `${runId}-${attempt}-release-artifacts`);
      assert.equal(readFileSync(join(retained, setupName), 'utf8'), 'setup-bytes');
      assert.equal(readFileSync(join(retained, workerName), 'utf8'), 'worker-bytes');
      const second = runScript({ staged, root: evidence });
      assert.notEqual(second.status, 0, 'retention is write-once');
      assert.match(second.stderr, /write-once/u);
    }));

  it('fails closed on a staged file that differs from its manifest digest, and retains nothing', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      writeFileSync(join(staged, setupName), 'tampered-bytes');
      const evidence = join(work, 'evidence');
      const result = runScript({ staged, root: evidence });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`sha256 mismatch for ${setupName.replace(/\./g, '\\.')}`, 'u'));
      assert.equal(existsSync(join(evidence, candidate)), false, 'a failed check retains nothing');
    }));

  it('fails when the manifest lists a file that is missing', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      rmSync(join(staged, zipName));
      const result = runScript({ staged, root: join(work, 'evidence') });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not hold exactly the manifest's files/u);
    }));

  it('fails when the staged tree holds a file the manifest does not list', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      writeFileSync(join(staged, 'unlisted.exe'), 'extra');
      const result = runScript({ staged, root: join(work, 'evidence') });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /does not hold exactly the manifest's files/u);
    }));

  it('fails when the manifest names another candidate or another run', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      const otherCandidate = runScript({
        staged,
        root: join(work, 'evidence-a'),
        candidateSha: 'b'.repeat(40),
      });
      assert.notEqual(otherCandidate.status, 0);
      assert.match(otherCandidate.stderr, /candidateSha does not match/u);
      const otherRun = runScript({ staged, root: join(work, 'evidence-b'), run: '999' });
      assert.notEqual(otherRun.status, 0);
      assert.match(otherRun.stderr, /run identity does not match/u);
    }));

  it('fails when SHA256SUMS.txt disagrees with the file it names', () =>
    withWork((work) => {
      const staged = buildStaged(work, { sumsText: `${'0'.repeat(64)}  ${setupName}\n` });
      const result = runScript({ staged, root: join(work, 'evidence') });
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(`SHA256SUMS\\.txt disagrees with ${setupName.replace(/\./g, '\\.')}`, 'u'),
      );
    }));

  it('accepts a SHA256SUMS.txt written with CRLF line endings', () =>
    withWork((work) => {
      const staged = buildStaged(work, {
        sumsText:
          `${sha256(Buffer.from('setup-bytes'))}  ${setupName}\r\n` +
          `${sha256(Buffer.from('zip-bytes'))}  ${zipName}\r\n`,
      });
      const result = runScript({ staged, root: join(work, 'evidence') });
      assert.equal(result.status, 0, result.stderr);
    }));

  it('refuses an evidence root inside the checkout, _work or _temp', () =>
    withWork((work) => {
      const staged = buildStaged(work);
      const result = runScript({ staged, root: join(work, '_work', 'evidence') });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /must be outside the checkout/u);
    }));

  it('refuses a staged symlink', (t) =>
    withWork((work) => {
      const staged = buildStaged(work);
      try {
        symlinkSync(join(staged, setupName), join(staged, 'link.exe'));
      } catch (error) {
        // Creating a symlink on Windows needs a privilege this host may not grant. The case is then
        // reported as skipped, never as passed.
        t.skip(`symlink creation is not permitted here: ${error.code}`);
        return;
      }
      const result = runScript({ staged, root: join(work, 'evidence') });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symlinks are not allowed/u);
    }));
});
