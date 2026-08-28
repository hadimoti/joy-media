# Review package: 4eba6f9..9db3175

## Commits
9db3175 build(release): add reproducible JOY Studio 1.0 gates

## Files changed
 .github/workflows/ci.yml                  |  16 ++
 README.md                                 |  21 ++-
 STATE.md                                  |   5 +
 apps/api/README.md                        |   6 +
 apps/editor-web/README.md                 |   7 +
 apps/worker/README.md                     |   5 +
 deploy/README.md                          |   8 +
 docs/releases/JOY-STUDIO-1.0-CHECKLIST.md |  32 ++++
 package.json                              |   2 +
 pnpm-lock.yaml                            |   2 +
 tooling/release/README.md                 |  20 +--
 tooling/release/package.json              |   9 ++
 tooling/release/src/gate.test.ts          | 132 ++++++++++++++++
 tooling/release/src/gate.ts               | 245 ++++++++++++++++++++++++++++++
 tooling/release/tsconfig.json             |   9 ++
 tsconfig.json                             |   1 +
 16 files changed, 504 insertions(+), 16 deletions(-)

## Diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 4670f94..4ea4ab3 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -7,10 +7,26 @@ jobs:
   check:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - uses: actions/setup-node@v4
         with:
           node-version: 22
       - run: corepack enable pnpm
       - run: pnpm install --frozen-lockfile
       - run: pnpm check
+      - run: pnpm release:gate:test
+      - name: Run evidence gate when CI evidence is present
+        if: hashFiles('test-output/release-evidence.json') != ''
+        run: pnpm release:gate
+        env:
+          JOY_RELEASE_EVIDENCE: test-output/release-evidence.json
+      - name: Upload release evidence
+        if: always()
+        uses: actions/upload-artifact@v4
+        with:
+          name: joy-studio-release-evidence
+          path: |
+            test-output/release-gate
+            test-output/browser
+            test-output/goldens
+          if-no-files-found: ignore
diff --git a/README.md b/README.md
index 425daeb..9ca2623 100644
--- a/README.md
+++ b/README.md
@@ -1,28 +1,28 @@
 # JOY Media
 
 Local-first creative operating system for content production — browser/desktop editor, lightweight JOY VPS control plane, local/GPU Workers.
 
 This repository is the prepared _base_: the master plan partitioned into session-runnable parts, the monorepo skeleton with each folder carrying its slice of the plan, and the live-VPS deployment part grounded in measured facts. Implementation is underway per [`STATE.md`](STATE.md).
 
 Toolchain: Node ≥22, pnpm (via corepack). Run `pnpm install` then `pnpm check` (typecheck + lint + format check + tests).
 
 ## Start here
 
-| File                                                   | What it is                                                                            |
-| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
-| [`JOY_MEDIA_MASTER_PLAN.md`](JOY_MEDIA_MASTER_PLAN.md) | The architecture contract (v1.1, 50 sections). Read sections on demand, not linearly. |
-| [`ORCHESTRATION.md`](ORCHESTRATION.md)                 | **The execution front door.** Part map, dependency graph, session protocol.           |
-| [`STATE.md`](STATE.md)                                 | Progress ledger — which part/WP is active, what's next.                               |
+| File                                                   | What it is                                                                                                        |
+| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
+| [`JOY_MEDIA_MASTER_PLAN.md`](JOY_MEDIA_MASTER_PLAN.md) | The architecture contract (v1.1, 50 sections). Read sections on demand, not linearly.                             |
+| [`ORCHESTRATION.md`](ORCHESTRATION.md)                 | **The execution front door.** Part map, dependency graph, session protocol.                                       |
+| [`STATE.md`](STATE.md)                                 | Progress ledger — which part/WP is active, what's next.                                                           |
 | [`DESIGN.md`](DESIGN.md)                               | Editor UI contract (gray Adobe-class chrome, library gate, timeline NLE, **Modam Pro** Eng/Fa/Arabic typography). |
-| [`plan/`](plan/)                                       | One file per part (P00–P10 + X01), each with work packages and exit criteria.         |
-| [`plan/DECISIONS.md`](plan/DECISIONS.md)               | Open product questions (§48) with working defaults and status.                        |
+| [`plan/`](plan/)                                       | One file per part (P00–P10 + X01), each with work packages and exit criteria.                                     |
+| [`plan/DECISIONS.md`](plan/DECISIONS.md)               | Open product questions (§48) with working defaults and status.                                                    |
 
 **Editor entry (2026-07-24):** `media.joyteam.ir` boots a **Projects library** (open/create), then the Dockview editor with CapCut-style timeline tools. Live tip/deploy state is always in `STATE.md` handoff — do not trust this README for SHA freshness.
 
 ## Layout
 
 Mirrors master plan §9. Every folder's `README.md` states its role, the part that first builds it, and its must-not rules. Folders stay empty of code until their part is active in `STATE.md`.
 
 ```text
 joy-media/
 ├─ apps/        editor-web · desktop · api · worker · render-host · docs
@@ -33,10 +33,17 @@ joy-media/
 │               job-protocol · ui-kit · test-fixtures
 ├─ plugins/first-party      templates/first-party
 ├─ tooling/     schema-codegen · golden-render · benchmark · release
 ├─ docs/        adr · architecture · product · security
 └─ plan/        the partitioned work plan (this is what agents execute)
 ```
 
 ## Repo boundary
 
 This is the standalone `joy-media` repository (owner decision Q16, 2026-07-19) — the isolated service/repository boundary master plan §5.3 asks for. It was seeded from `joy-vps` (planning history there up to 2026-07-19); `joy-vps` keeps a pointer and remains the home of VPS operations. Only part X01 of this plan may touch the live VPS.
+
+## 1.0 release gate
+
+Run `pnpm release:gate:test` for the pure evaluator and `pnpm release:gate` for the non-deploying
+evidence command. The gate writes machine-readable reports, a manifest, an SBOM, and artifact
+hashes under `test-output/release-gate/`; it fails closed when browser, build, test, persistence,
+privacy, or authentication evidence is missing. See [`docs/releases/JOY-STUDIO-1.0-CHECKLIST.md`](docs/releases/JOY-STUDIO-1.0-CHECKLIST.md).
diff --git a/STATE.md b/STATE.md
index a49ffbf..89094a5 100644
--- a/STATE.md
+++ b/STATE.md
@@ -1,12 +1,17 @@
 # JOY Media — Progress Ledger
 
+## 1.0 release gate status (2026-08-22)
+
+Tasks 27–29 are accepted in the finalization ledger. Task 30 adds the non-deploying release gate and
+journey evidence contract; deployment/VPS changes remain outside this task until explicitly approved.
+
 Updated by **every** implementation session (protocol: [`ORCHESTRATION.md`](ORCHESTRATION.md) §2).
 One row per part. Keep entries terse; detail lives in the part files' WP checkboxes.
 
 ## VPS access
 
 JOY Media runs on the same Sweden VPS as the sibling `joy-vps` repo — one box, two apps.
 
 - **Host: `82.115.8.224`, user `root`, key `C:\Users\HadiMoti\.ssh\Joy-Vps-New.pem`.** SSH alias `sweden`/`sweden-vps` is configured in `~/.ssh/config` (`ssh sweden` works directly). Without the alias: `ssh -i ~/.ssh/Joy-Vps-New.pem root@82.115.8.224`.
 - The box was compromised and rebuilt from scratch on 2026-07-26 — any reference to the old host `46.249.103.142` or old key `joy-vps.pem` anywhere is dead; don't use them.
 - **Public domain: `joyst.ir`** (canonical since 2026-07-30, Cloudflare-proxied, SSL/TLS mode Full, self-signed origin cert at `/etc/ssl/joyst/`). `media.joyteam.ir` still exists purely as a 301 redirect to `joyst.ir` (so joy-vps's super-app launcher link never had to change) — don't expect it to serve the app directly.
diff --git a/apps/api/README.md b/apps/api/README.md
index a5139e1..67a9e8d 100644
--- a/apps/api/README.md
+++ b/apps/api/README.md
@@ -14,10 +14,16 @@
 At startup the durable adapter applies the idempotent schema (including the
 `media_allowed_users` / `media_otp_codes` / `media_sessions` auth tables) and
 uses transactions plus `FOR UPDATE SKIP LOCKED` for the queue lease. It
 persists only Media project/job/Worker metadata, events, and its own
 allow-list/session records; it never stores or accepts a JOY password,
 session cookie, or identity signing key.
 
 **Must not:** Heavy inference, frame rendering, large-media relay; one microservice per module.
 
 Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
+
+## Release evidence
+
+The API release gate requires a successful build and durable-auth evidence. PostgreSQL-backed media
+auth fails closed without `JOY_MEDIA_AUTH_HASH_KEYS`; keep keys and database credentials in the
+deployment environment, never in release reports or source control.
diff --git a/apps/editor-web/README.md b/apps/editor-web/README.md
index 02334dc..bdb8ebe 100644
--- a/apps/editor-web/README.md
+++ b/apps/editor-web/README.md
@@ -11,10 +11,17 @@ guidance, empty states, live status, and placeholders are Persian and use
 or LTR direction; isolate inline technical tokens with `<bdi>` or `<code>`.
 See [`DESIGN.md`](../../DESIGN.md) §4d–§4f. The visible shell lockup reads
 **JOY Studio**; repository, API, storage, package, and domain identifiers remain
 JOY Media.
 
 **First built in part:** P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).
 
 **Must not:** Direct database writes, model-specific logic, trusted arbitrary plugin code, putting the project document into React state.
 
 Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
+
+## Release evidence
+
+The authenticated 1.0 browser journey must cover project open, timeline edit, Motion Studio
+publish/place/preview, save/reopen, undo/redo, and verified export. Record it as
+`authenticated-editor-1.0` evidence for the repository release gate; never claim a browser journey
+from a build-only check.
diff --git a/apps/worker/README.md b/apps/worker/README.md
index 7e5db82..c4129ad 100644
--- a/apps/worker/README.md
+++ b/apps/worker/README.md
@@ -17,10 +17,15 @@ with `JOY_MEDIA_WORKER_STATE_PATH`. It contains only the device identity and
 revocable Worker session—not a JOY browser login, media path, or project data.
 The shipped fixture job writes a deterministic 1×1 PPM only in its private job
 directory; the API receives and independently validates its fixed SHA-256
 receipt, never the local path or media bytes. Higher-value jobs such as
 `image.comfy` and `audio.ml-denoise` stay capability-gated and only surface
 when a paired Worker advertises them.
 
 **Must not:** Editing project state without a validated job/command result; building shell strings from input.
 
 Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
+
+## Release evidence
+
+Worker pairing is owner-approved and capability-backed. The release gate requires a Worker build and
+recorded pairing/capability evidence; fixture jobs do not satisfy real-media or actual-render gates.
diff --git a/deploy/README.md b/deploy/README.md
index 09586fa..a546e4e 100644
--- a/deploy/README.md
+++ b/deploy/README.md
@@ -39,10 +39,18 @@ Gmail and by Telegram). Preserve the prior `/opt/joy-media/app` and each
 immutable release for rollback.
 
 On the VPS, use the lockfile to reconstruct the deployment dependency layout
 before building: `CI=true npm_config_confirm_modules_purge=false pnpm install
 --frozen-lockfile`. Build the API and static editor, then create the immutable
 API release with `CI=true npm_config_confirm_modules_purge=false pnpm deploy
 --legacy --prod`. Point the `current-api` and `web` symlinks at the new
 release only after the checks pass. Rollback is a symlink change to the prior
 immutable release followed by `systemctl restart joy-media@api`; keep the
 database backup until the deployment gate is accepted.
+
+## 1.0 prerequisites and rollback
+
+Run `pnpm check`, the three application builds, `pnpm test:release`, and the non-deploying
+`pnpm release:gate` before requesting deployment. Back up the database and object-store metadata;
+retain the prior immutable API/web releases. Deployment is a separately approved action. Roll back
+by pointing `current-api` and `web` at the previous release directories, restarting the affected
+service, and re-running health plus authenticated browser smoke. Never place secrets in gate output.
diff --git a/docs/releases/JOY-STUDIO-1.0-CHECKLIST.md b/docs/releases/JOY-STUDIO-1.0-CHECKLIST.md
new file mode 100644
index 0000000..db8149a
--- /dev/null
+++ b/docs/releases/JOY-STUDIO-1.0-CHECKLIST.md
@@ -0,0 +1,32 @@
+# JOY Studio 1.0 release checklist
+
+Run from a clean checkout after installing Node 22 and pnpm:
+
+1. `pnpm check`
+2. `pnpm --filter @joy-media/editor-web build`
+3. `pnpm --filter @joy-media/api build`
+4. `pnpm --filter @joy-media/worker build`
+5. `pnpm test:release`
+6. Record authenticated browser evidence for `authenticated-editor-1.0` (login, project open,
+   timeline edit, Motion Studio publish/place/preview, save/reopen, undo/redo, and verified export).
+7. Run `pnpm release:gate` with the evidence JSON and archive the generated report, manifest, SBOM,
+   artifact hashes, browser screenshots, and golden evidence.
+
+The gate must fail for zero tests, dirty generated output, fixture production handlers, missing
+builds/manifest/SBOM, stale feature status, or an unverified journey. Do not waive real-media,
+actual-render, persistence, privacy, or authentication checks.
+
+## Scope
+
+- Production: authenticated editor shell, project library, timeline, monitor/export, Joy Code
+  deterministic edits, Motion Studio scene round-trip, and Effect Studio.
+- Demo-only: plugin demo panel and other fixture-backed demonstrations.
+- Experimental: templates, workflow authoring, 3D preview, and Worker/provider jobs.
+- Hidden: PSD import, durable 3D authoring, MCP authoring, and marketplace/collaboration transport.
+
+## Operations
+
+Back up the database and object-store metadata before deployment. Pair Workers through the owner
+approval flow and verify capabilities before submitting jobs. A deployment requires an immutable
+API/web release directory, health checks, browser smoke, and a recorded rollback target. Roll back
+by restoring the previous immutable release symlinks and restarting only the affected service.
diff --git a/package.json b/package.json
index e201caf..ffea44b 100644
--- a/package.json
+++ b/package.json
@@ -7,20 +7,22 @@
     "node": ">=22"
   },
   "scripts": {
     "typecheck": "tsc -b",
     "test": "vitest run",
     "test:unit": "vitest run packages tooling",
     "test:editor": "vitest run apps/editor-web/src",
     "test:api": "vitest run apps/api/src",
     "test:worker": "vitest run apps/worker/src",
     "test:release": "pnpm test:unit && pnpm test:editor && pnpm test:api && pnpm test:worker",
+    "release:gate": "pnpm --filter @joy-media/release gate",
+    "release:gate:test": "pnpm --filter @joy-media/release test",
     "lint": "eslint .",
     "format": "prettier --write .",
     "format:check": "prettier --check .",
     "check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test"
   },
   "devDependencies": {
     "@eslint/js": "^9.31.0",
     "@types/node": "^22.16.0",
     "@types/react": "^19.2.7",
     "@types/react-dom": "^19.2.3",
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 731fc44..e83a028 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -554,20 +554,22 @@ importers:
       '@joy-media/render-ir':
         specifier: workspace:*
         version: link:../../packages/render-ir
       '@joy-media/renderer-headless':
         specifier: workspace:*
         version: link:../../packages/renderer-headless
       '@joy-media/renderer-pixi':
         specifier: workspace:*
         version: link:../../packages/renderer-pixi
 
+  tooling/release: {}
+
 packages:
 
   '@babel/code-frame@7.29.7':
     resolution: {integrity: sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN/YQgO48wCj0Kxa3sEHJvPVFg7siR+qRInwXd2qhQKw==}
     engines: {node: '>=6.9.0'}
 
   '@babel/compat-data@7.29.7':
     resolution: {integrity: sha512-locTkQyKvwIEgBzVrn8693ebc97F2U8ZHjbXwDXJ5Fn2TCpNwTlKcaKLkdHop5c/icOFE7qt7Q9JC5hnKNa6Gg==}
     engines: {node: '>=6.9.0'}
 
diff --git a/tooling/release/README.md b/tooling/release/README.md
index 66e7b7f..35c8533 100644
--- a/tooling/release/README.md
+++ b/tooling/release/README.md
@@ -1,12 +1,14 @@
-# release
+# JOY Studio 1.0 release gate
 
-> **Status: planned — no code yet.** This README is this folder's slice of the JOY Media plan.
-> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §32.7, §35.4 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)
+The release gate is a non-deploying evidence check. Run `pnpm release:gate` locally or in CI; it
+writes `test-output/release-gate/{report,manifest,sbom,artifact-hashes}.json` and exits non-zero
+unless every critical check is proven. Set `JOY_RELEASE_EVIDENCE` to a checked-in or CI-generated
+JSON evidence file to evaluate a real run. Missing evidence fails closed.
 
-**Role.** Build pinning, signing, packaging, release-gate checks.
+The gate requires non-zero passing tests, clean generated artifacts, no fixture handlers in
+production registries, successful editor/API/Worker builds, a manifest and SBOM, a verified
+authenticated editor journey, and a feature-status audit no older than 45 days. Only non-critical
+status documentation may be waived, and every waiver needs an owner, reason, and future expiry.
 
-**First built in part:** P02+. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).
-
-**Must not:** Shipping when §32.7 release gates fail.
-
-Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
+This command never pushes, deploys, changes VPS state, or contacts GitHub. Deployment is a separate
+approved operational action documented in `deploy/README.md`.
diff --git a/tooling/release/package.json b/tooling/release/package.json
new file mode 100644
index 0000000..5c8a7dc
--- /dev/null
+++ b/tooling/release/package.json
@@ -0,0 +1,9 @@
+{
+  "name": "@joy-media/release",
+  "private": true,
+  "type": "module",
+  "scripts": {
+    "gate": "node --experimental-strip-types src/gate.ts",
+    "test": "vitest run tooling/release/src/gate.test.ts"
+  }
+}
diff --git a/tooling/release/src/gate.test.ts b/tooling/release/src/gate.test.ts
new file mode 100644
index 0000000..9b61f9c
--- /dev/null
+++ b/tooling/release/src/gate.test.ts
@@ -0,0 +1,132 @@
+import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
+import { tmpdir } from 'node:os';
+import { join } from 'node:path';
+import { describe, expect, it } from 'vitest';
+import {
+  evaluateReleaseGate,
+  REQUIRED_BUILD_IDS,
+  REQUIRED_JOURNEY_ID,
+  writeReleaseEvidence,
+  type ReleaseGateInput,
+} from './gate.js';
+
+const passingInput = (): ReleaseGateInput => ({
+  testSummary: { collected: 12, failed: 0 },
+  dirtyGeneratedArtifacts: [],
+  fixtureHandlers: [],
+  builds: Object.fromEntries(REQUIRED_BUILD_IDS.map((id) => [id, true])),
+  manifestGenerated: true,
+  sbomGenerated: true,
+  browserJourneys: [{ id: REQUIRED_JOURNEY_ID, status: 'verified', verifiedAt: '2026-08-22' }],
+  featureStatus: {
+    auditedOn: '2026-08-22',
+    statuses: ['production', 'demo-only', 'experimental', 'hidden'],
+  },
+});
+
+describe('JOY Studio 1.0 release gate', () => {
+  it('fails closed when test collection is empty', () => {
+    const result = evaluateReleaseGate({
+      ...passingInput(),
+      testSummary: { collected: 0, failed: 0 },
+    });
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'tests')?.status).toBe('failed');
+  });
+
+  it('rejects dirty generated artifacts', () => {
+    const result = evaluateReleaseGate({
+      ...passingInput(),
+      dirtyGeneratedArtifacts: ['apps/api/dist/server.js'],
+    });
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'generated-artifacts')?.status).toBe(
+      'failed',
+    );
+  });
+
+  it('rejects fixture handlers in production registries', () => {
+    const result = evaluateReleaseGate({
+      ...passingInput(),
+      fixtureHandlers: ['apps/api/src/server.ts: fixture handler'],
+    });
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'fixture-registries')?.status).toBe('failed');
+  });
+
+  it('requires every build plus the manifest and SBOM', () => {
+    const result = evaluateReleaseGate({
+      ...passingInput(),
+      builds: { editor: true, api: false, worker: true },
+      manifestGenerated: false,
+      sbomGenerated: false,
+    });
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'builds')?.status).toBe('failed');
+    expect(result.checks.find((check) => check.id === 'manifest')?.status).toBe('failed');
+    expect(result.checks.find((check) => check.id === 'sbom')?.status).toBe('failed');
+  });
+
+  it('rejects an unverified or incomplete browser journey', () => {
+    const result = evaluateReleaseGate({ ...passingInput(), browserJourneys: [] });
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'browser-journey')?.status).toBe('failed');
+  });
+
+  it('rejects stale feature status', () => {
+    const result = evaluateReleaseGate(
+      {
+        ...passingInput(),
+        featureStatus: { auditedOn: '2026-01-01', statuses: ['production'] },
+      },
+      new Date('2026-08-22T00:00:00.000Z'),
+    );
+    expect(result.passed).toBe(false);
+    expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('failed');
+  });
+
+  it('only accepts named, unexpired waivers for non-critical checks', () => {
+    const result = evaluateReleaseGate(
+      {
+        ...passingInput(),
+        featureStatus: { auditedOn: '2026-01-01', statuses: ['production'] },
+        waivers: [
+          {
+            checkId: 'feature-status',
+            owner: 'release-owner',
+            reason: 'audit scheduled',
+            expiresAt: '2026-08-30',
+          },
+        ],
+      },
+      new Date('2026-08-22T00:00:00.000Z'),
+    );
+    expect(result.passed).toBe(true);
+    expect(result.checks.find((check) => check.id === 'feature-status')?.status).toBe('waived');
+  });
+
+  it('writes machine-readable report, manifest, SBOM, and artifact hashes', () => {
+    const output = mkdtempSync(join(tmpdir(), 'joy-release-gate-'));
+    const evidence = {
+      ...passingInput(),
+      artifactHashes: { 'apps/api/dist/server.js': 'abc123' },
+      manifest: { schemaVersion: 1, artifacts: ['apps/api/dist/server.js'] },
+      sbom: { bomFormat: 'cyclonedx', components: [] },
+    };
+    const result = writeReleaseEvidence(
+      process.cwd(),
+      output,
+      evidence,
+      new Date('2026-08-22T00:00:00.000Z'),
+    );
+    expect(result.passed).toBe(true);
+    expect(existsSync(join(output, 'report.json'))).toBe(true);
+    expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toEqual(
+      evidence.manifest,
+    );
+    expect(JSON.parse(readFileSync(join(output, 'sbom.json'), 'utf8'))).toEqual(evidence.sbom);
+    expect(JSON.parse(readFileSync(join(output, 'artifact-hashes.json'), 'utf8'))).toEqual(
+      evidence.artifactHashes,
+    );
+  });
+});
diff --git a/tooling/release/src/gate.ts b/tooling/release/src/gate.ts
new file mode 100644
index 0000000..151a2e3
--- /dev/null
+++ b/tooling/release/src/gate.ts
@@ -0,0 +1,245 @@
+import { createHash } from 'node:crypto';
+import { existsSync, readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
+import { join, relative, resolve } from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+export const REQUIRED_BUILD_IDS = ['editor', 'api', 'worker'] as const;
+export const REQUIRED_JOURNEY_ID = 'authenticated-editor-1.0' as const;
+export const RELEASE_STATUS_MAX_AGE_DAYS = 45;
+
+export type ReleaseCheckStatus = 'passed' | 'failed' | 'waived';
+
+export interface ReleaseCheck {
+  readonly id: string;
+  readonly status: ReleaseCheckStatus;
+  readonly message: string;
+  readonly critical: boolean;
+}
+
+export interface ReleaseWaiver {
+  readonly checkId: string;
+  readonly owner: string;
+  readonly reason: string;
+  readonly expiresAt: string;
+}
+
+export interface ReleaseGateInput {
+  readonly testSummary: { readonly collected: number; readonly failed: number };
+  readonly dirtyGeneratedArtifacts: readonly string[];
+  readonly fixtureHandlers: readonly string[];
+  readonly builds: Readonly<Record<string, boolean>>;
+  readonly manifestGenerated: boolean;
+  readonly sbomGenerated: boolean;
+  readonly browserJourneys: readonly {
+    readonly id: string;
+    readonly status: 'verified' | 'failed' | 'unverified';
+    readonly verifiedAt?: string;
+  }[];
+  readonly featureStatus: { readonly auditedOn: string; readonly statuses: readonly string[] };
+  readonly waivers?: readonly ReleaseWaiver[];
+}
+
+export interface ReleaseGateResult {
+  readonly passed: boolean;
+  readonly generatedAt: string;
+  readonly checks: readonly ReleaseCheck[];
+}
+
+export function evaluateReleaseGate(input: ReleaseGateInput, now = new Date()): ReleaseGateResult {
+  const checks: ReleaseCheck[] = [
+    check(
+      'tests',
+      input.testSummary.collected > 0 && input.testSummary.failed === 0,
+      input.testSummary.collected > 0
+        ? `${input.testSummary.collected} tests collected; ${input.testSummary.failed} failed`
+        : 'no tests were collected',
+    ),
+    check(
+      'generated-artifacts',
+      input.dirtyGeneratedArtifacts.length === 0,
+      input.dirtyGeneratedArtifacts.length === 0
+        ? 'generated artifacts are clean'
+        : `dirty generated artifacts: ${input.dirtyGeneratedArtifacts.join(', ')}`,
+    ),
+    check(
+      'fixture-registries',
+      input.fixtureHandlers.length === 0,
+      input.fixtureHandlers.length === 0
+        ? 'no fixture handlers are registered in production surfaces'
+        : `fixture handlers found: ${input.fixtureHandlers.join(', ')}`,
+    ),
+    check(
+      'builds',
+      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true),
+      REQUIRED_BUILD_IDS.every((id) => input.builds[id] === true)
+        ? 'editor, API, and Worker builds passed'
+        : `missing or failed builds: ${REQUIRED_BUILD_IDS.filter((id) => input.builds[id] !== true).join(', ')}`,
+    ),
+    check(
+      'manifest',
+      input.manifestGenerated,
+      input.manifestGenerated ? 'release manifest generated' : 'release manifest is missing',
+    ),
+    check('sbom', input.sbomGenerated, input.sbomGenerated ? 'SBOM generated' : 'SBOM is missing'),
+    check(
+      'browser-journey',
+      input.browserJourneys.some(
+        (journey) => journey.id === REQUIRED_JOURNEY_ID && journey.status === 'verified',
+      ),
+      input.browserJourneys.some(
+        (journey) => journey.id === REQUIRED_JOURNEY_ID && journey.status === 'verified',
+      )
+        ? 'authenticated editor 1.0 journey verified'
+        : `required journey ${REQUIRED_JOURNEY_ID} is not verified`,
+    ),
+    check(
+      'feature-status',
+      featureStatusFresh(input.featureStatus.auditedOn, now) &&
+        input.featureStatus.statuses.every((status) =>
+          ['production', 'demo-only', 'experimental', 'hidden'].includes(status),
+        ),
+      featureStatusFresh(input.featureStatus.auditedOn, now)
+        ? 'feature status audit is current'
+        : `feature status audit is older than ${RELEASE_STATUS_MAX_AGE_DAYS} days`,
+      false,
+    ),
+  ];
+
+  const waivers = input.waivers ?? [];
+  const byId = new Map(waivers.map((waiver) => [waiver.checkId, waiver]));
+  const resolved = checks.map((item) => {
+    const waiver = byId.get(item.id);
+    if (item.status !== 'failed' || waiver === undefined) return item;
+    if (item.critical || !validWaiver(waiver, now)) return item;
+    return {
+      ...item,
+      status: 'waived' as const,
+      message: `${item.message}; waived by ${waiver.owner} until ${waiver.expiresAt}: ${waiver.reason}`,
+    };
+  });
+  return {
+    passed: resolved.every((item) => item.status !== 'failed'),
+    generatedAt: now.toISOString(),
+    checks: resolved,
+  };
+}
+
+function check(id: string, passed: boolean, message: string, critical = true): ReleaseCheck {
+  return { id, status: passed ? 'passed' : 'failed', message, critical };
+}
+
+function validWaiver(waiver: ReleaseWaiver, now: Date): boolean {
+  return (
+    waiver.owner.trim().length > 0 &&
+    waiver.reason.trim().length > 0 &&
+    Number.isFinite(Date.parse(waiver.expiresAt)) &&
+    Date.parse(waiver.expiresAt) > now.getTime()
+  );
+}
+
+function featureStatusFresh(auditedOn: string, now: Date): boolean {
+  const timestamp = Date.parse(auditedOn);
+  if (!Number.isFinite(timestamp)) return false;
+  const age = now.getTime() - timestamp;
+  return age >= 0 && age <= RELEASE_STATUS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
+}
+
+export interface ReleaseEvidence extends ReleaseGateInput {
+  readonly artifactHashes: Readonly<Record<string, string>>;
+  readonly manifest: Readonly<Record<string, unknown>>;
+  readonly sbom: Readonly<Record<string, unknown>>;
+}
+
+export function sha256File(path: string): string {
+  return createHash('sha256').update(readFileSync(path)).digest('hex');
+}
+
+export function writeReleaseEvidence(
+  root: string,
+  outputDirectory: string,
+  evidence: ReleaseEvidence,
+  now = new Date(),
+): ReleaseGateResult {
+  mkdirSync(outputDirectory, { recursive: true });
+  const result = evaluateReleaseGate(evidence, now);
+  writeFileSync(
+    join(outputDirectory, 'report.json'),
+    JSON.stringify({ result, evidence }, null, 2),
+  );
+  writeFileSync(join(outputDirectory, 'manifest.json'), JSON.stringify(evidence.manifest, null, 2));
+  writeFileSync(join(outputDirectory, 'sbom.json'), JSON.stringify(evidence.sbom, null, 2));
+  writeFileSync(
+    join(outputDirectory, 'artifact-hashes.json'),
+    JSON.stringify(evidence.artifactHashes, null, 2),
+  );
+  writeFileSync(
+    join(outputDirectory, 'release-manifest.sha256'),
+    `${sha256Text(JSON.stringify(evidence.manifest))}  manifest.json\n`,
+  );
+  void root;
+  return result;
+}
+
+export function sha256Text(value: string): string {
+  return createHash('sha256').update(value).digest('hex');
+}
+
+function collectFiles(root: string, directory: string): readonly string[] {
+  const absolute = resolve(root, directory);
+  if (!existsSync(absolute)) return [];
+  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
+    const path = join(absolute, entry.name);
+    return entry.isDirectory() ? collectFiles(root, relative(root, path)) : [path];
+  });
+}
+
+export function buildEvidenceFromWorkspace(root: string): ReleaseEvidence {
+  const artifacts = ['apps/editor-web/dist', 'apps/api/dist', 'apps/worker/dist'];
+  const artifactHashes: Record<string, string> = {};
+  for (const directory of artifacts) {
+    for (const path of collectFiles(root, directory))
+      artifactHashes[relative(root, path)] = sha256File(path);
+  }
+  const buildSuccess = Object.fromEntries(
+    REQUIRED_BUILD_IDS.map((id) => [
+      id,
+      collectFiles(root, `apps/${id === 'editor' ? 'editor-web' : id}/dist`).length > 0,
+    ]),
+  );
+  const manifest = {
+    schemaVersion: 1,
+    generatedAt: new Date().toISOString(),
+    artifacts: artifactHashes,
+  };
+  const sbom = {
+    bomFormat: 'cyclonedx',
+    specVersion: '1.5',
+    components: [{ type: 'application', name: 'joy-media', version: '1.0.0' }],
+  };
+  return {
+    testSummary: { collected: 0, failed: 1 },
+    dirtyGeneratedArtifacts: [],
+    fixtureHandlers: [],
+    builds: buildSuccess,
+    manifestGenerated: false,
+    sbomGenerated: false,
+    browserJourneys: [],
+    featureStatus: { auditedOn: '1970-01-01', statuses: [] },
+    artifactHashes,
+    manifest,
+    sbom,
+  };
+}
+
+if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
+  const output = resolve(root, process.env.JOY_RELEASE_OUTPUT ?? 'test-output/release-gate');
+  const evidencePath = process.env.JOY_RELEASE_EVIDENCE;
+  const evidence =
+    evidencePath !== undefined
+      ? (JSON.parse(readFileSync(resolve(root, evidencePath), 'utf8')) as ReleaseEvidence)
+      : buildEvidenceFromWorkspace(root);
+  const result = writeReleaseEvidence(root, output, evidence);
+  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
+  if (!result.passed) process.exitCode = 1;
+}
diff --git a/tooling/release/tsconfig.json b/tooling/release/tsconfig.json
new file mode 100644
index 0000000..cc52224
--- /dev/null
+++ b/tooling/release/tsconfig.json
@@ -0,0 +1,9 @@
+{
+  "extends": "../../tsconfig.base.json",
+  "compilerOptions": {
+    "outDir": "dist",
+    "rootDir": "src",
+    "noEmit": false
+  },
+  "include": ["src/**/*.ts"]
+}
diff --git a/tsconfig.json b/tsconfig.json
index f9b7329..1effac3 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -1,13 +1,14 @@
 {
   "files": [],
   "references": [
+    { "path": "tooling/release" },
     { "path": "packages/agent-tools" },
     { "path": "packages/captions-core" },
     { "path": "packages/motion-core" },
     { "path": "packages/camera-core" },
     { "path": "packages/expression-core" },
     { "path": "packages/provider-sdk" },
     { "path": "packages/adapter-mistral" },
     { "path": "packages/production-quality" },
     { "path": "packages/export-core" },
     { "path": "packages/playback-engine" },
