/* global Buffer */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindWindowsWorkerPasses, restoreRetainedEvidence } from './restore-retained-evidence.mjs';

const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_ID = '444';
const ATTEMPT = '1';
const PREVIOUS_SETUP_SHA256 = '3f5fbe853de04a24aac22a46e28dd661cc1a80a2a6c5a1fa383fcd9ab3efde04';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function desktopLifecycleEvidence(pass, containerId) {
  const scenarioIds = [
    'cli.render.playable',
    'cli.render.unsupported-features',
    'cli.render.failure-recovery',
    'cli.render.windows-entrypoints',
    'project.persistence.fresh-process',
    'desktop.app.restart-save-export',
    'desktop.windows.installed-lifecycle',
  ];
  return {
    schemaVersion: 1,
    status: 'verified',
    candidateSha: CANDIDATE_SHA,
    workflowRunId: RUN_ID,
    attempt: Number(ATTEMPT),
    pass,
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    containerIdentity: { containerId, imageDigest: `sha256:${'b'.repeat(64)}` },
    versions: { previous: '1.0.1', candidate: '1.0.2' },
    artifacts: {
      candidateSetupSha256: 'c'.repeat(64),
      candidatePortableArchiveSha256: 'd'.repeat(64),
      candidateDesktopExecutableSha256: 'e'.repeat(64),
      candidateCliBundleSha256: 'f'.repeat(64),
      candidateWorkerExecutableSha256: 'a'.repeat(64),
      previousSetupSha256: PREVIOUS_SETUP_SHA256,
      previousArchiveSha256: '21be785e26c0d06cadba40929ada839cfd24345f17b828cdb735d4eff056a88c',
      previousChecksumsSha256: 'a7b933f44ec82edd2f166dcde0bb013e1febd0ebbd19aa42dd49ac8e05adfe32',
      previousDesktopExecutableSha256: '3'.repeat(64),
      previousCliBundleSha256: '4'.repeat(64),
    },
    transitions: {
      installPrevious: 'passed',
      upgradeCandidate: 'passed',
      repairCandidate: 'passed',
      rollbackPrevious: 'passed',
      uninstall: 'passed',
      userDataPreserved: 'passed',
    },
    cliAcceptance: {
      joyCmd: {
        status: 'passed',
        launcherSha256: '1'.repeat(64),
        desktopExecutableSha256: '2'.repeat(64),
        cliBundleSha256: '3'.repeat(64),
        workerExecutableSha256: '4'.repeat(64),
        renderedMediaSha256: '5'.repeat(64),
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 3,
      },
      joyMediaCmd: {
        status: 'passed',
        launcherSha256: '6'.repeat(64),
        desktopExecutableSha256: '2'.repeat(64),
        cliBundleSha256: '3'.repeat(64),
        workerExecutableSha256: '4'.repeat(64),
        renderedMediaSha256: '7'.repeat(64),
        videoCodec: 'h264',
        audioCodec: 'aac',
        durationSeconds: 3,
      },
    },
    editorAcceptance: { status: 'passed', retries: 0, firstAttemptPassed: true },
    scenarios: scenarioIds.map((id) => ({
      id,
      status: 'passed',
      retries: 0,
      firstAttemptPassed: true,
    })),
    toolchain: {
      node: 'v24.0.0',
      pnpm: '11.15.0',
      electron: '44.3.0',
      ffmpeg: '8.1.1',
      ffprobe: '8.1.1',
      windows: 'Windows Server',
    },
    commands: [{ name: 'installed lifecycle pass', exitCode: 0 }],
    startedAt: '2026-10-18T00:00:00.000Z',
    finishedAt: '2026-10-18T00:10:00.000Z',
  };
}

function retainedFiles(lane, pass) {
  const files = {
    'test-output/operations/teardown.json': JSON.stringify({ clean: true, pass }),
    'test-output/ci-janitor/inventory.json': JSON.stringify({ pass }),
  };
  if (lane === 'real-service') {
    Object.assign(files, {
      'test-output/browser/journeys.json': JSON.stringify({ pass, status: 'passed' }),
      'test-output/release-performance/polling.json': JSON.stringify({ metrics: { pass } }),
      'test-output/release-performance/effects-soak.json': JSON.stringify({ metrics: { pass } }),
      'test-output/release-performance/timeline-integrity.json': JSON.stringify({
        metrics: { pass },
      }),
      'test-output/release-performance/editor.json': JSON.stringify({ metrics: { pass } }),
      'test-output/delivery/result.json': JSON.stringify({ pass }),
      'test-output/operations/restore.json': JSON.stringify({ pass }),
      'test-output/windows/acceptance.json': JSON.stringify({ pass, source: 'service-lane' }),
    });
  } else {
    Object.assign(files, {
      'test-output/browser/p3-export-matrix.json': JSON.stringify({ pass }),
      'test-output/browser/p3-lane-evidence.json': JSON.stringify({ pass }),
      'test-output/browser/p3-case-evidence.json': JSON.stringify({ pass }),
      'test-output/browser/p3-progress.jsonl': `${JSON.stringify({ pass })}\n`,
      'test-output/browser/p3-child-stdout-tail.txt': `pass ${pass}\n`,
      'test-output/browser/p3-child-stderr-tail.txt': '',
    });
  }
  return files;
}

async function writeRetainedPass(evidenceRoot, lane, pass, overrides = {}) {
  const base = lane === 'p3' ? join(evidenceRoot, 'p3') : evidenceRoot;
  const root = join(base, CANDIDATE_SHA, `${RUN_ID}-${ATTEMPT}-p${pass}`);
  const contents = {
    'context.txt': 'retained fixture\n',
    'git-status.txt': '',
    ...retainedFiles(lane, pass),
    ...overrides,
  };
  const manifestFiles = [];
  for (const [path, content] of Object.entries(contents)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    const bytes = Buffer.from(content);
    await writeFile(absolute, bytes);
    manifestFiles.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 1,
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: ATTEMPT,
    pass: String(pass),
    generatedAt: '2026-10-17T00:00:00Z',
    redactionApplied: true,
    quarantinedCount: 0,
    files: manifestFiles,
  };
  await writeFile(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(root, 'MANIFEST.sha256'),
    `${manifestFiles.map((entry) => `${entry.sha256}  ./${entry.path}`).join('\n')}\n`,
  );
  await writeFile(
    join(root, 'ARTIFACT-UPLOAD-STATUS.txt'),
    `candidate_sha=${CANDIDATE_SHA}\nrun_id=${RUN_ID}\nattempt=${ATTEMPT}\npass=${pass}\nupload_outcome=disabled\nsource=durable-evidence-store\nreason=github-artifact-upload-disabled-by-policy\n`,
  );
  return root;
}

async function writeDesktopPackageManifest(workspaceRoot) {
  await mkdir(join(workspaceRoot, 'apps/desktop'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'apps/desktop/package.json'),
    JSON.stringify({ version: '1.0.2' }),
  );
}

function windowsEvidence(pass, containerId) {
  return {
    schemaVersion: 2,
    status: 'verified',
    candidateSha: CANDIDATE_SHA,
    workflowRunId: RUN_ID,
    attempt: Number(ATTEMPT),
    runner: 'self-hosted,windows,x64,joy-media-worker-docker',
    execution: 'windows-docker-container',
    containerIdentity: { containerId, imageDigest: `sha256:${'b'.repeat(64)}` },
    windowsPlatformVerified: true,
    sourceProvenance: { commitSha: CANDIDATE_SHA, worktreeClean: true },
    verifiedAt: '2026-10-17T00:00:00.000Z',
    lifecycle: { install: { status: 'verified' } },
    desktopLifecycle: desktopLifecycleEvidence(pass, containerId),
    pass,
  };
}

test('restores both real-service and P3 passes into hash-bound evidence inputs', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'jm-retained-evidence-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-evidence-workspace-'));
  for (const lane of ['real-service', 'p3']) {
    await writeRetainedPass(evidenceRoot, lane, 1);
    await writeRetainedPass(evidenceRoot, lane, 2);
  }

  const result = await restoreRetainedEvidence({
    evidenceRoot,
    workspaceRoot,
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: ATTEMPT,
  });

  assert.equal(result.sources.length, 4);
  assert.ok(result.sources.every((source) => /^[0-9a-f]{64}$/.test(source.manifestSha256)));
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          'test-output/readiness/two-pass-evidence/real-service/pass-1/browser/journeys.json',
        ),
        'utf8',
      ),
    ),
    { pass: 1, status: 'passed' },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(workspaceRoot, 'test-output/browser/journeys.json'), 'utf8')),
    { pass: 2, status: 'passed' },
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(workspaceRoot, 'test-output/release-performance/effects-soak.json'),
        'utf8',
      ),
    ),
    { metrics: { pass: 2 } },
  );
  assert.ok(
    await readFile(
      join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
      'utf8',
    ),
  );
});

test('binds two Windows Worker passes from the same runner container', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-windows-evidence-'));
  await writeDesktopPackageManifest(workspaceRoot);
  await mkdir(join(workspaceRoot, 'test-output/readiness/two-pass-evidence'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      sources: [],
    }),
  );

  await bindWindowsWorkerPasses({
    workspaceRoot,
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    attempt: ATTEMPT,
    pass1B64: Buffer.from(JSON.stringify(windowsEvidence(1, '1'.repeat(12)))).toString('base64'),
    pass2B64: Buffer.from(JSON.stringify(windowsEvidence(2, '1'.repeat(12)))).toString('base64'),
  });

  const selected = JSON.parse(
    await readFile(join(workspaceRoot, 'test-output/windows/acceptance.json'), 'utf8'),
  );
  assert.equal(selected.pass, 2);
  assert.equal(selected.desktopLifecycle.pass, 2);
  assert.equal(selected.desktopLifecycle.artifacts.candidateSetupSha256, 'c'.repeat(64));
  assert.equal(
    JSON.parse(
      await readFile(
        join(
          workspaceRoot,
          'test-output/readiness/two-pass-evidence/windows/pass-1/acceptance.json',
        ),
        'utf8',
      ),
    ).pass,
    1,
  );
  const summary = JSON.parse(
    await readFile(
      join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
      'utf8',
    ),
  );
  assert.equal(summary.windowsWorkerPasses.length, 2);
  assert.equal(
    summary.windowsWorkerPasses[0].containerId,
    summary.windowsWorkerPasses[1].containerId,
  );
  assert.equal(summary.windowsWorkerPasses[0].pass, 1);
  assert.equal(summary.windowsWorkerPasses[1].pass, 2);
});

test('rejects Windows Worker pass output whose embedded pass number is swapped', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-swapped-windows-evidence-'));
  await writeDesktopPackageManifest(workspaceRoot);
  await mkdir(join(workspaceRoot, 'test-output/readiness/two-pass-evidence'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      sources: [],
    }),
  );

  await assert.rejects(
    bindWindowsWorkerPasses({
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      pass1B64: Buffer.from(JSON.stringify(windowsEvidence(2, '1'.repeat(12)))).toString('base64'),
      pass2B64: Buffer.from(JSON.stringify(windowsEvidence(2, '1'.repeat(12)))).toString('base64'),
    }),
    /Windows Worker pass 1 evidence declares pass 2/i,
  );
});

test('rejects missing or pass-mismatched installed desktop lifecycle evidence', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-invalid-desktop-lifecycle-'));
  await writeDesktopPackageManifest(workspaceRoot);
  await mkdir(join(workspaceRoot, 'test-output/readiness/two-pass-evidence'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
    }),
  );
  const missing = windowsEvidence(1, '1'.repeat(12));
  delete missing.desktopLifecycle;
  const mismatched = windowsEvidence(2, '1'.repeat(12));
  mismatched.desktopLifecycle.pass = 1;

  await assert.rejects(
    bindWindowsWorkerPasses({
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      pass1B64: Buffer.from(JSON.stringify(missing)).toString('base64'),
      pass2B64: Buffer.from(JSON.stringify(windowsEvidence(2, '1'.repeat(12)))).toString('base64'),
    }),
    /desktop lifecycle/i,
  );

  await assert.rejects(
    bindWindowsWorkerPasses({
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      pass1B64: Buffer.from(JSON.stringify(windowsEvidence(1, '1'.repeat(12)))).toString('base64'),
      pass2B64: Buffer.from(JSON.stringify(mismatched)).toString('base64'),
    }),
    /desktop lifecycle.*pass/i,
  );
});

test('rejects tampered persisted evidence before copying it into the gate workspace', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'jm-tampered-evidence-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-tampered-workspace-'));
  const root = await writeRetainedPass(evidenceRoot, 'real-service', 1);
  await writeRetainedPass(evidenceRoot, 'real-service', 2);
  await writeRetainedPass(evidenceRoot, 'p3', 1);
  await writeRetainedPass(evidenceRoot, 'p3', 2);
  await writeFile(join(root, 'test-output/browser/journeys.json'), '{"tampered":true}');

  await assert.rejects(
    restoreRetainedEvidence({
      evidenceRoot,
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
    }),
    /checksum mismatch|hash mismatch/i,
  );
});

test('rejects Windows Worker output from a different candidate or workflow run', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'jm-invalid-windows-evidence-'));
  await writeDesktopPackageManifest(workspaceRoot);
  await mkdir(join(workspaceRoot, 'test-output/readiness/two-pass-evidence'), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, 'test-output/readiness/two-pass-evidence/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      sources: [],
    }),
  );
  const stale = windowsEvidence(2, '3'.repeat(12));
  stale.candidateSha = 'c'.repeat(40);

  await assert.rejects(
    bindWindowsWorkerPasses({
      workspaceRoot,
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      attempt: ATTEMPT,
      pass1B64: Buffer.from(JSON.stringify(windowsEvidence(1, '4'.repeat(12)))).toString('base64'),
      pass2B64: Buffer.from(JSON.stringify(stale)).toString('base64'),
    }),
    /candidate|workflow run|run attempt/i,
  );
});
