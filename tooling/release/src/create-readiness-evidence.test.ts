import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildReadinessEvidence } from './create-readiness-evidence.mjs';
import { REQUIRED_SCENARIOS, validateReadinessEvidence } from './readiness-evidence.js';

const CANDIDATE_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const RUN_ID = '444';
const ATTEMPT = '1';
const LANES = [
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
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const PASS_PATH = {
  1: 'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json',
  2: 'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
} as const;

function lifecycle(pass: number) {
  const artifacts = {
    candidateSetupSha256: 'c'.repeat(64),
    candidatePortableArchiveSha256: 'd'.repeat(64),
    candidateDesktopExecutableSha256: 'e'.repeat(64),
    candidateCliBundleSha256: 'f'.repeat(64),
    candidateWorkerExecutableSha256: '1'.repeat(64),
    previousSetupSha256: '3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04',
    previousArchiveSha256: '21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c',
    previousChecksumsSha256: 'a7b933f44ec82edd2f166dcde0bb013e1febd0ebbd19aa42dd49ac8e05adfe32',
    previousDesktopExecutableSha256: '2'.repeat(64),
    previousCliBundleSha256: '4'.repeat(64),
  };
  const containerIdentity = { containerId: '0123456789ab', imageDigest: IMAGE_DIGEST };
  const cliAcceptance = (launcherSha256: string, renderedMediaSha256: string) => ({
    status: 'passed',
    launcherSha256,
    desktopExecutableSha256: artifacts.candidateDesktopExecutableSha256,
    cliBundleSha256: artifacts.candidateCliBundleSha256,
    workerExecutableSha256: artifacts.candidateWorkerExecutableSha256,
    renderedMediaSha256,
    videoCodec: 'h264',
    audioCodec: 'aac',
    durationSeconds: 3,
  });
  const desktopLifecycle = {
    schemaVersion: 1,
    status: 'verified',
    candidateSha: CANDIDATE_SHA,
    workflowRunId: RUN_ID,
    attempt: Number(ATTEMPT),
    pass,
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    containerIdentity,
    versions: { previous: '1.0.1', candidate: '1.0.2' },
    artifacts,
    transitions: {
      installPrevious: 'passed',
      upgradeCandidate: 'passed',
      repairCandidate: 'passed',
      rollbackPrevious: 'passed',
      uninstall: 'passed',
      userDataPreserved: 'passed',
    },
    cliAcceptance: {
      joyCmd: cliAcceptance('5'.repeat(64), '6'.repeat(64)),
      joyMediaCmd: cliAcceptance('7'.repeat(64), '8'.repeat(64)),
    },
    editorAcceptance: { status: 'passed', firstAttemptPassed: true, retries: 0 },
    scenarios: REQUIRED_SCENARIOS.filter((id) => id !== 'release.exact-candidate-two-pass').map(
      (id) => ({
        id,
        status: 'passed',
        retries: 0,
        firstAttemptPassed: true,
      }),
    ),
    commands: [{ name: 'Windows lifecycle scenario loop', exitCode: 0 }],
    toolchain: {
      node: 'v24.0.0',
      pnpm: '11.15.0',
      electron: '44.3.0',
      ffmpeg: 'ffmpeg version 8.1.1',
      ffprobe: 'ffprobe version 8.1.1',
      windows: 'Microsoft Windows NT 10.0.20348.0',
    },
    startedAt: `2026-10-18T00:0${pass}:00.000Z`,
    finishedAt: `2026-10-18T00:1${pass}:00.000Z`,
  };
  return {
    schemaVersion: 2,
    status: 'verified',
    pass,
    candidateSha: CANDIDATE_SHA,
    workflowRunId: RUN_ID,
    attempt: Number(ATTEMPT),
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    containerIdentity,
    desktopLifecycle,
  };
}

function prepareWorkspace() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'joy-readiness-evidence-'));
  const write = (relativePath: string, contents: string) => {
    const absolute = join(workspaceRoot, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const remove = (relativePath: string) => rmSync(join(workspaceRoot, relativePath));
  write('apps/desktop/package.json', JSON.stringify({ version: '1.0.2' }));
  write('pnpm-lock.yaml', 'frozen lockfile fixture');
  write('packages/test-fixtures/media/manifest.json', '{"fixture":"readiness"}');
  write(
    'test-output/readiness/two-pass-evidence/manifest.json',
    JSON.stringify({
      schemaVersion: 1,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      sources: [
        { lane: 'real-service', pass: 1 },
        { lane: 'real-service', pass: 2 },
        { lane: 'p3', pass: 1 },
        { lane: 'p3', pass: 2 },
      ],
      windowsWorkerPasses: [{ pass: 1 }, { pass: 2 }],
    }),
  );
  write(PASS_PATH[1], JSON.stringify(lifecycle(1)));
  write(PASS_PATH[2], JSON.stringify(lifecycle(2)));
  write('test-output/windows/acceptance.json', JSON.stringify(lifecycle(2)));
  write('test-output/windows/acceptance-passes/pass-1.json', JSON.stringify(lifecycle(1)));
  write('test-output/windows/acceptance-passes/pass-2.json', JSON.stringify(lifecycle(2)));
  for (const path of [
    'test-output/browser/journeys.json',
    'test-output/release-performance/polling.json',
    'test-output/release-performance/effects-soak.json',
    'test-output/release-performance/timeline-integrity.json',
    'test-output/release-performance/editor.json',
    'test-output/delivery/result.json',
    'test-output/operations/restore.json',
    'test-output/operations/teardown.json',
    'test-output/ci-janitor/inventory.json',
  ])
    write(path, JSON.stringify({ retained: true }));
  const needsJson = JSON.stringify(
    Object.fromEntries(LANES.map((lane) => [lane, { result: 'success' }])),
  );
  return { workspaceRoot, needsJson, write, remove };
}

function writePass(
  write: (relativePath: string, contents: string) => void,
  pass: 1 | 2,
  receipt: unknown,
) {
  write(PASS_PATH[pass], JSON.stringify(receipt));
}

function build(workspaceRoot: string, needsJson: string, overrides: { headSha?: string } = {}) {
  return buildReadinessEvidence({
    workspaceRoot,
    candidateSha: CANDIDATE_SHA,
    headSha: overrides.headSha ?? CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: ATTEMPT,
    needsJson,
    now: new Date('2026-10-18T00:20:00.000Z'),
  });
}

describe('createReadinessEvidence', () => {
  it('keeps the readiness lane list identical to the release workflow gate-summary needs', () => {
    const workflow = readFileSync(
      fileURLToPath(
        new URL('../../../.github/workflows/release-candidate-v2.yml', import.meta.url),
      ),
      'utf8',
    );
    const block = /\n {2}gate-summary:[\s\S]*?\n {4}needs:\s*\[([\s\S]*?)\]/.exec(workflow);
    expect(block).not.toBeNull();
    const needs = block![1]!
      .split(',')
      .map((lane) => lane.trim())
      .filter(Boolean);
    expect([...needs].sort()).toEqual([...LANES].sort());
  });

  it('emits every required scenario from measured receipts with derived counts and a validator-clean record', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    const evidence = build(workspaceRoot, needsJson);
    expect(REQUIRED_SCENARIOS).toHaveLength(9);
    expect(evidence.scenarioResults.map((result: { id: string }) => result.id).sort()).toEqual(
      [...REQUIRED_SCENARIOS].sort(),
    );
    expect(evidence.passCount).toBe(REQUIRED_SCENARIOS.length);
    expect(evidence.failCount).toBe(0);
    expect(evidence.skipCount).toBe(0);
    expect(evidence.retryCount).toBe(0);
    expect(evidence.installerArtifacts).toHaveLength(5);
    expect(
      evidence.installerArtifacts.every((artifact: { path: string }) =>
        artifact.path.startsWith('remote/windows/'),
      ),
    ).toBe(true);
    expect(evidence.commands.map((command: { name: string }) => command.name)).toEqual(
      expect.arrayContaining(LANES.map((lane) => `lane: ${lane}`)),
    );
    expect(
      evidence.commands.some((command: { name: string }) => /all self-hosted/u.test(command.name)),
    ).toBe(false);
    expect(evidence.redactedHashes[PASS_PATH[1]]).toMatch(/^[0-9a-f]{64}$/u);
    expect(validateReadinessEvidence(evidence, CANDIDATE_SHA)).toEqual([]);
  });

  it('fails when any required workflow lane is missing or not successful', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    const needs = JSON.parse(needsJson) as Record<string, { result: string }>;
    needs['p3-real-services']!.result = 'failure';
    expect(() => build(workspaceRoot, JSON.stringify(needs))).toThrow(/not all green/u);
  });

  it('fails when a required lane is absent from the needs context', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    const needs = JSON.parse(needsJson) as Record<string, { result: string }>;
    delete needs['acceptance-responsive'];
    expect(() => build(workspaceRoot, JSON.stringify(needs))).toThrow(
      /not all green.*absent from needs/u,
    );
  });

  it('fails closed when the needs context is empty or not a JSON object', () => {
    const { workspaceRoot } = prepareWorkspace();
    expect(() => build(workspaceRoot, '')).toThrow(/not all green/u);
    expect(() => build(workspaceRoot, '[]')).toThrow(/not all green/u);
  });

  it('fails when the second pass tests a different setup artifact', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const stale = lifecycle(2);
    stale.desktopLifecycle.artifacts.candidateSetupSha256 = '9'.repeat(64);
    writePass(write, 2, stale);
    expect(() => build(workspaceRoot, needsJson)).toThrow(/same exact candidate artifacts/u);
  });

  it('fails closed when either installed CLI launcher does not render playable video', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.cliAcceptance.joyMediaCmd.videoCodec = 'vp9';
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /did not render playable H\.264\/AAC video through joyMediaCmd/u,
    );
  });

  it('fails closed when a desktop install lifecycle transition is missing', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.transitions.repairCandidate = 'failed';
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /missing a required installer transition/u,
    );
  });

  it('fails when a Windows pass has no measured result for a required scenario', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.scenarios = secondPass.desktopLifecycle.scenarios.filter(
      (entry) => entry.id !== 'desktop.app.restart-save-export',
    );
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /has no measured result for desktop\.app\.restart-save-export/u,
    );
  });

  it('fails when the export parity scenario is missing from a Windows pass', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const firstPass = lifecycle(1);
    firstPass.desktopLifecycle.scenarios = firstPass.desktopLifecycle.scenarios.filter(
      (entry) => entry.id !== 'desktop.export-media-semantics',
    );
    writePass(write, 1, firstPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /has no measured result for desktop\.export-media-semantics/u,
    );
  });

  it('rejects retry-only success in a required scenario', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    const entry = secondPass.desktopLifecycle.scenarios.find(
      (scenario) => scenario.id === 'cli.render.playable',
    );
    expect(entry).toBeDefined();
    entry!.firstAttemptPassed = false;
    entry!.retries = 1;
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /did not pass cli\.render\.playable on its first attempt/u,
    );
  });

  it('rejects a scenario that its receipt reports as failed', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const firstPass = lifecycle(1);
    const entry = firstPass.desktopLifecycle.scenarios.find(
      (scenario) => scenario.id === 'project.persistence.fresh-process',
    );
    expect(entry).toBeDefined();
    entry!.status = 'failed';
    writePass(write, 1, firstPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /reports project\.persistence\.fresh-process as failed/u,
    );
  });

  it('rejects a Windows receipt bound to another candidate SHA', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.candidateSha = OTHER_SHA;
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(/stale or has mismatched provenance/u);
  });

  it('rejects a workspace whose checked-out HEAD is not the candidate SHA', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    expect(() => build(workspaceRoot, needsJson, { headSha: OTHER_SHA })).toThrow(
      /does not match candidate SHA/u,
    );
  });

  it('rejects a two-pass summary that omits a Linux acceptance pass', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    write(
      'test-output/readiness/two-pass-evidence/manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        sources: [
          { lane: 'real-service', pass: 1 },
          { lane: 'real-service', pass: 2 },
          { lane: 'p3', pass: 1 },
        ],
        windowsWorkerPasses: [{ pass: 1 }, { pass: 2 }],
      }),
    );
    expect(() => build(workspaceRoot, needsJson)).toThrow(/does not bind four/u);
  });

  it('rejects a Windows receipt whose recorded command failed', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.commands[0]!.exitCode = 1;
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(/failed or missing command/u);
  });

  it('fails closed when a required Windows receipt is missing', () => {
    const { workspaceRoot, needsJson, remove } = prepareWorkspace();
    remove(PASS_PATH[2]);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /required two-pass evidence file is missing/u,
    );
  });

  it('rejects a re-run workflow attempt, because a re-run cannot prove first-attempt success', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        headSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: '2',
        needsJson,
      }),
    ).toThrow(/first workflow attempt/u);
  });

  it('rejects a scenario that needed a retry even though its first attempt passed', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    const entry = secondPass.desktopLifecycle.scenarios.find(
      (scenario) => scenario.id === 'cli.render.windows-entrypoints',
    );
    expect(entry).toBeDefined();
    entry!.retries = 1;
    writePass(write, 2, secondPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /needed 1 retries for cli\.render\.windows-entrypoints/u,
    );
  });

  it('rejects duplicate measured results for one scenario', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const firstPass = lifecycle(1);
    const original = firstPass.desktopLifecycle.scenarios.find(
      (scenario) => scenario.id === 'cli.render.playable',
    );
    expect(original).toBeDefined();
    firstPass.desktopLifecycle.scenarios.push({ ...original! });
    writePass(write, 1, firstPass);
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /duplicate measured results for cli\.render\.playable/u,
    );
  });

  it('rejects a two-pass summary that repeats one Linux pass', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    write(
      'test-output/readiness/two-pass-evidence/manifest.json',
      JSON.stringify({
        schemaVersion: 1,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        sources: [
          { lane: 'real-service', pass: 1 },
          { lane: 'real-service', pass: 1 },
          { lane: 'p3', pass: 1 },
          { lane: 'p3', pass: 2 },
        ],
        windowsWorkerPasses: [{ pass: 1 }, { pass: 2 }],
      }),
    );
    expect(() => build(workspaceRoot, needsJson)).toThrow(
      /missing a required Linux acceptance pass/u,
    );
  });

  it('refuses to build evidence without a valid candidate SHA or run id', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: 'not-a-sha',
        headSha: 'not-a-sha',
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson,
      }),
    ).toThrow(/candidate SHA is invalid/u);
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        headSha: CANDIDATE_SHA,
        runId: 'run-x',
        attempt: ATTEMPT,
        needsJson,
      }),
    ).toThrow(/workflow run id is invalid/u);
  });
});
