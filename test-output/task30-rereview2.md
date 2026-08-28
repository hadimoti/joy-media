# Review package: 9db3175..2905c26

## Commits
2905c26 fix(release): require complete manifest and SBOM evidence
f0f8233 fix(release): hash artifacts after checks
a18abc7 fix(release): execute and verify gate evidence

## Files changed
 .github/workflows/ci.yml         |   5 +-
 tooling/release/src/gate.test.ts |  19 ++++-
 tooling/release/src/gate.ts      | 175 +++++++++++++++++++++++++++++++++++----
 3 files changed, 174 insertions(+), 25 deletions(-)

## Diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 4ea4ab3..2eee7d7 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -8,25 +8,24 @@ jobs:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - uses: actions/setup-node@v4
         with:
           node-version: 22
       - run: corepack enable pnpm
       - run: pnpm install --frozen-lockfile
       - run: pnpm check
       - run: pnpm release:gate:test
-      - name: Run evidence gate when CI evidence is present
-        if: hashFiles('test-output/release-evidence.json') != ''
+      - name: Run non-deploying release gate
         run: pnpm release:gate
         env:
-          JOY_RELEASE_EVIDENCE: test-output/release-evidence.json
+          JOY_RELEASE_EVIDENCE: ${{ hashFiles('test-output/release-evidence.json') != '' && 'test-output/release-evidence.json' || '' }}
       - name: Upload release evidence
         if: always()
         uses: actions/upload-artifact@v4
         with:
           name: joy-studio-release-evidence
           path: |
             test-output/release-gate
             test-output/browser
             test-output/goldens
           if-no-files-found: ignore
diff --git a/tooling/release/src/gate.test.ts b/tooling/release/src/gate.test.ts
index 9b61f9c..a10996f 100644
--- a/tooling/release/src/gate.test.ts
+++ b/tooling/release/src/gate.test.ts
@@ -1,18 +1,19 @@
-import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it } from 'vitest';
 import {
   evaluateReleaseGate,
   REQUIRED_BUILD_IDS,
   REQUIRED_JOURNEY_ID,
+  sha256File,
   writeReleaseEvidence,
   type ReleaseGateInput,
 } from './gate.js';
 
 const passingInput = (): ReleaseGateInput => ({
   testSummary: { collected: 12, failed: 0 },
   dirtyGeneratedArtifacts: [],
   fixtureHandlers: [],
   builds: Object.fromEntries(REQUIRED_BUILD_IDS.map((id) => [id, true])),
   manifestGenerated: true,
@@ -99,29 +100,39 @@ describe('JOY Studio 1.0 release gate', () => {
           },
         ],
       },
       new Date('2026-08-22T00:00:00.000Z'),
     );
     expect(result.passed).toBe(true);
     expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('waived');
   });
 
   it('writes machine-readable report, manifest, SBOM, and artifact hashes', () => {
+    const root = mkdtempSync(join(tmpdir(), 'joy-release-root-'));
     const output = mkdtempSync(join(tmpdir(), 'joy-release-gate-'));
+    mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
+    writeFileSync(join(root, 'apps/api/dist/server.js'), 'release artifact');
     const evidence = {
       ...passingInput(),
-      artifactHashes: { 'apps/api/dist/server.js': 'abc123' },
-      manifest: { schemaVersion: 1, artifacts: ['apps/api/dist/server.js'] },
+      artifactHashes: {
+        'apps/api/dist/server.js': sha256File(join(root, 'apps/api/dist/server.js')),
+      },
+      manifest: {
+        schemaVersion: 1,
+        artifacts: {
+          'apps/api/dist/server.js': sha256File(join(root, 'apps/api/dist/server.js')),
+        },
+      },
       sbom: { bomFormat: 'cyclonedx', components: [] },
     };
     const result = writeReleaseEvidence(
-      process.cwd(),
+      root,
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
diff --git a/tooling/release/src/gate.ts b/tooling/release/src/gate.ts
index 151a2e3..92ea249 100644
--- a/tooling/release/src/gate.ts
+++ b/tooling/release/src/gate.ts
@@ -1,11 +1,12 @@
 import { createHash } from 'node:crypto';
+import { spawnSync } from 'node:child_process';
 import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
 import { join, relative, resolve } from 'node:path';
 import { fileURLToPath } from 'node:url';
 
 export const REQUIRED_BUILD_IDS = ['editor', 'api', 'worker'] as const;
 export const REQUIRED_JOURNEY_ID = 'authenticated-editor-1.0' as const;
 export const RELEASE_STATUS_MAX_AGE_DAYS = 45;
 
 export type ReleaseCheckStatus = 'passed' | 'failed' | 'waived';
 
@@ -141,105 +142,243 @@ function featureStatusFresh(auditedOn: string, now: Date): boolean {
   const timestamp = Date.parse(auditedOn);
   if (!Number.isFinite(timestamp)) return false;
   const age = now.getTime() - timestamp;
   return age >= 0 && age <= RELEASE_STATUS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
 }
 
 export interface ReleaseEvidence extends ReleaseGateInput {
   readonly artifactHashes: Readonly<Record<string, string>>;
   readonly manifest: Readonly<Record<string, unknown>>;
   readonly sbom: Readonly<Record<string, unknown>>;
+  readonly commandResults?: readonly ReleaseCommandResult[];
+}
+
+export interface ReleaseCommandResult {
+  readonly id: string;
+  readonly command: string;
+  readonly exitCode: number;
+  readonly durationMs: number;
 }
 
 export function sha256File(path: string): string {
   return createHash('sha256').update(readFileSync(path)).digest('hex');
 }
 
 export function writeReleaseEvidence(
   root: string,
   outputDirectory: string,
   evidence: ReleaseEvidence,
   now = new Date(),
 ): ReleaseGateResult {
   mkdirSync(outputDirectory, { recursive: true });
+  verifyArtifactHashes(root, evidence.artifactHashes, evidence.manifest);
+  verifyReleaseDocuments(evidence.manifest, evidence.sbom);
   const result = evaluateReleaseGate(evidence, now);
+  const manifestText = JSON.stringify(evidence.manifest, null, 2);
   writeFileSync(
     join(outputDirectory, 'report.json'),
     JSON.stringify({ result, evidence }, null, 2),
   );
-  writeFileSync(join(outputDirectory, 'manifest.json'), JSON.stringify(evidence.manifest, null, 2));
+  writeFileSync(join(outputDirectory, 'manifest.json'), manifestText);
   writeFileSync(join(outputDirectory, 'sbom.json'), JSON.stringify(evidence.sbom, null, 2));
   writeFileSync(
     join(outputDirectory, 'artifact-hashes.json'),
     JSON.stringify(evidence.artifactHashes, null, 2),
   );
   writeFileSync(
     join(outputDirectory, 'release-manifest.sha256'),
-    `${sha256Text(JSON.stringify(evidence.manifest))}  manifest.json\n`,
+    `${sha256Text(manifestText)}  manifest.json\n`,
   );
   void root;
   return result;
 }
 
 export function sha256Text(value: string): string {
   return createHash('sha256').update(value).digest('hex');
 }
 
 function collectFiles(root: string, directory: string): readonly string[] {
   const absolute = resolve(root, directory);
   if (!existsSync(absolute)) return [];
   return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
     const path = join(absolute, entry.name);
     return entry.isDirectory() ? collectFiles(root, relative(root, path)) : [path];
   });
 }
 
 export function buildEvidenceFromWorkspace(root: string): ReleaseEvidence {
+  const commandResults = runReleaseCommands(root);
   const artifacts = ['apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'];
+  const buildSuccess = Object.fromEntries(
+    REQUIRED_BUILD_IDS.map((id) => {
+      const commandId = `${id}-build`;
+      return [
+        id,
+        commandResults.some((result) => result.id === commandId && result.exitCode === 0) &&
+          collectFiles(root, `apps/${id === 'editor' ? 'editor-web' : id}/dist`).length > 0,
+      ];
+    }),
+  );
   const artifactHashes: Record<string, string> = {};
   for (const directory of artifacts) {
     for (const path of collectFiles(root, directory))
       artifactHashes[relative(root, path)] = sha256File(path);
   }
-  const buildSuccess = Object.fromEntries(
-    REQUIRED_BUILD_IDS.map((id) => [
-      id,
-      collectFiles(root, `apps/${id === 'editor' ? 'editor-web' : id}/dist`).length > 0,
-    ]),
-  );
+  const tests = commandResults.find((result) => result.id === 'tests');
+  const featureStatusText = existsSync(join(root, 'docs/product/FEATURE-STATUS.md'))
+    ? readFileSync(join(root, 'docs/product/FEATURE-STATUS.md'), 'utf8')
+    : '';
+  const auditedOn =
+    featureStatusText.match(/Audited against current source on (\d{4}-\d{2}-\d{2})/u)?.[1] ??
+    '1970-01-01';
+  const statuses = [
+    ...featureStatusText.matchAll(/\|\s+(production|demo-only|experimental|hidden)\s+\|/gu),
+  ].map((match) => match[1]!);
+  const browserJourneys = readBrowserJourneys(root);
   const manifest = {
     schemaVersion: 1,
     generatedAt: new Date().toISOString(),
     artifacts: artifactHashes,
+    commands: commandResults,
   };
   const sbom = {
     bomFormat: 'cyclonedx',
     specVersion: '1.5',
     components: [{ type: 'application', name: 'joy-media', version: '1.0.0' }],
   };
   return {
-    testSummary: { collected: 0, failed: 1 },
-    dirtyGeneratedArtifacts: [],
-    fixtureHandlers: [],
+    testSummary: { collected: tests === undefined ? 0 : 1, failed: tests?.exitCode === 0 ? 0 : 1 },
+    dirtyGeneratedArtifacts: dirtyGeneratedArtifacts(root),
+    fixtureHandlers: fixtureHandlers(root),
     builds: buildSuccess,
-    manifestGenerated: false,
-    sbomGenerated: false,
-    browserJourneys: [],
-    featureStatus: { auditedOn: '1970-01-01', statuses: [] },
+    manifestGenerated: true,
+    sbomGenerated: true,
+    browserJourneys,
+    featureStatus: { auditedOn, statuses },
     artifactHashes,
     manifest,
     sbom,
+    commandResults,
   };
 }
 
+function runReleaseCommands(root: string): readonly ReleaseCommandResult[] {
+  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
+  const commands: readonly [string, readonly string[]][] = [
+    ['typecheck', ['typecheck']],
+    ['lint', ['lint']],
+    ['format', ['format:check']],
+    ['tests', ['test:release']],
+    ['editor-build', ['--filter', '@joy-media/editor-web', 'build']],
+    ['api-build', ['--filter', '@joy-media/api', 'build']],
+    ['worker-build', ['--filter', '@joy-media/worker', 'build']],
+    ['goldens', ['exec', 'vitest', 'run', 'tooling/golden-render/src']],
+  ];
+  return commands.map(([id, args]) => {
+    const started = Date.now();
+    const result = spawnSync(pnpm, args, { cwd: root, stdio: 'ignore', shell: false });
+    return {
+      id,
+      command: [pnpm, ...args].join(' '),
+      exitCode: result.status ?? 1,
+      durationMs: Date.now() - started,
+    };
+  });
+}
+
+function dirtyGeneratedArtifacts(root: string): readonly string[] {
+  const pnpm = process.platform === 'win32' ? 'git.exe' : 'git';
+  const result = spawnSync(
+    pnpm,
+    ['status', '--porcelain', '--', 'apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'],
+    {
+      cwd: root,
+      encoding: 'utf8',
+      shell: false,
+    },
+  );
+  return (result.stdout ?? '')
+    .split(/\r?\n/u)
+    .map((line) => line.trim())
+    .filter(Boolean);
+}
+
+function fixtureHandlers(root: string): readonly string[] {
+  return collectFiles(root, 'apps')
+    .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !/\.test\.[^.]+$/u.test(path))
+    .flatMap((path) => {
+      const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
+      return lines.flatMap((line, index) =>
+        /fixture(?:handler|registry|port)/iu.test(line)
+          ? [`${relative(root, path)}:${index + 1}`]
+          : [],
+      );
+    });
+}
+
+function readBrowserJourneys(root: string): ReleaseGateInput['browserJourneys'] {
+  const path = join(root, 'test-output/browser/journeys.json');
+  if (!existsSync(path)) return [];
+  try {
+    return JSON.parse(readFileSync(path, 'utf8')) as ReleaseGateInput['browserJourneys'];
+  } catch {
+    return [];
+  }
+}
+
+function verifyArtifactHashes(
+  root: string,
+  hashes: Readonly<Record<string, string>>,
+  manifest: Readonly<Record<string, unknown>>,
+): void {
+  const manifestArtifacts = manifest.artifacts;
+  if (
+    typeof manifestArtifacts !== 'object' ||
+    manifestArtifacts === null ||
+    Array.isArray(manifestArtifacts)
+  ) {
+    throw new Error('release manifest must contain an artifact hash map');
+  }
+  const manifestHashMap = manifestArtifacts as Record<string, unknown>;
+  if (Object.keys(manifestHashMap).length !== Object.keys(hashes).length) {
+    throw new Error('release manifest artifact hashes do not match the evidence hash map');
+  }
+  for (const [relativePath, expected] of Object.entries(hashes)) {
+    if (manifestHashMap[relativePath] !== expected) {
+      throw new Error(`release manifest hash mismatch: ${relativePath}`);
+    }
+    const path = resolve(root, relativePath);
+    const repositoryRoot = resolve(root);
+    if (
+      path !== repositoryRoot &&
+      !path.startsWith(`${repositoryRoot}/`) &&
+      !path.startsWith(`${repositoryRoot}\\`)
+    )
+      throw new Error(`artifact path escapes repository: ${relativePath}`);
+    if (!existsSync(path)) throw new Error(`artifact is missing: ${relativePath}`);
+    const actual = sha256File(path);
+    if (actual !== expected) throw new Error(`artifact hash mismatch: ${relativePath}`);
+  }
+}
+
+function verifyReleaseDocuments(
+  manifest: Readonly<Record<string, unknown>>,
+  sbom: Readonly<Record<string, unknown>>,
+): void {
+  if (manifest.schemaVersion !== 1) throw new Error('release manifest schemaVersion must be 1');
+  if (sbom.bomFormat !== 'cyclonedx' || !Array.isArray(sbom.components)) {
+    throw new Error('release SBOM must be CycloneDX with components');
+  }
+}
+
 if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
-  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
+  const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
   const output = resolve(root, process.env.JOY_RELEASE_OUTPUT ?? 'test-output/release-gate');
-  const evidencePath = process.env.JOY_RELEASE_EVIDENCE;
+  const evidencePath = process.env.JOY_RELEASE_EVIDENCE?.trim();
   const evidence =
-    evidencePath !== undefined
+    evidencePath !== undefined && evidencePath.length > 0
       ? (JSON.parse(readFileSync(resolve(root, evidencePath), 'utf8')) as ReleaseEvidence)
       : buildEvidenceFromWorkspace(root);
   const result = writeReleaseEvidence(root, output, evidence);
   process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
   if (!result.passed) process.exitCode = 1;
 }
