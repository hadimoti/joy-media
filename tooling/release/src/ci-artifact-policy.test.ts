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

  it('uses one short-lived artifact pair only for the exact-candidate renderer handoff', () => {
    const bundleJob = jobBlock(workflow, 'editor-web-bundle');
    const windowsJob = jobBlock(workflow, 'windows-worker-clean');
    expect(workflow.match(/uses:\s*actions\/upload-artifact@/g) ?? []).toHaveLength(1);
    expect(workflow.match(/uses:\s*actions\/download-artifact@/g) ?? []).toHaveLength(1);
    expect(bundleJob).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2',
    );
    expect(windowsJob).toContain(
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0',
    );
    expect(bundleJob).toContain(EDITOR_WEB_ARTIFACT_NAME);
    expect(windowsJob).toContain(EDITOR_WEB_ARTIFACT_NAME);
    expect(bundleJob).toContain('retention-days: 1');
    expect(bundleJob).toContain('if-no-files-found: error');

    for (const evidenceJob of [
      'linux-real-services',
      'real-service-acceptance',
      'p3-real-services',
      'gate-summary',
    ]) {
      const block = jobBlock(workflow, evidenceJob);
      expect(block).not.toContain('actions/upload-artifact');
      expect(block).not.toContain('actions/download-artifact');
    }
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
