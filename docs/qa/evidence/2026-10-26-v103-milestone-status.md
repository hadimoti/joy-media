# JOY Media v1.0.3: milestone status, 2026-10-26

Status snapshot, not a release receipt. Nothing here merges into `main`, changes the release gate, deploys, or publishes
a release. Development CI runs on the feature branch only: `ci-dev.yml` triggers on `workflow_dispatch`, and its `push`
trigger is `main` only.

**Verdict: NOT READY for release.** The owner-dependent items below are open. Release-critical engineering that does not
need the owner is listed under "Remaining engineering". Each row names its evidence, and an item without a receipt is not
claimed as passing.

## Plan status matrix (autonomous pass, 2026-10-26)

Development snapshot, not a release receipt. PASS means the acceptance criteria have engineering evidence on the commit named.
PARTIAL means an engineering part is done and a receipt or an owner step is pending. BLOCKED means an owner or attended step has
not happened.

| Item                                 | Status              | Evidence (commit or run)                                                                                                                                                                                                                                                                                                  | Still needed                                                                                                                                                                         |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1 update and rollback               | PARTIAL             | Installer keeps the previous version and rolls back, including the database snapshot; shipped-CLI verifier fails closed; Sandbox 25 of 25 on `fb49a0e8`                                                                                                                                                                   | Owner key ceremony and pin (D2); positive signed-update path; gate lifecycle receipt                                                                                                 |
| L2 GPU crash                         | BLOCKED             | Diagnostic mode behind a flag; stage probe S0 and S1 pass; Media Foundation enumeration; the default build still crashes (2026-10-24 note)                                                                                                                                                                                | Attended G1 diagnosis and G2 30-run proof; activation, encode and Electron bisect builds (with G1)                                                                                   |
| L3 Persian captions                  | PARTIAL             | WOFF2 face registered only after SHA-256 check; CLI pixel probe 16 of 16; packaged CLI refusal; render-parity caption case 2 of 2 on this host                                                                                                                                                                            | Gate lifecycle caption receipt; D14 (TTF default face) owner decision                                                                                                                |
| L4 frame-count header                | PASS                | HTTP suite 55 of 55 (matrix, 2026-10-26); no-count remux path removed                                                                                                                                                                                                                                                     | None for the engineering acceptance                                                                                                                                                  |
| L5a held file                        | PARTIAL             | `render-recovery.e2e.test.ts` 8 of 8 on the Windows host, held-file case included; Sandbox refuses the held update                                                                                                                                                                                                        | Gate-required lifecycle measurement                                                                                                                                                  |
| L5b full disk                        | BLOCKED (owner)     | Accepted limit in the plan                                                                                                                                                                                                                                                                                                | Owner confirmation of the wording (D16)                                                                                                                                              |
| L6 menus and keyboard                | PASS (v1.0.3 scope) | Coverage ledger 24 of 24 exercised, strict mode 0 open; packaged suites 23 of 23 on `fb49a0e8`                                                                                                                                                                                                                            | Timeline depth, effects and transitions are v1.0.4; Pause and Stop decision                                                                                                          |
| L7a account                          | BLOCKED (owner)     | Attended preparation done: leak scan, checklists, synthetic dry run                                                                                                                                                                                                                                                       | Session A1 with a dedicated account (D10)                                                                                                                                            |
| L7b worker jobs                      | PARTIAL             | Export and upscale dispatch implemented; model SHA-256 pin enforced (`local-upscaling.test.ts` 3 of 3)                                                                                                                                                                                                                    | Attended upscale quality receipt (A1); licensed weights (D12)                                                                                                                        |
| L7c cli.worker                       | BLOCKED (owner)     | Excluded                                                                                                                                                                                                                                                                                                                  | Session A1 with licensed weights                                                                                                                                                     |
| L8 CLI runtime contract              | PARTIAL             | Launchers in `bin`; Sandbox fresh shell runs `joy-media --version` and `joy --version`, both report 1.0.3                                                                                                                                                                                                                 | Gate lifecycle receipt; release-note wording (D15)                                                                                                                                   |
| L9 test tightening                   | PASS                | Reverse mutations: without `apad` and `-t` the audio-length test fails (0.187 s against 0.0213 s); with direct imports only, the transitive spec test fails; the control-port helper throws in real-services runs (unit test). The fixture lane uses an explicit spec list in place of `--grep-invert` (workflow comment) | None for the v1.0.3 acceptance                                                                                                                                                       |
| L10 CI and evidence debt             | PARTIAL             | v3 workflow in PR #13 (check running) and on the dev branch; "survives" test identified; flake not reproduced under load                                                                                                                                                                                                  | Shadow dispatch go (D18) and C0 choice; weekly repeat merge (D21); legacy deletion (D22); branch-protection Worker check (D23); cutover (D19); 30 loaded runs from the scheduled job |
| F1 PATH                              | PARTIAL             | `bin` is the only PATH entry on a fresh install; Sandbox PATH checks pass                                                                                                                                                                                                                                                 | Gate lifecycle receipt                                                                                                                                                               |
| F2 installer                         | PARTIAL             | Hard failures on shortcut, PATH and uninstaller errors; staged install; exact-tree rollback; Sandbox 25 of 25                                                                                                                                                                                                             | Gate lifecycle receipt                                                                                                                                                               |
| F3 infrastructure detail             | PASS                | Scrub `75da669e`; privacy scan 2 of 2 on the current tree                                                                                                                                                                                                                                                                 | Git history keeps the old text (owner)                                                                                                                                               |
| F4 matrix inconsistencies            | PASS                | Inconsistency rows resolved (2026-10-25 section); rows corrected in `75da669e`                                                                                                                                                                                                                                            | None                                                                                                                                                                                 |
| P0 measure and decide                | PARTIAL             | Per-job durations for run `40148387453`; "survives" test identified; decisions listed in plan §5                                                                                                                                                                                                                          | Owner answers to D1 to D26 (the plan's recommendations are not confirmations)                                                                                                        |
| P1 engineering tracks A to I         | PARTIAL             | A, F, H, I done or prepared; B, C, D, E implemented with receipts pending; G partial                                                                                                                                                                                                                                      | Receipts above; MF activation and Electron builds (with G1)                                                                                                                          |
| P2 CI v3                             | PARTIAL             | Workflow, tooling and policy tests on the dev branch; PR #13 check running                                                                                                                                                                                                                                                | Shadow dispatch go (D18); merge of PR #13 is approved                                                                                                                                |
| P3 attended G1                       | BLOCKED (owner)     | Preparation only                                                                                                                                                                                                                                                                                                          | Attended session                                                                                                                                                                     |
| P4 freeze and one v3 run             | BLOCKED             | Needs P2 and P3                                                                                                                                                                                                                                                                                                           | Owner go for the shadow run; P3 result                                                                                                                                               |
| P5 attended G2, A1, release decision | BLOCKED (owner)     | Preparation only                                                                                                                                                                                                                                                                                                          | Attended sessions; release authorization                                                                                                                                             |

Commits and runs: `main` at `c458d1df`, unchanged. PR #13 head `1ead07cf`, required check run `40361864277`: static job success,
browser suites and Worker build in progress. Dev branch `v1.0.3/no-owner-tracks` at `74c93a3a`, the merge of PR #13's head; dev CI
run `40364557338` in progress. Dev CI run `40356464953` on `fb49a0e8` succeeded.

Verdict: NOT READY for release. The release-critical rows (L1, L2, L3, L4, L5a, L8, L9, L10, F1, F2, F3, F4) still need exact-candidate
receipts, and L2 and L7 need attended owner sessions.

## Latest verified results (autonomous pass, 2026-10-26)

- PR #13 was squash-merged to `main` as `b0e2bf4f`, after its required check (run `40361864277`, head `1ead07cf`) succeeded.
  The push-triggered CI on `main` is run `40366623833`. Local `verify:ci` on `c1b0f61b` passed: 738 test files, 6,821 tests,
  34 skipped. The `main` workflow `release-candidate-v3.yml` is dispatch-only, and `release-candidate-v2.yml` is unchanged.
- Windows Sandbox lifecycle on candidate `fb49a0e8` (setup SHA-256 `02fefb7d…`): previous-upgrade-rollback 25 of 25 and
  fresh-candidate 8 of 8, 0 failed. It covers the kept rollback with the database restored, the held-file refusal, the shipped-CLI
  refusals of a changed manifest and of a manifest signed by a key that is not pinned, and `joy-media --version` from a fresh shell.
  Record: `docs/qa/evidence/2026-10-26-sandbox-fb49a0e8-lifecycle.md`. The positive signed update still needs the owner's key.
- L9, reverse mutation: with `apad` and `-t` removed from the remux, the test "exports 48 kHz stereo AAC whose audio and video both
  last the declared duration" fails (audio and video differ by 0.187 s; the limit is one AAC frame, 0.0213 s). The file was restored.
- L5a: `render-recovery.e2e.test.ts` passes 8 of 8 on the Windows host, including the held-file case.
- P0: per-job durations for run `40148387453` are in the runbook's resources section and the timing baseline `6d7657bf`. The critical
  path is the real-service chain (about 44 minutes per pass) and the Windows lane (about 70 minutes).
- The "survives" flake is `local-worker.integration.test.ts`, "survives a Worker killed mid-job" (see the v3 design doc, section 1).
- Dev CI on `fb49a0e8`: run `40356464953`, success, workflow_dispatch.
- PR 13 (the v3 merge to `main`): head `1ead07cf`, required check in progress.

## Branch and development CI

- Commits since `cad3445e` (the Sandbox note): `e983842b` (packaged click-through of File > Settings and its manual update check,
  L6; dev CI run `40292255809`, success, 6 of 6), `59cfee15` (GPU diagnostic mode wired behind its flag; rollback checks for the
  exact install tree and the database snapshot, with the Sandbox guest carrying the same checks; L1 and L2 prep), and `de99320c`
  (Media Foundation enumeration probe, L2 prep).
- Branch `v1.0.3/no-owner-tracks`. Commits in this checkpoint, on top of `a93f819c`, `c94efe62`, `54a33fdf` and `58943380`:
  - `6ae9be64`: GPU diagnostic-mode switch, stage list and local-only crash settings. Inert, not wired into the app.
  - `de392213`: attended G2 repeat harness. Preflight verified; the run loop has not run.
  - `5de135f1`: attended G1 stage probe. S0 and S1 ran locally; S2 to S6 wait for G1.
- Dev CI on `6ae9be64` (run `40248976254`), `41f8431d` (run `40252020545`) and `5103c444` (run `40258394170`): each success,
  6 of 6 jobs. The packager fix `0da4e880` (run `40262979132`) was cancelled, superseded by the push of `2b01e8f4`.
- Final head `2b01e8f4`: run `40263566162`, success, 6 of 6 jobs (static verification, Worker package, three browser suites,
  summary). This is development CI, not release approval. Later commits on the branch are recorded in the gbrain checkpoint.
- Earlier dev CI on `64531d2e`: run `40238451437`, success, 6 of 6 jobs. Kept as history.

## Installer, rollback and updates (L1, F1, F2)

- Implemented in `apps/desktop/installer/Setup.cs`: install stages into `JOY Media.staging-<version>`, verifies every staged
  file against the embedded manifest, snapshots the local database into `backups\pre-update-<version>`, and swaps folders
  so the replaced version is kept as `JOY Media.previous`. The install starts from a button click. Shortcut, PATH and
  uninstaller errors are hard failures. `/rollback` restores the kept version, and `/restore-data` restores the snapshot.
- PATH follows the restored layout (`SetUserPathLayout`, commit `58943380`). Only the `bin` folder goes on PATH (F1).
- Windows Sandbox on candidate setup `be7a636a` (see `2026-10-26-rollback-path-layout.md`): kept-previous rollback
  23 of 23 steps, fresh install with `joy-media --version` and `joy --version` from a fresh shell 8 of 8, zero failed steps.
- Current-source candidate `a369df53…` (built after the packager fix `0da4e880`): both sequences exit 0, previous-upgrade-rollback
  25 of 25 and fresh-candidate 8 of 8. The renderer smoke passes after upgrade, after the refused update, and on fresh install,
  and both shipped-CLI refusals pass. See `2026-10-26-rollback-path-layout.md`.
- Previous release v1.0.2, the plan's previous version (its setup and archive SHA-256 match the published `SHA256SUMS.txt`): the
  same candidate passes previous-upgrade-rollback 25 of 25 and fresh-candidate 8 of 8, with 0 failed steps. See
  `2026-10-26-sandbox-v102-previous.md`.
- Previous-release pins moved from v1.0.1 to v1.0.2 (owner approval, this round) in `tests/desktop/windows-lifecycle.ps1`, in the
  gate's pinned download in `.github/workflows/release-candidate-v2.yml`, and in the evidence-restore check
  (`ops/self-hosted/linux-runner/restore-retained-evidence.mjs`). The three hashes were checked against the local v1.0.2 release
  folder and its published `SHA256SUMS.txt` (setup `6d8089…`, checksums `9e15f9…`, archive `e59ee1…`). The acceptance steps are
  unchanged. Gate receipts still need a CI run, and the gate's cutover (D19) is still owner-gated.
- Settings > Updates (this round): `File > Settings…` opens a dialog whose Updates section has a manual "Check for Updates" button.
  The check runs only on a click, calls `desktop.check-for-update`, and never downloads or installs. The result is described in
  plain words, a newer release shows a small dot on the Updates entry, and nothing pops up. Unit tests in
  `apps/editor-web/src/AppSettingsDialog.test.tsx` (9 of 9). A packaged click-through (`e983842b`, `tests/desktop/settings-dialog.spec.ts`,
  1 of 1) opens the dialog and runs the manual check on the packaged build.
- Rollback checks (`59cfee15`): the rollback runs with `/restore-data`. The restored database must equal the snapshot the upgrade took,
  byte for byte, and the install tree must equal the v1.0.2 tree from before the upgrade. Sandbox evidence on candidate `59cfee15`
  (setup SHA-256 `3dc8beb9…`): previous-upgrade-rollback 25 of 25 and fresh-candidate 8 of 8, 0 failed steps, with the database changed
  before the rollback and restored to the snapshot. See `2026-10-26-sandbox-59cfee15-rollback-restore.md`. The same checks in
  `tests/desktop/windows-lifecycle.ps1` are parse-checked only, because the owner-gated CI lifecycle runs that script.
- CLI: `joy-media update check | verify <file> | rollback`. The verifier checks an Ed25519 signature over the exact manifest
  bytes and fails closed with no pinned key (`4b0d72e3`). The app's update check uses the same verifier and no longer
  needs a subscription.
- Signing (D2, development side complete this round): `tooling/release/src/sign-release-manifest.mjs` adds `keygen` (release keys
  are encrypted with a passphrase read from a file, and development keys are labelled `development-…` and `notForRelease`),
  `fingerprint`, and a `sign` that never overwrites. Keys are refused inside the checkout or a runner workspace. Tests:
  `sign-release-keygen.test.ts` (12 of 12) and `sign-release-manifest.test.ts` (4 of 4). `packages/release-trust/src/policy.test.ts`
  adds 16 positive and negative cases for the verifier (rotation, forced update, tampering, wrong key, non-Ed25519 key,
  malformed signature text, malformed manifest, channel mismatch, downgrade refusal). The custody procedure is
  `docs/release/offline-signing-key-ceremony.md`.
- **Not done:** the pinned release key list (`PINNED_RELEASE_PUBLIC_KEYS_PEM`) is still empty, so no signed update can
  verify in a shipped build until the owner runs the ceremony and approves the pin change. The lifecycle transitions
  `updateRefusedWhileFileHeld`, `tamperedUpdateRefused` and `wrongKeyManifestRefused` are in `tests/desktop/windows-lifecycle.ps1`,
  which is parse-checked only. They need a Windows lifecycle run. The positive path needs the owner's real key.

## GPU (L2, sessions G1 and G2)

- Built: `apps/desktop/src/main/gpu-diagnostics.ts`, the diagnostic mode. It is wired into `electron-entry.ts` behind
  `--joy-media-gpu-diagnostics` (`59cfee15`), so a normal launch does nothing new. Nine unit tests use fakes;
  `tooling/diagnostics/src/redact-gpu-report.ts` with its tests; the stage probe in `tests/desktop/gpu-probe/`;
  and the repeat harness `tooling/diagnostics/run-default-export-repeat.ps1`.
- Stage probe, run locally on the `apps/desktop` Electron 44.3.0 build: S0 ok; S1 ok, WebGL 2 on ANGLE D3D11 with the
  RTX 5070 Ti and no child-process events. S2 to S6 exercise the encoder path under study, so they run only in G1.
- Repeat harness: `-PreflightOnly` passed with a stub install and a pnpm stub, and refused without pnpm. The run loop
  has not run. It needs pnpm on PATH, because the Playwright config's API server starts with pnpm, and it needs an installed
  build and the attended session.
- Electron is pinned exactly at `44.3.0` in `apps/desktop/package.json`.
- Media Foundation probe (`tooling/diagnostics/mf-probe/`, `de99320c`): it lists the hardware H.264 encoders from outside Chromium.
  On this PC it finds the NVIDIA H.264 Encoder MFT and two AMD H.264 encoder MFTs, all names readable
  (`2026-10-26-gpu-mf-enumeration.md`). Its activation and one-frame encode are not built; they belong with G1.
- Not built: the Electron variant builds for the bisect. They need large downloads, which the session constraints limit, and they
  belong with G1.
- The shipped default build still crashes on this host (note of 2026-10-24). Owner sessions G1 (diagnosis) and G2
  (30-run proof on the exact candidate) have not run.

## Packaged app (2026-10-26)

- Defect: the packaged main process imports `@joy-media/release-trust`, which the packager did not stage. A packaged app
  outside the repository failed at import with `ERR_MODULE_NOT_FOUND` before its window, so it never started. Local runs
  passed because the standalone build sits inside the repository, so the earlier local smoke results do not show it.
- Fix `0da4e880`: the packager derives the staged packages from the desktop manifest (`apps/desktop/scripts/workspace-packages.mjs`).
  `workspace-packages.test.mjs` checks that every declared internal dependency is staged, and that every `@joy-media` import in
  the desktop main process is a declared dependency. Both run in the harness list.
- Dev CI did not catch the defect: it has no packaged startup check. Adding one needs a runner and a policy decision (owner).

## Captions (L3)

- `69633e07`: desktop captions draw in the bundled Noto Sans Arabic face. The WOFF2 is registered only after its SHA-256
  matches the manifest, and export fails when it is missing.
- Packaged export spec `tests/desktop/export-semantics.spec.ts`: 2 of 2 passed on the unpacked build. CLI pinned pixel probe:
  16 of 16 passed.
- The caption case of `render-parity.e2e.test.ts` passes on this host with the lifecycle's variable set (`JOY_MEDIA_REQUIRE_CAPTION_FACE=1`,
  `--retry=0`): 2 of 2 runs, about 25 seconds each, after the probe deadline fix and a bounded retry of a timed-out first Chromium
  start. The first start in each new profile root timed out in six of six fresh roots and succeeded on the second attempt. The
  lifecycle receipt on the release gate is still pending, and the gate runs on a CI Windows runner. The cause of the slow first
  start is not verified. The corrupted-face refusal is covered in two halves: a corrupted face is judged unusable
  (`caption-face-probe.test.ts`, which now takes a face argument), and an unusable probe gives `SETUP_REQUIRED`
  (`capabilities-cmd.test.ts`). This round adds the chain in one test, `plan-title.test.ts`: the real FFmpeg/libass probe judges
  corrupted bytes unusable, the production caption planning refuses with `SETUP_REQUIRED` and writes no plan, and the bundled face
  passes the same probe (negative control). The packaged CLI (standalone folder, hard-linked work copy) prepares the Persian caption
  plan from the healthy face (exit 0). With the Arabic 400 libass face corrupted, it refuses with `SETUP_REQUIRED` (kind
  `canonical-caption-face-unavailable`), exits 1, and writes no plan (`tooling/fonts/packaged-caption-refusal.mjs`, and
  `docs/qa/evidence/2026-10-26-packaged-caption-refusal.md`). The Windows lifecycle copy of the same case is the gate's. See
  `docs/qa/evidence/2026-10-26-caption-face-windows-host.md`. The default-face change
  needs the owner's confirmation (D14).

## Export semantics (L4, L9)

- L4: the export remux route requires `x-joy-frame-count`. The HTTP suite passed 55 of 55 (matrix, 2026-10-26).
- L9: the reverse mutations in the export and spec-selection tests fail as required (matrix). Not re-run in this checkpoint.

## Held file (L5a) and full disk (L5b)

- L5a: the held-file case passes locally in `render-recovery.e2e.test.ts`. The Sandbox also refuses the update while a file is
  held. The Windows lifecycle receipt is pending.
- L5b: accepted limit (D16).

## Menus, keyboard and file package (L6)

- `b42a284f`: the coverage ledger's 24 open entries are each exercised by a packaged test that performs the action and checks
  its effect. Strict mode (`JOY_MEDIA_L6_RELEASE=1`) passes with 0 open items (8 of 8).
- `keyboard-shortcuts.spec.ts`: all 15 shortcut actions in 1 test, 16 steps, passed. `menu-actions.spec.ts`: 8 tests passed.
- Batch relink and override-after-restart are verified packaged in `tests/desktop/missing-media.spec.ts` (matrix note,
  2026-10-25).
- Packaged Settings click-through (`e983842b`): `tests/desktop/settings-dialog.spec.ts` opens File > Settings…, runs the manual
  Updates check and closes the dialog (1 of 1). The ledger marks `file.settings` as `exercised`. Packaged suites on the unpacked build
  from `cad3445e` (the same app code as `e983842b`): menu-panels 2 of 2, keyboard-shortcuts 1 of 1, menu-actions 8 of 8,
  settings-dialog 1 of 1, 12 of 12 with 0 failed. The ledger validator passes 8 of 8, also in strict mode.
- Open UX gap, for decision: Joy Code > Pause / Stop is always enabled and does nothing when no run is in progress.

## Worker capabilities (L7a, L7b, L7c)

- L7b, implemented: `render.export` and `upscale.image` are dispatched by the desktop orchestrator. The payload is stored at
  submit and returned in the lease, and the lease and Worker payload tests passed 25 of 25.
- L7b, model pin (`2500fe3c`): an upscaling model is ready only while its file's SHA-256 equals
  `JOY_MEDIA_REAL_ESRGAN_MODEL_SHA256`. A missing or malformed pin, and a file swapped after pinning, are refused
  (`local-upscaling.test.ts`, 3 of 3). The pin comes from configuration, not from source, until the owner approves the
  licensed weights (D12).
- L7a: the attended preparation is done (leak scan, receipt, checklists, synthetic dry run). Session A1 has not run.
- L7b quality receipt and L7c model-quality receipt: owner session A1, not run.

## CLI runtime contract (L8, F1)

- The launchers sit in `bin`, the only folder on PATH. The Sandbox evidence is listed under "Installer, rollback and updates".
  The Windows lifecycle receipt is pending.

## CI and flakes (L10)

- P0 timing baseline committed: `6d7657bf`. Per-job durations for run `40148387453` (release-candidate-v2 reference, 2026-10-24):
  the longest job is `windows-p0-real-services`, 2,924 s; `windows-worker-clean` 1,299 s; the Linux real-service passes 539 s
  and 566 s; `node-contracts` 676 s and 698 s. The critical path is the Windows P0 job, so the 75-minute target depends on it.
- The "survives" flake (`local-worker.integration.test.ts`, Worker killed mid-job): the one failure on record is run `40118338118`
  (commit `5d08272c`). That commit had no source hold; `a165d51a` added one, and the three ci-dev runs since (`6ae9be64`,
  `41f8431d`, `5103c444`) and the final head all passed. On WSL Ubuntu 24.04 the job stays `running` for about 540 ms, and six
  runs without the hold all passed, five of them under two-core load. The root cause is not confirmed. This change adds the job's
  state to the timeout message. See `docs/qa/evidence/2026-10-26-survives-flake-analysis.md`.
- Desktop packaged flakes (2026-10-26, head `c6e679b2`). In the first full `tests/desktop` run (42 tests), two tests failed.
  `menu-actions` "clip split from the Clip menu" timed out on the writer gate's busy state ("Editor access is unavailable")
  after `page.reload()`. `missing-media` "wrong hash or wrong size" failed in cleanup: EPERM removing its fresh profile after
  the app had closed. Each test has since passed five times out of five: the rerun of the two files (19 of 19), three repeats
  of those files (57 of 57), and a full run on the final build (42 of 42). That is one failure in six executions of each test,
  and both occurred in the same full run. Reproduction on demand failed: 200 same-tab reloads in plain Chromium and 240 in the
  packaged editor, with `navigator.locks` instrumented, gave no busy result. The root cause is not confirmed. No locking
  change was made. A bounded busy-retry was tried on a hypothesis and reverted. The failure path now logs the app's window list
  (busy case) and the live Joy Media and Chromium processes (profile removal), so the next occurrence can be classified.
- Shutdown defect found while tracing the EPERM: `createWorkerSupervisor` cleared its stop flag when a restart scheduled before
  `stop()` fired, so the Worker could start again after the app had asked it to stop. Fixed in `worker-supervisor.ts`, with two
  regression tests; the restart test fails on the old code. It is not shown to be the cause of the EPERM.
- CI v3 verification (2026-10-26, branch): the release tooling and ops suites pass, 35 files and 547 tests, 4 skipped. v2 is
  unchanged from `c49bcc93`, and its SHA-256 is pinned in `release-candidate-v3.test.ts`. The shadow prerequisites, resources,
  costs and boundaries are in `docs/release/ci-v3-shadow-runbook.md`. No v3 job has run on GitHub, so the critical path and the
  hosted minutes are estimates, not measurements.
- The Vitest `onTaskUpdate` RPC timeout was not reproduced. A full run of the repository suite (726 files) on WSL, pinned to two
  cores with CPU burners, had 0 `onTaskUpdate` timeouts. Its 3 failing files (4 tests) are specific to the WSL image: the 2
  export-core jitter tests, the plugin scaffold test and the observer test all pass on the Windows host. Pool concurrency is capped
  in `vitest.config.ts`: one worker on GitHub-hosted runners, otherwise the lower of 8 and the cores minus one. The 47 test files
  that spawn processes run in their own project, `serial-process`, one file at a time (`fileParallelism: false`); the list is
  `vitest.serial-process.json`. `tooling/release/src/vitest-serial-project.test.ts` (3 of 3) fails when the list and the discovered
  files disagree. The split leaves the test list unchanged: 6,699 entries before and after, none missing, and none added except
  the three entries of the new policy test.
- CI v3 (D17, branch implementation, approved 2026-10-26; reviewed 2026-10-26, see the design, section 2.2). `release-candidate-v3.yml`
  is dispatch-only and is **not** the production gate. Its job graph (design, section 2.1): `hosted-verify-shard` ×3 runs the Vitest
  suite in three shards with `--retry=0`; `hosted-prepare` collects `vitest list --json` in the shards' PostgreSQL environment and runs
  the static commands and the production audit; `hosted-verify` merges the shards against the collection (exact coverage) with no
  dependency install, and publishes the verified report's digest as its job output. `windows-candidate` merges the Windows P0 lane, the
  CLI suite (once), the artifact staging, one build, the pinned v1.0.2 download and one lifecycle pass (output `evidence1`).
  `real-service-acceptance` runs once with the Windows check deferred to the gate (`JOY_MEDIA_CI_WINDOWS_EVIDENCE=deferred`); its needs are
  validation only. `fixture-acceptance` and `p3-real-services` run after upstream failures (`always`), so one run reports every failure. The
  final gate has eight lanes, and its 17 checks are unchanged (`gate.ts`). It reads the verified hosted report, and checks its digest. The
  v3 coverage receipts are kept beside the final evidence, with checksums. `release-candidate-v2.yml` is unchanged; its SHA-256 is pinned.
- Review findings, verified against the code before any change (Codex gpt-6.1-sol, read-only): a blocker, the collection running without
  the database environment the shards had (fixed: `hosted-prepare`); a listed test that skipped counted as executed (fixed: the merge
  refuses it); the P0 config inheriting the default suite's projects (fixed for v3 with `vitest.p0-v3.config.ts`; v2 is an owner
  decision); real-service not starting first (fixed with the v3-only deferral, the final gate still binds Windows); the acceptance chain
  not running after an upstream failure, the summary step not failing, the P3 janitor without a token, the Windows teardown suppressing
  inspection errors, and the v3 receipts not kept (all fixed). Details and the deliberately unchanged items are in the design, section 2.2.
- Local rehearsal on this PC (32 logical cores, 8 workers per shard, one run after the last code change; NOT hosted runners):
  collection `vitest list --json` 32 s, 6,819 tests in 738 files; shards exit 0 at 48 s, 346 s and 137 s; merge ok, 6,819 of 6,819
  executed, 0 missing, 0 duplicated, 0 unexpected, 0 skipped-listed, 0 failed, 34 platform-skipped tests recorded and not counted; static
  commands exit 0 (typecheck 0.9 s, lint 14 s, format 25 s, goldens 2 s); the report verifies (1.34 MB). Hosted timings are not measured.
  The estimate for a hosted shard is the review's proxy only (vitest.config.ts runs one worker per hosted job), and it stays a proxy until a
  shadow dispatch measures it.
- Two earlier local runs were discarded. The first ran while test files were being edited, so it mixed two versions. The second passed the
  test file as the output path of `vitest list --json` and overwrote it; the file was restored from the last version written and reformatted,
  and every test in it passes. The measurements above come from a run on a frozen tree.
- Built and tested, now used by the v3 graph: the Vitest shard merge (`vitest-shard-merge.mjs`, `vitest-skip-semantics.test.ts`), the hosted
  report (`hosted-verify.mjs`, 26 tests), the gate's reader (`gate-hosted-verify.test.ts`, 9 tests), the run inputs (`ci-v3-run-inputs.mjs`,
  16 tests), the run summary (`ci-v3-run-summary.mjs`), and the policy (`release-candidate-v3.test.ts`, 59 tests with a negative control per
  refused property). The deferred-mode and P0-config tests are `windows-evidence-mode.test.ts` and `p0-v3-config.test.ts`.
- Not done, and owner-gated: the shadow dispatches (D18). GitHub dispatches v3 only from the default branch, so the file needs a merge
  to `main`; C0 needs a decision (the runbook, section 2); and the v2 shadow summary needs a v2 record that the unchanged v2 gate does
  not retain (runbook, "The v2 summary"). The cutover (D19), legacy deletion (D22) and branch protection (D23) stay with the owner.
  `docs/release/ci-v3-shadow-runbook.md` has the exact steps.
- Equivalence of executed tests: `ci-v3-equivalence.ts` (7 tests) and the shadow comparison share the rule that v3 may add tests but
  may not drop one.
- Weekly repeat (D21, prep): `.github/workflows/ci-repeat.yml` runs `vitest-load-repeat.mjs` (Vitest passes under synthetic CPU
  load, `--retry=0`, flake receipt `flake-counts.json`) on a hosted runner. It is inert until merged to `main`. Its tests are in
  `ci-repeat.test.ts` (9 of 9), including mutated copies that publish, merge, go self-hosted or widen the token. The Windows
  lifecycle and real-service repeats from the plan are not in it yet; they depend on the v3 jobs. The runner policy test names this
  job as the only hosted job added (`ci-runner-policy.test.ts`).
- Evidence store (D20, prep): `tooling/release/src/prune-evidence.mjs` is dry-run by default and needs an owner marker file. It keeps
  released candidates forever, prunes unreleased runs older than 30 days only with `--apply`, refuses symlinks and refuses roots
  inside the checkout. `prune-evidence.test.ts` has 10 cases, and a policy test fails any workflow that names it (the gate never
  deletes).
- Legacy workflow deletion (D22) and the branch-protection Worker check (D23): owner decisions, not done.

## Docs (F3, F4)

- `75da669e`: infrastructure detail scrubbed from the docs and plan, a scan added to enforce it, and matrix rows corrected.
  The privacy scan (`tooling/release/src/privacy-scan.test.ts`) was re-run on the current tree and passes 2 of 2.

## Plan phases

| Phase | Status                                | Why                                                                                                                                                 |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0    | Mostly done                           | Timing baseline committed. Per-job durations for run `40148387453` are measured (see CI and flakes). Owner decisions not collected.                 |
| P1    | Implemented locally, receipts pending | Tracks A, C, D, E, F, H, I. Track G partial (see GPU). Lifecycle and release-gate receipts pending.                                                 |
| P2    | Implemented on the branch, not run    | CI v3 with the job merges is written and policy-tested (dispatch-only). Shadow runs need the merge to main and the C0 decision (see CI and flakes). |
| P3    | Blocked                               | Attended G1 (owner).                                                                                                                                |
| P4    | Blocked                               | Needs P2 and P3.                                                                                                                                    |
| P5    | Blocked                               | Attended G2 and A1 on the frozen artifact, then a release decision.                                                                                 |

## Owner items (open)

- D2: signing-key ceremony. The development tooling and its tests are done (see Installer). The owner runs the ceremony in
  `docs/release/offline-signing-key-ceremony.md`, and the pinned key list stays empty until the owner approves the pin change.
- Owner approvals received on 2026-10-26 for development work: D17 (branch implementation of the v3 design, still to be written),
  D18 (equivalence harness and negative controls; shadow dispatches only after the no-publish check), D20 (receipts-only store,
  dry-run prune utility), D21 (weekly repeat file, inert until merged), the v1.0.2 pins, the Settings > Updates check, and the
  caption probe design. Still reserved: D19 (cutover), D22 (legacy deletion), D23 (branch protection) and final release
  authorization.
- D17 to D23 remaining: D19, D22 and D23 stay with the owner. D18 shadow dispatches and the D21 merge to `main` need their own go.
- G1 and G2: attended GPU sessions, with decisions D6 to D8 (diagnostics, driver changes, mitigations).
- A1: attended account and model sessions, with D9 to D12.
- D14 (default caption face), D16 (full disk), D25 and D26 (menu and keyboard scope; worker dispatch exposure).
- Release authorization: none requested, and `release-candidate-v2` has not been dispatched.

## Remaining engineering, not owner-gated

- The Media Foundation probe's activation and one-frame encode (`tooling/diagnostics/mf-probe/`): not built. The enumeration is
  built (`de99320c`), and its constants were checked at run time. The encode belongs with G1.
- The packaged CLI caption refusal is built and run locally (see Captions). The Windows lifecycle copy of the case is the gate's.
- The job merges and sharding of plan 3.4 are implemented on the branch (L10, see CI and flakes). Their hosted and acceptance results
  are not measured until a shadow dispatch runs them.
- A positive signed-update check with the owner's key (L1): owner-gated; the key is not generated.
- The Electron variant builds for the bisect. These need network downloads and belong with G1.
- The lifecycle receipts for L1, L3, L5a and F2. `windows-lifecycle.ps1` needs the CI toolchain, and its receipt belongs to the
  owner-gated release gate. The Sandbox run on candidate `a369df53` is supporting evidence: 25 of 25 and 8 of 8, including both
  shipped-CLI refusals and the held-file refusal. The gate's lifecycle and its previous-release pins now name v1.0.2 (approved this
  round), so a gate run will verify them. Its receipt is still pending. L3's caption case passes on this host (see the L3 section);
  its release-gate receipt is pending.
- Survives flake: root cause not confirmed. The timeout message now names the job state, so the next occurrence settles it.
- A packaged-startup check in CI, so a packaged app that cannot import its main module fails the build. It needs a runner and a
  policy decision (owner).
- Refresh the readiness matrix rows once the receipts exist. Each row keeps its evidence source. The rows are unchanged in this
  checkpoint, because no gate receipt exists for them.
