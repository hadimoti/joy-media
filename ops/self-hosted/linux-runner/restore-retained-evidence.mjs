/* global Buffer, process */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const RETAINED_EVIDENCE_PATHS = new Set([
  'test-output/browser/journeys.json',
  'test-output/browser/authenticated-editor-1.0/journey-evidence.json',
  'test-output/browser/real-service-profile-matrix.json',
  'test-output/browser/p3-export-matrix.json',
  'test-output/browser/p3-export-matrix-copy.json',
  'test-output/browser/p3-export-json.json',
  'test-output/browser/p3-progress.jsonl',
  'test-output/browser/p3-child-stdout-tail.txt',
  'test-output/browser/p3-child-stderr-tail.txt',
  'test-output/browser/p3-lane-evidence.json',
  'test-output/browser/p3-case-evidence.json',
  'test-output/browser/journey-failure.json',
  'test-output/browser/web-dev-server.log',
  'test-output/release-performance/polling.json',
  'test-output/release-performance/effects-soak.json',
  'test-output/release-performance/timeline-integrity.json',
  'test-output/release-performance/editor.json',
  'test-output/delivery/result.json',
  'test-output/operations/restore.json',
  'test-output/operations/teardown.json',
  'test-output/ci-janitor/inventory.json',
  'test-output/windows/acceptance.json',
]);

const FINAL_GATE_VIEW = [
  'test-output/browser/journeys.json',
  'test-output/browser/authenticated-editor-1.0/journey-evidence.json',
  'test-output/release-performance/polling.json',
  'test-output/release-performance/effects-soak.json',
  'test-output/release-performance/timeline-integrity.json',
  'test-output/release-performance/editor.json',
  'test-output/delivery/result.json',
  'test-output/operations/restore.json',
  'test-output/operations/teardown.json',
  'test-output/ci-janitor/inventory.json',
];

const SUMMARY_RELATIVE_PATH = 'test-output/readiness/two-pass-evidence/manifest.json';
const RELEASE_EVIDENCE_UPLOAD_STATUS = [
  'upload_outcome=disabled',
  'source=durable-evidence-store',
  'reason=github-artifact-upload-disabled-by-policy',
];
const PREVIOUS_RELEASE = {
  version: '1.0.1',
  setupSha256: '3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04',
  archiveSha256: '21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c',
  checksumsSha256: 'a7b933f44ec82edd2f166dcde0bb013e1febd0ebbd19aa42dd49ac8e05adfe32',
};
const REQUIRED_WINDOWS_SCENARIOS = [
  'cli.render.playable',
  'cli.render.unsupported-features',
  'cli.render.failure-recovery',
  'cli.render.windows-entrypoints',
  'project.persistence.fresh-process',
  'desktop.app.restart-save-export',
  'desktop.windows.installed-lifecycle',
];
const CANDIDATE_ARTIFACT_HASH_FIELDS = [
  'candidateSetupSha256',
  'candidatePortableArchiveSha256',
  'candidateDesktopExecutableSha256',
  'candidateCliBundleSha256',
  'candidateWorkerExecutableSha256',
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function assertSafeRelativePath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !/^[A-Za-z0-9_./-]+$/u.test(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('retained manifest contains an unsafe path');
  }
}

function isAllowedRetainedFile(path) {
  if (path === 'context.txt' || path === 'git-status.txt') return true;
  if (RETAINED_EVIDENCE_PATHS.has(path)) return true;
  if (path === 'test-output/browser/p3-export-gallery/manifest.json') return true;
  if (!path.startsWith('test-output/browser/p3-export-gallery/')) return false;
  return (
    /\.(?:mp4|png)$/iu.test(path) ||
    /^test-output\/browser\/p3-export-gallery\/[^/]+\/frame-(?:0\.10|0\.50|0\.90)\.ppm$/u.test(path)
  );
}

function parseSha256Manifest(value) {
  const entries = new Map();
  for (const line of value.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}\.\/([A-Za-z0-9_./-]+)$/u.exec(line);
    if (match === null) throw new Error('retained checksum manifest has an invalid entry');
    const [, digest, path] = match;
    assertSafeRelativePath(path);
    if (entries.has(path)) throw new Error('retained checksum manifest has a duplicate path');
    entries.set(path, digest);
  }
  return entries;
}

async function readVerifiedPass(root, expected) {
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new Error(`retained ${expected.lane} pass ${expected.pass} is missing`);
  }
  const manifestPath = join(realRoot, 'MANIFEST.json');
  const checksumPath = join(realRoot, 'MANIFEST.sha256');
  let manifestBytes;
  let checksumBytes;
  try {
    [manifestBytes, checksumBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(checksumPath),
    ]);
  } catch {
    throw new Error(`retained ${expected.lane} pass ${expected.pass} has no complete manifest`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error(`retained ${expected.lane} pass ${expected.pass} has invalid manifest JSON`);
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.schemaVersion !== 1 ||
    manifest.candidateSha !== expected.candidateSha ||
    manifest.runId !== expected.runId ||
    manifest.attempt !== expected.attempt ||
    manifest.pass !== String(expected.pass) ||
    manifest.redactionApplied !== true ||
    manifest.quarantinedCount !== 0 ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`retained ${expected.lane} pass ${expected.pass} has mismatched provenance`);
  }

  const checksums = parseSha256Manifest(checksumBytes.toString('utf8'));
  const seen = new Set();
  const verifiedFiles = [];
  for (const entry of manifest.files) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !isSha256(entry.sha256)
    ) {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} has a malformed file entry`);
    }
    assertSafeRelativePath(entry.path);
    if (!isAllowedRetainedFile(entry.path)) {
      throw new Error(
        `retained ${expected.lane} pass ${expected.pass} contains an unapproved file: ${entry.path}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} has a duplicate file entry`);
    }
    seen.add(entry.path);
    if (checksums.get(entry.path) !== entry.sha256) {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} checksum mismatch`);
    }
    const absolutePath = resolve(realRoot, ...entry.path.split('/'));
    const relativePath = relative(realRoot, absolutePath);
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} contains an escaping path`);
    }
    let fileBytes;
    try {
      const actualPath = await realpath(absolutePath);
      if (actualPath !== absolutePath || !(await lstat(absolutePath)).isFile()) {
        throw new Error('not a regular file');
      }
      fileBytes = await readFile(absolutePath);
    } catch {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} file is missing or unsafe`);
    }
    if (fileBytes.length !== entry.bytes || sha256(fileBytes) !== entry.sha256) {
      throw new Error(`retained ${expected.lane} pass ${expected.pass} hash mismatch`);
    }
    verifiedFiles.push({ ...entry, absolutePath });
  }
  if (checksums.size !== seen.size || [...checksums.keys()].some((path) => !seen.has(path))) {
    throw new Error(`retained ${expected.lane} pass ${expected.pass} checksum inventory mismatch`);
  }

  const uploadStatusPath = join(realRoot, 'ARTIFACT-UPLOAD-STATUS.txt');
  let uploadStatus;
  try {
    uploadStatus = (await readFile(uploadStatusPath, 'utf8')).split(/\r?\n/u);
  } catch {
    throw new Error(
      `retained ${expected.lane} pass ${expected.pass} upload-policy receipt is missing`,
    );
  }
  for (const line of [
    `candidate_sha=${expected.candidateSha}`,
    `run_id=${expected.runId}`,
    `attempt=${expected.attempt}`,
    `pass=${expected.pass}`,
    ...RELEASE_EVIDENCE_UPLOAD_STATUS,
  ]) {
    if (!uploadStatus.includes(line)) {
      throw new Error(
        `retained ${expected.lane} pass ${expected.pass} upload-policy receipt is invalid`,
      );
    }
  }

  return {
    manifestSha256: sha256(manifestBytes),
    checksumManifestSha256: sha256(checksumBytes),
    fileCount: verifiedFiles.length,
    files: verifiedFiles,
  };
}

function isInside(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function ensureSafeWorkspaceDirectory(workspaceRoot, relativeDirectory) {
  assertSafeRelativePath(relativeDirectory);
  const realWorkspace = await realpath(workspaceRoot);
  let current = realWorkspace;
  for (const segment of relativeDirectory.split('/')) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('restored evidence destination contains an unsafe directory');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
    const actual = await realpath(current);
    if (!isInside(realWorkspace, actual)) {
      throw new Error('restored evidence destination escapes the checkout');
    }
  }
  return current;
}

async function safeWorkspaceFilePath(workspaceRoot, relativePath, allowExisting) {
  assertSafeRelativePath(relativePath);
  const segments = relativePath.split('/');
  const filename = segments.pop();
  if (filename === undefined) throw new Error('restored evidence path is invalid');
  const parent = await ensureSafeWorkspaceDirectory(workspaceRoot, segments.join('/'));
  const destination = join(parent, filename);
  try {
    const info = await lstat(destination);
    if (!allowExisting || !info.isFile() || info.isSymbolicLink()) {
      throw new Error('restored evidence destination already exists or is unsafe');
    }
    const actual = await realpath(destination);
    if (!isInside(await realpath(workspaceRoot), actual)) {
      throw new Error('restored evidence destination escapes the checkout');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return destination;
}

async function copyToWorkspace(source, workspaceRoot, destinationRelativePath) {
  const destination = await safeWorkspaceFilePath(workspaceRoot, destinationRelativePath, false);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function writeWorkspaceFile(workspaceRoot, relativePath, bytes, allowExisting = false) {
  const destination = await safeWorkspaceFilePath(workspaceRoot, relativePath, allowExisting);
  await writeFile(destination, bytes, { flag: allowExisting ? 'w' : 'wx' });
}

function findFile(files, path) {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`required retained evidence is missing: ${path}`);
  return file;
}

export async function restoreRetainedEvidence({
  evidenceRoot,
  workspaceRoot,
  candidateSha,
  runId,
  attempt,
}) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? '')) throw new Error('candidate SHA is invalid');
  if (!/^[0-9]+$/u.test(runId ?? '')) throw new Error('workflow run ID is invalid');
  if (!/^[1-9][0-9]*$/u.test(attempt ?? '')) throw new Error('workflow attempt is invalid');
  const summaryPath = resolve(workspaceRoot, ...SUMMARY_RELATIVE_PATH.split('/'));
  try {
    await lstat(summaryPath);
    throw new Error('two-pass evidence summary already exists in the workspace');
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'two-pass evidence summary already exists in the workspace'
    )
      throw error;
  }

  const sources = [];
  const verified = new Map();
  for (const lane of ['real-service', 'p3']) {
    for (const pass of [1, 2]) {
      const root = resolve(
        evidenceRoot,
        ...(lane === 'p3' ? ['p3'] : []),
        candidateSha,
        `${runId}-${attempt}-p${pass}`,
      );
      const source = await readVerifiedPass(root, {
        lane,
        pass,
        candidateSha,
        runId,
        attempt,
      });
      verified.set(`${lane}:${pass}`, source.files);
      sources.push({
        lane,
        pass,
        manifestSha256: source.manifestSha256,
        checksumManifestSha256: source.checksumManifestSha256,
        fileCount: source.fileCount,
      });
      for (const file of source.files) {
        if (!file.path.startsWith('test-output/')) continue;
        if (file.path.startsWith('test-output/browser/p3-export-gallery/')) continue;
        const relativeEvidencePath = file.path.slice('test-output/'.length);
        const destination = `test-output/readiness/two-pass-evidence/${lane}/pass-${pass}/${relativeEvidencePath}`;
        await copyToWorkspace(file.absolutePath, workspaceRoot, destination);
      }
    }
  }

  const pass2Files = verified.get('real-service:2');
  if (pass2Files === undefined) throw new Error('real-service pass 2 evidence is missing');
  const gateView = [];
  for (const path of FINAL_GATE_VIEW) {
    const file = findFile(pass2Files, path);
    await copyToWorkspace(file.absolutePath, workspaceRoot, path);
    gateView.push({ path, sha256: file.sha256 });
  }

  const summary = {
    schemaVersion: 1,
    candidateSha,
    runId,
    attempt,
    restoredAt: new Date().toISOString(),
    sources,
    gateView,
    windowsWorkerPasses: [],
  };
  await writeWorkspaceFile(
    workspaceRoot,
    SUMMARY_RELATIVE_PATH,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

function decodeWindowsPass(base64, expectedPass) {
  if (
    typeof base64 !== 'string' ||
    base64.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)
  ) {
    throw new Error(`Windows Worker pass ${expectedPass} evidence is missing or malformed`);
  }
  let evidence;
  try {
    evidence = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error(`Windows Worker pass ${expectedPass} evidence is not valid JSON`);
  }
  const identity = evidence?.containerIdentity;
  if (evidence?.pass !== expectedPass) {
    throw new Error(
      `Windows Worker pass ${expectedPass} evidence declares pass ${String(evidence?.pass)}`,
    );
  }
  if (
    evidence === null ||
    typeof evidence !== 'object' ||
    evidence.schemaVersion !== 2 ||
    evidence.status !== 'verified' ||
    evidence.runner !== 'self-hosted,windows,x64,joy-media-worker-docker' ||
    evidence.execution !== 'windows-docker-container' ||
    evidence.windowsPlatformVerified !== true ||
    typeof identity?.containerId !== 'string' ||
    !/^[0-9a-f]{12,64}$/u.test(identity.containerId) ||
    typeof identity?.imageDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(identity.imageDigest) ||
    evidence.lifecycle === null ||
    typeof evidence.lifecycle !== 'object'
  ) {
    throw new Error(
      `Windows Worker pass ${expectedPass} evidence is not verified Windows-Docker evidence`,
    );
  }
  validateDesktopLifecycle(evidence, expectedPass);
  return evidence;
}

function validateDesktopLifecycle(evidence, expectedPass) {
  const lifecycle = evidence.desktopLifecycle;
  if (lifecycle?.pass !== expectedPass) {
    throw new Error(
      `Windows Worker pass ${expectedPass} desktop lifecycle declares pass ${String(lifecycle?.pass)}`,
    );
  }
  const invalid = [];
  if (lifecycle === null || typeof lifecycle !== 'object') invalid.push('record');
  if (lifecycle.schemaVersion !== 1 || lifecycle.status !== 'verified')
    invalid.push('status/schema');
  if (
    lifecycle.candidateSha !== evidence.candidateSha ||
    lifecycle.workflowRunId !== evidence.workflowRunId ||
    lifecycle.attempt !== evidence.attempt ||
    lifecycle.sourceProvenance?.commitSha !== evidence.candidateSha ||
    lifecycle.sourceProvenance?.worktreeClean !== true
  )
    invalid.push('candidate/run/source provenance');
  if (
    lifecycle.containerIdentity?.containerId !== evidence.containerIdentity.containerId ||
    lifecycle.containerIdentity?.imageDigest !== evidence.containerIdentity.imageDigest
  )
    invalid.push('container identity');
  if (
    lifecycle.versions?.previous !== PREVIOUS_RELEASE.version ||
    typeof lifecycle.versions?.candidate !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(lifecycle.versions.candidate)
  )
    invalid.push('versions');
  if (
    lifecycle.artifacts?.previousSetupSha256 !== PREVIOUS_RELEASE.setupSha256 ||
    lifecycle.artifacts?.previousArchiveSha256 !== PREVIOUS_RELEASE.archiveSha256 ||
    lifecycle.artifacts?.previousChecksumsSha256 !== PREVIOUS_RELEASE.checksumsSha256 ||
    !isSha256(lifecycle.artifacts?.previousDesktopExecutableSha256) ||
    !isSha256(lifecycle.artifacts?.previousCliBundleSha256) ||
    !CANDIDATE_ARTIFACT_HASH_FIELDS.every((field) => isSha256(lifecycle.artifacts?.[field]))
  )
    invalid.push('artifact hashes');
  if (
    lifecycle.transitions === null ||
    typeof lifecycle.transitions !== 'object' ||
    [
      'installPrevious',
      'upgradeCandidate',
      'repairCandidate',
      'rollbackPrevious',
      'uninstall',
      'userDataPreserved',
    ].some((step) => lifecycle.transitions[step] !== 'passed')
  )
    invalid.push('install/update/repair/rollback/uninstall transitions');
  if (
    lifecycle.editorAcceptance?.status !== 'passed' ||
    lifecycle.editorAcceptance?.firstAttemptPassed !== true ||
    lifecycle.editorAcceptance?.retries !== 0
  )
    invalid.push('editor acceptance');
  if (
    !validWindowsCliAcceptance(lifecycle.cliAcceptance?.joyCmd) ||
    !validWindowsCliAcceptance(lifecycle.cliAcceptance?.joyMediaCmd)
  )
    invalid.push('installed CLI render acceptance');
  if (!validWindowsToolchain(lifecycle.toolchain)) invalid.push('toolchain versions');
  if (
    !Array.isArray(lifecycle.commands) ||
    lifecycle.commands.length === 0 ||
    lifecycle.commands.some(
      (command) =>
        command === null ||
        typeof command !== 'object' ||
        typeof command.name !== 'string' ||
        command.name.trim() === '' ||
        command.exitCode !== 0,
    )
  )
    invalid.push('command results');
  if (
    !Array.isArray(lifecycle.scenarios) ||
    !validUtcTimestamp(lifecycle.startedAt) ||
    !validUtcTimestamp(lifecycle.finishedAt) ||
    Date.parse(lifecycle.finishedAt) < Date.parse(lifecycle.startedAt)
  )
    invalid.push('scenario list or timestamps');
  if (invalid.length > 0) {
    throw new Error(
      `Windows Worker pass ${expectedPass} desktop lifecycle evidence is incomplete or mismatched: ${invalid.join(', ')}`,
    );
  }

  const scenarioResults = new Map();
  for (const result of lifecycle.scenarios) {
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof result.id !== 'string' ||
      scenarioResults.has(result.id)
    ) {
      throw new Error(
        `Windows Worker pass ${expectedPass} desktop lifecycle has malformed scenario results`,
      );
    }
    scenarioResults.set(result.id, result);
  }
  for (const scenarioId of REQUIRED_WINDOWS_SCENARIOS) {
    const result = scenarioResults.get(scenarioId);
    if (result?.status !== 'passed' || result.firstAttemptPassed !== true || result.retries !== 0) {
      throw new Error(
        `Windows Worker pass ${expectedPass} desktop lifecycle scenario did not pass first try: ${scenarioId}`,
      );
    }
  }
}

function validWindowsCliAcceptance(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.status === 'passed' &&
    isSha256(result.launcherSha256) &&
    isSha256(result.desktopExecutableSha256) &&
    isSha256(result.cliBundleSha256) &&
    isSha256(result.workerExecutableSha256) &&
    isSha256(result.renderedMediaSha256) &&
    result.videoCodec === 'h264' &&
    result.audioCodec === 'aac' &&
    Number.isFinite(result.durationSeconds) &&
    result.durationSeconds >= 2.9
  );
}

function validWindowsToolchain(toolchain) {
  return (
    toolchain !== null &&
    typeof toolchain === 'object' &&
    ['node', 'pnpm', 'electron', 'ffmpeg', 'ffprobe', 'windows'].every(
      (name) => typeof toolchain[name] === 'string' && toolchain[name].trim() !== '',
    )
  );
}

function validUtcTimestamp(value) {
  return (
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
  );
}

export async function bindWindowsWorkerPasses({
  workspaceRoot,
  candidateSha,
  runId,
  attempt,
  pass1B64,
  pass2B64,
}) {
  const summaryPath = resolve(workspaceRoot, ...SUMMARY_RELATIVE_PATH.split('/'));
  let summary;
  try {
    summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  } catch {
    throw new Error('two-pass evidence summary is missing before Windows evidence binding');
  }
  if (
    summary.candidateSha !== candidateSha ||
    summary.runId !== runId ||
    summary.attempt !== attempt
  ) {
    throw new Error('two-pass evidence summary has mismatched candidate or workflow provenance');
  }
  const passes = [decodeWindowsPass(pass1B64, 1), decodeWindowsPass(pass2B64, 2)];
  for (const [index, evidence] of passes.entries()) {
    const expectedPass = index + 1;
    if (
      evidence.candidateSha !== candidateSha ||
      evidence.workflowRunId !== runId ||
      evidence.attempt !== Number(attempt) ||
      evidence.sourceProvenance?.commitSha !== candidateSha ||
      evidence.sourceProvenance?.worktreeClean !== true
    ) {
      throw new Error(
        `Windows Worker pass ${expectedPass} provenance does not match the candidate/run/attempt`,
      );
    }
  }
  const firstLifecycle = passes[0].desktopLifecycle;
  const secondLifecycle = passes[1].desktopLifecycle;
  const desktopPackage = JSON.parse(
    await readFile(resolve(workspaceRoot, 'apps/desktop/package.json'), 'utf8'),
  );
  if (
    firstLifecycle.containerIdentity.containerId !==
      secondLifecycle.containerIdentity.containerId ||
    firstLifecycle.containerIdentity.imageDigest !==
      secondLifecycle.containerIdentity.imageDigest ||
    firstLifecycle.versions.candidate !== secondLifecycle.versions.candidate ||
    firstLifecycle.versions.candidate !== desktopPackage.version ||
    CANDIDATE_ARTIFACT_HASH_FIELDS.some(
      (field) => firstLifecycle.artifacts[field] !== secondLifecycle.artifacts[field],
    )
  ) {
    throw new Error(
      'Windows desktop lifecycle passes do not use the same candidate artifact and runner container',
    );
  }
  const windowsWorkerPasses = [];
  for (const [index, evidence] of passes.entries()) {
    const pass = index + 1;
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const relativePath = `test-output/readiness/two-pass-evidence/windows/pass-${pass}/acceptance.json`;
    await writeWorkspaceFile(workspaceRoot, relativePath, bytes);
    const absolutePath = resolve(workspaceRoot, ...relativePath.split('/'));
    windowsWorkerPasses.push({
      pass,
      runner: evidence.runner,
      execution: evidence.execution,
      containerId: evidence.containerIdentity.containerId,
      imageDigest: evidence.containerIdentity.imageDigest,
      verifiedAt: evidence.verifiedAt,
      desktopLifecycle: evidence.desktopLifecycle,
      sha256: sha256(bytes),
    });
    if (pass === 2) {
      await copyToWorkspace(absolutePath, workspaceRoot, 'test-output/windows/acceptance.json');
      await copyToWorkspace(
        absolutePath,
        workspaceRoot,
        'test-output/windows/acceptance-passes/pass-2.json',
      );
    } else {
      await copyToWorkspace(
        absolutePath,
        workspaceRoot,
        'test-output/windows/acceptance-passes/pass-1.json',
      );
    }
  }

  summary.windowsWorkerPasses = windowsWorkerPasses;
  await writeWorkspaceFile(
    workspaceRoot,
    SUMMARY_RELATIVE_PATH,
    `${JSON.stringify(summary, null, 2)}\n`,
    true,
  );
  return summary;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [evidenceRoot, candidateSha, runId, attempt] = process.argv.slice(2);
  try {
    const summary = await restoreRetainedEvidence({
      evidenceRoot,
      workspaceRoot: process.cwd(),
      candidateSha,
      runId,
      attempt,
    });
    await bindWindowsWorkerPasses({
      workspaceRoot: process.cwd(),
      candidateSha,
      runId,
      attempt,
      pass1B64: process.env.WINDOWS_EVIDENCE_1_B64,
      pass2B64: process.env.WINDOWS_EVIDENCE_2_B64,
    });
    process.stdout.write(
      `restored and bound ${summary.sources.length} retained Linux evidence passes plus both Windows Worker passes\n`,
    );
  } catch (error) {
    process.stderr.write(
      `restore-retained-evidence failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
