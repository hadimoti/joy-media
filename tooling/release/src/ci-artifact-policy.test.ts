import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows/release-candidate-v2.yml',
);

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

const DISABLED_RECEIPT = [
  'upload_outcome=disabled',
  'source=durable-evidence-store',
  'reason=github-artifact-upload-disabled-by-policy',
];

const EDITOR_WEB_ARTIFACT_NAME =
  'joy-media-editor-web-${{ github.run_id }}-${{ github.run_attempt }}-${{ inputs.candidate_sha }}';

const WINDOWS_RELEASE_ARTIFACT_NAME =
  'joy-media-windows-release-${{ github.run_id }}-${{ github.run_attempt }}-${{ inputs.candidate_sha }}';

const UPLOAD_ACTION = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2';
const DOWNLOAD_ACTION =
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0';

// One step of a job, from its `- name:` line to the next step or comment line at the same indent.
function stepBlock(job: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  if (start < 0) return '';
  const rest = job.slice(start + marker.length);
  const next = rest.match(/\n {6}(?:- |#)/);
  return job.slice(start, next ? start + marker.length + next.index! : job.length);
}

function jobBlock(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return '';
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.match(/\n {2}[a-z0-9-]+:\n/);
  return workflow.slice(start, nextJob ? start + marker.length + nextJob.index! : workflow.length);
}

describe('v2 release-candidate artifact upload policy', () => {
  const workflow = readWorkflow();

  it('is a parseable, non-empty v2 workflow file', () => {
    expect(workflow.length).toBeGreaterThan(0);
    expect(workflow).toContain('name: release-candidate-v2');
  });

  it('uses two short-lived artifact pairs only: the renderer handoff and the Windows release files for the gate', () => {
    const bundleJob = jobBlock(workflow, 'editor-web-bundle');
    const windowsJob = jobBlock(workflow, 'windows-worker-clean');
    const gateJob = jobBlock(workflow, 'gate-summary');
    // Exactly two uploads and two downloads in the whole workflow. Each is named below, and no other job
    // may take part.
    expect(workflow.match(/uses:\s*actions\/upload-artifact@/g) ?? []).toHaveLength(2);
    expect(workflow.match(/uses:\s*actions\/download-artifact@/g) ?? []).toHaveLength(2);
    expect(bundleJob).toContain(UPLOAD_ACTION);
    expect(windowsJob).toContain(DOWNLOAD_ACTION);
    expect(bundleJob).toContain(EDITOR_WEB_ARTIFACT_NAME);
    expect(windowsJob).toContain(EDITOR_WEB_ARTIFACT_NAME);
    expect(bundleJob).toContain('retention-days: 1');
    expect(bundleJob).toContain('if-no-files-found: error');
    // The Windows job uploads once and downloads once (the renderer). The gate downloads once and never uploads.
    expect(windowsJob.match(/uses:\s*actions\/upload-artifact@/g) ?? []).toHaveLength(1);
    expect(windowsJob.match(/uses:\s*actions\/download-artifact@/g) ?? []).toHaveLength(1);
    expect(gateJob.match(/uses:\s*actions\/download-artifact@/g) ?? []).toHaveLength(1);
    expect(gateJob).not.toContain('actions/upload-artifact');

    for (const evidenceJob of [
      'linux-real-services',
      'real-service-acceptance',
      'p3-real-services',
    ]) {
      const block = jobBlock(workflow, evidenceJob);
      expect(block).not.toContain('actions/upload-artifact');
      expect(block).not.toContain('actions/download-artifact');
    }
  });

  it('hands the Windows release files to the gate as a one-day artifact of this run, bound to the candidate', () => {
    const windowsJob = jobBlock(workflow, 'windows-worker-clean');
    const gateJob = jobBlock(workflow, 'gate-summary');

    const upload = stepBlock(
      windowsJob,
      'Upload the staged Windows release artifacts for the final gate (one day, this run only)',
    );
    expect(upload).toContain(`uses: ${UPLOAD_ACTION}`);
    expect(upload).toContain(`name: ${WINDOWS_RELEASE_ARTIFACT_NAME}`);
    expect(upload).toContain('path: test-output/release-artifacts');
    expect(upload).toContain('retention-days: 1');
    expect(upload).toContain('if-no-files-found: error');
    expect(upload).not.toContain('overwrite:');
    expect(upload).not.toContain('include-hidden-files');
    // The upload takes the tree the staging step wrote, after it, and before any teardown.
    expect(windowsJob.indexOf('Stage Windows release artifacts with their manifest')).toBeLessThan(
      windowsJob.indexOf('Upload the staged Windows release artifacts'),
    );
    expect(windowsJob.indexOf('Upload the staged Windows release artifacts')).toBeLessThan(
      windowsJob.indexOf('Verify clean Worker teardown'),
    );
    // Nothing of the old per-runner store remains in the Windows lane.
    expect(workflow).not.toContain('JOY_MEDIA_WINDOWS_EVIDENCE_ROOT');

    const download = stepBlock(
      gateJob,
      'Download the Windows release artifacts that this run uploaded',
    );
    expect(download).toContain(`uses: ${DOWNLOAD_ACTION}`);
    expect(download).toContain(`name: ${WINDOWS_RELEASE_ARTIFACT_NAME}`);
    expect(download).toContain('path: test-output/windows-release-incoming');
    // Same run only: no cross-run, cross-repository or token-based download, and no name patterns.
    for (const forbidden of [
      'run-id:',
      'repository:',
      'github-token:',
      'pattern:',
      'merge-multiple',
    ]) {
      expect(download).not.toContain(forbidden);
    }
  });

  it('retains, verifies and restores the downloaded Windows release files in order, from the store', () => {
    const gateJob = jobBlock(workflow, 'gate-summary');
    const idx = (name: string): number => gateJob.indexOf(`      - name: ${name}`);
    const order = [
      'Restore and bind both isolated evidence passes',
      'Download the Windows release artifacts that this run uploaded',
      'Retain the downloaded Windows release artifacts in the durable evidence store',
      'Verify the retained Windows release artifacts in the evidence store',
      'Place the verified Windows release artifacts where the readiness builder reads them',
      'Build source-bound readiness evidence from all two-pass results',
      'Evaluate source-bound release gate',
    ].map(idx);
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const identity =
      '"$CANDIDATE_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$JOY_MEDIA_CI_EVIDENCE_ROOT"';
    const retain = stepBlock(
      gateJob,
      'Retain the downloaded Windows release artifacts in the durable evidence store',
    );
    expect(retain).toContain(
      `node tooling/release/src/retain-release-artifacts.mjs test-output/windows-release-incoming ${identity}`,
    );
    expect(retain).not.toContain('--verify-only');
    expect(retain).not.toContain('--restore-to');
    const verify = stepBlock(
      gateJob,
      'Verify the retained Windows release artifacts in the evidence store',
    );
    expect(verify).toContain(`retain-release-artifacts.mjs - ${identity} --verify-only`);
    // The builder reads a copy restored from the verified store, never the downloaded directory.
    const place = stepBlock(
      gateJob,
      'Place the verified Windows release artifacts where the readiness builder reads them',
    );
    expect(place).toContain(
      `retain-release-artifacts.mjs - ${identity} --restore-to test-output/readiness/artifacts`,
    );
    expect(place).not.toContain('windows-release-incoming');
  });

  it('keeps the workflow token read-only', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n {2}actions: read[^\n]*\n/);
    expect(workflow).not.toMatch(/\n\s+(?:id-token|packages|pull-requests|issues):/);
    expect(workflow).not.toMatch(/\n\s+contents: write/);
  });

  it('records disabled receipts for both passes and the final gate', () => {
    // Two isolated acceptance passes plus one final source-bound gate receipt.
    const writes = workflow.match(/ARTIFACT-UPLOAD-STATUS\.txt/g) ?? [];
    expect(writes.length).toBe(3);

    // Every disabled-receipt line appears in both passes and the final gate.
    for (const line of DISABLED_RECEIPT) {
      const occurrences = workflow.split(line).length - 1;
      expect(occurrences).toBe(3);
    }
    expect(workflow.split('pass=gate').length - 1).toBe(1);
  });

  it('removes the conditional GitHub-artifact source branching', () => {
    expect(workflow).not.toContain('github-actions-artifact');
    expect(workflow).not.toMatch(/steps\.upload-[a-z0-9-]+\.outcome/);
    expect(workflow).not.toContain('upload-real-service-artifact');
    expect(workflow).not.toContain('upload-p3-artifact');
  });

  it('builds the renderer on the standard hosted Linux runner from the exact candidate', () => {
    const bundleJob = jobBlock(workflow, 'editor-web-bundle');
    expect(bundleJob.length).toBeGreaterThan(0);
    expect(bundleJob).toContain('runs-on: ubuntu-24.04');
    expect(bundleJob).toContain('needs: [validate-candidate]');
    expect(bundleJob).toContain('ref: ${{ env.CANDIDATE_SHA }}');
    expect(bundleJob).toContain(
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0',
    );
    expect(bundleJob).toContain('node-version: 22');
    expect(bundleJob).toContain('pnpm --filter @joy-media/editor-web... build');
    expect(bundleJob).toContain('node tooling/release/src/editor-web-artifact.mjs create');
    expect(bundleJob).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    );
    expect(bundleJob).toContain(EDITOR_WEB_ARTIFACT_NAME);
  });

  it('keeps durable evidence verification for both passes', () => {
    expect(workflow).toContain('Verify retained evidence (required');
    expect(workflow).toContain('Verify retained P3 evidence');
    expect(workflow).toContain('sha256sum -c MANIFEST.sha256');
    expect(workflow).toContain('MANIFEST.sha256');
    expect(workflow).toContain('MANIFEST.json');
    expect(workflow).toContain('REDACTION-FAILURES.txt');
  });

  it('evaluates the source-bound release gate per pass and once after both isolated passes', () => {
    expect(workflow).toContain('Evaluate source-bound release gate');
    const realAcceptanceStart = workflow.indexOf('\n  real-service-acceptance:');
    const realAcceptanceEnd = workflow.indexOf('\n  p3-real-services:', realAcceptanceStart);
    const realAcceptance = workflow.slice(realAcceptanceStart, realAcceptanceEnd);
    const gateSummary = workflow.slice(workflow.indexOf('\n  gate-summary:'));
    const releaseGateStart = gateSummary.indexOf(
      '      - name: Evaluate source-bound release gate',
    );
    const releaseGateEnd = gateSummary.indexOf('      - name:', releaseGateStart + 1);
    const releaseGateStep = gateSummary.slice(releaseGateStart, releaseGateEnd);

    // Repetition contract item 6: each pass is evaluated independently, then both are bound together.
    expect(realAcceptance).toContain('pnpm run release:gate');
    expect(realAcceptance).toContain('JOY_RELEASE_SCOPE: pass');
    // An inherited JOY_RELEASE_SCOPE=pass must never weaken the consolidated gate.
    expect(releaseGateStep).toContain('JOY_RELEASE_SCOPE: release');
    expect(gateSummary).toContain('pnpm run release:gate');
    expect(gateSummary).toContain('runs-on: [self-hosted, linux, x64, joy-media-acceptance]');
    expect(gateSummary).toContain('linux-real-services');
    expect(gateSummary).toContain('windows-worker-clean');
    expect(gateSummary).toContain('acceptance-primary');
    expect(gateSummary).toContain('acceptance-responsive');
    expect(gateSummary).toContain('prod-build-smoke');
    expect(gateSummary).toContain('real-service-acceptance');
    expect(gateSummary).toContain('p3-real-services');
    expect(gateSummary).toContain('Restore and bind both isolated evidence passes');
    expect(gateSummary).toContain('restore-retained-evidence.mjs');
    expect(gateSummary).toContain('needs.windows-worker-clean.outputs.evidence1');
    expect(gateSummary).toContain('needs.windows-worker-clean.outputs.evidence2');
    expect(gateSummary).toContain(
      'Build source-bound readiness evidence from all two-pass results',
    );
    expect(gateSummary).toContain('create-readiness-evidence.mjs');
    expect(gateSummary).toContain('pnpm run release:gate');
    for (const secretOrHarnessEnv of [
      'JOY_MEDIA_CI_DATABASE_URL',
      'JOY_MEDIA_CI_S3_ACCESS_KEY',
      'JOY_MEDIA_CI_S3_SECRET_KEY',
      'JOY_MEDIA_CI_S3_SECRET_ACCESS_KEY',
      'JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND',
      'JOY_MEDIA_CI_EVIDENCE_ROOT',
      'JOY_MEDIA_OPENCLI_PROFILE',
    ]) {
      expect(releaseGateStep).toContain(`${secretOrHarnessEnv}: ''`);
    }
    const needsStart = gateSummary.indexOf('    needs:');
    const stepsStart = gateSummary.indexOf('    steps:', needsStart);
    const needsBlock = gateSummary.slice(needsStart, stepsStart);
    for (const lane of [
      'linux-real-services',
      'windows-worker-clean',
      'acceptance-primary',
      'acceptance-responsive',
      'prod-build-smoke',
      'real-service-acceptance',
      'p3-real-services',
    ]) {
      expect(needsBlock).toContain(lane);
    }
    const laneCheckIndex = gateSummary.indexOf('Require every lane green on both isolated passes');
    const evidenceBuildIndex = gateSummary.indexOf(
      'Build source-bound readiness evidence from all two-pass results',
    );
    const gateIndex = gateSummary.indexOf('Evaluate source-bound release gate');
    expect(laneCheckIndex).toBeGreaterThanOrEqual(0);
    expect(evidenceBuildIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(laneCheckIndex).toBeLessThan(gateIndex);
    expect(evidenceBuildIndex).toBeLessThan(gateIndex);
    expect(gateSummary.indexOf('Restore and bind both isolated evidence passes')).toBeLessThan(
      evidenceBuildIndex,
    );
    expect(readFileSync(join(import.meta.dirname, 'gate.ts'), 'utf8')).toContain(
      "'test-output/readiness/two-pass-evidence'",
    );
  });

  it('builds, installs, verifies, and tears down the exact Windows desktop candidate on its Docker runner', () => {
    const start = workflow.indexOf('\n  windows-worker-clean:');
    const end = workflow.indexOf('\n  acceptance-primary:', start);
    const windowsJob = workflow.slice(start, end);

    expect(windowsJob).toContain('runs-on: [self-hosted, windows, x64, joy-media-worker-docker]');
    expect(windowsJob).toContain('needs: [validate-candidate, editor-web-bundle]');
    expect(windowsJob).toContain('node apps/desktop/scripts/install-electron-windows.mjs');
    expect(windowsJob).toContain('node tooling/release/src/editor-web-artifact.mjs verify');
    expect(windowsJob).toContain(
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0',
    );
    expect(windowsJob).toContain('node tooling/release/src/editor-web-artifact.mjs verify');
    expect(windowsJob).toContain('editor-web artifact verification failed');
    expect(windowsJob).not.toContain('pnpm --filter @joy-media/editor-web... build');
    expect(windowsJob).toContain('pnpm --workspace-concurrency=1 --filter @joy-media/cli... build');
    expect(windowsJob.indexOf('install-electron-windows.mjs')).toBeLessThan(
      windowsJob.indexOf('package:installer'),
    );
    expect(windowsJob.indexOf('@joy-media/cli... build')).toBeLessThan(
      windowsJob.indexOf('package:installer'),
    );
    expect(windowsJob.indexOf('editor-web-artifact.mjs verify')).toBeLessThan(
      windowsJob.indexOf('package:installer'),
    );
    expect(windowsJob).toContain('package:installer');
    expect(windowsJob).toContain('build-installer.ps1');
    expect(windowsJob).toContain('tests/desktop/windows-lifecycle.ps1');
    expect(windowsJob).toContain('-PreviousArchivePath $previousArchive');
    expect(windowsJob).toContain('joy-media-windows-lifecycle');
    expect(windowsJob).toContain('joy-media-setup.exe');
    expect(windowsJob).toContain('JOY_MEDIA_WINDOWS_IMAGE_DIGEST');
    expect(windowsJob).toContain('Installed JOY Media files remained after lifecycle cleanup');
  });

  it('declares 18 job instances across both passes and runtime versions', () => {
    const jobKeys = Array.from(workflow.matchAll(/^\s{2}([a-z0-9-]+):$/gm), (m) => m[1]);
    const uniqueKeys = [...new Set(jobKeys)];
    expect(uniqueKeys).toEqual([
      'validate-candidate',
      'node-contracts',
      'editor-web-bundle',
      'linux-real-services',
      'windows-p0-real-services',
      'windows-worker-clean',
      'acceptance-primary',
      'acceptance-responsive',
      'prod-build-smoke',
      'real-service-acceptance',
      'p3-real-services',
      'gate-summary',
    ]);
    // 5 matrix lanes (linux-real-services, acceptance-primary,
    // acceptance-responsive, real-service-acceptance, p3-real-services)
    // each run pass 1 + pass 2 = 10 instances.
    const matrixPasses = workflow.match(/pass:\s*\[1,\s*2\]/g) ?? [];
    expect(matrixPasses.length).toBe(5);
    expect(matrixPasses.length * 2).toBe(10);
    // 6 single-instance jobs (validate-candidate, editor-web-bundle,
    // windows-p0-real-services, windows-worker-clean, prod-build-smoke,
    // gate-summary), plus the 2-version node-contracts matrix. 10 + 6 + 2 = 18.
    expect(workflow).toMatch(/node:\s*\['22\.17\.0',\s*24\]/);
    expect(matrixPasses.length * 2 + 6 + 2).toBe(18);
  });

  it('runs both passes for every matrix lane', () => {
    for (const lane of [
      'linux-real-services',
      'acceptance-primary',
      'acceptance-responsive',
      'real-service-acceptance',
      'p3-real-services',
    ]) {
      const laneIdx = workflow.indexOf(`${lane}:`);
      expect(laneIdx).toBeGreaterThan(-1);
      const slice = workflow.slice(laneIdx);
      expect(slice).toMatch(/pass:\s*\[1,\s*2\]/);
    }
  });
});
