import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertDisposableHost,
  decideDisposableEnvironment,
  DisposableHostRefusal,
  LIFECYCLE_MARKER_PURPOSE,
  probeHostFacts,
} from './disposable-host.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const installerCheck = resolve(repoRoot, 'tests/desktop/installer-package-check.mjs');
const windowsLifecycle = resolve(repoRoot, 'tests/desktop/windows-lifecycle.ps1');
const disposableGate = resolve(repoRoot, 'tests/desktop/disposable-environment.ps1');

const containerId = '0123456789ab';
const runnerEnv = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'self-hosted',
  JOY_MEDIA_WINDOWS_CONTAINER_ID: containerId,
};
// The owner's PC: a physical machine, not a container, with no lifecycle marker.
const ownerPcFacts = {
  hostname: 'desktop-owner',
  manufacturer: 'ASUSTeK COMPUTER INC.',
  model: 'ROG Strix',
  marker: null,
};
const containerFacts = { hostname: containerId, manufacturer: null, model: null, marker: null };
const marker = { purpose: LIFECYCLE_MARKER_PURPOSE, kind: 'hyperv-vm' };
const hyperVFacts = {
  hostname: 'joy-lifecycle',
  manufacturer: 'Microsoft Corporation',
  model: 'Virtual Machine',
  marker,
};

function decide(env, facts, platform = 'win32') {
  return decideDisposableEnvironment({ platform, env, facts });
}

// Decodes the -EncodedCommand payload that probeHostFacts hands to PowerShell.
function decodedProbe(args) {
  return Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
}

test('refuses the owner PC even when runner variables and a container id are present', () => {
  assert.equal(decide(runnerEnv, ownerPcFacts).allowed, false);
});

test('refuses a legacy environment override: it is not evidence of disposability', () => {
  const verdict = decide({ JOY_MEDIA_DISPOSABLE_HOST: '1' }, ownerPcFacts);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.environment, null);
});

test('refuses a container id that is not the container hostname', () => {
  const verdict = decide(runnerEnv, { ...containerFacts, hostname: 'fedcba987654' });
  assert.equal(verdict.allowed, false);
});

test('refuses a container id that is not a Docker container id', () => {
  const env = { ...runnerEnv, JOY_MEDIA_WINDOWS_CONTAINER_ID: 'joy-media' };
  assert.equal(decide(env, { ...containerFacts, hostname: 'joy-media' }).allowed, false);
});

test('refuses an uppercase container id, which the runner entrypoint never records', () => {
  const env = { ...runnerEnv, JOY_MEDIA_WINDOWS_CONTAINER_ID: containerId.toUpperCase() };
  assert.equal(
    decide(env, { ...containerFacts, hostname: containerId.toUpperCase() }).allowed,
    false,
  );
});

test('refuses a matching container when the caller is not GitHub Actions', () => {
  const env = { RUNNER_ENVIRONMENT: 'self-hosted', JOY_MEDIA_WINDOWS_CONTAINER_ID: containerId };
  assert.equal(decide(env, containerFacts).allowed, false);
});

test('refuses a GitHub-hosted runner as a container identity', () => {
  const env = { ...runnerEnv, RUNNER_ENVIRONMENT: 'github-hosted' };
  assert.equal(decide(env, containerFacts).allowed, false);
});

test('refuses a Hyper-V guest without the lifecycle marker', () => {
  assert.equal(decide({}, { ...hyperVFacts, marker: null }).allowed, false);
});

test('refuses a Hyper-V guest whose marker names another purpose or kind', () => {
  const otherPurpose = { ...hyperVFacts, marker: { ...marker, purpose: 'owner-workstation' } };
  const otherKind = { ...hyperVFacts, marker: { ...marker, kind: 'container' } };
  assert.equal(decide({}, otherPurpose).allowed, false);
  assert.equal(decide({}, otherKind).allowed, false);
});

test('refuses a physical PC that carries a valid-looking marker', () => {
  assert.equal(decide({}, { ...ownerPcFacts, marker }).allowed, false);
});

test('refuses when the environment probe did not answer (fail closed)', () => {
  assert.equal(decide(runnerEnv, null).allowed, false);
  assert.equal(decide(runnerEnv, { ...containerFacts, hostname: null }).allowed, false);
});

test('refuses off Windows, whatever else is true', () => {
  assert.equal(decide(runnerEnv, containerFacts, 'linux').allowed, false);
});

test('accepts a CI container runner whose container id is its hostname', () => {
  assert.deepEqual(decide(runnerEnv, containerFacts), {
    allowed: true,
    environment: 'ci-container',
    reasons: [],
  });
});

test('accepts a Hyper-V guest that carries the lifecycle marker', () => {
  assert.equal(decide({}, hyperVFacts).environment, 'hyperv-vm');
});

test('assertDisposableHost refuses with a reason and never probes off Windows', () => {
  let probes = 0;
  assert.throws(
    () =>
      assertDisposableHost({
        platform: 'linux',
        env: runnerEnv,
        probe: () => {
          probes += 1;
          return containerFacts;
        },
      }),
    DisposableHostRefusal,
  );
  assert.equal(probes, 0);
});

test('assertDisposableHost refuses on the owner PC and names the reasons', () => {
  assert.throws(
    () => assertDisposableHost({ platform: 'win32', env: {}, probe: () => ownerPcFacts }),
    (error) => error instanceof DisposableHostRefusal && error.reasons.length > 0,
  );
});

test('assertDisposableHost fails closed when the probe throws', () => {
  assert.throws(
    () =>
      assertDisposableHost({
        platform: 'win32',
        env: runnerEnv,
        probe: () => {
          throw new Error('no CIM');
        },
      }),
    DisposableHostRefusal,
  );
});

test('assertDisposableHost returns the identified environment', () => {
  assert.equal(
    assertDisposableHost({ platform: 'win32', env: runnerEnv, probe: () => containerFacts }),
    'ci-container',
  );
});

test('probeHostFacts treats a failed PowerShell run as no evidence', () => {
  const run = () => ({ status: 1, stdout: '', error: undefined });
  assert.equal(probeHostFacts({ run }), null);
});

test('probeHostFacts treats an unreadable answer as no evidence', () => {
  assert.equal(probeHostFacts({ run: () => ({ status: 0, stdout: 'not json' }) }), null);
  assert.equal(probeHostFacts({ run: () => ({ status: 0, stdout: 'null' }) }), null);
});

test('probeHostFacts keeps the hostname and marker from a valid answer', () => {
  const answer = JSON.stringify({
    hostname: containerId,
    manufacturer: 'Microsoft Corporation',
    model: 'Virtual Machine',
    marker,
  });
  assert.deepEqual(probeHostFacts({ run: () => ({ status: 0, stdout: answer }) }), {
    hostname: containerId,
    manufacturer: 'Microsoft Corporation',
    model: 'Virtual Machine',
    marker,
    userName: null,
    profile: null,
    sandboxSession: null,
  });
});

test('the environment probe is read-only PowerShell', () => {
  let captured = [];
  probeHostFacts({
    run: (file, args) => {
      captured = [file, ...args];
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(captured[0], 'powershell.exe');
  const script = decodedProbe(captured);
  assert.doesNotMatch(
    script,
    /\b(?:Remove-Item|Set-Item|New-Item|Set-ItemProperty|Start-Process|Copy-Item|Move-Item|Set-Content|Add-Content|Out-File|Invoke-Expression)\b/u,
  );
  assert.doesNotMatch(script, /\breg(?:\.exe)?\s+(?:add|delete)\b/iu);
});

test('installer-package-check decides before any side effect', () => {
  const source = readFileSync(installerCheck, 'utf8');
  const gate = source.indexOf('assertDisposableHost()');
  assert.ok(gate > 0, 'the installer check must call assertDisposableHost()');
  for (const effect of ['spawnSync(', 'mkdtempSync(', 'mkdirSync(', 'writeFileSync(']) {
    assert.ok(gate < source.indexOf(effect), `the gate must precede ${effect}`);
  }
  assert.doesNotMatch(source, /JOY_MEDIA_DISPOSABLE_HOST/u);
});

test('installer-package-check runs the sandboxed uninstaller by absolute path under a system-only PATH', () => {
  const source = readFileSync(installerCheck, 'utf8');
  assert.doesNotMatch(source, /\['\/d', '\/c', 'uninstall\.cmd'\]/u);
  assert.match(
    source,
    /\['\/d', '\/s', '\/c', `""\$\{join\(sandboxInstallDir, 'uninstall\.cmd'\)\}""`\]/u,
  );
  assert.match(source, /windowsVerbatimArguments: true/u);
  assert.match(source, /PATH: systemPath,/u);
  assert.match(source, /if \/I not "%~dp0"=="\$\{sandboxInstallDir\}\\\\" exit \/b 9/u);
});

test('the lifecycle harness decides before its first write and refuses pre-existing host integrations', () => {
  const source = readFileSync(windowsLifecycle, 'utf8');
  const gate = source.indexOf('Assert-DisposableEnvironment');
  assert.ok(gate > 0, 'the lifecycle harness must call Assert-DisposableEnvironment');
  for (const write of [
    'New-Item -ItemType Directory -Path $workRoot',
    'Invoke-VerifiedSetup $testTamperedArtifact',
  ]) {
    assert.ok(gate < source.indexOf(write), `the gate must precede ${write}`);
  }
  assert.match(
    source,
    /Refusing to start: a JOY Media shortcut or uninstall registry key already exists/u,
  );
  // The gate itself lives in the shared file, which the lifecycle and the Windows Sandbox runner both load.
  assert.ok(
    source.includes('disposable-environment.ps1'),
    'the lifecycle harness must load the shared gate',
  );
  assert.ok(
    readFileSync(disposableGate, 'utf8').includes("'joy-media-disposable-test-environment'"),
  );
});

// The PowerShell gate must decide exactly as the JavaScript gate does. Both run against the same cases.
const sandboxParityNonce = '0123456789abcdef0123456789abcdef';
const sandboxParityFacts = {
  hostname: 'a1b2c3d4e5f6',
  manufacturer: 'Microsoft Corporation',
  model: 'Virtual Machine',
  marker: null,
  userName: 'WDAGUtilityAccount',
  profile: 'C:\\Users\\WDAGUtilityAccount',
  sandboxSession: { purpose: 'joy-media-windows-sandbox', nonce: sandboxParityNonce },
};
const parityCases = [
  { name: 'ci container', env: runnerEnv, facts: containerFacts },
  {
    name: 'windows sandbox',
    env: { JOY_MEDIA_SANDBOX_NONCE: sandboxParityNonce },
    facts: sandboxParityFacts,
  },
  {
    name: 'windows sandbox with a stale nonce',
    env: { JOY_MEDIA_SANDBOX_NONCE: 'fedcba9876543210fedcba9876543210' },
    facts: sandboxParityFacts,
  },
  { name: 'owner pc with runner variables', env: runnerEnv, facts: ownerPcFacts },
  { name: 'hyper-v guest with marker', env: {}, facts: hyperVFacts },
  { name: 'hyper-v guest without marker', env: {}, facts: { ...hyperVFacts, marker: null } },
  { name: 'probe did not answer', env: runnerEnv, facts: null },
  {
    name: 'case-sensitive runner value',
    env: { ...runnerEnv, GITHUB_ACTIONS: 'TRUE' },
    facts: containerFacts,
  },
  {
    name: 'uppercase container id',
    env: { ...runnerEnv, JOY_MEDIA_WINDOWS_CONTAINER_ID: containerId.toUpperCase() },
    facts: { ...containerFacts, hostname: containerId.toUpperCase() },
  },
  {
    name: 'marker kind mismatch',
    env: {},
    facts: { ...hyperVFacts, marker: { ...marker, kind: 'container' } },
  },
];

const POWERSHELL_GATE_PARITY = [
  "$ErrorActionPreference = 'Stop'",
  '$errors = $null',
  '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:JOY_GATE_HARNESS, [ref]$null, [ref]$errors)',
  'if ($errors.Count -gt 0) { throw ($errors | Out-String) }',
  // The shared gate file has no side effects: it only defines the rules and their constants.
  '. $env:JOY_GATE_HARNESS',
  '$cases = $env:JOY_GATE_CASES | ConvertFrom-Json',
  '$results = foreach ($case in $cases) {',
  '  $facts = $null',
  '  if ($null -ne $case.facts) { $facts = [pscustomobject]@{ Hostname = $case.facts.hostname; Manufacturer = $case.facts.manufacturer; Model = $case.facts.model; Marker = $case.facts.marker; UserName = $case.facts.userName; Profile = $case.facts.profile; SandboxSession = $case.facts.sandboxSession } }',
  '  $environment = @{}',
  '  foreach ($property in $case.environment.PSObject.Properties) { $environment[$property.Name] = [string]$property.Value }',
  '  $verdict = Test-DisposableEnvironment -Facts $facts -Environment $environment',
  '  [pscustomobject]@{ Name = [string]$case.name; Allowed = [bool]$verdict.Allowed; Environment = [string]$verdict.Environment }',
  '}',
  'ConvertTo-Json -Compress -InputObject @($results)',
].join('\n');

test(
  'the PowerShell gate decides exactly as the JavaScript gate',
  { skip: process.platform !== 'win32' },
  () => {
    const run = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(POWERSHELL_GATE_PARITY, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
        env: {
          ...process.env,
          JOY_GATE_HARNESS: disposableGate,
          JOY_GATE_CASES: JSON.stringify(
            parityCases.map(({ name, env, facts }) => ({ name, environment: env, facts })),
          ),
        },
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const powerShellVerdicts = JSON.parse(run.stdout);
    assert.equal(powerShellVerdicts.length, parityCases.length);
    parityCases.forEach((testCase, index) => {
      const javaScript = decide(testCase.env, testCase.facts);
      assert.deepEqual(
        {
          name: powerShellVerdicts[index].Name,
          allowed: powerShellVerdicts[index].Allowed,
          environment: powerShellVerdicts[index].Environment,
        },
        {
          name: testCase.name,
          allowed: javaScript.allowed,
          environment: javaScript.environment ?? '',
        },
        testCase.name,
      );
    });
  },
);
