import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_EVIDENCE_GUEST,
  SANDBOX_STAGING_GUEST,
  SEQUENCES,
  buildManifest,
  buildSandboxConfig,
  checkSandboxConfig,
  makeSandboxNonce,
  readJsonFile,
  readPinnedHashes,
  readSequenceResult,
  stageRun,
} from './sandbox-run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const nonce = '0123456789abcdef0123456789abcdef';
const config = (overrides = {}) =>
  buildSandboxConfig({
    stagingHost: 'E:\\JOY-Sandbox-Runs\\run-1\\staging',
    evidenceHost: 'E:\\JOY-Sandbox-Runs\\run-1\\evidence',
    nonce,
    sequence: 'fresh-candidate',
    ...overrides,
  });

test('makes a 32-digit hex nonce that differs on every call', () => {
  const first = makeSandboxNonce();
  assert.match(first, /^[0-9a-f]{32}$/u);
  assert.notEqual(first, makeSandboxNonce());
});

test('maps the staging folder read-only and the evidence folder writable, with networking off', () => {
  const xml = config();
  assert.deepEqual(checkSandboxConfig(xml), []);
  assert.ok(xml.includes(`<SandboxFolder>${SANDBOX_STAGING_GUEST}</SandboxFolder>`));
  assert.ok(xml.includes(`<SandboxFolder>${SANDBOX_EVIDENCE_GUEST}</SandboxFolder>`));
  assert.ok(xml.includes('<Networking>Disable</Networking>'));
});

test('passes the sequence and the nonce to the guest runner, and escapes the command for XML', () => {
  const xml = config({ sequence: 'previous-upgrade-rollback' });
  assert.ok(xml.includes('-Sequence previous-upgrade-rollback'));
  assert.ok(xml.includes(`-SessionNonce ${nonce}`));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/u.test(xml), 'a bare ampersand would break the XML');
});

test('refuses a writable staging folder (negative control)', () => {
  const writableStaging = config().replace(
    '<ReadOnly>true</ReadOnly>',
    '<ReadOnly>false</ReadOnly>',
  );
  assert.ok(checkSandboxConfig(writableStaging).includes('the staging folder is writable'));
});

test('refuses networking and a missing evidence folder (negative controls)', () => {
  const networked = config().replace(
    '<Networking>Disable</Networking>',
    '<Networking>Enable</Networking>',
  );
  assert.ok(checkSandboxConfig(networked).includes('networking is not disabled'));
  const noEvidence = config().replace('<ReadOnly>false</ReadOnly>', '<ReadOnly>true</ReadOnly>');
  assert.ok(checkSandboxConfig(noEvidence).includes('no writable evidence folder is mapped'));
});

test('rejects an unknown sequence and a malformed nonce', () => {
  assert.throws(() => config({ sequence: 'anything-else' }), /Unknown sequence/u);
  assert.throws(() => config({ nonce: 'not-a-nonce' }), /32 lowercase hex digits/u);
  assert.deepEqual(SEQUENCES, ['previous-upgrade-rollback', 'fresh-candidate']);
});

test('reads the previous release pins from the lifecycle harness, so both harnesses trust the same bytes', () => {
  const lifecycle = readFileSync(
    join(repoRoot, 'tests', 'desktop', 'windows-lifecycle.ps1'),
    'utf8',
  );
  const pins = readPinnedHashes(lifecycle);
  assert.equal(pins.PreviousVersion, '1.0.1');
  assert.match(pins.PreviousSetupSha256, /^[0-9a-f]{64}$/u);
  assert.match(pins.PreviousArchiveSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => readPinnedHashes('no pins here'), /does not pin PreviousVersion/u);
});

test('builds a manifest with backslash paths for the guest', () => {
  const manifest = buildManifest({
    candidate: { version: '1.0.3', setupSha256: 'a', installed: [] },
    previous: { version: '1.0.1', setupSha256: 'b', installed: [] },
  });
  assert.equal(manifest.candidate.setup, 'candidate\\joy-media-setup.exe');
  assert.equal(manifest.previous.setup, 'previous\\joy-media-setup.exe');
});

test('refuses a run folder inside the repository, and a run folder that already has contents', () => {
  const common = {
    candidateSetup: 'x',
    candidateStandalone: 'x',
    candidateVersion: '1.0.3',
    previousSetup: 'x',
    previousZip: 'x',
    previousVersion: '1.0.1',
    pins: { PreviousSetupSha256: 'x', PreviousArchiveSha256: 'x' },
  };
  assert.throws(
    () => stageRun({ ...common, runFolder: join(repoRoot, 'sandbox-run-check') }),
    /outside the repository/u,
  );
  const existing = mkdtempSync(join(tmpdir(), 'joy-sandbox-run-'));
  try {
    writeFileSync(join(existing, 'keep.txt'), 'data');
    assert.throws(() => stageRun({ ...common, runFolder: existing }), /must be new or empty/u);
    assert.equal(
      readFileSync(join(existing, 'keep.txt'), 'utf8'),
      'data',
      'the existing file must survive',
    );
  } finally {
    rmSync(existing, { recursive: true, force: true });
  }
});

test('the guest runner checks the disposable gate with the launch nonce before it changes anything', () => {
  const guest = readFileSync(
    join(repoRoot, 'tests', 'desktop', 'sandbox', 'sandbox-lifecycle-guest.ps1'),
    'utf8',
  );
  const gateAt = guest.indexOf('Assert-DisposableEnvironment');
  assert.ok(gateAt > 0, 'the guest must call the gate');
  assert.ok(
    guest.indexOf('$env:JOY_MEDIA_SANDBOX_NONCE = $SessionNonce') < gateAt,
    'the nonce is set before the gate',
  );
  assert.ok(guest.indexOf('Invoke-Program') > gateAt, 'nothing runs before the gate');
  assert.ok(guest.includes('JOY-Evidence'), 'the guest writes to the evidence folder');
});

test('reads a summary that Windows PowerShell 5.1 wrote with a byte order mark (negative control: JSON.parse alone fails)', () => {
  const folder = mkdtempSync(join(tmpdir(), 'joy-sandbox-bom-'));
  try {
    const path = join(folder, 'summary.json');
    writeFileSync(path, '\uFEFF{"sequence":"fresh-candidate","failed":0}\n', 'utf8');
    assert.throws(() => JSON.parse(readFileSync(path, 'utf8')), SyntaxError);
    assert.deepEqual(readJsonFile(path), { sequence: 'fresh-candidate', failed: 0 });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a summary that cannot be read fails its own sequence, and an unfinished sandbox fails too', () => {
  const folder = mkdtempSync(join(tmpdir(), 'joy-sandbox-summary-'));
  try {
    writeFileSync(join(folder, 'summary.json'), '{not json', 'utf8');
    const unreadable = readSequenceResult(folder, 'fresh-candidate', true);
    assert.equal(unreadable.failed, 1);
    assert.equal(unreadable.steps[0].step, 'summary');
    const unfinished = readSequenceResult(folder, 'fresh-candidate', false);
    assert.equal(unfinished.failed, 1);
    assert.equal(unfinished.steps[0].detail, 'the sandbox did not finish in time');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the guest runner writes evidence without a byte order mark and runs programs without Start-Process', () => {
  const guest = readFileSync(
    join(repoRoot, 'tests', 'desktop', 'sandbox', 'sandbox-lifecycle-guest.ps1'),
    'utf8',
  );
  // Comments may name the cmdlets they avoid, so only the code lines are checked.
  const code = guest
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(
    code.includes('UTF8Encoding]::new($false)'),
    'evidence is written without a byte order mark',
  );
  assert.ok(
    !/\b(?:Set-Content|Add-Content)\b/u.test(code),
    'evidence must not go through Set-Content or Add-Content',
  );
  assert.ok(
    !code.includes('Start-Process'),
    'Start-Process gives a null ExitCode for redirected output',
  );
  assert.ok(
    code.includes('[System.Diagnostics.Process]'),
    'programs run through System.Diagnostics.Process',
  );
});

test(
  'the guest runner parses as Windows PowerShell',
  { skip: process.platform !== 'win32' && 'Windows only' },
  () => {
    const parse =
      '$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:JOY_GUEST_RUNNER, [ref]$null, [ref]$errors) | Out-Null; ' +
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }';
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', parse],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          JOY_GUEST_RUNNER: join(
            repoRoot,
            'tests',
            'desktop',
            'sandbox',
            'sandbox-lifecycle-guest.ps1',
          ),
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  },
);
