/* global process */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGateSummary } from './ci-gate-summary.ts';
import {
  REQUIRED_SCENARIOS,
  requiredScenariosFor,
  validateReadinessEvidence,
} from './readiness-evidence.ts';
import { parseChecksumFile, verifyArtifacts } from './artifact-integrity.mjs';

// Every value in the emitted record is derived from authenticated execution evidence:
// the workflow's `needs` context, the two exact Windows lifecycle receipts, the two-pass
// summary, and the checked-out tree. Anything missing, failed, first-attempt-only or
// inconsistent makes the build throw, so no record is written. Nothing is filled in
// from a constant.
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
const TWO_PASS_SCENARIO = 'release.exact-candidate-two-pass';
// Every required scenario except the two-pass verdict is measured by the Windows
// installed-lifecycle receipt of each exact pass. Deriving the list from the validator's
// inventory keeps the producer and the gate from drifting apart.
const LIFECYCLE_SCENARIOS = REQUIRED_SCENARIOS.filter((id) => id !== TWO_PASS_SCENARIO);
// The lifecycle scenarios of a topology: its required inventory without its own verdict scenario.
function lifecycleScenariosFor(topology) {
  const verdict = shapeFor(topology).verdict;
  return requiredScenariosFor(topology).filter((id) => id !== verdict);
}
// The release artifacts the gate verifies, under the names the packager and the installer build
// write to apps/desktop/dist/releases. The portable archive carries the candidate version, and the
// setup line is appended to SHA256SUMS.txt by build-installer.ps1 after the packager has run.
function releaseArtifacts(version) {
  return [
    ['joy-media-setup.exe', 'candidateSetupSha256'],
    [`joy-media-windows-x64-v${version}.zip`, 'candidatePortableArchiveSha256'],
    ['joy-media.exe', 'candidateDesktopExecutableSha256'],
    ['joy-media-bundle.mjs', 'candidateCliBundleSha256'],
    ['joy-worker.exe', 'candidateWorkerExecutableSha256'],
  ];
}
const TWO_PASS_SUMMARY = 'test-output/readiness/two-pass-evidence/manifest.json';
// Artifact bytes, the independent checksum file and the release manifest, as retained by the
// evidence store. Expected digests come only from the checksum file, never from a receipt.
const ARTIFACT_ROOT = 'test-output/readiness/artifacts';

function readRequiredText(root, relativePath) {
  const absolute = evidencePath(root, relativePath);
  if (!existsSync(absolute)) fail(`required artifact integrity file is missing: ${relativePath}`);
  return readFileSync(absolute, 'utf8');
}

function readRequiredJson(root, relativePath) {
  try {
    return JSON.parse(readRequiredText(root, relativePath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail(`required artifact integrity file is invalid JSON: ${relativePath}`);
    }
    throw error;
  }
}
const WINDOWS_PASS_PATHS = [
  'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json',
  'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
];
const REDACTED_INPUT_PATHS = [
  TWO_PASS_SUMMARY,
  `${ARTIFACT_ROOT}/SHA256SUMS.txt`,
  `${ARTIFACT_ROOT}/joy-media-release-manifest.json`,
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

// The two gate topologies (plan §3.4). The two-pass shape is the production gate (release-candidate-v2), and its values
// above are unchanged. The single-pass shape is for release-candidate-v3: one Windows pass, one real-service pass and one P3
// pass, each written under its own folder. Each topology's values are fixed here, so no caller can choose a shape that is
// not listed.
const SINGLE_PASS_VERDICT = 'release.exact-candidate';
const SINGLE_PASS_SUMMARY = 'test-output/readiness/single-pass-evidence/manifest.json';
const SINGLE_PASS_WINDOWS_PATHS = [
  'test-output/readiness/single-pass-evidence/windows/pass-1/acceptance.json',
];
// The single-pass gate runs the same nine lanes as v2, each once. Its job graph is pinned by release-candidate-v3.test.ts.
const SINGLE_PASS_LANES = RELEASE_LANES;
// `messages` keeps the two-pass wording exactly as the existing tests assert it.
export const SHAPES = {
  'two-pass': {
    lanes: RELEASE_LANES,
    verdict: TWO_PASS_SCENARIO,
    summaryPath: TWO_PASS_SUMMARY,
    windowsPaths: WINDOWS_PASS_PATHS,
    sourceKeys: 'p3:1,p3:2,real-service:1,real-service:2',
    sourceCount: 4,
    windowsPassNumbers: '1,2',
    redactedInputPaths: REDACTED_INPUT_PATHS,
    evidenceLabel: 'two-pass evidence',
    messages: {
      sourceCount:
        'two-pass summary does not bind four real-service/P3 passes to this candidate and run',
      sourceKeys: 'two-pass summary is missing a required Linux acceptance pass',
      windowsCount: 'two-pass summary does not contain both Windows acceptance passes',
      windowsNumbers: 'two-pass summary does not list Windows passes 1 and 2 exactly once',
      windowsDigest: (pass) =>
        `Windows pass ${pass} receipt does not match the digest recorded in the two-pass summary`,
    },
  },
  'single-pass': {
    lanes: SINGLE_PASS_LANES,
    verdict: SINGLE_PASS_VERDICT,
    summaryPath: SINGLE_PASS_SUMMARY,
    windowsPaths: SINGLE_PASS_WINDOWS_PATHS,
    sourceKeys: 'p3:1,real-service:1',
    sourceCount: 2,
    windowsPassNumbers: '1',
    redactedInputPaths: [
      ...REDACTED_INPUT_PATHS.filter(
        (path) =>
          !path.includes('two-pass-evidence') && !path.endsWith('acceptance-passes/pass-2.json'),
      ),
      SINGLE_PASS_SUMMARY,
      ...SINGLE_PASS_WINDOWS_PATHS,
    ],
    evidenceLabel: 'single-pass evidence',
    messages: {
      sourceCount:
        'single-pass summary does not bind two Linux acceptance passes to this candidate and run',
      sourceKeys: 'single-pass summary is missing a required Linux acceptance pass',
      windowsCount: 'single-pass summary does not contain the Windows acceptance pass',
      windowsNumbers: 'single-pass summary does not list Windows pass 1 exactly once',
      windowsDigest: (pass) =>
        `Windows pass ${pass} receipt does not match the digest recorded in the single-pass summary`,
    },
  },
};

/** The shape of one topology. Anything other than the two listed names is refused. */
function shapeFor(topology) {
  const shape = SHAPES[topology];
  if (shape === undefined) throw new Error(`unknown gate topology: ${String(topology)}`);
  return shape;
}

function fail(message) {
  throw new Error(message);
}

// Every evidence input resolves inside the workspace, so a relative path cannot reach a file outside
// it. Each reader below goes through this check.
function evidencePath(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!absolute.startsWith(`${resolve(root)}${sep}`)) {
    fail('readiness evidence input escaped the workspace');
  }
  return absolute;
}

function readJson(root, relativePath) {
  const absolute = evidencePath(root, relativePath);
  if (!existsSync(absolute)) fail(`required two-pass evidence file is missing: ${relativePath}`);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch {
    fail(`required two-pass evidence file is invalid JSON: ${relativePath}`);
  }
}

// Reads a receipt and the digest of its exact bytes, so the two-pass summary can bind it.
function readReceipt(root, relativePath) {
  const absolute = evidencePath(root, relativePath);
  if (!existsSync(absolute)) fail(`required two-pass evidence file is missing: ${relativePath}`);
  const bytes = readFileSync(absolute);
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`required two-pass evidence file is invalid JSON: ${relativePath}`);
  }
  return { evidence, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function hashFile(root, relativePath) {
  const bytes = readFileSync(evidencePath(root, relativePath));
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
  const requiredTransitions = [
    'installPrevious',
    'upgradeCandidate',
    'repairCandidate',
    'rollbackToKeptPrevious',
    'updateRefusedWhileFileHeld',
    'tamperedUpdateRefused',
    'wrongKeyManifestRefused',
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

// Each exact pass must report its own measured result for every lifecycle scenario. A
// scenario counts only when the pass reports it as passed, on its first attempt, with
// zero retries. A missing entry fails closed.
function measuredOutcomes(lifecycle, pass, scenarios = LIFECYCLE_SCENARIOS) {
  return new Map(
    scenarios.map((id) => {
      const matches = (lifecycle.scenarios ?? []).filter((candidate) => candidate?.id === id);
      if (matches.length > 1) {
        fail(`Windows desktop lifecycle pass ${pass} has duplicate measured results for ${id}`);
      }
      const entry = matches[0];
      if (entry === undefined) {
        fail(`Windows desktop lifecycle pass ${pass} has no measured result for ${id}`);
      }
      if (entry.status !== 'passed') {
        fail(`Windows desktop lifecycle pass ${pass} reports ${id} as ${String(entry.status)}`);
      }
      if (entry.firstAttemptPassed !== true) {
        fail(`Windows desktop lifecycle pass ${pass} did not pass ${id} on its first attempt`);
      }
      if (entry.retries !== 0) {
        fail(
          `Windows desktop lifecycle pass ${pass} needed ${String(entry.retries)} retries for ${id}; zero retries are required`,
        );
      }
      return [
        id,
        {
          status: entry.status,
          firstAttemptPassed: entry.firstAttemptPassed,
          retries: entry.retries,
        },
      ];
    }),
  );
}

export function buildReadinessEvidence({
  workspaceRoot,
  candidateSha,
  headSha,
  runId,
  attempt,
  needsJson,
  now = new Date(),
  topology = 'two-pass',
}) {
  const shape = shapeFor(topology);
  const lifecycleScenarios = lifecycleScenariosFor(topology);
  const root = resolve(workspaceRoot);
  if (!/^[0-9a-f]{40}$/u.test(candidateSha ?? '')) fail('candidate SHA is invalid');
  if (headSha !== candidateSha) {
    fail(
      `checked-out HEAD ${String(headSha)} does not match candidate SHA ${String(candidateSha)}`,
    );
  }
  if (!/^[0-9]+$/u.test(runId ?? '')) fail('workflow run id is invalid');
  if (!/^[1-9][0-9]*$/u.test(attempt ?? '')) fail('workflow attempt is invalid');
  if (attempt !== '1') {
    fail(
      'readiness requires the first workflow attempt; a re-run cannot prove first-attempt success',
    );
  }
  const lanes = evaluateGateSummary(needsJson ?? '', shape.lanes.join(','));
  if (!lanes.ok)
    fail(`required self-hosted CI lanes are not all green: ${lanes.reasons.join('; ')}`);
  const needs = JSON.parse(needsJson);
  const laneCommands = shape.lanes.map((lane) => ({
    name: `lane: ${lane}`,
    exitCode: needs[lane].result === 'success' ? 0 : 1,
  }));

  const desktopPackage = readJson(root, 'apps/desktop/package.json');
  const releaseFiles = releaseArtifacts(desktopPackage.version);
  const summary = readJson(root, shape.summaryPath);
  if (
    summary.schemaVersion !== 1 ||
    summary.candidateSha !== candidateSha ||
    summary.runId !== runId ||
    summary.attempt !== attempt ||
    !Array.isArray(summary.sources) ||
    summary.sources.length !== shape.sourceCount
  ) {
    fail(shape.messages.sourceCount);
  }
  const sourceKeys = summary.sources.map((source) => `${source.lane}:${source.pass}`).sort();
  if (sourceKeys.join(',') !== shape.sourceKeys) {
    fail(shape.messages.sourceKeys);
  }
  const windowsCount = shape.windowsPassNumbers.split(',').length;
  if (
    !Array.isArray(summary.windowsWorkerPasses) ||
    summary.windowsWorkerPasses.length !== windowsCount
  ) {
    fail(shape.messages.windowsCount);
  }

  // The summary records a digest of each Windows receipt. Every receipt must match its recorded digest byte for
  // byte, and each pass of this topology must appear exactly once.
  const summaryPassNumbers = summary.windowsWorkerPasses.map((entry) => entry?.pass).sort();
  if (summaryPassNumbers.join(',') !== shape.windowsPassNumbers) {
    fail(shape.messages.windowsNumbers);
  }
  const receipts = shape.windowsPaths.map((path) => readReceipt(root, path));
  receipts.forEach((receipt, index) => {
    const entry = summary.windowsWorkerPasses.find((candidate) => candidate?.pass === index + 1);
    if (entry?.sha256 !== receipt.sha256) {
      fail(shape.messages.windowsDigest(index + 1));
    }
  });
  const windowsEvidence = receipts.map((receipt) => receipt.evidence);
  const lifecycles = windowsEvidence.map((evidence, index) =>
    assertLifecycle(evidence, { candidateSha, runId, attempt, pass: index + 1 }),
  );
  const outcomes = lifecycles.map((lifecycle, index) =>
    measuredOutcomes(lifecycle, index + 1, lifecycleScenarios),
  );
  const first = lifecycles[0];
  // A second pass, when the topology has one, must match the first pass exactly. A single pass has nothing to match.
  const others = lifecycles.slice(1);
  const artifactKeys = releaseFiles.map(([, key]) => key);
  if (
    others.some(
      (other) =>
        first.versions.candidate !== other.versions.candidate ||
        first.containerIdentity.containerId !== other.containerIdentity.containerId ||
        first.containerIdentity.imageDigest !== other.containerIdentity.imageDigest ||
        artifactKeys.some((key) => first.artifacts[key] !== other.artifacts[key]),
    )
  ) {
    fail(
      'Windows acceptance passes do not use the same exact candidate artifacts and runner container',
    );
  }
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
    others.some((other) =>
      ['node', 'pnpm', 'electron', 'ffmpeg', 'ffprobe', 'windows'].some(
        (name) => first.toolchain[name] !== other.toolchain[name],
      ),
    )
  ) {
    fail('Windows lifecycle toolchain changed between its two acceptance passes');
  }

  const lockfileSha256 = hashFile(root, 'pnpm-lock.yaml');
  const fixtureManifestSha256 = hashFile(root, 'packages/test-fixtures/media/manifest.json');
  const sourceEvidencePath = shape.windowsPaths[0];
  // Expected digests come from the independent checksum file, and the release manifest must agree
  // with it. Observed digests come from hashing the artifact bytes. The Windows receipts are only
  // cross-checked against the checksum file, and a receipt never supplies the expected value.
  const checksums = parseChecksumFile(readRequiredText(root, `${ARTIFACT_ROOT}/SHA256SUMS.txt`));
  const releaseManifest = readRequiredJson(
    root,
    `${ARTIFACT_ROOT}/joy-media-release-manifest.json`,
  );
  const verifiedArtifacts = verifyArtifacts({
    artifacts: releaseFiles.map(([fileName, key]) => {
      const digest = first.artifacts[key];
      if (!/^[0-9a-f]{64}$/u.test(digest ?? ''))
        fail(`Windows artifact hash is invalid for ${fileName}`);
      return { name: fileName, receiptSha256: digest };
    }),
    checksums,
    bytesByName: (name) => {
      const absolute = evidencePath(root, `${ARTIFACT_ROOT}/${name}`);
      return existsSync(absolute) ? readFileSync(absolute) : null;
    },
    candidateSha,
    releaseManifest,
    // The packager records the four artifacts it hashes in the release manifest. The setup is only
    // added to SHA256SUMS.txt after the packager has run, so it is not expected in the manifest.
    recordedNames: releaseFiles
      .map(([fileName]) => fileName)
      .filter((fileName) => fileName !== 'joy-media-setup.exe'),
  });
  const installerArtifacts = verifiedArtifacts.map((artifact, index) => ({
    path: `remote/windows/${artifact.name}`,
    expectedSha256: artifact.expectedSha256,
    observedSha256: artifact.observedSha256,
    sourceEvidencePath,
    sourceEvidenceKey: `desktopLifecycle.artifacts.${releaseFiles[index][1]}`,
  }));

  const redactedPaths = [...new Set(shape.redactedInputPaths)].sort();
  const redactedHashes = Object.fromEntries(
    redactedPaths.map((path) => [path, hashFile(root, path)]),
  );

  // Scenario results are copied from the measured entries of the exact passes.
  const scenarioResults = lifecycleScenarios.map((id) => ({ id, ...outcomes[0].get(id) }));
  const everyPass = shape.windowsPassNumbers.includes(',');
  const twoPassRequirements = [
    ['every required lane succeeded in the workflow needs context', lanes.ok],
    [
      everyPass
        ? 'both exact Windows passes verified against this candidate and run'
        : 'the exact Windows pass verified against this candidate and run',
      lifecycles.length === windowsCount,
    ],
    [
      everyPass
        ? 'every lifecycle scenario measured as passed on its first attempt in both passes'
        : 'every lifecycle scenario measured as passed on its first attempt in the pass',
      outcomes.every((map) =>
        lifecycleScenarios.every((id) => {
          const outcome = map.get(id);
          return (
            outcome?.status === 'passed' &&
            outcome.firstAttemptPassed === true &&
            outcome.retries === 0
          );
        }),
      ),
    ],
    ['checked-out HEAD equals the candidate SHA', headSha === candidateSha],
  ];
  const unmet = twoPassRequirements.filter(([, met]) => met !== true).map(([label]) => label);
  if (unmet.length > 0) fail(`${shape.verdict} is not satisfied: ${unmet.join('; ')}`);
  scenarioResults.push({
    id: shape.verdict,
    status: 'passed',
    retries: 0,
    firstAttemptPassed: true,
  });

  const commands = [
    ...lifecycles.flatMap((lifecycle, index) =>
      lifecycle.commands.map((command) => ({
        name: `windows-pass-${index + 1}: ${command.name}`,
        exitCode: command.exitCode,
      })),
    ),
    ...laneCommands,
  ];
  const startedAt = lifecycles
    .map((lifecycle) => Date.parse(lifecycle.startedAt))
    .sort((a, b) => a - b)[0];
  const endedAt = lifecycles
    .map((lifecycle) => Date.parse(lifecycle.finishedAt))
    .sort((a, b) => b - a)[0];
  const evidence = {
    schemaVersion: 1,
    // Only single-pass evidence names its topology; a two-pass record keeps its existing shape.
    ...(topology === 'single-pass' ? { topology } : {}),
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
    passCount: scenarioResults.filter((result) => result.status === 'passed').length,
    failCount: scenarioResults.filter((result) => result.status === 'failed').length,
    skipCount: scenarioResults.filter((result) => result.status === 'skipped').length,
    retryCount: scenarioResults.reduce((total, result) => total + result.retries, 0),
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
    const workspaceRoot = process.cwd();
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    }).trim();
    const topology = process.env.READINESS_TOPOLOGY ?? 'two-pass';
    const evidence = buildReadinessEvidence({
      workspaceRoot,
      candidateSha: process.env.CANDIDATE_SHA,
      headSha,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      needsJson: process.env.NEEDS_JSON,
      topology,
    });
    const outputPath = join(workspaceRoot, 'test-output/readiness/evidence.json');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    const passes = topology === 'single-pass' ? 'one pass' : 'two passes';
    process.stdout.write(
      `Readiness evidence verified for ${evidence.passCount} exact-candidate scenarios across ${passes}.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `create-readiness-evidence failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}
