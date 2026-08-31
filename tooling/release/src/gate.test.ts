import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStaticAssetInventory,
  evaluateReleaseGate,
  FEATURE_STATUS_PATH,
  findProductionFixtureRegistrations,
  findTrackedArtifactViolations,
  RELEASE_COMMANDS,
  REQUIRED_BUILD_IDS,
  REQUIRED_EFFECT_MOTION_PREVIEW_COUNT,
  REQUIRED_JOURNEY_ID,
  sha256File,
  verifyDeploymentManifests,
  verifyRequiredEditorStaticAssets,
  verifyBrowserJourneyEvidence,
  writeReleaseEvidence,
  type ReleaseGateInput,
  type ReleaseOperationalEvidence,
  type ReleaseSourceProvenance,
} from './gate.js';

const sourceProvenance = (commit = 'a'.repeat(40)): ReleaseSourceProvenance => ({
  commitSha: commit,
  treeHash: 'b'.repeat(40),
  lockfileSha256: 'c'.repeat(64),
  worktreeClean: true,
});

const staticAssetInventory = () => ({
  assets: [
    {
      path: 'assets/transition-preview-frame-a.svg',
      kind: 'required-transition-frame' as const,
      mimeType: 'image/svg+xml',
      signature: '<svg',
      size: 20,
      sha256: '1'.repeat(64),
      sourcePath: 'apps/editor-web/public/assets/transition-preview-frame-a.svg',
      sourceSha256: '2'.repeat(64),
    },
    {
      path: 'effects/preview/glow.png',
      kind: 'effect-preview' as const,
      mimeType: 'image/png',
      signature: '89504e470d0a1a0a',
      size: 4,
      sha256: '3'.repeat(64),
      sourcePath: 'apps/editor-web/public/effects/preview/glow.png',
      sourceSha256: '4'.repeat(64),
    },
    {
      path: 'effects/preview-motion/joy-motion-01.webm',
      kind: 'effect-motion-preview' as const,
      mimeType: 'video/webm',
      signature: '1a45dfa3',
      size: 4,
      sha256: '5'.repeat(64),
      sourcePath: 'apps/editor-web/public/effects/preview-motion/joy-motion-01.webm',
      sourceSha256: '6'.repeat(64),
    },
    {
      path: 'assets/index-a1b2c3.js',
      kind: 'built-asset' as const,
      mimeType: 'text/javascript',
      signature: 'console.log("ok"',
      size: 18,
      sha256: '7'.repeat(64),
    },
  ],
  htmlEntryPoints: ['index.html'],
  htmlReferences: ['assets/index-a1b2c3.js'],
  summary: {
    publicAssetCount: 54,
    copiedSourceAssetCount: 53,
    builtAssetCount: 1,
    requiredTransitionFrameCount: 2,
    effectPreviewCount: 33,
    effectMotionPreviewCount: REQUIRED_EFFECT_MOTION_PREVIEW_COUNT,
  },
});

const performanceEvidence = () => ({
  runId: 'test-run',
  generatedAt: '2026-08-28T11:00:00.000Z',
  generator: 'joy-media-release-observer' as const,
  phase: 'staging' as const,
  sourceProvenance: sourceProvenance(),
  polling: {
    artifactPath: 'test-output/release-performance/polling.json',
    warmupMs: 60_000,
    durationMs: 60_000,
    visibleRequestsPerMinute: 1,
    hiddenRequestsPerMinute: 0,
    duplicateInFlightRequests: 0,
    queryRatePerMinute: 1,
  },
  effectsSoak: {
    artifactPath: 'test-output/release-performance/effects-soak.json',
    durationMs: 30 * 60_000,
    categoriesVisited: 9,
    searchIterations: 1,
    favoriteIterations: 1,
    uncaughtExceptions: 0,
    navigationFailures: 0,
    maxMountedPreviews: 12,
    maxPlayingPreviews: 6,
    heapGrowthPercent: 20,
  },
  timelineIntegrity: {
    artifactPath: 'test-output/release-performance/timeline-integrity.json',
    operations: 100,
    countSequence: [2, 4, 3, 4],
    uniqueIds: true,
    orphanReferences: 0,
    canonicalModelEqualAfterReload: true,
  },
  editor: {
    artifactPath: 'test-output/release-performance/editor.json',
    measuredWallTimeMs: 60_000,
    longTaskPercent: 0,
    initialEditorJsBytes: 500_000,
  },
});

const operationalEvidence = (): ReleaseOperationalEvidence => ({
  delivery: {
    schemaVersion: 1,
    status: 'verified',
    execution: 'real-services',
    delivery: {
      mixedSourceExport: {
        status: 'passed',
        producer: 'joy-export-mp4',
        bytes: 128,
        sha256: 'd'.repeat(64),
        durableRedownloadMatched: true,
      },
      downloaded: { status: 200, bytes: 128, sha256: 'd'.repeat(64) },
      ffprobe: { status: 'passed', streamTypes: ['video', 'audio'] },
      reimport: {
        status: 201,
        uploadStatus: 201,
        downloadStatus: 200,
        bytes: 128,
        sha256: 'd'.repeat(64),
      },
      cancelRetry: { canceledState: 'canceled', retriedState: 'queued' },
      missingSource: { status: 409 },
    },
  },
  windows: {
    schemaVersion: 1,
    status: 'verified',
    execution: 'windows-clean-worker',
    lifecycle: {
      install: { status: 'passed' },
      startup: { status: 'passed', daemon: { started: true, terminated: true } },
      session: {
        status: 'passed',
        stateIsolated: true,
        ownerSessionUsed: false,
        persistedSession: false,
      },
      renewal: { status: 'passed', restarted: true },
      recovery: { status: 'passed' },
      repair: { status: 'passed', restored: true },
      update: { status: 'passed', atomicReplacement: true, distinctPackageBytes: true },
      rollback: { status: 'passed' },
      uninstall: { status: 'passed' },
    },
    signing: { status: 'unsigned' },
  },
  restore: {
    schemaVersion: 1,
    status: 'verified',
    execution: 'real-services',
    restore: {
      status: 'passed',
      schemaIsolation: true,
      nVersion: { status: 'passed' },
      nMinusOneVersion: { status: 'passed' },
      cleanup: { status: 'passed' },
    },
  },
});

const passingInput = (): ReleaseGateInput => ({
  testSummary: { collected: 12, failed: 0 },
  dirtyGeneratedArtifacts: [],
  fixtureHandlers: [],
  deploymentManifests: [],
  builds: Object.fromEntries(REQUIRED_BUILD_IDS.map((id) => [id, true])),
  staticAssetPackaging: [],
  staticAssetInventory: staticAssetInventory(),
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
    sourcePath: FEATURE_STATUS_PATH,
    present: true,
  },
  performanceEvidence: performanceEvidence(),
});

describe('JOY Studio 1.0 release gate', () => {
  it('keeps the self-hosted CI check before the browser audit', () => {
    const editorBuild = RELEASE_COMMANDS.findIndex(([id]) => id === 'editor-build');
    const tests = RELEASE_COMMANDS.findIndex(([id]) => id === 'tests');
    expect(editorBuild).toBeGreaterThanOrEqual(0);
    expect(editorBuild).toBeLessThan(tests);

    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    const verifyCi = workflowLines.indexOf('- run: pnpm run verify:ci');
    expect(verifyCi).toBeGreaterThanOrEqual(0);
    expect(workflowLines).toContain('browser-e2e:');
    expect(workflowLines).toContain('needs: check');
  });

  it('keeps production dependency auditing in the CI verification contract', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    expect(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')).toContain(
      '"audit:prod": "pnpm audit --prod --audit-level=moderate"',
    );
    expect(workflowLines).toContain('- run: pnpm run verify:ci');
    expect(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')).toContain(
      '"release:gate": "node --experimental-strip-types tooling/release/src/gate.ts"',
    );
  });

  it('keeps source-bound release evidence outside the basic self-hosted CI check', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    expect(workflowLines).not.toContain('- run: pnpm run release:gate');
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(readFileSync(resolve(import.meta.dirname, '../../../package.json'), 'utf8')).toContain(
      '"release:gate": "node --experimental-strip-types tooling/release/src/gate.ts"',
    );
  });

  it('serializes trusted mainline CI runs and isolates browser matrix outputs', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('JOY_MEDIA_E2E_API_PORT: ${{ matrix.api_port }}');
    expect(workflow).toContain('JOY_MEDIA_E2E_WEB_PORT: ${{ matrix.web_port }}');
    expect(workflow).toContain(
      'PLAYWRIGHT_HTML_REPORT: playwright-report-${{ matrix.project }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(workflow).toContain(
      'PLAYWRIGHT_TEST_RESULTS_DIR: playwright-test-results-${{ matrix.project }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(workflow).toContain(
      'joy-worker-" + $env:GITHUB_SHA + "-" + $env:GITHUB_RUN_ID + "-" + $env:GITHUB_RUN_ATTEMPT + ".exe"',
    );
  });

  it('isolates and always cleans release acceptance Playwright outputs', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
      'utf8',
    );
    const acceptance = workflow.slice(workflow.indexOf('\n  acceptance:'));

    expect(acceptance).toContain(
      'PLAYWRIGHT_HTML_REPORT: ${{ runner.temp }}/joy-media-playwright-report-acceptance-${{ matrix.profile }}-${{ matrix.pass }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(acceptance).toContain(
      'PLAYWRIGHT_TEST_RESULTS_DIR: ${{ runner.temp }}/joy-media-playwright-results-acceptance-${{ matrix.profile }}-${{ matrix.pass }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(acceptance).toContain('- name: Verify acceptance teardown\n        if: always()');
    expect(acceptance).toContain(
      'for output_path in "$PLAYWRIGHT_HTML_REPORT" "$PLAYWRIGHT_TEST_RESULTS_DIR"; do',
    );
    expect(acceptance).toContain('"$RUNNER_TEMP"/*) ;;');
    expect(acceptance).toContain('rm -rf -- "$output_path"');
    expect(acceptance).toContain('test ! -e "$output_path"');
    expect(acceptance).toContain('test -z "$(git status --porcelain)"');
  });

  it('requires a separate real-service acceptance/evidence pass before release proof', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
      'utf8',
    );
    const realAcceptance = workflow.slice(workflow.indexOf('\n  real-service-acceptance:'));
    expect(realAcceptance).toContain('runs-on: [self-hosted, linux, x64, joy-media-acceptance]');
    expect(realAcceptance).toContain(
      'needs: [validate-candidate, acceptance, windows-worker-clean]',
    );
    expect(realAcceptance).toContain(
      'test "${JOY_MEDIA_CI_ACCEPTANCE_PROFILE:-}" = \'real-services\'',
    );
    expect(realAcceptance).toContain('test "${JOY_MEDIA_CI_ACCEPTANCE_WORKER:-}" = \'disposable\'');
    expect(realAcceptance).toContain('JOY_MEDIA_CI_REAL_ACCEPTANCE_COMMAND');
    expect(realAcceptance).toContain('test-output/browser/journeys.json');
    expect(realAcceptance).toContain('test-output/release-performance/polling.json');
    expect(realAcceptance).toContain('test-output/delivery/result.json');
    expect(realAcceptance).toContain('test-output/windows/acceptance.json');
    expect(realAcceptance).toContain('test-output/operations/restore.json');
    expect(realAcceptance).toContain('WINDOWS_EVIDENCE_1_B64');
    expect(realAcceptance).toContain('WINDOWS_EVIDENCE_2_B64');
    expect(realAcceptance).toContain('case "${{ matrix.pass }}" in');
    expect(realAcceptance).toContain('mkdir -p test-output/windows');
    expect(realAcceptance).toContain(
      'printf \'%s\' "$WINDOWS_EVIDENCE_B64" | base64 --decode > test-output/windows/acceptance.json',
    );
    expect(realAcceptance).toContain('pnpm run release:gate');
    expect(realAcceptance).toContain('test -z "${JOY_MEDIA_OPENCLI_PROFILE:-}"');
  });

  it('validates the checked-out candidate and always checks Worker teardown', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/release-candidate.yml'),
      'utf8',
    );
    const validationStart = workflow.indexOf('\n  validate-candidate:');
    const validationEnd = workflow.indexOf('\n  linux-real-services:');
    const validation = workflow.slice(validationStart, validationEnd);
    expect(validation).toContain('Validate immutable candidate input');
    expect(validation).toContain('^[0-9a-f]{40}$');
    expect(validation).toContain('ref: ${{ env.CANDIDATE_SHA }}');
    expect(validation).toContain('resolved_sha="$(git rev-parse HEAD)"');
    expect(validation).toContain('resolved_sha');
    expect(validation.indexOf('uses: actions/checkout@')).toBeLessThan(
      validation.indexOf('Validate immutable candidate input'),
    );
    expect(validation).toContain('persist-credentials: false');
    const windows = workflow.slice(workflow.indexOf('\n  windows-worker-clean:'));
    expect(windows).toContain('needs: [validate-candidate]');
    expect(windows).toContain('evidence1: ${{ steps.publish-evidence.outputs.evidence1 }}');
    expect(windows).toContain('evidence2: ${{ steps.publish-evidence.outputs.evidence2 }}');
    expect(windows).toContain("foreach ($pass in @('1', '2'))");
    expect(windows).toContain('joy-worker-clean-" + $env:CANDIDATE_SHA');
    expect(windows).toContain('Verify clean Worker teardown\n        if: always()');
    expect(windows).toContain("Get-Process -Name 'joy-worker'");
    expect(windows).not.toContain('actions/upload-artifact');
    expect(windows).not.toContain('actions/download-artifact');
    const linux = workflow.slice(workflow.indexOf('\n  linux-real-services:'));
    expect(linux).toContain('needs: [validate-candidate]');
    expect(linux).toContain('Verify no untracked teardown residue\n        if: always()');
  });

  it('verifies the self-hosted FFmpeg/FFprobe toolchain before CI dependencies', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../../.github/workflows/ci.yml'),
      'utf8',
    );
    const workflowLines = workflow.split(/\r?\n/u).map((line) => line.trim());
    const toolchain = workflowLines.indexOf('- name: Install media toolchain');
    const install = workflowLines.indexOf('- run: pnpm install --frozen-lockfile');

    expect(toolchain).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(toolchain);
    for (const command of ['ffmpeg -version', 'ffprobe -version']) {
      const index = workflowLines.indexOf(command);
      expect(index, `${command} must be present`).toBeGreaterThan(toolchain);
      expect(index).toBeLessThan(install);
    }
    expect(workflow).not.toContain('sudo apt-get');
  });

  it('lets Playwright derive ports and output paths from the workflow environment', () => {
    const config = readFileSync(
      resolve(import.meta.dirname, '../../../playwright.config.ts'),
      'utf8',
    );
    expect(config).toContain("const e2eApiPort = process.env.JOY_MEDIA_E2E_API_PORT ?? '4174';");
    expect(config).toContain("const e2eWebPort = process.env.JOY_MEDIA_E2E_WEB_PORT ?? '4173';");
    expect(config).toContain(
      "const playwrightReportDirectory = process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report';",
    );
    expect(config).toContain(
      "process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? 'test-results/playwright';",
    );
    expect(config).toContain('outputDir: playwrightOutputDirectory,');
    expect(config).toContain('url: `${e2eApiUrl}/health`,');
    expect(config).toContain(
      'command: `pnpm --filter @joy-media/editor-web dev --host 127.0.0.1 --port ${e2eWebPort}`',
    );
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
    expect(config).toContain('location = /live {\n        proxy_pass http://127.0.0.1:8790/live;');
    expect(config).toContain(
      'location = /ready {\n        proxy_pass http://127.0.0.1:8790/ready;',
    );
    expect(config).toContain(
      'location = /health/ready {\n        proxy_pass http://127.0.0.1:8790/health/ready;',
    );
    expect(config.match(/try_files \$uri =404;/gu)).toHaveLength(2);
    expect(config.match(/try_files \$uri \$uri\/ \/index\.html;/gu)).toHaveLength(1);
  });

  it('requires deployment manifests and rollback markers in release evidence', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      deploymentManifests: ['deploy/README.md missing: systemctl restart joy-media@api'],
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'deployment-manifests')?.status).toBe(
      'failed',
    );
  });

  it('verifies nginx, override, and rollback docs directly from the workspace', () => {
    expect(verifyDeploymentManifests(resolve(import.meta.dirname, '../../../'))).toEqual([]);
  });

  it('fails closed when deployment manifests or rollback markers are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-deploy-root-'));
    mkdirSync(join(root, 'deploy'), { recursive: true });
    writeFileSync(
      join(root, 'deploy/joy-media.nginx.conf'),
      'location = /live {\nproxy_pass http://127.0.0.1:8790/live;\n}',
    );
    writeFileSync(
      join(root, 'deploy/joy-media-api.override.conf'),
      'WorkingDirectory=/opt/joy-media/releases/current-api',
    );
    writeFileSync(join(root, 'deploy/README.md'), 'Rollback is manual.');

    expect(verifyDeploymentManifests(root)).toEqual([
      'deploy/joy-media.nginx.conf missing: location = /ready {',
      'deploy/joy-media.nginx.conf missing: proxy_pass http://127.0.0.1:8790/ready;',
      'deploy/joy-media.nginx.conf missing: location = /health/ready {',
      'deploy/joy-media.nginx.conf missing: proxy_pass http://127.0.0.1:8790/health/ready;',
      'deploy/joy-media.nginx.conf missing: try_files $uri =404;',
      'deploy/joy-media-api.override.conf missing: EnvironmentFile=/etc/joy-media/api.env',
      'deploy/README.md missing: current-api',
      'deploy/README.md missing: web',
      'deploy/README.md missing: /opt/joy-media/web-releases/',
      'deploy/README.md missing: release-identity.env',
      'deploy/README.md missing: joy-media-release-identity.sh write',
      'deploy/README.md missing: systemctl restart joy-media@api',
      'deploy/README.md missing: Back up the database',
      'missing file: deploy/joy-media-release-identity.sh',
      'missing file: deploy/joy-media-rollback.sh',
    ]);
  });

  it('fails the gate if required transition frames are not packaged as SVG', () => {
    const result = evaluateReleaseGate({
      ...passingInput(),
      staticAssetPackaging: [
        'build output has invalid signature: assets/transition-preview-frame-b.svg',
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'static-assets')?.status).toBe('failed');
  });

  it('requires byte-for-byte SVG static assets in the editor build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-static-assets-'));
    const asset = 'assets/transition-preview-frame-a.svg';
    const sourcePath = join(root, 'apps/editor-web/public', asset);
    const outputPath = join(root, 'apps/editor-web/dist', asset);
    mkdirSync(join(root, 'apps/editor-web/dist/assets'), { recursive: true });
    mkdirSync(join(root, 'apps/editor-web/dist'), { recursive: true });
    writeFileSync(
      join(root, 'apps/editor-web/dist/index.html'),
      '<script src="/assets/index.js"></script>',
    );
    writeFileSync(join(root, 'apps/editor-web/dist/assets/index.js'), 'console.log("ok");');
    mkdirSync(resolve(sourcePath, '..'), { recursive: true });
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    writeFileSync(sourcePath, '<svg viewBox="0 0 1 1"/>');
    writeFileSync(outputPath, '<!doctype html><html></html>');

    expect(verifyRequiredEditorStaticAssets(root)).toEqual([
      `build output has invalid signature: ${asset}`,
      'source missing: assets/transition-preview-frame-b.svg',
    ]);

    writeFileSync(outputPath, '<svg viewBox="0 0 1 1"/>');
    const secondSource = join(root, 'apps/editor-web/public/assets/transition-preview-frame-b.svg');
    const secondOutput = join(root, 'apps/editor-web/dist/assets/transition-preview-frame-b.svg');
    writeFileSync(secondSource, '<svg viewBox="0 0 1 1"/>');
    writeFileSync(secondOutput, '<svg viewBox="0 0 1 1"/>');
    expect(verifyRequiredEditorStaticAssets(root)).toEqual([]);
  });

  it('records a deterministic static asset inventory from the editor build', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-static-inventory-'));
    const svgAssets = [
      'assets/transition-preview-frame-a.svg',
      'assets/transition-preview-frame-b.svg',
    ];
    const publicFiles = [
      ...svgAssets,
      'effects/preview/glow.png',
      'effects/preview/emboss.png',
      'effects/preview/sepia.png',
      'effects/preview-motion/joy-motion-01.webm',
      'effects/preview-motion/joy-motion-02.webm',
      'fonts/demo.woff2',
    ];
    for (const asset of publicFiles) {
      const sourcePath = join(root, 'apps/editor-web/public', asset);
      const distPath = join(root, 'apps/editor-web/dist', asset);
      mkdirSync(resolve(sourcePath, '..'), { recursive: true });
      mkdirSync(resolve(distPath, '..'), { recursive: true });
      if (asset.endsWith('.svg')) {
        writeFileSync(sourcePath, '<svg viewBox="0 0 1 1"/>');
        writeFileSync(distPath, '<svg viewBox="0 0 1 1"/>');
      } else if (asset.endsWith('.png')) {
        const png = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
        ]);
        writeFileSync(sourcePath, png);
        writeFileSync(distPath, png);
      } else if (asset.endsWith('.webm')) {
        const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42]);
        writeFileSync(sourcePath, webm);
        writeFileSync(distPath, webm);
      } else {
        const woff2 = Buffer.from('wOF2demo');
        writeFileSync(sourcePath, woff2);
        writeFileSync(distPath, woff2);
      }
    }
    const builtJs = join(root, 'apps/editor-web/dist/assets/index-abcd1234.js');
    mkdirSync(resolve(builtJs, '..'), { recursive: true });
    writeFileSync(builtJs, 'console.log("release");');
    writeFileSync(
      join(root, 'apps/editor-web/dist/index.html'),
      '<link href="/fonts/demo.woff2" rel="preload"><script src="/assets/index-abcd1234.js"></script>',
    );

    const result = buildStaticAssetInventory(root);
    expect(result.errors).toEqual([]);
    expect(result.inventory.htmlEntryPoints).toEqual(['index.html']);
    expect(result.inventory.htmlReferences).toEqual([
      'assets/index-abcd1234.js',
      'fonts/demo.woff2',
    ]);
    expect(result.inventory.summary.requiredTransitionFrameCount).toBe(2);
    expect(result.inventory.summary.effectPreviewCount).toBe(3);
    expect(result.inventory.summary.effectMotionPreviewCount).toBe(2);
    expect(
      result.inventory.assets.find((asset) => asset.path === 'assets/index-abcd1234.js'),
    ).toMatchObject({
      kind: 'built-asset',
      mimeType: 'text/javascript',
      size: expect.any(Number),
      sha256: expect.any(String),
    });
  });

  it('requires every effect preview binary to survive the build without an SPA fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-effect-assets-'));
    const asset = 'effects/preview/glow.png';
    const sourcePath = join(root, 'apps/editor-web/public', asset);
    const outputPath = join(root, 'apps/editor-web/dist', asset);
    mkdirSync(join(root, 'apps/editor-web/dist/assets'), { recursive: true });
    mkdirSync(join(root, 'apps/editor-web/dist'), { recursive: true });
    writeFileSync(
      join(root, 'apps/editor-web/dist/index.html'),
      '<script src="/assets/index.js"></script>',
    );
    writeFileSync(join(root, 'apps/editor-web/dist/assets/index.js'), 'console.log("ok");');
    mkdirSync(resolve(sourcePath, '..'), { recursive: true });
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    writeFileSync(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    writeFileSync(outputPath, '<!doctype html><html></html>');

    expect(verifyRequiredEditorStaticAssets(root)).toEqual([
      'source missing: assets/transition-preview-frame-a.svg',
      'source missing: assets/transition-preview-frame-b.svg',
      'build output has invalid signature: effects/preview/glow.png',
    ]);

    writeFileSync(outputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(verifyRequiredEditorStaticAssets(root)).toEqual([
      'source missing: assets/transition-preview-frame-a.svg',
      'source missing: assets/transition-preview-frame-b.svg',
    ]);
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

  it('explains when source provenance is missing from journey evidence', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const current = sourceProvenance();
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        sourceProvenance: current,
        browserJourneys: [
          {
            ...passingInput().browserJourneys[0]!,
            verifiedAt: '2026-08-28T11:00:00.000Z',
          },
        ],
      },
      now,
    );

    expect(result.checks.find((check) => check.id === 'source-provenance')).toMatchObject({
      status: 'failed',
      message:
        'authenticated browser evidence is not bound to a source revision; the journey evidence JSON must contain sourceProvenance',
    });
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

  it('requires all provenance-bound quantitative release evidence', () => {
    const missing = evaluateReleaseGate({ ...passingInput(), performanceEvidence: undefined });
    expect(missing.passed).toBe(false);
    expect(missing.checks.find((check) => check.id === 'performance-evidence')).toMatchObject({
      status: 'failed',
      message: 'quantitative performance evidence is missing',
    });

    const overBudget = evaluateReleaseGate({
      ...passingInput(),
      performanceEvidence: {
        ...performanceEvidence(),
        effectsSoak: { ...performanceEvidence().effectsSoak, maxPlayingPreviews: 7 },
      },
    });
    expect(overBudget.passed).toBe(false);
    expect(overBudget.checks.find((check) => check.id === 'performance-evidence')?.status).toBe(
      'failed',
    );

    const malformed = evaluateReleaseGate({
      ...passingInput(),
      performanceEvidence: {
        ...performanceEvidence(),
        polling: undefined,
      } as unknown as ReleaseGateInput['performanceEvidence'],
    });
    expect(malformed.passed).toBe(false);
    expect(malformed.checks.find((check) => check.id === 'performance-evidence')?.message).toBe(
      'performance evidence metric blocks are malformed',
    );
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

  it('names the exact release command that failed', () => {
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
        exitCode: id === 'format' ? 1 : 0,
        durationMs: 1,
      })),
    });

    expect(result.checks.find((check) => check.id === 'command-health')).toMatchObject({
      status: 'failed',
      message: 'one or more required release commands failed: format',
    });
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
    ['fixture job registration', "registerFixtureJob('thumbnail', handler);"],
    ['fixture handler registration', "registry.registerFixtureHandler('thumbnail', handler);"],
    ['fixture enqueue path', "await client.enqueueFixture('project', 'fixture-thumbnail-id');"],
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

  it('ignores fixture comments, declarations, and dist output', () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-release-fixture-ignore-root-'));
    mkdirSync(join(root, 'apps/api/src'), { recursive: true });
    mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
    writeFileSync(
      join(root, 'apps/api/src/control-plane.ts'),
      [
        '/** fixture.thumbnail is a transport kind, not a registration. */',
        'export interface FixtureReceipt {',
        "  readonly kind: 'fixture.thumbnail';",
        '}',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'apps/api/dist/control-plane.d.ts'),
      "export interface FixtureReceipt { readonly kind: 'fixture.thumbnail'; }",
    );

    expect(findProductionFixtureRegistrations(root)).toEqual([]);
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
    expect(result.checks.find((check) => check.id === 'browser-journey')).toMatchObject({
      status: 'failed',
      message:
        'required journey authenticated-editor-1.0 is missing; supply test-output/browser/journeys.json or JOY_RELEASE_EVIDENCE.browserJourneys',
    });
  });

  it('rejects stale feature status', () => {
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        featureStatus: {
          auditedOn: '2026-01-01',
          statuses: ['production'],
          sourcePath: FEATURE_STATUS_PATH,
          present: true,
        },
      },
      new Date('2026-08-22T00:00:00.000Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('failed');
  });

  it('requires complete operational evidence when a real workspace supplies it', () => {
    const passed = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: operationalEvidence(),
    });
    expect(passed.checks.find((check) => check.id === 'operational-evidence')).toMatchObject({
      status: 'passed',
    });

    const incomplete = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: null,
    });
    expect(incomplete.checks.find((check) => check.id === 'operational-evidence')).toMatchObject({
      status: 'failed',
      message: 'delivery, Windows, and restore evidence is missing',
    });
  });

  it('requires export bytes and hashes to match download and re-import evidence', () => {
    const evidence = operationalEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: {
        ...evidence,
        delivery: {
          ...evidence.delivery,
          delivery: {
            ...(evidence.delivery.delivery as Record<string, unknown>),
            downloaded: { status: 200, bytes: 128, sha256: 'e'.repeat(64) },
          },
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'operational-evidence')?.status).toBe(
      'failed',
    );
  });

  it('rejects delivery evidence that is not bound to the JOY export path', () => {
    const evidence = operationalEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: {
        ...evidence,
        delivery: {
          ...evidence.delivery,
          delivery: {
            ...(evidence.delivery.delivery as Record<string, unknown>),
            mixedSourceExport: {
              ...((evidence.delivery.delivery as Record<string, unknown>).mixedSourceExport as Record<
                string,
                unknown
              >),
              producer: 'standalone-ffmpeg',
            },
          },
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'operational-evidence')?.status).toBe(
      'failed',
    );
  });

  it('rejects delivery evidence when the retained export cannot be redownloaded byte-for-byte', () => {
    const evidence = operationalEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: {
        ...evidence,
        delivery: {
          ...evidence.delivery,
          delivery: {
            ...(evidence.delivery.delivery as Record<string, unknown>),
            mixedSourceExport: {
              ...((evidence.delivery.delivery as Record<string, unknown>).mixedSourceExport as Record<
                string,
                unknown
              >),
              durableRedownloadMatched: false,
            },
          },
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'operational-evidence')?.status).toBe(
      'failed',
    );
  });

  it('rejects operational evidence with a failed lifecycle step', () => {
    const evidence = operationalEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: {
        ...evidence,
        windows: {
          ...evidence.windows,
          lifecycle: {
            ...evidence.windows.lifecycle,
            startup: { status: 'failed' },
          },
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'operational-evidence')?.status).toBe(
      'failed',
    );
  });

  it('rejects non-verified operational evidence statuses', () => {
    const evidence = operationalEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      operationalEvidence: {
        ...evidence,
        delivery: {
          ...evidence.delivery,
          status: 'smoke-only',
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'operational-evidence')?.status).toBe(
      'failed',
    );
  });

  it('requires strict boolean timeline integrity evidence', () => {
    const evidence = performanceEvidence();
    const result = evaluateReleaseGate({
      ...passingInput(),
      performanceEvidence: {
        ...evidence,
        timelineIntegrity: {
          ...evidence.timelineIntegrity,
          uniqueIds: 1 as unknown as boolean,
        },
      },
    });
    expect(result.checks.find((check) => check.id === 'performance-evidence')?.status).toBe(
      'failed',
    );
  });

  it('fails explicitly when the feature-status document is missing', () => {
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        featureStatus: {
          auditedOn: '1970-01-01',
          statuses: [],
          sourcePath: FEATURE_STATUS_PATH,
          present: false,
        },
      },
      new Date('2026-08-29T00:00:00.000Z'),
    );
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === 'feature-status')).toMatchObject({
      status: 'failed',
      message: `${FEATURE_STATUS_PATH} is missing`,
    });
  });

  it('only accepts named, unexpired waivers for non-critical checks', () => {
    const result = evaluateReleaseGate(
      {
        ...passingInput(),
        featureStatus: {
          auditedOn: '2026-01-01',
          statuses: ['production'],
          sourcePath: FEATURE_STATUS_PATH,
          present: true,
        },
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

  it('writes machine-readable report, manifest, SBOM, asset hashes, and static inventory', () => {
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
    expect(JSON.parse(readFileSync(join(output, 'static-assets.json'), 'utf8'))).toEqual(
      evidence.staticAssetInventory,
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
