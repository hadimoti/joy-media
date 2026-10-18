import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReadinessEvidence } from './create-readiness-evidence.mjs';
import { REQUIRED_SCENARIOS } from './readiness-evidence.js';

const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_ID = '444';
const ATTEMPT = '1';
const LANES = [
  'linux-real-services',
  'node-contracts',
  'windows-worker-clean',
  'acceptance-primary',
  'acceptance-responsive',
  'prod-build-smoke',
  'real-service-acceptance',
  'p3-real-services',
];
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;

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
  write(
    'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json',
    JSON.stringify(lifecycle(1)),
  );
  write(
    'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
    JSON.stringify(lifecycle(2)),
  );
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
  return { workspaceRoot, needsJson, write };
}

describe('createReadinessEvidence', () => {
  it('emits eight first-attempt scenarios only from green, source-bound two-pass evidence', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    const evidence = buildReadinessEvidence({
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      needsJson,
      now: new Date('2026-10-18T00:20:00.000Z'),
    });
    expect(evidence.scenarioResults).toHaveLength(8);
    expect(evidence.passCount).toBe(8);
    expect(evidence.retryCount).toBe(0);
    expect(evidence.installerArtifacts).toHaveLength(5);
    expect(
      evidence.installerArtifacts.every((artifact) => artifact.path.startsWith('remote/windows/')),
    ).toBe(true);
    expect(
      evidence.redactedHashes[
        'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json'
      ],
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('fails when any required workflow lane is missing or not successful', () => {
    const { workspaceRoot, needsJson } = prepareWorkspace();
    const needs = JSON.parse(needsJson) as Record<string, { result: string }>;
    needs['p3-real-services']!.result = 'failure';
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson: JSON.stringify(needs),
      }),
    ).toThrow(/not all green/u);
  });

  it('fails when the second pass tests a different setup artifact', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const stale = lifecycle(2);
    stale.desktopLifecycle.artifacts.candidateSetupSha256 = '9'.repeat(64);
    write(
      'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
      JSON.stringify(stale),
    );
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson,
      }),
    ).toThrow(/same exact candidate artifacts/u);
  });

  it('fails closed when either installed CLI launcher does not render playable video', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.cliAcceptance.joyMediaCmd.videoCodec = 'vp9';
    write(
      'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
      JSON.stringify(secondPass),
    );
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson,
      }),
    ).toThrow(/did not render playable H\.264\/AAC video through joyMediaCmd/u);
  });

  it('fails closed when a desktop install lifecycle transition is missing', () => {
    const { workspaceRoot, needsJson, write } = prepareWorkspace();
    const secondPass = lifecycle(2);
    secondPass.desktopLifecycle.transitions.repairCandidate = 'failed';
    write(
      'test-output/readiness/two-pass-evidence/windows/pass-2/acceptance.json',
      JSON.stringify(secondPass),
    );
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson,
      }),
    ).toThrow(/missing a required installer transition/u);
  });
});
