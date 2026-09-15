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

  it('records a disabled receipt in both the real-service and P3 passes', () => {
    // Exactly two ARTIFACT-UPLOAD-STATUS.txt writes, one per pass lane.
    const writes = workflow.match(/ARTIFACT-UPLOAD-STATUS\.txt/g) ?? [];
    expect(writes.length).toBe(2);

    // Every disabled-receipt line appears exactly twice (once per pass lane).
    for (const line of DISABLED_RECEIPT) {
      const occurrences = workflow.split(line).length - 1;
      expect(occurrences).toBe(2);
    }
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

  it('invokes the source-bound release gate inside the real-service lane', () => {
    expect(workflow).toContain('Evaluate source-bound release gate');
    expect(workflow).toContain('pnpm run release:gate');
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
