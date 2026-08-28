import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateReleaseGate,
  findProductionFixtureRegistrations,
  findTrackedArtifactViolations,
  RELEASE_COMMANDS,
  REQUIRED_BUILD_IDS,
  REQUIRED_JOURNEY_ID,
  sha256File,
  verifyRequiredEditorStaticAssets,
  verifyBrowserJourneyEvidence,
  writeReleaseEvidence,
  type ReleaseGateInput,
  type ReleaseSourceProvenance,
} from './gate.js';

const sourceProvenance = (commit = 'a'.repeat(40)): ReleaseSourceProvenance => ({
  commitSha: commit,
  treeHash: 'b'.repeat(40),
  lockfileSha256: 'c'.repeat(64),
  worktreeClean: true,
});

const passingInput = (): ReleaseGateInput => ({
  testSummary: { collected: 12, failed: 0 },
  dirtyGeneratedArtifacts: [],
  fixtureHandlers: [],
  builds: Object.fromEntries(REQUIRED_BUILD_IDS.map((id) => [id, true])),
  staticAssetPackaging: [],
  manifestGenerated: true,
  sbomGenerated: true,
  browserJourneys: [
    {
      id: REQUIRED_JOURNEY_ID,
      status: 'verified',
      verifiedAt: '2026-08-22',
      evidencePath: 'test-output/browser/authenticated-editor-1.0/journey-evidence.json',
      execution: 'real-services',
      deliveryChannel: 'verified-delivery',
      inspectionState: 'passed',
      postMotionPlacement: true,
    },
  ],
  featureStatus: {
    auditedOn: '2026-08-22',
    statuses: ['production', 'demo-only', 'experimental', 'hidden'],
  },
});

describe('JOY Studio 1.0 release gate', () => {
  it('builds the editor before tests evaluate the generated budget manifest', () => {
    const editorBuild = RELEASE_COMMANDS.findIndex(([id]) => id === 'editor-build');
    const tests = RELEASE_COMMANDS.findIndex(([id]) => id === 'tests');
    expect(editorBuild).toBeGreaterThanOrEqual(0);
    expect(editorBuild).toBeLessThan(tests);

    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    expect(workflowLines.indexOf('- run: pnpm --filter @joy-media/editor-web build')).toBeLessThan(
      workflowLines.indexOf('- run: pnpm check'),
    );
  });

  it('audits production dependency advisories before build and release evaluation', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    const audit = 'run: pnpm audit --prod --audit-level high';
    const auditIndex = workflowLines.indexOf(audit);

    expect(workflowLines.filter((line) => line === audit)).toHaveLength(1);
    expect(auditIndex).toBeGreaterThan(
      workflowLines.indexOf('- run: pnpm install --frozen-lockfile'),
    );
    expect(auditIndex).toBeLessThan(
      workflowLines.indexOf('- run: pnpm --filter @joy-media/editor-web build'),
    );
    expect(auditIndex).toBeLessThan(workflowLines.indexOf('run: pnpm release:gate'));
  });

  it('installs and verifies the FFmpeg/FFprobe toolchain before CI dependencies', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    const toolchain = workflowLines.indexOf('- name: Install media toolchain');
    const install = workflowLines.indexOf('- run: pnpm install --frozen-lockfile');

    expect(toolchain).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(toolchain);
    for (const command of [
      'sudo apt-get update',
      'sudo apt-get install --yes ffmpeg',
      'ffmpeg -version',
      'ffprobe -version',
    ]) {
      const index = workflowLines.indexOf(command);
      expect(index, `${command} must be present`).toBeGreaterThan(toolchain);
      expect(index).toBeLessThan(install);
    }
  });

  it('keeps missing static assets out of the SPA fallback in nginx', () => {
    const config = readFileSync(
      resolve(import.meta.dirname, '../../../deploy/joy-media.nginx.conf'),
      'utf8',
    );
    const staticPrefixes =
      'location ~* ^/(?:assets|effects|fonts|images|media|transitions|workers?|worklets?)/ {';
    const staticExtensions = 'location ~* \\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|mjs|map|';
    const spaFallback = 'try_files $uri $uri/ /index.html;';

    expect(config).toContain(`${staticPrefixes}\n        try_files $uri =404;`);
    expect(config).toContain(staticExtensions);
    expect(config.indexOf(staticPrefixes)).toBeLessThan(config.indexOf(spaFallback));
    expect(config.indexOf(staticExtensions)).toBeLessThan(config.indexOf(spaFallback));
    expect(config).toContain('location ^~ /api/ {');
    expect(config.match(/try_files \$uri =404;/gu)).toHaveLength(2);
    expect(config.match(/try_files \$uri \$uri\/ \/index\.html;/gu)).toHaveLength(1);
  });

  it('fails the gate if required transition frames are not packaged as SVG', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      staticAssetPackaging: ['build output is not SVG: assets/transition-preview-frame-b.svg'],
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'static-assets')?.status).toBe('failed');
  });

  it('requires byte-for-byte SVG static assets in the editor build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-static-assets-'));
    const asset = 'assets/transition-preview-frame-a.svg';
    const sourcePath = join(root, 'apps/editor-web/public', asset);
    const outputPath = join(root, 'apps/editor-web/dist', asset);
    mkdirSync(resolve(sourcePath, '..'), { recursive: true });
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    writeFileSync(sourcePath, '<svg viewBox="0 0 1 1"/>');
    writeFileSync(outputPath, '<!doctype html><html></html>');

    expect(verifyRequiredEditorStaticAssets(root)).toEqual([
      `build output is not SVG: ${asset}`,
      'source missing: assets/transition-preview-frame-b.svg',
    ]);

    writeFileSync(outputPath, '<svg viewBox="0 0 1 1"/>');
    const secondSource = join(root, 'apps/editor-web/public/assets/transition-preview-frame-b.svg');
    const secondOutput = join(root, 'apps/editor-web/dist/assets/transition-preview-frame-b.svg');
    writeFileSync(secondSource, '<svg viewBox="0 0 1 1"/>');
    writeFileSync(secondOutput, '<svg viewBox="0 0 1 1"/>');
    expect(verifyRequiredEditorStaticAssets(root)).toEqual([]);
  });

  it('rejects dirty, missing, stale, or cross-revision browser provenance', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const current = sourceProvenance();
    const journey = {
      ...passingInput().browserJourneys[0]!,
      verifiedAt: '2026-08-28T11:00:00.000Z',
      sourceProvenance: current,
    };
    const { sourceProvenance: omittedSource, ...journeyWithoutSource } = journey;
    void omittedSource;
    expect(
      evaluateReleaseGate(
        {
          ...passingInput(),
          sourceProvenance: current,
          browserJourneys: [journey],
        },
        now,
      ).passed,
    ).toBe(true);

    for (const input of [
      { sourceProvenance: { ...current, worktreeClean: false }, browserJourneys: [journey] },
      { sourceProvenance: current, browserJourneys: [journeyWithoutSource] },
      {
        sourceProvenance: current,
        browserJourneys: [{ ...journey, sourceProvenance: sourceProvenance('d'.repeat(40)) }],
      },
      {
        sourceProvenance: current,
        browserJourneys: [{ ...journey, verifiedAt: '2026-08-26T11:00:00.000Z' }],
      },
    ]) {
      const result = evaluateReleaseGate({ ...passingInput(), ...input }, now);
      expect(result.passed).toBe(false);
      expect(result.checks.find((check) => check.id === 'source-provenance')?.status).toBe(
        'failed',
      );
    }
  });

  it.each([
    ['a mismatched journey id', { journeyId: 'different-journey', status: 'verified' }],
    ['a failed evidence status', { journeyId: REQUIRED_JOURNEY_ID, status: 'failed' }],
  ])('rejects browser index entries backed by %s', (_description, identity) => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-browser-binding-'));
    const evidencePath = join(root, 'test-output/browser/journey-evidence.json');
    mkdirSync(resolve(evidencePath, '..'), { recursive: true });
    writeFileSync(
      evidencePath,
      JSON.stringify({
        ...identity,
        verifiedAt: '2026-08-28T11:00:00.000Z',
        execution: 'real-services',
        sourceProvenance: sourceProvenance(),
        assertions: {
          motionPlacement: [{}, {}],
          verifiedExport: {
            channel: 'verified-delivery',
            inspection: { state: 'passed' },
          },
        },
      }),
    );
    const [journey] = verifyBrowserJourneyEvidence(root, [
      {
        ...passingInput().browserJourneys[0]!,
        evidencePath: 'test-output/browser/journey-evidence.json',
        sourceProvenance: sourceProvenance(),
      },
    ]);

    expect(journey?.status).toBe('unverified');
    expect(journey?.execution).toBe('unknown');
    expect(journey?.sourceProvenance).toBeUndefined();
  });

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

  it('rejects tracked test, debug, and compiled TypeScript artifacts', () => {
    expect(
      findTrackedArtifactViolations([
        '.tmp-p3-debug.mts',
        'test-output/browser/journey.png',
        'tooling/browser-smoke/test-results/.last-run.json',
        'apps/editor-web/src/session.ts',
        'apps/editor-web/src/session.js',
        'apps/editor-web/src/session.js.map',
        'apps/editor-web/src/session.d.ts',
        'apps/editor-web/src/intentional-runtime.js',
        'types/vendor.d.ts',
        'packages/test-fixtures/src/index.ts',
      ]),
    ).toEqual([
      '.tmp-p3-debug.mts',
      'apps/editor-web/src/session.d.ts',
      'apps/editor-web/src/session.js',
      'apps/editor-web/src/session.js.map',
      'test-output/browser/journey.png',
      'tooling/browser-smoke/test-results/.last-run.json',
    ]);
  });

  it('rejects fixture handlers in production registries', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      fixtureHandlers: ['apps/api/src/server.ts: fixture handler'],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'fixture-registries')?.status).toBe('failed');
  });

  it.each([
    ['literal fixture thumbnail job type', "export const type = 'fixture.thumbnail';"],
    ['fixture job registration', "registerFixtureJob('thumbnail', handler);"],
    ['fixture handler registration', "registry.registerFixtureHandler('thumbnail', handler);"],
  ])('rejects %s in production source', (_description, source) => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-fixture-root-'));
    const sourceDirectory = join(root, 'apps/api/src');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(join(sourceDirectory, 'control-plane.ts'), source);

    const fixtureHandlers = findProductionFixtureRegistrations(root);
    expect(fixtureHandlers).toHaveLength(1);
    expect(fixtureHandlers[0]?.replaceAll('\\', '/')).toBe('apps/api/src/control-plane.ts:1');

    const result = evaluateReleaseGate({ ...passingInput(), fixtureHandlers });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'fixture-registries')?.status).toBe('failed');
  });

  it('preserves fixture registrations in test-only source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-test-fixture-root-'));
    const sourceDirectory = join(root, 'apps/api/src');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(sourceDirectory, 'control-plane.test.ts'),
      "registerFixtureJob('fixture.thumbnail', registerFixtureHandler);",
    );

    const fixtureHandlers = findProductionFixtureRegistrations(root);
    expect(fixtureHandlers).toEqual([]);
    expect(evaluateReleaseGate({ ...passingInput(), fixtureHandlers }).passed).toBe(true);
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
      sbom: {
        bomFormat: 'cyclonedx',
        components: [{ type: 'library', name: 'joy-media', version: '1.0.0' }],
      },
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

  it('rejects a source-bound manifest from a different commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-source-root-'));
    const output = mkdtempSync(join(tmpdir(), 'joy-release-source-gate-'));
    mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
    writeFileSync(join(root, 'apps/api/dist/server.js'), 'release artifact');
    const current = sourceProvenance();
    const artifactHash = sha256File(join(root, 'apps/api/dist/server.js'));
    const evidence = {
      ...passingInput(),
      sourceProvenance: current,
      browserJourneys: [{ ...passingInput().browserJourneys[0]!, sourceProvenance: current }],
      artifactHashes: { 'apps/api/dist/server.js': artifactHash },
      manifest: {
        schemaVersion: 2,
        sourceProvenance: sourceProvenance('d'.repeat(40)),
        artifacts: { 'apps/api/dist/server.js': artifactHash },
      },
      sbom: {
        bomFormat: 'cyclonedx',
        components: [{ type: 'library', name: 'joy-media', version: '1.0.0' }],
      },
    };

    expect(() => writeReleaseEvidence(root, output, evidence)).toThrow(
      'release manifest source provenance does not match the workspace evidence',
    );
  });

  it('reports a dirty source-bound checkout as a failed gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-dirty-root-'));
    const output = mkdtempSync(join(tmpdir(), 'joy-release-dirty-gate-'));
    mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
    writeFileSync(join(root, 'apps/api/dist/server.js'), 'release artifact');
    const dirtySource = { ...sourceProvenance(), worktreeClean: false };
    const artifactHash = sha256File(join(root, 'apps/api/dist/server.js'));
    const evidence = {
      ...passingInput(),
      sourceProvenance: dirtySource,
      browserJourneys: [
        {
          ...passingInput().browserJourneys[0]!,
          verifiedAt: '2026-08-28T11:00:00.000Z',
          sourceProvenance: dirtySource,
        },
      ],
      artifactHashes: { 'apps/api/dist/server.js': artifactHash },
      manifest: {
        schemaVersion: 2,
        sourceProvenance: dirtySource,
        artifacts: { 'apps/api/dist/server.js': artifactHash },
      },
      sbom: {
        bomFormat: 'cyclonedx',
        components: [{ type: 'library', name: 'joy-media', version: '1.0.0' }],
      },
    };

    const result = writeReleaseEvidence(
      root,
      output,
      evidence,
      new Date('2026-08-28T12:00:00.000Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'source-provenance')?.status).toBe('failed');
  });
});
