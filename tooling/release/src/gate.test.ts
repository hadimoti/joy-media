import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseGate,
  REQUIRED_BUILD_IDS,
  REQUIRED_JOURNEY_ID,
  sha256File,
  writeReleaseEvidence,
  type ReleaseGateInput,
} from './gate.js';

const passingInput = (): ReleaseGateInput => ({
  testSummary: { collected: 12, failed: 0 },
  dirtyGeneratedArtifacts: [],
  fixtureHandlers: [],
  builds: Object.fromEntries(REQUIRED_BUILD_IDS.map((id) => [id, true])),
  manifestGenerated: true,
  sbomGenerated: true,
  browserJourneys: [{ id: REQUIRED_JOURNEY_ID, status: 'verified', verifiedAt: '2026-08-22' }],
  featureStatus: {
    auditedOn: '2026-08-22',
    statuses: ['production', 'demo-only', 'experimental', 'hidden'],
  },
});

describe('JOY Studio 1.0 release gate', () => {
  it('fails closed when test collection is empty', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      testSummary: { collected: 0, failed: 0 },
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'tests')?.status).toBe('failed');
  });

  it('rejects a failed typecheck, lint, format, build, or golden command', () => {
    const commandIds = [
      'typecheck',
      'lint',
      'format',
      'tests',
      'editor-build',
      'api-build',
      'worker-build',
      'goldens',
    ];
    const result = evaluateReleaseGate({
      ...passingInput(),
      commandResults: commandIds.map((id) => ({
        id,
        command: id,
        exitCode: id === 'lint' ? 1 : 0,
        durationMs: 1,
      })),
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'command-health')?.status).toBe('failed');
  });

  it('rejects dirty generated artifacts', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      dirtyGeneratedArtifacts: ['apps/api/dist/server.js'],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'generated-artifacts')?.status).toBe(
      'failed',
    );
  });

  it('rejects fixture handlers in production registries', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      fixtureHandlers: ['apps/api/src/server.ts: fixture handler'],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'fixture-registries')?.status).toBe('failed');
  });

  it('requires every build plus the manifest and SBOM', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      builds: { editor: true, api: false, worker: true },
      manifestGenerated: false,
      sbomGenerated: false,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'builds')?.status).toBe('failed');
    expect(result.checks.find((check) => check.id === 'manifest')?.status).toBe('failed');
    expect(result.checks.find((check) => check.id === 'sbom')?.status).toBe('failed');
  });

  it('rejects an unverified or incomplete browser journey', () => {
    const result = evaluateReleaseGate({ ...passingInput(), browserJourneys: [] });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'browser-journey')?.status).toBe('failed');
  });

  it('rejects stale feature status', () => {
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        featureStatus: { auditedOn: '2026-01-01', statuses: ['production'] },
      },
      new Date('2026-08-22T00:00:00.000Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('failed');
  });

  it('only accepts named, unexpired waivers for non-critical checks', () => {
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        featureStatus: { auditedOn: '2026-01-01', statuses: ['production'] },
        waivers: [
          {
            checkId: 'feature-status',
            owner: 'release-owner',
            reason: 'audit scheduled',
            expiresAt: '2026-08-30',
          },
        ],
      },
      new Date('2026-08-22T00:00:00.000Z'),
    );
    expect(result.passed).toBe(true);
    expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('waived');
  });

  it('writes machine-readable report, manifest, SBOM, and artifact hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-root-'));
    const output = mkdtempSync(join(tmpdir(), 'joy-release-gate-'));
    mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
    writeFileSync(join(root, 'apps/api/dist/server.js'), 'release artifact');
    const evidence = {
      ...passingInput(),
      artifactHashes: {
        'apps/api/dist/server.js': sha256File(join(root, 'apps/api/dist/server.js')),
      },
      manifest: {
        schemaVersion: 1,
        artifacts: {
          'apps/api/dist/server.js': sha256File(join(root, 'apps/api/dist/server.js')),
        },
      },
      sbom: { bomFormat: 'cyclonedx', components: [] },
    };
    const result = writeReleaseEvidence(
      root,
      output,
      evidence,
      new Date('2026-08-22T00:00:00.000Z'),
    );
    expect(result.passed).toBe(true);
    expect(existsSync(join(output, 'report.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toEqual(
      evidence.manifest,
    );
    expect(JSON.parse(readFileSync(join(output, 'sbom.json'), 'utf8'))).toEqual(evidence.sbom);
    expect(JSON.parse(readFileSync(join(output, 'artifact-hashes.json'), 'utf8'))).toEqual(
      evidence.artifactHashes,
    );
  });
});
