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

describe('v2 release-candidate artifact upload policy', () => {
  const workflow = readWorkflow();

  it('is a parseable, non-empty v2 workflow file', () => {
    expect(workflow.length).toBeGreaterThan(0);
    expect(workflow).toContain('name: release-candidate-v2');
  });

  it('asserts zero upload-artifact and zero download-artifact actions', () => {
    expect(workflow).not.toMatch(/uses:\s*actions\/upload-artifact\b/);
    expect(workflow).not.toMatch(/uses:\s*actions\/download-artifact\b/);
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(workflow).not.toContain('actions/download-artifact');
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

  it('keeps durable evidence verification for both passes', () => {
    expect(workflow).toContain('Verify retained evidence (required');
    expect(workflow).toContain('Verify retained P3 evidence');
    expect(workflow).toContain('sha256sum -c MANIFEST.sha256');
    expect(workflow).toContain('MANIFEST.sha256');
    expect(workflow).toContain('MANIFEST.json');
    expect(workflow).toContain('REDACTION-FAILURES.txt');
  });

  it('evaluates the source-bound release gate once after both isolated passes', () => {
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

    expect(realAcceptance).not.toContain('pnpm run release:gate');
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
    expect(windowsJob).toContain('pnpm --filter @joy-media/desktop exec install-electron');
    expect(windowsJob).toContain('apps\\desktop\\node_modules\\electron\\dist\\electron.exe');
    expect(windowsJob.indexOf('exec install-electron')).toBeLessThan(
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

  it('declares 14 job instances across both passes', () => {
    const jobKeys = Array.from(workflow.matchAll(/^\s{2}([a-z0-9-]+):$/gm), (m) => m[1]);
    const uniqueKeys = [...new Set(jobKeys)];
    expect(uniqueKeys).toEqual([
      'validate-candidate',
      'linux-real-services',
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
    // 4 single-instance jobs (validate-candidate, windows-worker-clean,
    // prod-build-smoke, gate-summary). 10 + 4 = 14 job instances total.
    expect(matrixPasses.length * 2 + 4).toBe(14);
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
