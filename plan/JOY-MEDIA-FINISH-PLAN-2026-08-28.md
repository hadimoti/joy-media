# JOY Media convergence and finish plan — 2026-08-28

Status: execution-ready plan; current release verdict is **NO-GO**.

This is the delta plan for finishing the standalone `joy-media` repository and the public JOY
Studio application at `https://joyst.ir/` and `https://www.joyst.ir/`. It does not authorize or
modify `joy-vps`. The older `plan/P18-joy-media-finalization.md` remains the historical capability
roadmap; this document supersedes its integration, residual-gap, release, and deployment sequence.

## Objective and release definition

Finish the currently implemented product, close every confirmed production/UI/backend gap, make
all visible actions truthful and testable, converge the canonical branches, merge the verified
candidate to `main`, push the same commit to GitHub and the JOY Media VPS bare remote, deploy one
immutable release, verify it at the VPS origin and public domains, and retain a rehearsed rollback.

“Without bugs” has the following measurable release meaning:

- zero reproducible P0 or P1 defects;
- zero failed required tests, builds, migrations, browser journeys, inspections, or security gates;
- zero unexpected page errors, console errors/warnings, failed static requests, wrong MIME types,
  private-reference leaks, or dirty generated output;
- every visible production action works through its real backend or is removed/disabled with an
  honest reason;
- experimental/demo/hidden capabilities are not marketed or mounted as production;
- a verified render is produced by a real Worker, passes retained inspection, survives reload, and
  is recoverable after a controlled failure;
- the exact released SHA and artifacts are reproducible twice from clean clones.

Absolute absence of all future defects cannot be proven; no agent may weaken the measurable gates
above or translate “tests pass” into a stronger claim.

## Hard boundaries

- Canonical product source is this standalone repository. VPS checkout: `/opt/joy-media/repo`;
  bare remote: `/opt/joy-media.git`; runtime secrets: `/etc/joy-media/api.env`.
- Never copy credentials, OTPs, cookies, tokens, private object references, environment values,
  customer data, or secret-bearing traces into Git, CI artifacts, chat, screenshots, or Gbrain.
- Do not merge or cherry-pick the large checkpoint wholesale. Reconcile by domain and behavior.
- Run destructive/mutation browser journeys against disposable local/staging fixtures. Production
  receives read-only smoke plus one narrowly scoped canary only after the release candidate passes.
- Database changes must be additive/expand-contract until old-binary rollback is proven.
- Build once on a capable runner and promote the same verified archive. Do not reconstruct a
  different release manually on the memory-constrained VPS.
- If any release or post-deploy gate fails, stop and roll back; never “document around” a blocker.

## Agent execution policy

The execution round uses five independent roles and a consensus review after each milestone:

1. Backend/domain specialist: API, migrations, auth, privacy, control plane, Worker protocol.
2. Frontend/UX specialist: library/editor journeys, accessibility, errors, feature truth.
3. Release/QA/operations specialist: clean CI, provenance, security, deployment, rollback.
4. Kilo browser tester A: OpenCLI-only independent live/staging QA.
5. Hermes browser tester B: OpenCLI-only independent live/staging QA.

Required free-model routing:

- Kilo CLI uses the available Kilo free-pool id `kilo/kilo-auto/free` (the CLI displays
  `kilo-auto/free`; the shorter `kilo/free` is not a valid installed model id).
- Hermes CLI uses `openrouter/free` with provider `openrouter`.
- Do not silently fall back to paid models. Record the actual selected model in the run report.
- Kilo and Hermes use OpenCLI Browser Bridge profile `cefd9k77`, unique session names, and OpenCLI
  commands only. OpenCLI 1.8.6 accepted the profile through the `--profile cefd9k77` browser
  option for the local probes.
- Each specialist reads the other two reports, challenges unsupported findings, and records the
  accepted/rejected resolution before the lead integrator advances the milestone.

The 2026-08-28 OpenCLI runs verified that profile `cefd9k77` is connected, but the bound Chrome
surface showed the unauthenticated login gate. Those reports prove the public login shell only;
they do not count as authenticated editor evidence. Before the final OpenCLI gate, authenticate that
profile through the normal user-controlled flow without exposing credentials. The authenticated
Codex in-app-browser findings below remain valid independent evidence.

## Evidence baseline

### Repository and branch state

| Surface                     | Observed tip/state                                | Consequence                                                                       |
| --------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Local checkpoint branch     | `8d4b579` on `codex/joy-media-implement-20260828` | Clean tested candidate, published for review; not yet promoted to `main`.         |
| Deployed/VPS release branch | `b3c1866`                                         | Older certified release; candidate has additional hardening and is not deployed.  |
| GitHub `main`               | `2083ffc`                                         | 407 main-only commits versus 162 candidate-only commits.                          |
| VPS `main`                  | `1e4657f`                                         | 225 VPS-main-only commits versus 162 candidate-only commits.                      |
| Common merge base           | `73744bb`                                         | A blind merge is unsafe; simulated reconciliation has extensive overlap/conflict. |

`aec01ef` contains 324 changed files and a large quantity of transient evidence, debug files, and
generated JavaScript/declaration siblings that can shadow TypeScript source. It must remain an
immutable recovery reference until all unique behavior is classified, then the transient artifacts
must be removed on the reconciliation branch.

### Live and release evidence

- Public `/api/health` returns HTTP 200 with `controlPlane:true`, but the authenticated UI reports
  cloud sync unavailable and Verified delivery unavailable. Current health is therefore not a
  readiness signal.
- The currently deployed release references `/transitions/preview/transition1.png` and
  `transition2.png`, which return the SPA body instead of image bytes; the browser records a
  transition preview load error. The checkpoint now ships deterministic source-controlled SVG
  frames at `/assets/transition-preview-frame-a.svg` and
  `/assets/transition-preview-frame-b.svg` so clean builds do not depend on optional generated
  PNGs.
- The committed release report has `result.passed=false`. The critical journey records quick browser
  export, real-service execution unknown, and inspection not requested.
- The report/journey/build manifest predates `aec01ef`. It is not SHA-bound evidence for the
  checkpoint.
- The editor build-budget test reads ignored `dist/.vite/manifest.json`, while current CI/gate order
  can run tests before building. Passing locally with stale `dist` is not clean-clone proof.
- A production dependency audit reported two high-severity advisories among eight total; the locked
  Nodemailer release is one required upgrade target.

## Dependency graph

```text
canonical convergence
  -> clean/reproducible CI
     -> migrations + readiness + privacy
        -> Worker lease/render/delivery closure
           -> integrated UX and feature truth
              -> real-service E2E + security/performance gates
                 -> merge/push/tag
                    -> backup/migrate/immutable deploy
                       -> origin/public/canary verification or rollback
```

No downstream phase may start its release acceptance before all dependencies to its left are green.
Independent implementation slices inside a phase may run in parallel.

## Phase 0 — Canonical convergence and repository hygiene (P0)

### 0.1 Preserve evidence and create the integration line

1. Keep branch/commit `aec01ef` reachable as the checkpoint; do not push it to `main`.
2. Fetch/prune both remotes and record tips plus merge base in the reconciliation report.
3. Create `codex/joy-media-finish-20260828` from fresh `github/main`, not from the checkpoint.
4. Audit the newer VPS-main-only history separately. Do not assume VPS drift is canonical merely
   because it is deployed or present in the bare remote.

Suggested diagnostics:

```powershell
git fetch --prune github
git fetch --prune vps
git rev-list --left-right --count github/main...aec01ef
git rev-list --left-right --count vps/main...aec01ef
git merge-base github/main aec01ef
git range-diff 73744bb..github/main 73744bb..aec01ef
git switch -c codex/joy-media-finish-20260828 github/main
```

### 0.2 Reconcile by domain

Build a parity matrix for each unique checkpoint/main/VPS behavior. Assign exactly one resolution:
keep main, port checkpoint behavior, port VPS behavior, combine behind a shared contract, or remove
as obsolete. Reconcile in this order:

1. release/CI/tooling and dependency graph;
2. database schema and migration ownership;
3. auth/provider approval/rate limiting/private object boundaries;
4. project revisions/recovery/control-plane persistence;
5. Worker protocol/render-host/inspection/delivery;
6. asset import/resolution/backup/privacy;
7. editor workspace, Joy Code, panels, timeline, captions, Effects, Motion, Production Board;
8. static assets, E2E harness, docs, and feature-status matrix.

For every port, add/retain a contract test before moving code. Main already contains partial fixes
for Worker periodic hello/failure persistence and browser-safe asset DTOs; preserve and complete
them rather than reimplementing the checkpoint version.

### 0.3 Remove source shadows and transient evidence

- Delete the checkpoint-only `.tmp-p3-debug.mts`, tracked `.last-run.json`, Playwright/MCP outputs,
  checkpoint SQLite data, raw task-review dumps, and other transient test output from the candidate.
- Remove generated `.js`, `.js.map`, `.d.ts`, and `.d.ts.map` siblings from TypeScript source unless
  an explicit package contract proves they are hand-maintained source.
- Move intentionally retained release evidence to short-retention CI artifacts or one curated,
  redacted evidence bundle; do not commit per-run screenshots, traces, databases, or reports.
- Extend `.gitignore`, generated-output detection, privacy scanning, and TS/JS sibling-shadow tests.
- Make `git diff --check` pass on the complete candidate.

### Phase 0 exit gate

- The parity matrix accounts for all 127 checkpoint-only and relevant VPS-only commits by behavior.
- Candidate is based on current GitHub main and has focused, reviewable commits.
- No transient/source-shadow file is tracked; clean status and `git diff --check` pass.
- Backend, UX, and release specialists sign the same reconciliation report.

## Phase 1 — Reproducible clean-clone CI and release evidence (P0)

1. Change the budget test/gate ordering so editor build output is created in the same run before any
   test reads its manifest. Never consume an ignored pre-existing `dist`.
2. Split CI into visible jobs: format/lint/typecheck, unit, real-PostgreSQL integration, builds and
   budget, Playwright E2E, release gate, production dependency audit, provenance/SBOM.
3. Add PostgreSQL 17 and isolated object-store services. The Worker “integration” gate may not use
   only `LocalControlPlane`.
4. Bind every release report and browser journey to Git commit SHA, tree id, lockfile digest,
   Node/pnpm versions, build host/runner, artifact digests, and generation time.
5. Produce browser evidence in the same CI run. Reject stale, missing, cross-SHA, quick-export-only,
   mocked-service, or inspection-not-requested evidence.
6. Add explicit workflow permissions, concurrency/cancellation, timeouts, minimal artifact retention,
   failure-only sanitized traces, and immutable action SHAs where practical.
7. Require zero unwaived high/critical production advisories. Upgrade Nodemailer and verify OTP mail
   compatibility before closing the audit.
8. Run the complete pipeline twice in separate clean clones. The second run proves there is no hidden
   cache/artifact dependency or flake.

Core clean-clone sequence, adjusted to the reconciled package scripts:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @joy-media/editor-web build
pnpm --filter @joy-media/api build
pnpm --filter @joy-media/worker build
pnpm --filter @joy-media/render-host build
pnpm check
pnpm test:release
pnpm release:gate:test
pnpm audit --prod --audit-level=high
pnpm release:gate
git status --porcelain --untracked-files=all
```

Exit gate: two clean runs produce matching source-bound manifests and `result.passed=true`, with a
clean tree and no stale artifact input.

## Phase 2 — Backend, persistence, privacy, and readiness closure

### 2.1 Versioned migrations and blue/green compatibility (P0)

- Replace mutable startup DDL and ad-hoc primary-key changes with immutable ordered migrations,
  checksums, one advisory-locked migrator, and an expected-schema-version readiness check.
- Consolidate control-plane, provider-approval, and Mistral schema ownership.
- Test a sanitized prior-production restore, apply twice, concurrent migrators, interrupted migration,
  previous/candidate API coexistence, backup restore, and expand/contract rollback.
- Refuse release if an old binary cannot safely run against the expanded schema.

### 2.2 Real health and release identity (P0)

- `/live`: process/event-loop only.
- `/ready`: expected release SHA/schema version, PostgreSQL critical query, private object-store
  availability, required signing/provider configuration, and control-plane readiness.
- Keep optional providers explicitly degraded without marking core storage/delivery ready.
- Deployment and orchestration use `/ready`, not the current unconditional health response.

### 2.3 Browser-safe asset boundary (P1/security)

- Apply one `assetForBrowser`/schema projection to list, register, upload, metadata, retag, recovery,
  and every nested asset response.
- Recursively prove that `locations`, `cloudRef`, filesystem paths, object keys, and credentials never
  cross the browser boundary.
- Frontend parses/projects the DTO as defense-in-depth instead of casting/spreading raw API data.
- Add logged-out, wrong-owner, shared-curated, revoked, and signed-link-expiry tests.

### 2.4 Control-plane contract completion (P1)

- Make provider grant creation one awaited durable commit; no duplicate unawaited save.
- Run one shared Local/PostgreSQL adapter contract suite, including retry payload/requirements/
  idempotency/max-attempt preservation.
- Add paginated project-document revision metadata, clear retention/compaction, exact restore
  semantics, concurrent update/recovery, and storage-quota failure behavior.
- Fix the trusted-proxy boundary. Validate forwarded addresses only from configured proxies and use
  bounded actor/route-specific rate-limit buckets so users and Workers do not share localhost state.
- Test spoofed `X-Forwarded-For`, multiple clients, OTP abuse, Worker traffic, and bucket eviction.

Exit gate: real PostgreSQL/object-store integration passes, `/ready` reflects dependency failures,
browser DTOs leak no private references, and previous/candidate binaries pass compatibility tests.

## Phase 3 — Worker, render, inspection, and Verified delivery closure (P0)

1. Keep idle Workers connected with periodic capability hello independent of leased-job progress.
   Test presence across several 35-second editor windows and prompt disconnect after shutdown.
2. Replace event-loop-blocking `spawnSync` FFmpeg/FFprobe paths with supervised async child processes
   or move lease renewal to an independent watchdog that cannot be starved by rendering.
3. Renew leases throughout renders longer than multiple lease periods; support bounded cancellation,
   process cleanup, exactly-once completion, and duplicate-worker exclusion.
4. Persist caught runtime/upload/complete failures through the `/fail` contract. Enforce
   `attempt_count >= maxAttempts` in PostgreSQL and dead-letter/expose actionable retry.
5. Remove `fixture.thumbnail` from production protocol/API/lease surfaces or compile it exclusively
   into a test registry. Strengthen the release scan beyond its current narrow fixture regex.
6. Persist render receipts and retained inspection reports; reconcile the UI after reload/service
   restart. Never promote quick browser export to Verified delivery.
7. Add failure injection for Worker crash, lease expiry, upload failure, inspection failure, stale
   revision, retry, duplicate completion, and API restart.

Phase journey: authenticated disposable project -> real source media -> Worker idle longer than the
presence threshold -> render longer than one lease -> one artifact -> deep inspection pass ->
download/reopen -> Worker/API restart -> retained terminal delivery state.

Exit gate: the live-candidate UI no longer reports Verified delivery unavailable when a capable
Worker is healthy, and every failure reaches a durable, intelligible terminal/retry state.

## Phase 4 — Static packaging, complete UI journeys, and product truth

### 4.1 Static release correctness (P0)

- Guarantee that all Vite public assets, transitions, fonts, Workers, JS, CSS, and media are present
  in the immutable archive with correct permissions, MIME types, and hashes.
- Configure Nginx so unknown asset-like paths return 404 instead of SPA `index.html`; SPA fallback is
  allowed only for real application routes.
- Make `TransitionPreviewCard` catch load/decode rejection and render an accessible retry/failure
  fallback instead of a transparent canvas.
- Add build/archive/origin tests for PNG magic and a browser pixel assertion for each transition.

### 4.2 Auth, library, recovery, and import (P1)

- Give login contact/token inputs persistent labels, named OTP groups, selected-method semantics,
  correct combobox behavior, live errors, busy state, focus management, and keyboard coverage.
- Implement or remove the Project Library’s disabled Import Media/Start from Template promises.
- Handle storage/quota/corruption errors per action; test empty, 100-project, scroll, create/open,
  rename/duplicate/trash/restore, recovered-copy, offline, conflict, and cloud reconnect states.
- Make multi-file import atomic, or explicitly report per-file success/failure with cleanup and retry.
  Prove no orphaned catalog objects or cached bytes after failure.

### 4.3 Timeline, captions, preview, and Board (P1)

- Remove/implement the disabled Remove Track TODO and every other visible dead action.
- Prove split/trim/ripple/track/marker/DnD/keyboard commands through one transaction path, then
  save/reopen/undo/redo and preview/export parity.
- Apply authored caption `lang`/`dir` to editors; preserve the previous document after invalid SRT/
  VTT; cover transcription/import/edit/revert/delete/export and Persian/English direction.
- Turn “Reconnect media”/“Sign in again” recovery copy into keyboard-operable actions with live
  announcements. Handle fullscreen rejection and missing/revoked/cloud-only source states.
- Add busy/deduplication/error/confirmation states to Production Board approve/cancel/retry; expose
  lease-expired distinctly and never swallow reconciliation failures into indefinite pending.

### 4.4 Effects, Motion, Joy Code, workflows, and feature status (P1/P2)

- Run integrated real-document journeys for Effects, Motion publish/place/reopen, and Joy Code
  dry-run/reject/approve/apply/undo plus provider/attachment failures.
- Audit agent query tools that still return “not implemented” warnings. Implement production-visible
  queries or keep their invoking surfaces hidden; never fabricate results.
- Workflows, Jobs, Templates, Flow, plugins, PSD, 3D, and advanced Motion remain hidden/experimental
  unless their complete real-service journeys and persistence contracts pass. Hidden source is not a
  release defect; visible false affordances are.
- Regenerate `docs/product/FEATURE-STATUS.md` from the final manifest and verify every mounted panel,
  command, menu item, backend route, Worker capability, and flag agrees with it.

### 4.5 Accessibility, language, and supported viewport (P1/P2)

- Preserve the intentionally English shell (`lang=en`, LTR) unless product policy changes; tag/apply
  direction to Persian authored/explainer content locally. Do not force global RTL based on market.
- Add axe plus real Tab/Shift+Tab/arrow/Escape/Enter/Space/focus-return tests for dialogs, app menus,
  dock overflow, timeline, caption cells, approvals, and error recovery.
- Normalize desktop pointer targets/focus visibility where 24 px controls are not tightly scoped NLE
  precision controls.
- Product ADRs exclude mobile from 1.0. At unsupported small widths, show an accessible desktop/
  tablet requirement and safe project/download actions instead of a crushed 390 px editor. If mobile
  is promoted, fund a separate single-panel layout with 16 px inputs, 44 px actions, operable toolbar
  overflow, no clipped focusables, and the full mobile journey matrix.
- Align the document title/branding choice (`JOY Media` versus `JOY Studio`) deliberately.

Exit gate: every visible action has a real success, empty, pending, error, retry, and permission state;
integrated desktop journeys pass with no unexpected accessibility or console errors.

## Phase 5 — End-to-end, security, performance, and observability gates

### Required isolated E2E matrix

- Auth: request/verify for supported methods, invalid/expired/rate-limited cases, session reload,
  logout/back/reload, no credential logging.
- Projects: create/open/rename/duplicate/trash/restore/recovery/conflict/offline/quota.
- Assets: image/video/audio import, mixed invalid batch, private backup, catalog filtering, preview,
  revoked/missing source, no private refs.
- Editor: all production timeline commands, keyboard intake, preview, save/reopen, undo/redo.
- Captions: manual/import/transcribe, Persian/English direction, failure preservation, render burn-in.
- Effects/transitions/Motion: preview/render parity, static assets, publish/place/reopen.
- Joy Code: consent, bounded egress, dry-run, approval, compound apply, rejection, failure, undo.
- Production/delivery: Board states/actions, idle Worker, long render, crash/retry/cancel, inspection,
  artifact reopen/download and persisted terminal state.
- Global: title/lang/dir, supported viewport, axe, tab order, no page errors, no unexpected console
  messages, no failed static/font/Worker requests, loading/empty/error states.

Run at least desktop `1440x900`, compact desktop/tablet `1024x768`, and the unsupported-width guard
at `390x844`. Keep screenshots/traces only on failure, sanitized and short-retention.

### Security and supply chain

- `gitleaks` (redacted output), production advisory audit, lockfile integrity, license review, and a
  validated CycloneDX SBOM with component graph/hashes.
- Pin/supervise FFmpeg, browser, and native tool versions; record them in provenance.
- Verify auth/session/CSRF/origin policy, provider consent and egress redaction, object ownership,
  signed-link expiry, rate limiting, request-size limits, and log/trace redaction.
- Require zero high/critical unwaived production advisories and no committed/session artifact.

### Performance and reliability

- Enforce editor chunk/bundle budget from fresh build output, initial-load budget, panel lazy loading,
  100-project/large-asset virtualization, long-timeline interaction latency, and memory/URL cleanup.
- Soak API/Worker presence and delivery beyond lease/session thresholds; test reconnect and service
  restart without data loss.
- Add release-SHA/schema/dependency fields to safe health/metrics, plus alerts for sync failure,
  Worker loss, lease expiry, render/inspection failure, static MIME fallback, and error-rate change.

Exit gate: the entire matrix passes twice on one exact SHA; the second clean run is non-flaky and
produces a clean tree plus a signed/hash-verified release archive.

## Phase 6 — Commit to main, push, tag, deploy, verify, or roll back

### 6.1 Main integration

1. Keep implementation commits focused by domain; squash only review noise, never evidence-bearing
   behavioral boundaries.
2. Rebase/merge the verified candidate onto the then-current GitHub `main`; rerun the full gate if
   the tree id changes.
3. Merge to `main` only after all required checks and the three-specialist consensus are green.
4. Push the exact `main` SHA to GitHub and the JOY Media VPS bare remote. Verify both refs resolve to
   the same commit and the working trees are clean.
5. Create one annotated release tag referencing the source-bound manifest and rollback record; push
   the tag to both remotes.

No deployment may originate from `aec01ef`, the old release branch, a dirty checkout, or a SHA that
differs from the passed manifest.

### 6.2 Backup and migration rehearsal

- Record the current API/web symlink targets and service state.
- Back up PostgreSQL and object-store metadata/objects without printing credentials.
- Restore the database backup into a scratch database and verify object manifest/checksums.
- Apply migrations to the scratch restore, start previous and candidate APIs against the expanded
  schema, and pass the signed-in core journey.
- Keep prior immutable releases and the verified backup until the production acceptance window ends.

### 6.3 Immutable activation

1. Verify the promoted archive SHA, manifest, SBOM/provenance, file permissions, and static inventory
   on the VPS before activation.
2. Apply only the rehearsed additive migrations.
3. Create immutable API and web release directories from the verified archive.
4. Atomically switch `current-api` and `web` symlinks.
5. Restart only `joy-media@api` if API/runtime changed; reload Nginx only after `nginx -t` passes.
6. Keep `gbrain-http` and unrelated JOY/VPS services untouched.

### 6.4 Origin and public verification

Run direct-origin checks with `curl --noproxy '*' --resolve ...` for both hostnames before trusting
Cloudflare/public results:

- `/live`, dependency-aware `/ready`, release SHA, schema version;
- root application, session boundary, project/control-plane read paths;
- every emitted JS/CSS/font/Worker/image asset from the manifest;
- both transition PNGs: HTTP 2xx, `image/png`, non-HTML body, PNG magic
  `89504e470d0a1a0a`, and drawn browser pixels;
- unknown asset path returns 404, never SPA HTML.

Then repeat against `https://joyst.ir/` and `https://www.joyst.ir/` and compare release assets/SHA.

### 6.5 Browser and delivery canary

- Codex in-app browser: authenticated, read-only shell/console/network/static checks using the
  existing session.
- Kilo and Hermes: parallel OpenCLI-only audits on authenticated profile `cefd9k77`, with independent
  reports and a cross-review. They must not inspect or print session/credential storage.
- Run the full destructive journey against staging fixtures. Production receives one prefixed,
  isolated canary project only if its exact ownership and cleanup are safe: import known test media,
  edit, caption/effect/Motion, Joy Code approval, save/reopen, long Worker render, inspection, and
  artifact download. Remove only exact canary-owned data after verifying no shared references.
- Require zero unexpected console warnings/errors, failed requests, framework overlays, blank
  previews, sync warnings, or unavailable Verified delivery state.

### 6.6 Automatic rollback criteria

Immediately restore prior API/web symlinks if any of these occur:

- Nginx validation failure, service restart loop, `/live` or `/ready` failure, schema/release mismatch;
- static 4xx/5xx, wrong MIME, HTML asset fallback, console/page error, blank transition/preview;
- auth/session, project save/reload/revision, cloud sync, private object, Worker lease/completion,
  render, inspection, or Verified delivery failure;
- new database errors, cleanup inconsistency, elevated latency/error rate, or unredacted data in logs.

Binary rollback is allowed only after old-binary compatibility passes. If the schema is not backward
compatible, halt before activation; do not restore a database over new production writes without an
explicit data-loss decision. After rollback, repeat health, origin/public static checks, authenticated
smoke, and an observation window.

### 6.7 Completion record

After successful acceptance, update `STATE.md`, release docs, and the authoritative Gbrain JOY Media
ops page with confirmed non-secret facts only:

- final main SHA/tag and matching remote refs;
- migration versions, release directories, symlink targets, artifact/manifest hashes;
- clean-clone/CI/E2E/inspection/security results and OpenCLI/Codex browser outcomes;
- origin/public route and MIME matrix, Worker/delivery canary result;
- backup verification, rollback targets, observation result, and any accepted P2 item.

Do not record credentials, hashes of credentials, cookies, OTPs, private object refs, customer data,
or raw secret-bearing artifacts.

## Final acceptance checklist

## Execution checkpoint — 2026-08-28

- The local JOY Media hardening checkpoint is committed through `8d4b579` on
  `codex/joy-media-implement-20260828`; its pre-merge state is preserved at
  `backup/joy-media-before-main-merge-20260828`.
- The checkpoint passes `pnpm typecheck`, `pnpm format:check`, and the full `pnpm test`
  suite (311 files, 2,425 passed tests, 1 skipped). Focused API, asset-library, timeline,
  and Joy Code lifecycle tests pass (68 tests).
- `pnpm audit --prod --audit-level high` reports no known vulnerabilities.
- The candidate now includes `ef86e87`, which adds validated non-secret release identity and
  dependency probes to `/ready`, and `d8c0be6`/`8eeba0e`, which discard stale Joy Code
  reasoning responses after project/revision changes, prevent duplicate submits, and expose
  accessible failure alerts. Asset-library audio/video insertion is wired by `ecbdd56` and
  `e06c4cc` with routing/type-contract tests.
- Deployment documentation now requires the four generated `JOY_MEDIA_RELEASE_*` values in
  `/etc/joy-media/api.env`, sourced from the exact release manifest, so the new readiness gate
  cannot be bypassed by a stale or partial deployment.
- A GitHub branch has been published at
  `codex/joy-media-implement-20260828` for review.
- The release evaluator run at 2026-08-28T11:58:05Z passes command health, tests,
  generated-artifact hygiene, fixture registry, builds, manifest, SBOM, and feature-status
  checks. It still fails only source-bound authenticated browser provenance and the missing
  `authenticated-editor-1.0` journey.
- Reconciliation with GitHub `main` is currently a release blocker: the two lines
  diverge from a July common base and the remote line's creative-brief, Joy Code,
  and universal-timeline additions do not type-check against the deployed
  checkpoint when merged. The merge was aborted without changing either remote;
  no force-push, VPS mutation, or live deployment has been performed.
- Before promotion, an explicit reconciliation decision is required: port the
  remote `main` feature line onto the tested checkpoint (with a new full gate), or
  promote the tested checkpoint as the new `main` while preserving the remote
  feature line in a review branch. Until that decision and a clean merge are
  complete, the final acceptance checklist remains intentionally unchecked.
- Live Codex-browser inspection of the authenticated `https://www.joyst.ir/` tab
  still shows `Saved locally; cloud sync is unavailable`, `Verified delivery is
unavailable`, and a console error loading `/transitions/preview/transition2.png`.
  This is evidence of the currently deployed release, not evidence for the new
  checkpoint; no browser mutation was performed.
- The transition preview defect is fixed on the checkpoint in `e2e7838` (with the formatted
  release note in `63c6511`). OpenCLI profile `cefd9k77` verified both stable SVG endpoints from
  a local production build with HTTP 200 and `image/svg+xml`; transition preview tests, the full
  test suite (2,425 passed, 1 skipped), and editor build passed.
- Kilo was invoked with `kilo/kilo-auto/free` and OpenCLI profile `cefd9k77` for an independent
  review. Its run was stopped after it began reviewing a stale detached checkpoint, so its
  observations are advisory only. Hermes was invoked with `openrouter/free` for bounded review;
  its attempts did not return usable source-bound evidence. Neither agent was granted secret or
  VPS access, and neither supports a promotion claim.
- The legacy `fixture.thumbnail` production path was retired in `f485bbc`. The
  release evaluator now passes command health, tests, generated-artifact hygiene,
  fixture registry, builds, manifest, SBOM, and feature-status checks. It still
  fails only the required fresh source-bound authenticated browser evidence and
  browser-journey checks, which cannot be honestly synthesized from the current
  live tab.

- [ ] GitHub `main`, local `main`, VPS bare `main`, release tag, manifest, and deployed release all
      resolve to the same verified source SHA/tree.
- [ ] No checkpoint behavior is lost or duplicated; the reconciliation/parity matrix is complete.
- [ ] Clean-clone pipeline passes twice with no stale outputs or dirty tree.
- [ ] Real PostgreSQL migrations/readiness/rollback compatibility pass.
- [ ] Browser asset DTOs expose no private references; auth/rate limits use a trusted-proxy model.
- [ ] Idle Worker presence, long-render lease, failure/dead-letter, retry/cancel, and restart tests pass.
- [ ] Verified delivery produces one real artifact with a retained passed inspection.
- [ ] Every visible production action and full desktop journey succeeds or is honestly removed/gated.
- [ ] Auth, recovery, captions, preview, Production Board, accessibility, and supported-width behavior
      pass integrated browser tests.
- [ ] Transition/static assets return correct MIME/magic; unknown assets return 404; browser console
      and network gates are clean.
- [ ] Zero unwaived high/critical production advisories; secret/privacy/SBOM/provenance gates pass.
- [ ] Database/object backups are restored/verified; prior immutable releases remain available.
- [ ] Origin and public smoke plus the isolated production canary pass after activation.
- [ ] Gbrain and repository completion records contain only confirmed non-secret facts.

Only when every checked item is true is JOY Media finished for this release.
