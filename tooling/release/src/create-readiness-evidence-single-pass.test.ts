import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReadinessEvidence } from './create-readiness-evidence.mjs';
import {
  REQUIRED_SCENARIOS,
  REQUIRED_SCENARIOS_SINGLE_PASS,
  SINGLE_PASS_VERDICT_SCENARIO,
  TWO_PASS_VERDICT_SCENARIO,
  validateReadinessEvidence,
} from './readiness-evidence.js';

// The single-pass topology (release-candidate-v3, plan §3.4). These tests build the topology's own fixture: one Windows
// pass, one real-service pass and one P3 pass. Every value is written to disk, so each refusal below comes from the builder.
const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_ID = '555';
const ATTEMPT = '1';
const SINGLE_LANES = [
  'hosted-verify',
  'linux-real-services',
  'windows-candidate',
  'node-contracts',
  'fixture-acceptance',
  'acceptance-responsive',
  'real-service-acceptance',
  'p3-real-services',
];
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const SUMMARY = 'test-output/readiness/single-pass-evidence/manifest.json';
const WINDOWS_PASS = 'test-output/readiness/single-pass-evidence/windows/pass-1/acceptance.json';
const PORTABLE_ARCHIVE = 'joy-media-windows-x64-v1.0.3.zip';
const RELEASE_MANIFEST = 'test-output/readiness/artifacts/joy-media-release-manifest.json';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let workspaceRoot = '';
let candidateDigests: Record<string, string> = {};

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'joy-readiness-single-pass-'));
  prepareWorkspace();
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function write(relativePath: string, contents: string) {
  const absolute = join(workspaceRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function lifecycle(overrides: Record<string, unknown> = {}) {
  const artifacts = {
    candidateSetupSha256: candidateDigests['joy-media-setup.exe'],
    candidatePortableArchiveSha256: candidateDigests[PORTABLE_ARCHIVE],
    candidateDesktopExecutableSha256: candidateDigests['joy-media.exe'],
    candidateCliBundleSha256: candidateDigests['joy-media-bundle.mjs'],
    candidateWorkerExecutableSha256: candidateDigests['joy-worker.exe'],
    previousSetupSha256: '6d8089467afaecc1d78d272f5c029d6c186a81f7aac90a7cd584045e847bdabe',
    previousArchiveSha256: 'e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca',
    previousChecksumsSha256: '9e15f9b45307293a33414b1f89461859c7c5fcdcdf69f7b3f03e491cae55a8eb',
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
    pass: 1,
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    containerIdentity,
    versions: { previous: '1.0.2', candidate: '1.0.3' },
    artifacts,
    transitions: {
      installPrevious: 'passed',
      upgradeCandidate: 'passed',
      repairCandidate: 'passed',
      rollbackToKeptPrevious: 'passed',
      updateRefusedWhileFileHeld: 'passed',
      tamperedUpdateRefused: 'passed',
      wrongKeyManifestRefused: 'passed',
      uninstall: 'passed',
      userDataPreserved: 'passed',
    },
    cliAcceptance: {
      joyCmd: cliAcceptance('5'.repeat(64), '6'.repeat(64)),
      joyMediaCmd: cliAcceptance('7'.repeat(64), '8'.repeat(64)),
    },
    editorAcceptance: { status: 'passed', firstAttemptPassed: true, retries: 0 },
    // The lifecycle measures every required scenario of the topology except its own verdict.
    scenarios: REQUIRED_SCENARIOS_SINGLE_PASS.filter(
      (id) => id !== SINGLE_PASS_VERDICT_SCENARIO,
    ).map((id) => ({ id, status: 'passed', retries: 0, firstAttemptPassed: true })),
    commands: [{ name: 'Windows lifecycle scenario loop', exitCode: 0 }],
    toolchain: {
      node: 'v24.0.0',
      pnpm: '11.15.0',
      electron: '44.3.0',
      ffmpeg: 'ffmpeg version 8.1.1',
      ffprobe: 'ffprobe version 8.1.1',
      windows: 'Microsoft Windows NT 10.0.20348.0',
    },
    startedAt: '2026-10-26T00:01:00.000Z',
    finishedAt: '2026-10-26T00:11:00.000Z',
    ...overrides,
  };
  return {
    schemaVersion: 2,
    status: 'verified',
    pass: 1,
    candidateSha: CANDIDATE_SHA,
    workflowRunId: RUN_ID,
    attempt: Number(ATTEMPT),
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    containerIdentity,
    desktopLifecycle,
  };
}

function summaryWith(receipt: unknown, overrides: Record<string, unknown> = {}) {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  return {
    schemaVersion: 1,
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: ATTEMPT,
    sources: [
      { lane: 'real-service', pass: 1 },
      { lane: 'p3', pass: 1 },
    ],
    windowsWorkerPasses: [{ pass: 1, sha256: digest(bytes) }],
    ...overrides,
  };
}

function prepareWorkspace(
  receiptOverrides: Record<string, unknown> = {},
  summaryOverrides: Record<string, unknown> = {},
) {
  write('apps/desktop/package.json', JSON.stringify({ version: '1.0.3' }));
  write('pnpm-lock.yaml', 'frozen lockfile fixture');
  write('packages/test-fixtures/media/manifest.json', '{"fixture":"readiness"}');
  const artifactBytes: Record<string, string> = {
    [PORTABLE_ARCHIVE]: 'portable bytes',
    'joy-media.exe': 'desktop bytes',
    'joy-media-bundle.mjs': 'cli bytes',
    'joy-worker.exe': 'worker bytes',
    'joy-media-setup.exe': 'setup bytes',
  };
  candidateDigests = Object.fromEntries(
    Object.entries(artifactBytes).map(([name, bytes]) => [name, digest(bytes)]),
  );
  for (const [name, bytes] of Object.entries(artifactBytes)) {
    write(`test-output/readiness/artifacts/${name}`, bytes);
  }
  write(
    'test-output/readiness/artifacts/SHA256SUMS.txt',
    `${Object.entries(candidateDigests)
      .map(([name, hash]) => `${hash}  ${name}`)
      .join('\n')}\n`,
  );
  write(
    RELEASE_MANIFEST,
    JSON.stringify({
      name: 'joy-media',
      version: '1.0.3',
      platform: 'windows-x64',
      targetCommit: CANDIDATE_SHA,
      artifacts: [
        {
          fileName: PORTABLE_ARCHIVE,
          type: 'portable-archive',
          sha256: candidateDigests[PORTABLE_ARCHIVE],
        },
        {
          fileName: 'joy-media.exe',
          type: 'standalone-binary',
          sha256: candidateDigests['joy-media.exe'],
        },
        {
          fileName: 'joy-worker.exe',
          type: 'standalone-worker',
          sha256: candidateDigests['joy-worker.exe'],
        },
        {
          fileName: 'joy-media-bundle.mjs',
          type: 'standalone-cli-bundle',
          sha256: candidateDigests['joy-media-bundle.mjs'],
        },
        { fileName: 'joy.cmd', type: 'cli-launcher' },
        { fileName: 'joy-media.cmd', type: 'cli-launcher' },
      ],
    }),
  );
  const receipt = lifecycle(receiptOverrides);
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  write(WINDOWS_PASS, receiptBytes);
  write(SUMMARY, JSON.stringify(summaryWith(receipt, summaryOverrides)));
  write('test-output/windows/acceptance.json', receiptBytes);
  write('test-output/windows/acceptance-passes/pass-1.json', receiptBytes);
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
  ]) {
    write(path, JSON.stringify({ retained: true }));
  }
}

function needsJson(overrides: Record<string, { result: string }> = {}): string {
  return JSON.stringify(
    Object.fromEntries(
      SINGLE_LANES.map((lane) => [lane, overrides[lane] ?? { result: 'success' }]),
    ),
  );
}

function build(needs = needsJson(), overrides: { headSha?: string; attempt?: string } = {}) {
  return buildReadinessEvidence({
    workspaceRoot,
    candidateSha: CANDIDATE_SHA,
    headSha: overrides.headSha ?? CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: overrides.attempt ?? ATTEMPT,
    needsJson: needs,
    now: new Date('2026-10-26T00:20:00.000Z'),
    topology: 'single-pass',
  });
}

describe('single-pass readiness evidence (release-candidate-v3)', () => {
  it('keeps the scenario inventory identical to two-pass except for the verdict name', () => {
    const renamed = REQUIRED_SCENARIOS.map((id) =>
      id === TWO_PASS_VERDICT_SCENARIO ? SINGLE_PASS_VERDICT_SCENARIO : id,
    );
    expect(REQUIRED_SCENARIOS_SINGLE_PASS).toEqual(renamed);
    expect(REQUIRED_SCENARIOS_SINGLE_PASS).toHaveLength(9);
  });

  it('emits every required scenario in one pass, with the topology named and the record validator-clean', () => {
    const evidence = build();
    expect(evidence.topology).toBe('single-pass');
    expect(evidence.passCount).toBe(REQUIRED_SCENARIOS_SINGLE_PASS.length);
    expect(evidence.scenarioResults.map((result: { id: string }) => result.id).sort()).toEqual(
      [...REQUIRED_SCENARIOS_SINGLE_PASS].sort(),
    );
    expect(evidence.commands.map((command: { name: string }) => command.name)).toEqual(
      expect.arrayContaining(SINGLE_LANES.map((lane) => `lane: ${lane}`)),
    );
    expect(evidence.redactedHashes[SUMMARY]).toMatch(/^[0-9a-f]{64}$/u);
    expect(evidence.redactedHashes[WINDOWS_PASS]).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      Object.keys(evidence.redactedHashes).some((path) => path.includes('two-pass-evidence')),
    ).toBe(false);
    expect(validateReadinessEvidence(evidence, CANDIDATE_SHA)).toEqual([]);
  });

  it('refuses the single-pass record when a two-pass record is validated under the single-pass name (topology is authoritative)', () => {
    const evidence = build();
    const asTwoPass = { ...evidence, topology: undefined };
    const blockers = validateReadinessEvidence(asTwoPass, CANDIDATE_SHA);
    expect(blockers).toEqual(
      expect.arrayContaining([`missing required scenario: ${TWO_PASS_VERDICT_SCENARIO}`]),
    );
  });

  it('refuses an unknown topology in the record', () => {
    const blockers = validateReadinessEvidence(
      { ...build(), topology: 'three-pass' } as never,
      CANDIDATE_SHA,
    );
    expect(blockers.join(';')).toMatch(/unsupported evidence topology: three-pass/u);
  });

  it('refuses an unknown topology before reading any input', () => {
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        headSha: CANDIDATE_SHA,
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson: needsJson(),
        topology: 'four-pass',
      } as never),
    ).toThrow(/unknown gate topology: four-pass/u);
  });

  it('fails when any single-pass lane is not green, or a lane of the two-pass gate is the only one present', () => {
    expect(() => build(needsJson({ 'hosted-verify': { result: 'failure' } }))).toThrow(
      /not all green/u,
    );
    const twoPassOnly = JSON.parse(needsJson()) as Record<string, unknown>;
    delete twoPassOnly['hosted-verify'];
    expect(() => build(JSON.stringify(twoPassOnly))).toThrow(/not all green/u);
  });

  it('refuses a rerun: only the first workflow attempt can prove first-attempt success', () => {
    expect(() => build(needsJson(), { attempt: '2' })).toThrow(/first workflow attempt/u);
  });

  it('refuses a Windows receipt that does not match the digest recorded in the single-pass summary', () => {
    write(WINDOWS_PASS, '{"tampered":true}\n');
    expect(() => build()).toThrow(
      /Windows pass 1 receipt does not match the digest recorded in the single-pass summary/u,
    );
  });

  it('refuses a summary that binds two Windows passes or a two-pass source list', () => {
    write(
      SUMMARY,
      JSON.stringify(
        summaryWith(lifecycle(), {
          sources: [
            { lane: 'real-service', pass: 1 },
            { lane: 'real-service', pass: 2 },
            { lane: 'p3', pass: 1 },
            { lane: 'p3', pass: 2 },
          ],
        }),
      ),
    );
    expect(() => build()).toThrow(/single-pass summary does not bind two Linux acceptance passes/u);
  });

  it('refuses a summary that does not list its one Windows pass exactly once', () => {
    const receipt = lifecycle();
    write(
      SUMMARY,
      JSON.stringify(
        summaryWith(receipt, { windowsWorkerPasses: [{ pass: 2, sha256: digest('x') }] }),
      ),
    );
    expect(() => build()).toThrow(/single-pass summary does not list Windows pass 1 exactly once/u);
  });

  it('refuses a lifecycle that needed a retry for any scenario of the topology', () => {
    const scenarios = REQUIRED_SCENARIOS_SINGLE_PASS.filter(
      (id) => id !== SINGLE_PASS_VERDICT_SCENARIO,
    ).map((id) =>
      id === 'desktop.app.restart-save-export'
        ? { id, status: 'passed', retries: 1, firstAttemptPassed: false }
        : { id, status: 'passed', retries: 0, firstAttemptPassed: true },
    );
    prepareWorkspace({ scenarios });
    // A retry is refused at the first measured failure of the first-attempt flag, which is checked before the count.
    expect(() => build()).toThrow(
      /did not pass desktop\.app\.restart-save-export on its first attempt/u,
    );
  });

  it('refuses a lifecycle that is missing a measured result for a scenario of the topology', () => {
    const scenarios = REQUIRED_SCENARIOS_SINGLE_PASS.filter(
      (id) => id !== SINGLE_PASS_VERDICT_SCENARIO && id !== 'cli.render.playable',
    ).map((id) => ({ id, status: 'passed', retries: 0, firstAttemptPassed: true }));
    prepareWorkspace({ scenarios });
    expect(() => build()).toThrow(/has no measured result for cli\.render\.playable/u);
  });

  it('refuses a lifecycle that does not match the candidate SHA', () => {
    prepareWorkspace({ candidateSha: 'c'.repeat(40) });
    expect(() => build()).toThrow(/stale or has mismatched provenance/u);
  });

  it('refuses a checked-out HEAD that is not the candidate', () => {
    expect(() =>
      buildReadinessEvidence({
        workspaceRoot,
        candidateSha: CANDIDATE_SHA,
        headSha: 'd'.repeat(40),
        runId: RUN_ID,
        attempt: ATTEMPT,
        needsJson: needsJson(),
        topology: 'single-pass',
      }),
    ).toThrow(/does not match candidate SHA/u);
  });

  it('builds the single-pass lane list and the two-pass lane list from separate shapes', async () => {
    const { SHAPES } = await import('./create-readiness-evidence.mjs');
    expect(SHAPES['single-pass'].lanes).toEqual(SINGLE_LANES);
    expect(SHAPES['single-pass'].lanes).not.toContain('windows-p0-real-services');
    expect(SHAPES['two-pass'].lanes).toContain('windows-p0-real-services');
  });
});
