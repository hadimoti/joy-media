// Host side of the Windows Sandbox lifecycle run. Owner decision 2026-10-26: Windows Sandbox replaces the Hyper-V test
// VM, and no Windows ISO is downloaded. The launcher stages the guest runner and the installers in a read-only folder,
// writes a session file with a fresh nonce, starts one sandbox per lifecycle sequence, and waits for that sandbox to
// write its done file. Evidence stays in the run folder, which must be outside the repository. The launcher itself
// changes nothing on this PC: it starts sandboxes and reads their evidence.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEQUENCES = ['previous-upgrade-rollback', 'fresh-candidate'];
export const SANDBOX_STAGING_GUEST = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\JOY-Staging';
export const SANDBOX_EVIDENCE_GUEST = 'C:\\Users\\WDAGUtilityAccount\\Desktop\\JOY-Evidence';
const GUEST_RUNNER = 'sandbox-lifecycle-guest.ps1';
const GATE_FILE = 'disposable-environment.ps1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function makeSandboxNonce() {
  return randomBytes(16).toString('hex');
}

export function escapeXml(text) {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * The .wsb configuration for one sequence. The staging folder is mapped read-only, so the guest cannot change the
 * installers or the session file. Only the evidence folder is writable. Networking, audio, video, printing and the
 * clipboard are disabled, because the lifecycle needs none of them.
 */
export function buildSandboxConfig({ stagingHost, evidenceHost, nonce, sequence }) {
  if (!SEQUENCES.includes(sequence)) throw new Error(`Unknown sequence: ${sequence}`);
  if (!/^[0-9a-f]{32}$/u.test(nonce))
    throw new Error('The session nonce must be 32 lowercase hex digits.');
  const logon =
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ' +
    `${SANDBOX_STAGING_GUEST}\\${GUEST_RUNNER} -Sequence ${sequence} -SessionNonce ${nonce}`;
  return [
    '<Configuration>',
    '  <VGpu>Disable</VGpu>',
    '  <Networking>Disable</Networking>',
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    '  <ClipboardRedirection>Disable</ClipboardRedirection>',
    '  <MappedFolders>',
    '    <MappedFolder>',
    `      <HostFolder>${escapeXml(stagingHost)}</HostFolder>`,
    `      <SandboxFolder>${SANDBOX_STAGING_GUEST}</SandboxFolder>`,
    '      <ReadOnly>true</ReadOnly>',
    '    </MappedFolder>',
    '    <MappedFolder>',
    `      <HostFolder>${escapeXml(evidenceHost)}</HostFolder>`,
    `      <SandboxFolder>${SANDBOX_EVIDENCE_GUEST}</SandboxFolder>`,
    '      <ReadOnly>false</ReadOnly>',
    '    </MappedFolder>',
    '  </MappedFolders>',
    '  <LogonCommand>',
    `    <Command>${escapeXml(logon)}</Command>`,
    '  </LogonCommand>',
    '</Configuration>',
    '',
  ].join('\n');
}

/**
 * Checks a configuration against the rules above. It returns the problems it finds, so a test can show that a
 * writable staging folder, or networking, is refused.
 */
export function checkSandboxConfig(xml) {
  const problems = [];
  const folders = [...xml.matchAll(/<MappedFolder>[\s\S]*?<\/MappedFolder>/gu)].map(
    (match) => match[0],
  );
  const staging = folders.find((folder) =>
    folder.includes(`<SandboxFolder>${SANDBOX_STAGING_GUEST}</SandboxFolder>`),
  );
  if (!staging) problems.push('the staging folder is not mapped');
  else if (!staging.includes('<ReadOnly>true</ReadOnly>'))
    problems.push('the staging folder is writable');
  if (!xml.includes('<Networking>Disable</Networking>'))
    problems.push('networking is not disabled');
  if (!xml.includes('<ReadOnly>false</ReadOnly>'))
    problems.push('no writable evidence folder is mapped');
  return problems;
}

/** The manifest the guest checks every installer and installed file against. Paths use backslashes, as Windows does. */
export function buildManifest({ candidate, previous }) {
  return {
    candidate: { ...candidate, setup: 'candidate\\joy-media-setup.exe' },
    previous: { ...previous, setup: 'previous\\joy-media-setup.exe' },
  };
}

/** The pinned hashes the lifecycle harness uses for its previous release, so both harnesses trust the same bytes. */
export function readPinnedHashes(lifecycleText) {
  const pins = {};
  for (const name of ['PreviousVersion', 'PreviousSetupSha256', 'PreviousArchiveSha256']) {
    const match = new RegExp(`\\$${name} = '([^']+)'`, 'u').exec(lifecycleText);
    if (!match) throw new Error(`The lifecycle harness does not pin ${name}.`);
    pins[name] = match[1];
  }
  return pins;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  return path;
}

function ensureOutside(target, root) {
  const rel = relative(root, target);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) throw new Error('The run folder must be outside the repository.');
}

// Reads the expected installed-file hashes from a release folder, or from one file of a ZIP the launcher extracts.
function installedFileHashes(entries) {
  return entries.map(({ path, file }) => ({ path, sha256: sha256File(file) }));
}

const CANDIDATE_INSTALLED = [
  'joy-media.exe',
  'resources\\app\\cli\\joy-media-bundle.mjs',
  'resources\\app\\worker\\joy-worker.exe',
];
const PREVIOUS_INSTALLED = ['joy-media.exe', 'resources\\app\\cli\\joy-media-bundle.mjs'];

/** Stages the guest runner, the disposable-environment gate, both installers and the manifest for one run. */
export function stageRun({
  runFolder,
  candidateSetup,
  candidateStandalone,
  candidateVersion,
  previousSetup,
  previousZip,
  previousVersion,
  pins,
}) {
  ensureOutside(runFolder, repoRoot);
  // A run folder is created fresh. Anything already in it is left alone, so a mistyped path cannot delete data.
  if (existsSync(runFolder) && readdirSync(runFolder).length > 0) {
    throw new Error('The run folder must be new or empty, so nothing already in it is removed.');
  }
  const staging = join(runFolder, 'staging');
  mkdirSync(join(staging, 'candidate'), { recursive: true });
  mkdirSync(join(staging, 'previous'), { recursive: true });
  mkdirSync(join(runFolder, 'evidence'), { recursive: true });

  const previousSetupHash = sha256File(requireFile(previousSetup, 'Previous setup'));
  if (previousSetupHash !== pins.PreviousSetupSha256)
    throw new Error('The previous setup does not match its pinned hash.');
  const previousZipHash = sha256File(requireFile(previousZip, 'Previous archive'));
  if (previousZipHash !== pins.PreviousArchiveSha256)
    throw new Error('The previous archive does not match its pinned hash.');

  copyFileSync(
    requireFile(join(repoRoot, 'tests', 'desktop', 'sandbox', GUEST_RUNNER), 'Guest runner'),
    join(staging, GUEST_RUNNER),
  );
  copyFileSync(
    requireFile(join(repoRoot, 'tests', 'desktop', GATE_FILE), 'Disposable gate'),
    join(staging, GATE_FILE),
  );
  const candidateSetupCopy = join(staging, 'candidate', 'joy-media-setup.exe');
  const previousSetupCopy = join(staging, 'previous', 'joy-media-setup.exe');
  copyFileSync(requireFile(candidateSetup, 'Candidate setup'), candidateSetupCopy);
  copyFileSync(previousSetup, previousSetupCopy);

  const candidateFiles = CANDIDATE_INSTALLED.map((path) => ({
    path,
    file: join(candidateStandalone, path),
  }));
  const previousExtract = join(runFolder, 'previous-extract');
  mkdirSync(previousExtract, { recursive: true });
  // The Windows tar, not a tar from another toolchain on PATH, which reads "C:" as a remote host.
  const windowsTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const extracted = spawnSync(
    windowsTar,
    [
      '-xf',
      previousZip,
      '-C',
      previousExtract,
      'joy-media-win32-x64/joy-media.exe',
      'joy-media-win32-x64/resources/app/cli/joy-media-bundle.mjs',
    ],
    { encoding: 'utf8' },
  );
  if (extracted.status !== 0)
    throw new Error(`Extracting the previous archive failed: ${extracted.stderr}`);
  const previousFiles = PREVIOUS_INSTALLED.map((path) => ({
    path,
    file: join(previousExtract, 'joy-media-win32-x64', path),
  }));

  const manifest = buildManifest({
    candidate: {
      version: candidateVersion,
      setupSha256: sha256File(candidateSetupCopy),
      installed: installedFileHashes(candidateFiles),
    },
    previous: {
      version: previousVersion,
      setupSha256: previousSetupHash,
      installed: installedFileHashes(previousFiles),
    },
  });
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  rmSync(previousExtract, { recursive: true, force: true });
  return { staging, manifest };
}

export function launchSandbox(
  configPath,
  { systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {},
) {
  const exe = join(systemRoot, 'System32', 'WindowsSandbox.exe');
  const child = spawn(exe, [configPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function closeSandbox() {
  // Closing the sandbox window discards its state. The evidence is already on the host by then.
  for (const image of ['WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe']) {
    spawnSync('taskkill', ['/IM', image, '/F'], { stdio: 'ignore' });
  }
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 5000));
  }
  return true;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Expected --name value pairs, got: ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
}

export async function main(argv) {
  if (process.platform !== 'win32')
    throw new Error('The Windows Sandbox run works only on Windows.');
  const sandboxExe = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsSandbox.exe',
  );
  if (!existsSync(sandboxExe)) {
    throw new Error(
      'Windows Sandbox is not available yet. Enable the optional feature and restart Windows, then run again.',
    );
  }
  const options = parseArgs(argv);
  const required = [
    'out',
    'candidate-setup',
    'candidate-standalone',
    'candidate-version',
    'previous-setup',
    'previous-zip',
    'previous-version',
  ];
  for (const name of required) if (!options[name]) throw new Error(`Missing --${name}`);

  const pins = readPinnedHashes(
    readFileSync(join(repoRoot, 'tests', 'desktop', 'windows-lifecycle.ps1'), 'utf8'),
  );
  if (options['previous-version'] !== pins.PreviousVersion)
    throw new Error(`The previous version must be ${pins.PreviousVersion}.`);
  const runFolder = resolve(options.out);
  const { staging } = stageRun({
    runFolder,
    candidateSetup: options['candidate-setup'],
    candidateStandalone: options['candidate-standalone'],
    candidateVersion: options['candidate-version'],
    previousSetup: options['previous-setup'],
    previousZip: options['previous-zip'],
    previousVersion: options['previous-version'],
    pins,
  });

  const evidence = join(runFolder, 'evidence');
  const results = [];
  for (const sequence of SEQUENCES) {
    const nonce = makeSandboxNonce();
    writeFileSync(
      join(staging, 'session.json'),
      `${JSON.stringify({ purpose: 'joy-media-windows-sandbox', nonce, sequence })}\n`,
      'utf8',
    );
    const configPath = join(runFolder, `${sequence}.wsb`);
    writeFileSync(
      configPath,
      buildSandboxConfig({ stagingHost: staging, evidenceHost: evidence, nonce, sequence }),
      'utf8',
    );
    const problems = checkSandboxConfig(readFileSync(configPath, 'utf8'));
    if (problems.length > 0)
      throw new Error(`The sandbox configuration is not acceptable: ${problems.join('; ')}`);
    launchSandbox(configPath);
    const done = await waitForFile(join(evidence, sequence, 'done.json'), 60 * 60 * 1000);
    closeSandbox();
    const summaryPath = join(evidence, sequence, 'summary.json');
    results.push(
      done && existsSync(summaryPath)
        ? JSON.parse(readFileSync(summaryPath, 'utf8'))
        : {
            sequence,
            passed: 0,
            failed: 1,
            steps: [
              { step: 'sequence', status: 'failed', detail: 'the sandbox did not finish in time' },
            ],
          },
    );
    // Sandbox allows one instance at a time, so the next sequence starts after the previous window has closed.
    await new Promise((done2) => setTimeout(done2, 10000));
  }

  const failed = results.reduce((sum, result) => sum + result.failed, 0);
  const runSummary = {
    generatedUtc: new Date().toISOString(),
    sequences: results,
    failedSteps: failed,
  };
  writeFileSync(
    join(runFolder, 'run-summary.json'),
    `${JSON.stringify(runSummary, null, 2)}\n`,
    'utf8',
  );
  for (const result of results) {
    process.stdout.write(`${result.sequence}: ${result.passed} passed, ${result.failed} failed\n`);
    for (const step of result.steps)
      process.stdout.write(`  [${step.status}] ${step.step}: ${step.detail}\n`);
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(join('sandbox', 'sandbox-run.mjs'))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    },
  );
}
