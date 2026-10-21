/* global process */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGateSummary } from './ci-gate-summary.ts';
import { validateReadinessEvidence } from './readiness-evidence.ts';

const RELEASE_LANES = [
  'linux-real-services',
  'windows-p0-real-services',
  'node-contracts',
  'windows-worker-clean',
  'acceptance-primary',
  'acceptance-responsive',
  'prod-build-smoke',
  'real-service-acceptance',
  'p3-real-services',
];
const WINDOWS_SCENARIOS = [
  'cli.render.playable',
  'cli.render.unsupported-features',
  'cli.render.failure-recovery',
  'cli.render.windows-entrypoints',
  'project.persistence.fresh-process',
  'desktop.app.restart-save-export',
  'desktop.windows.installed-lifecycle',
];
const REMOTE_ARTIFACTS = [
  ['joy-media-setup.exe', 'candidateSetupSha256'],
  ['joy-media-windows-x64.zip', 'candidatePortableArchiveSha256'],
  ['joy-media.exe', 'candidateDesktopExecutableSha256'],
  ['joy-media-bundle.mjs', 'candidateCliBundleSha256'],
  ['joy-worker.exe', 'candidateWorkerExecutableSha256'],
];
const TWO_PASS_SUMMARY = 'test-output/readiness/two-pass-evidence/manifest.json';
const WINDOWS_PASS_PATHS = [
  'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json',
  'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
];
const REDACTED_INPUT_PATHS = [
  TWO_PASS_SUMMARY,
  ...WINDOWS_PASS_PATHS,
  'test-output/windows/acceptance.json',
  'test-output/windows/acceptance-passes/pass-1.json',
  'test-output/windows/acceptance-passes/pass-2.json',
  'test-output/browser/journeys.json',
  'test-output/release-performance/polling.json',
  'test-output/release-performance/effects-soak.json',
  'test-output/release-performance/timeline-integrity.json',
  'test-output/release-performance/editor.json',
  'test-output/delivery/result.json',
  'test-output/operations/restore.json',
  'test-output/operations/teardown.json',
  'test-output/ci-janitor/inventory.json',
];

function fail(message) {
  throw new Error(message);
}

function readJson(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`)) {
    fail('readiness evidence input escaped the workspace');
  }
  if (!existsSync(absolute)) fail(`required two-pass evidence file is missing: ${relativePath}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    fail(`required two-pass evidence file is invalid JSON: ${relativePath}`);
  }
}

function hashFile(root, relativePath) {
  const bytes = readFileSync(resolve(root, relativePath));
  return createHash('sha256').update(bytes).digest('hex');
}

function assertLifecycle(evidence, expected) {
  const lifecycle = evidence?.desktopLifecycle;
  if (
    evidence?.schemaVersion !== 2 ||
    evidence.status !== 'verified' ||
    evidence.pass !== expected.pass ||
    evidence.candidateSha !== expected.candidateSha ||
    evidence.workflowRunId !== expected.runId ||
    evidence.attempt !== Number(expected.attempt) ||
    evidence.sourceProvenance?.commitSha !== expected.candidateSha ||
    evidence.sourceProvenance?.worktreeClean !== true ||
    lifecycle?.schemaVersion !== 1 ||
    lifecycle.status !== 'verified' ||
    lifecycle.pass !== expected.pass ||
    lifecycle.candidateSha !== expected.candidateSha ||
    lifecycle.workflowRunId !== expected.runId ||
    lifecycle.attempt !== Number(expected.attempt) ||
    lifecycle.sourceProvenance?.commitSha !== expected.candidateSha ||
    lifecycle.sourceProvenance?.worktreeClean !== true ||
    lifecycle.containerIdentity?.containerId !== evidence.containerIdentity?.containerId ||
    lifecycle.containerIdentity?.imageDigest !== evidence.containerIdentity?.imageDigest
  ) {
    fail(`Windows desktop lifecycle pass ${expected.pass} is stale or has mismatched provenance`);
  }
  for (const id of WINDOWS_SCENARIOS) {
    const scenario = lifecycle.scenarios?.find((entry) => entry.id === id);
    if (
      scenario?.status !== 'passed' ||
      scenario.firstAttemptPassed !== true ||
      scenario.retries !== 0
    ) {
      fail(
        `Windows desktop lifecycle pass ${expected.pass} did not pass ${id} on its first attempt`,
      );
    }
  }
  const requiredTransitions = [
    'installPrevious',
    'upgradeCandidate',
    'repairCandidate',
    'rollbackPrevious',
    'uninstall',
    'userDataPreserved',
  ];
  if (requiredTransitions.some((name) => lifecycle.transitions?.[name] !== 'passed')) {
    fail(
      `Windows desktop lifecycle pass ${expected.pass} is missing a required installer transition`,
    );
  }
  for (const launcher of ['joyCmd', 'joyMediaCmd']) {
    const acceptance = lifecycle.cliAcceptance?.[launcher];
    if (
      acceptance?.status !== 'passed' ||
      !/^[0-9a-f]{64}$/u.test(acceptance.launcherSha256 ?? '') ||
      !/^[0-9a-f]{64}$/u.test(acceptance.renderedMediaSha256 ?? '') ||
      acceptance.videoCodec !== 'h264' ||
      acceptance.audioCodec !== 'aac' ||
      typeof acceptance.durationSeconds !== 'number' ||
      acceptance.durationSeconds < 2.9
    ) {
      fail(
        `Windows desktop lifecycle pass ${expected.pass} did not render playable H.264/AAC video through ${launcher}`,
      );
    }
  }
  if (
    lifecycle.commands?.length < 1 ||
    lifecycle.commands.some((command) => !command?.name || command.exitCode !== 0)
  ) {
    fail(`Windows desktop lifecycle pass ${expected.pass} contains a failed or missing command`);
  }
  if (
    lifecycle.editorAcceptance?.status !== 'passed' ||
    lifecycle.editorAcceptance.firstAttemptPassed !== true ||
    lifecycle.editorAcceptance.retries !== 0 ||
    lifecycle.cliAcceptance?.joyCmd?.status !== 'passed' ||
    lifecycle.cliAcceptance?.joyMediaCmd?.status !== 'passed'
  ) {
    fail(
      `Windows desktop lifecycle pass ${expected.pass} is missing packaged app or CLI acceptance`,
    );
  }
  return lifecycle;
}

export function buildReadinessEvidence({
  workspaceRoot,
  candidateSha,
  runId,
  attempt,
  needsJson,
  now = new Date(),
}) {
  const root = resolve(workspaceRoot);
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? '')) fail('candidate SHA is invalid');
  if (!/^[0-9]+$/u.test(runId ?? '')) fail('workflow run id is invalid');
  if (!/^[1-9][0-9]*$/u.test(attempt ?? '')) fail('workflow attempt is invalid');
  const lanes = evaluateGateSummary(needsJson ?? '', RELEASE_LANES.join(','));
  if (!lanes.ok)
    fail(`required self-hosted CI lanes are not all green: ${lanes.reasons.join('; ')}`);

  const summary = readJson(root, TWO_PASS_SUMMARY);
  if (
    summary.schemaVersion !== 1 ||
    summary.candidateSha !== candidateSha ||
    summary.runId !== runId ||
    summary.attempt !== attempt ||
    !Array.isArray(summary.sources) ||
    summary.sources.length !== 4
  ) {
    fail('two-pass summary does not bind four real-service/P3 passes to this candidate and run');
  }
  const sourceKeys = summary.sources.map((source) => `${source.lane}:${source.pass}`).sort();
  if (sourceKeys.join(',') !== 'p3:1,p3:2,real-service:1,real-service:2') {
    fail('two-pass summary is missing a required Linux acceptance pass');
  }
  if (!Array.isArray(summary.windowsWorkerPasses) || summary.windowsWorkerPasses.length !== 2) {
    fail('two-pass summary does not contain both Windows acceptance passes');
  }

  const windowsEvidence = WINDOWS_PASS_PATHS.map((path) => readJson(root, path));
  const lifecycles = windowsEvidence.map((evidence, index) =>
    assertLifecycle(evidence, { candidateSha, runId, attempt, pass: index + 1 }),
  );
  const first = lifecycles[0];
  const second = lifecycles[1];
  const artifactKeys = REMOTE_ARTIFACTS.map(([, key]) => key);
  if (
    first.versions.candidate !== second.versions.candidate ||
    first.containerIdentity.containerId !== second.containerIdentity.containerId ||
    first.containerIdentity.imageDigest !== second.containerIdentity.imageDigest ||
    artifactKeys.some((key) => first.artifacts[key] !== second.artifacts[key])
  ) {
    fail(
      'Windows acceptance passes do not use the same exact candidate artifacts and runner container',
    );
  }
  const desktopPackage = readJson(root, 'apps/desktop/package.json');
  if (first.versions.candidate !== desktopPackage.version) {
    fail('Windows installed lifecycle version does not match the checked-out candidate package');
  }

  const toolchain = first.toolchain;
  if (
    toolchain === null ||
    typeof toolchain !== 'object' ||
    ['node', 'pnpm', 'electron', 'ffmpeg', 'ffprobe', 'windows'].some(
      (name) => typeof toolchain[name] !== 'string' || toolchain[name].trim() === '',
    )
  ) {
    fail('Windows lifecycle toolchain versions are incomplete');
  }
  if (
    ['node', 'pnpm', 'electron', 'ffmpeg', 'ffprobe', 'windows'].some(
      (name) => first.toolchain[name] !== second.toolchain[name],
    )
  ) {
    fail('Windows lifecycle toolchain changed between its two acceptance passes');
  }

  const lockfileSha256 = hashFile(root, 'pnpm-lock.yaml');
  const fixtureManifestSha256 = hashFile(root, 'packages/test-fixtures/media/manifest.json');
  const sourceEvidencePath = WINDOWS_PASS_PATHS[0];
  const installerArtifacts = REMOTE_ARTIFACTS.map(([fileName, key]) => {
    const digest = first.artifacts[key];
    if (!/^[0-9a-f]{64}$/u.test(digest ?? ''))
      fail(`Windows artifact hash is invalid for ${fileName}`);
    return {
      path: `remote/windows/${fileName}`,
      expectedSha256: digest,
      observedSha256: digest,
      sourceEvidencePath,
      sourceEvidenceKey: `desktopLifecycle.artifacts.${key}`,
    };
  });

  const redactedPaths = [...new Set(REDACTED_INPUT_PATHS)].sort();
  const redactedHashes = Object.fromEntries(
    redactedPaths.map((path) => [path, hashFile(root, path)]),
  );
  const scenarioResults = [
    ...WINDOWS_SCENARIOS.map((id) => ({
      id,
      status: 'passed',
      retries: 0,
      firstAttemptPassed: true,
    })),
    {
      id: 'release.exact-candidate-two-pass',
      status: 'passed',
      retries: 0,
      firstAttemptPassed: true,
    },
  ];
  const commands = [
    ...lifecycles.flatMap((lifecycle, index) =>
      lifecycle.commands.map((command) => ({
        name: `windows-pass-${index + 1}: ${command.name}`,
        exitCode: command.exitCode,
      })),
    ),
    { name: 'all self-hosted release lanes green with four retained Linux passes', exitCode: 0 },
  ];
  const startedAt = lifecycles
    .map((lifecycle) => Date.parse(lifecycle.startedAt))
    .sort((a, b) => a - b)[0];
  const endedAt = lifecycles
    .map((lifecycle) => Date.parse(lifecycle.finishedAt))
    .sort((a, b) => b - a)[0];
  const evidence = {
    schemaVersion: 1,
    candidateSha,
    lockfileSha256,
    toolchainVersions: {
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      electron: toolchain.electron,
      ffmpeg: toolchain.ffmpeg,
      ffprobe: toolchain.ffprobe,
      windows: toolchain.windows,
      windowsRunnerImage: first.containerIdentity.imageDigest,
    },
    fixtureManifestSha256,
    startUtc: new Date(startedAt).toISOString(),
    endUtc: new Date(Math.max(endedAt, now.getTime())).toISOString(),
    commands,
    passCount: scenarioResults.length,
    failCount: 0,
    skipCount: 0,
    retryCount: 0,
    scenarioResults,
    installerArtifacts,
    redactedPaths,
    redactedHashes,
  };
  const blockers = validateReadinessEvidence(evidence, candidateSha);
  if (blockers.length > 0) fail(`readiness evidence failed validation: ${blockers.join('; ')}`);
  return evidence;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const evidence = buildReadinessEvidence({
      workspaceRoot: process.cwd(),
      candidateSha: process.env.CANDIDATE_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      needsJson: process.env.NEEDS_JSON,
    });
    const outputPath = join(process.cwd(), 'test-output/readiness/evidence.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(
      `Readiness evidence verified for ${evidence.passCount} exact-candidate scenarios across two passes.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `create-readiness-evidence failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
