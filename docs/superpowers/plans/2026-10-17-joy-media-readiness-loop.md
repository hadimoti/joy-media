# JOY Media readiness test and fixture loop implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` for orchestration,
> with bounded implementation delegated through the owner-approved local Kilo
> CLI. Track the checkboxes below. The orchestrator verifies actual diffs and
> results independently before accepting each work package.

**Goal:** Close the evidence and behavior gaps that prevent the Windows app and
agent-facing CLI from being dependable for their documented supported workflows.

**Architecture:** Keep the existing Vitest, CLI subprocess harness, generated
media fixtures, Playwright journeys, desktop package scripts, and two-pass release
gate. Connect them with one scenario inventory and evidence contract; add failing
scenarios at real process, storage, media, and installed-application boundaries.

**Tech stack:** TypeScript, Node >=22, pnpm 11.15.0, Vitest 3, Playwright,
Electron, SQLite, FFmpeg/FFprobe, existing self-hosted Windows/Linux runners.

**Spec:** [Repository audit and readiness definition](../../qa/evidence/2026-10-17-readiness-audit.md).

**Status (2026-10-17):** Tasks 1 and 2 are complete and committed as `930d73cb`
and `6eacd9b5`. Tasks 3–7 now have extensive local Windows evidence for playable CLI
output, recovery, fresh-profile project operations, packaged editor workflow, and
staging package/launcher checks, but remain open where their full scope is not yet
accepted. Task 8 has not started. Task 9 remains open for a frozen-candidate two-pass
run, independent reviews, owner release decision, and required closeout receipt. This
plan is not an app-ready or release certificate.
The implementation began from remote baseline SHA
`c1fffd59d5078902e031e7684e69c27df40ce607`. The earlier October 14 plan was removed
upstream and its statement that CLI rendering produces no media is superseded.

**Owner-confirmed requirement (2026-10-17):** `joy-media render` must produce
playable video for the CLI to count as ready. A render-plan manifest alone does
not satisfy closeout. Required acceptance checks the actual output file through
FFprobe and decoding, including picture, audio where expected, and timing.

**Owner model instruction (2026-10-17):** Never use GPT-6 Astra. The
candidate-specific model review gate, if required for release, must use
GPT-6.1-sol. This supersedes the Astra references in the originating audit and
does not waive the independent Claude Code review or the owner's release decision.

## Global constraints

- Preserve the current branch, existing untracked `nul`, other worktrees, and user profiles.
- Use isolated work based on the fetched candidate; do not reset this checkout.
- Follow the existing PR #7 handoff: branch integration remains on
  `hadimoti/wonderful-ritchie-vfpgv7`; workers return patches, never push or merge.
- Before any worker, read `C:\Users\HadiMoti\Desktop\agents-handoff.md` and
  verify billing, effective isolation, and sanitized configuration. For this task,
  the owner approved `C:\Users\HadiMoti\Desktop\KILO-BYTEPLUS-RUNBOOK.md` as its
  replacement because the handoff file is absent. Implementation route:
  `kilo/byteplus-coding/deepseek-v4-flash`; existing quota only. No retired
  routes, new purchases, paid fallback, production credentials, or Gbrain writes.
- Preserve external Claude Code independent review; if unavailable, record that
  gate as pending. Do not silently replace it or launch Claude-model workers.
- Only existing permitted self-hosted runner labels; no GitHub-hosted billing.
- No real provider calls in deterministic tests. Separate fake-provider contract
  tests from explicitly scoped real-provider or real-GPU acceptance.
- A plan, mock response, worker self-test, or successful CI summary cannot stand
  in for decoded media or installed-app acceptance.
- Reuse `release-candidate-v2.yml` and its exact-candidate two-pass gate. Recheck
  its contract before dispatch; do not relax missing-evidence/freshness checks.
- GPT-6.1-sol's candidate-specific `APPROVE_FOR_DEPLOY` and the owner's
  release authorization remain required. This plan authorizes no publication.

## Review focus

1. CLI renders unsupported editor features without matching their meaning:
   Task 3 must either prove the result or reject it explicitly.
2. Audio is present as a stream but muted, wrong, clipped, or shifted:
   Tasks 2–4 must inspect decoded samples and timing.
3. An interrupted or concurrent operation loses projects, media references, or
   the last successful output: Tasks 3 and 5 must inject these failures.
4. Linux passes while the Windows shipped entry, DPAPI, paths, or cleanup fail:
   Tasks 6–7 must run on Windows and the final artifact.
5. A skipped/retried test, stale receipt, or source build is reported as proof of
   the installer: Tasks 1 and 9 must reject incomplete/mismatched evidence.

## The loop used for every work package

1. **Choose one scenario:** record risk ID, fixture IDs, expected state/media,
   entry/platform, and current candidate SHA in the ledger.
2. **Reproduce:** run against that candidate in a disposable profile. A failure
   must be an observable assertion, not a missing dependency or broken harness.
3. **Fix in bounded work:** give Kilo exact allowed files, one behavior, test
   commands, and output restrictions. Require a real session ID and actual diff.
4. **Prove the regression:** retain test-red-on-parent, fix-green evidence.
   New scenarios that already pass expand coverage without a gratuitous fix.
   Negative controls run only in disposable work; never revert shared changes.
5. **Review and verify:** external independent review, then Codex runs the
   targeted suite plus relevant neighboring boundary tests independently.
6. **Integrate:** stage only the accepted scope, commit test and fix together,
   and update the ledger. A changed candidate invalidates affected prior evidence.
7. **Close or repeat:** close only with artifacts and reviewer receipt. A repeated
   flake gets an owner, reproduction, and fix; required P0/P1 cases cannot be
   waived by quarantine, retries, or a review-round limit.

Do not run the entire monorepo after every small patch. Run it at integration
milestones; run the existing full exact-candidate gate for release acceptance.

## Task 1: Freeze the baseline and make readiness measurable

**Files:** Create `docs/qa/READINESS-MATRIX.md`,
`tooling/release/src/readiness-evidence.ts`, and its `.test.ts` sibling.
Modify `docs/product/FEATURE-STATUS.md`, `STATE.md`, and
`tooling/release/src/gate.ts` with its existing tests.

**Interfaces:** A scenario record has `id`, `surface`, `priority`, `supported`,
`fixtureIds`, `platform`, `entry`, `testCommand`, `status`, and `evidencePath`.
A `ReadinessEvidence` record has `schemaVersion: 1`, `candidateSha`,
`lockfileSha256`, artifact SHA-256 where applicable, toolchain versions,
fixture-manifest hash, start/end UTC, commands/exit codes, pass/fail/skip/retry
counts, scenario results, and redacted artifact paths/hashes.
`validateReadinessEvidence(evidence, expectedCandidateSha): string[]` returns
blocking reasons; it supplements existing gate validation rather than replacing it.

- [x] Inventory CLI help/commands, app menus/panels, worker operations, account
      flows, persistence and installer surfaces. Map every documented supported
      operation to a scenario or explicit open gap; mark unavailable features honestly.
- [x] Add `rejectsDifferentCandidate`, `rejectsMissingRequiredScenario`,
      `rejectsRequiredSkip`, `rejectsRetryOnlySuccess`, and
      `rejectsInstallerHashMismatch` tests. Each must return a nonempty blocker list
      for its named invalid evidence; a complete matching record returns `[]`.
- [x] Run the new tests red, implement validation and gate wiring, then run:
      `pnpm exec vitest run tooling/release/src` and `pnpm test:harness`.
- [x] In the isolated candidate checkout, record fresh `pnpm verify:ci`,
      `pnpm test:harness`, tool versions, and `pnpm exec playwright test --list`.
      Classify every skip by requirement; fail setup when required tools are absent.
- [x] Refresh stale status documents using linked evidence; do not change audit
      dates merely to make a gate pass.
- [x] Commit baseline/ledger/gate changes together after final review.

**Exit:** One candidate identity, an exhaustive supported-surface ledger, and a
validator that cannot call skipped or mismatched evidence ready.

## Task 2: Establish reusable fixtures with independent expected results

**Files:** Extend `tooling/generate-media-fixtures.mjs`,
`packages/test-fixtures/media/manifest.json`, and
`packages/test-fixtures/src/media-manifest.test.ts`.
Create `packages/test-fixtures/src/readiness/{projects,tolerances}.ts` and tests.
Reuse existing `reference-project.ts` and animation builders after locating them
in the fixture package; preserve the existing 16-input manifest contract.

**Interfaces:** Export named project builders from `projects.ts` and
`READINESS_TOLERANCES` from `tolerances.ts`. Manifest additions identify purpose,
generator/tool version, byte hash/size, provenance/license, expected decoded
duration/frame/stream/sample properties, and consumers. Keep existing fields and
update its explicit file-list test intentionally.

- [x] Add fixtures: red/blue hard-cut plus known tones; flash/click sync marker;
      silent and audio-only sources; stereo channels with distinct frequencies;
      44.1/48 kHz audio; VFR and 30000/1001 video; rotation metadata; alpha image;
      odd dimensions encoded losslessly with a format that supports them; truncated,
      empty, and mislabeled files; Persian/emoji/path-with-spaces variants.
- [x] Add project builders: basic A/V delivery, gaps/parallel tracks,
      kitchen-sink of supported editor domains, Persian/RTL, each supported historical
      schema, missing/relinked assets, and generated 10,000-clip scale case.
- [x] Test the generator output with independent FFprobe/decode expectations.
      A hash-only test against a manifest rewritten by the same generator is
      insufficient. Force an incorrect duration/tone in disposable test output and
      demonstrate failure of the semantic check.
- [x] Initial proposed bounds: duration within one output frame; flash/click
      onset within one output frame after decoder timestamp/encoder-delay handling;
      normalized PCM RMS absolute error <=0.02; no NaN/Inf; solid-color center samples
      use the existing red/blue/green predicates. Keep existing visual goldens'
      tolerances; calibrate new complex-scene comparisons before accepting them.
- [x] Pin/record FFmpeg builds for strict byte goldens. Across platforms compare
      decoded semantics using declared tolerances; do not claim byte identity across
      encoders. Never auto-bless changed expected output.
- [x] Generate in disposable storage first; after review update intended fixture
      files. Run `pnpm exec vitest run packages/test-fixtures/src`, review provenance
      and exact diff, then commit. No copyrighted/customer source media.

**Exit:** Reproducible inputs with independently checked expected outputs shared
by CLI, browser, desktop, and release tests.

## Task 3: Close CLI media delivery and parity risks first

**Files:** Extend `apps/cli/src/humanized/render-real.e2e.test.ts` and
`render-benchmark.e2e.test.ts`; create `render-parity.e2e.test.ts` and
`render-recovery.e2e.test.ts` beside them. Modify
`apps/cli/src/commands/{render-cmd,render-media}.ts` only where tests demonstrate
gaps. Reuse the current subprocess harness and real FFmpeg.

**Interfaces:** Retain the current NDJSON contract: real delivery has
`mediaProduced: true` and a playable `mediaPath`; explicit plan output has
`mediaProduced: false`. Evolve any error/event schema deliberately in Task 7.
Recommended behavior decision: default real-render requests reject unsupported
features with a machine-readable `unsupported-feature` error and no replacement
output. Keep explicit `--manifest-only` for planning. If partial export is wanted,
it needs an explicit opt-in, enumerated omissions, and a visibly partial outcome.

- [ ] Add `metadataMatchesDecodedTimeline`: gap/overlap/parallel-track projects
      assert duration equals timeline end, fps and frame count agree with decoded
      media, and completion/manifest totals describe the actual result.
- [ ] Add `mixRespectsMuteGainPanAndPlacement`: distinct channel tones expose
      wrong gains/mute/pan, audio source offsets, and timing. Check samples, not only
      codec presence. Test no-audio and audio-only timelines explicitly.
- [ ] Add feature cases for transforms/crop/alpha, captions/Persian text, effects,
      transitions, speed/reverse, and nested scenes. For every supported operation,
      compare CLI output with the desktop reference. Otherwise assert explicit
      unsupported behavior and document the limitation; no silent success/omission.
- [ ] Add `failedRenderPreservesLastGoodOutput` and
      `manifestFailureCannotReportComplete`: missing input, permission/disk-full
      injection, FFmpeg failure, cancellation, and failure between media promotion
      and sidecar write. Verify previous deliverable hashes, cleanup, error outcome,
      and no false success event; define recovery for any published partial pair.
- [ ] Add `concurrentSameOutputDoesNotCrossPublish`: two renders either serialize,
      reject contention, or publish separate outputs with matching metadata; they
      must never pair one render's media with another's manifest.
- [ ] Run each regression red, fix minimally, and prove red/green. Verify using
      `pnpm exec vitest run apps/cli/src/humanized/render-real.e2e.test.ts apps/cli/src/humanized/render-parity.e2e.test.ts apps/cli/src/humanized/render-recovery.e2e.test.ts --no-file-parallelism`.
      Repeat representative real rendering through `bin`, `bundle`, and Task 6's
      installed `joy.cmd`; missing FFmpeg in the required lane fails setup.
- [ ] Review independently, update ledger, and commit accepted fixes with tests.

**Exit:** The CLI delivers correct media for its declared supported scope and
cannot misreport unsupported, failed, interrupted, or partial delivery as complete.

## Task 4: Prove desktop editing, preview, save/reopen, and export together

**Files:** Extend `tests/e2e/{final-encoded-export-decoder,timeline-editing-features,wp29-export-recovery,wp32-real-project-journey}.spec.ts`;
create `tests/desktop/editor-acceptance.spec.ts` and a separate
`playwright.desktop.config.ts`. Modify the affected editor/export source only
after a failing real workflow identifies a defect.

**Interfaces:** Desktop config launches the packaged application with a disposable
profile and fixture media. It must not reuse a browser-only editor server as
proof of Electron acceptance. Browser helpers remain reusable where applicable.

- [ ] Drive: create project -> import A/V -> split/trim/move -> title/caption ->
      effect/keyframe/transition -> undo/redo -> save -> restart -> read back -> export
      -> decode final media. Map every supported operation from Task 1 to a case.
- [ ] Assert Local badge and changing Monitor frames at three scrub positions,
      playback progression, audio onset, and actual saved values after restart.
      Include a keyboard-only route, Persian/mixed-bidi title and caption, and
      screenshot evidence at 1024x768, 1366x768, and 1920x1080 plus DPI scaling.
- [ ] Compare decoded desktop export against fixture expectations and sampled
      preview frames. Cover all supported presets, audio mixing, scenes and overlays.
      Crash or cancel during export must leave project data intact and allow retry.
- [ ] Run focused browser specs first, then `pnpm run test:e2e:audit --retries=0`.
      Run packaged scenarios via
      `pnpm exec playwright test --config playwright.desktop.config.ts --retries=0`.
      Exercise axe scans and keyboard reachability on supported panels; do not infer
      full-viewports coverage from the existing two one-test responsive lanes.
- [ ] Record/fix failures through the loop, review, and commit. Any browser-only
      proof stays labeled browser-only until the packaged-app equivalent passes.

**Exit:** An installed creator can edit, restart, scrub/play locally, and deliver
an inspected file with the intended picture, timing, and sound.

## Task 5: Close persistence, media portability, and interruption safety

**Files:** Extend `packages/project-persistence/src/{persistence,sqlite-store}.test.ts`,
`apps/cli/src/humanized/{project-robustness,project-lifecycle}.e2e.test.ts`, and
editor project-package tests. Create `apps/cli/src/humanized/asset-recovery.e2e.test.ts`.
Potential fix owners: `apps/cli/src/utils/{asset-sources,project-loader}.ts`,
`apps/cli/src/commands/timeline-cmd.ts`, and persistence adapters.

**Interfaces:** Use existing JSON/project-package and SQLite store contracts.
Fresh-process reads are the oracle; a worker's in-memory object is insufficient.

- [ ] Add `parallelRegistrationsRetainBothAssets`: two processes add distinct
      files concurrently; restart and render each project; neither source map entry
      may disappear. A failed add/edit must not leave a half-applied project state.
- [ ] Add `exportImportRelinkRendersOnFreshProfile`: export, move originals,
      import in a clean profile, relink explicitly, and inspect the resulting media.
      No dependence on the original profile's path registry is allowed.
- [ ] For every supported historical schema, load/migrate/save/reopen with
      semantic equality and idempotent migration. Newer schemas must be rejected
      without rewriting; malformed/dangling/cyclic inputs fail without data loss.
- [ ] Kill disposable writers at database commit and file-rename boundaries;
      inject locked/read-only/full destinations. Readback is always the old or new
      complete revision, never torn. Contention returns a bounded error or succeeds
      with monotonic revisions. Check recovery and leftover temp files after restart.
- [ ] Run `pnpm exec vitest run packages/project-persistence/src apps/cli/src/humanized/project-robustness.e2e.test.ts apps/cli/src/humanized/asset-recovery.e2e.test.ts --no-file-parallelism`
      plus affected editor package tests. Prove each fix independently, review, commit.

**Exit:** The app and CLI preserve projects and can recover/relink media after
concurrent edits, interrupted writes, and transfer to another profile.

## Task 6: Make the shipped Windows artifacts the acceptance boundary

**Files:** Extend `tests/desktop/installer-package-check.mjs`,
`apps/desktop/scripts/{smoke-packaged,smoke-standalone}.mjs`; create
`tests/desktop/windows-lifecycle.ps1` and
`tests/desktop/installed-cli-acceptance.mjs`. Change packaging only for proven bugs.

**Interfaces:** Lifecycle harness accepts explicit `InstallerPath`, `ExpectedSha256`,
`PreviousInstallerPath`, and `EvidenceDir`; refuses the developer's active install
or profile. Use a disposable Windows VM/user. Installed CLI harness accepts its
explicit `joy.cmd` path and sanitized disposable state directory.

- [ ] Before implementation, inspect actual installer options and lock supported
      install/uninstall/data-retention behavior into tests; do not invent flags.
- [ ] Test clean install -> first launch offline -> Task 4 workflow -> restart ->
      installed CLI JSON project/edit/render -> upgrade from v1.0.1 with project,
      settings, library, and DPAPI-wrapped synthetic key -> uninstall. Verify registry,
      shortcuts, actual version, expected retained data, and no orphan worker/FFmpeg.
- [ ] Exercise paths with spaces/Persian, non-admin install, locked output, and
      PowerShell 5.1/7 hosts. Verify executable precedence: `joy.cmd` invokes the CLI;
      the desktop executable must not accidentally satisfy a CLI version assertion.
- [ ] Verify installer/archive/sidecar hashes and tamper rejection. Record actual
      signing status; unsigned acceptance remains an explicit owner release decision.
- [x] Build with `pnpm --filter @joy-media/desktop package:unpacked` and run
      `pnpm --filter @joy-media/desktop test:smoke-packaged`. The packaged Playwright
      acceptance also passed with `--retries=0` (1 journey, including playable export).
- [ ] Package the installer with the current release prerequisites and run the
      lifecycle harness only in the designated disposable host. Associate all
      lifecycle evidence with exact source, lockfile, and artifact hashes.
- [ ] Fix/review/commit; never uninstall or overwrite the owner's working install.

**Exit:** The actual Windows artifacts work without the source checkout or a
developer's preexisting configuration; upgrade preserves data and cleanup works.

## Task 7: Finish the agent-facing command and failure contract

**Files:** Extend `apps/cli/src/humanized/{cli-contract,doctor-worker,agent-run,agent-secrets,agent-resilience}.e2e.test.ts`;
create `apps/cli/src/humanized/agent-delivery.e2e.test.ts` and versioned schemas
under `apps/cli/schemas/`. Extend the Windows self-hosted lane and its policy tests.

**Interfaces:** Reuse `createSandbox()` and the existing scripted local provider.
Schema fixtures cover help/error/doctor/project/timeline and each render NDJSON
event, including real-media and plan-only completion. Preserve documented exit
semantics: success 0, runtime failure 1, usage failure 2; treat termination policy
explicitly per platform rather than copying POSIX signal numbers onto Windows.

- [ ] Run local mock-agent journey: discover help -> create -> add real media ->
      split/trim -> make one invalid request -> consume structured error -> correct ->
      render -> inspect artifact -> reopen project in a fresh process. Validate every
      JSON document/event against its schema; stdout has no banners, ANSI, or SQLite
      warning leakage. Test Node versions that reproduced the startup warning.
- [ ] Add Windows equivalents for relevant POSIX skips: ACL inspection for
      synthetic credentials, real Windows termination/child cleanup, path/reserved
      name behavior, and file-lock failures. Test `bin`, `bundle`, installed `joy.cmd`.
- [ ] Cover provider 401/429/500, malformed tool/SSE, hung stream, cancellation,
      bounded retry, and no project mutation after failed/denied proposals. Scan logs,
      reports, and persisted state for synthetic keys. Desktop main-process credential
      transfer may be necessary; assert raw keys never return to renderer-visible
      results/events/logs, rather than banning every internal IPC payload.
- [x] Run the CLI, project-persistence, and fixture Vitest suites with
      `--no-file-parallelism` on both Linux and Windows.
      Windows: 30 files, 494 passed, 21 skipped. Ubuntu: 30 files, 507 passed,
      8 skipped. Windows `pnpm verify:ci` and runner policy harness also passed.
- [ ] Review/commit and publish the supported CLI contract in help/docs; the
      schema version changes intentionally when a breaking event shape changes.

**Exit:** An automated caller can diagnose errors, recover, and obtain verified
media through every shipped CLI entry on Windows without parsing human prose.

## Task 8: Qualify optional services and sustained use

**Files:** Extend `apps/api/src` account/device/gateway tests,
worker/job-protocol tests, `tests/e2e/agent-byok-security.spec.ts`,
`tooling/benchmark/src`, and existing release-performance observers. Reuse existing
disposable Postgres/provider/worker acceptance harnesses under `ops/self-hosted`.

**Interfaces:** Separate outcomes for deterministic mocks, real local worker, and
real services. Evidence must name which ran and what remained unavailable.

- [ ] Test account OTP expiry/replay/rate limits, revoke/device entitlement,
      ledger idempotency under duplicate/concurrent requests, and documented failure
      charging policy. Exercise disposable database backup/restore and the control
      plane deny-list; do not contact real customers or alter production records.
- [ ] Worker fixtures: no GPU/runtime/model, progress/error/hang/cancel/death;
      bounded error, no orphan process, unchanged project, cleaned temp output.
      Real-GPU qualification: one supported job per advertised capability with decoded
      output checks; a mock protocol pass cannot claim model output quality.
- [ ] Run 200 edits and the existing 30-minute effects/media soak, with warmup
      and machine/toolchain recorded. First measure baseline; proposed release bound
      is <=20% slowdown against the same machine class and <=10% post-warmup retained
      heap growth. Calibrate sampling/GC method before freezing these new bounds;
      retain existing stronger gates. Resource exhaustion must fail without data loss.
- [ ] Run the existing benchmark/performance and real-service harness commands
      resolved from the current release workflow, then targeted tests for changed code.
      Record unavailable hardware/service checks as blocking for advertised features,
      or disable/relabel those features explicitly before release.
- [ ] Review and commit fixes/evidence; include dependency/security and
      redistribution/source-obligation checks for the exact packaged artifacts.

**Exit:** Optional features fail predictably when unavailable; advertised live
capabilities and resource behavior have distinct, real acceptance evidence.

## Task 9: Repeat the exact-candidate release gate and close the ledger

**Files:** Extend `.github/workflows/release-candidate-v2.yml` and its policy/
evidence tests only for missing desktop/CLI requirements. Update Task 1's matrix,
release notes, and artifact-bound evidence index.

- [ ] Freeze a candidate after all work packages integrate. Run `pnpm verify:ci`
      and `pnpm test:harness`; run required generated-fixture, CLI Windows/Linux,
      packaged desktop, decoded media, real-service/GPU, restore, and soak checks.
- [ ] Dispatch the existing exact-SHA two-pass release workflow on permitted
      runners after checking current inputs. Its development-CI counterpart and its
      two one-test responsive jobs cannot substitute for release acceptance.
- [ ] Require retry-free first-pass success for every mandatory scenario in
      both isolated passes. Retain diagnostic retries as failed/flaky evidence;
      they do not erase the original failure. Missing required fixtures/tools fail.
- [ ] Verify source SHA, lock hash, fixture hash, package hashes, freshness,
      required scenario completeness, and redacted artifacts through the gate.
      A binary rebuild needs a new artifact hash and binary acceptance; source changes
      require a new candidate and new release evidence.
- [ ] Close all supported-surface rows. Zero open data-loss/security/false-success
      or other P0/P1 defects. Every remaining P2 has an owner, user-visible limitation,
      workaround, and release-note entry. Coverage count alone closes nothing.
- [ ] Obtain external Claude Code review and GPT-6.1-sol's exact-candidate
      `APPROVE_FOR_DEPLOY`; resolve findings through the same loop. Obtain the owner's
      release decision, including unsigned distribution if applicable. Only then can
      merge/release/distribution/deployment proceed within that explicit authorization.
- [ ] Orchestrator writes a redacted durable result to VPS Gbrain, reads it back,
      runs `Invoke-VpsGbrainExport.ps1` without arguments, and publishes a PC receipt
      with the verified export SHA. Failed sync remains sync-pending, not complete.

**Exit:** App-ready, CLI-ready, and release-ready each have explicit evidence.
The project is closed only when all three are satisfied for the same candidate.

## Order, milestones, and completion decisions

Execution order: **1 -> 2 -> 3 -> 5 -> 4 -> 6 -> 7 -> 8 -> 9**. Tasks 3 and 5
come early because output correctness and preservation of user work dominate the
risk. Tasks 4/6 supply actual desktop proof; Task 7 uses the accepted render path.
Do not start paid workers until the standing pipeline/billing gates are verified.

Milestones: M1 reproducible baseline/fixtures; M2 trustworthy CLI delivery/data
safety; M3 packaged desktop journey/Windows lifecycle; M4 services/resources;
M5 two-pass candidate acceptance and external release approvals. Size later
milestones after M1 exposes actual failures rather than promising a calendar date.

Planning assumptions requiring confirmation before their dependent implementation:
fail closed for unsupported CLI media features; proposed new audio/performance
bounds; access to a disposable Windows lifecycle host; unsigned distribution
policy. Continue independent tests while a decision is pending. The existing
real-render feature itself is already present upstream; implementing it anew is
not a work package.
