# JOY Media v1.0.3: milestone status, 2026-10-26

Status snapshot, not a release receipt. Nothing here merges into `main`, changes the release gate, deploys, or publishes
a release. Development CI runs on the feature branch only: `ci-dev.yml` triggers on `workflow_dispatch`, and its `push`
trigger is `main` only.

**Verdict: NOT READY for release.** The owner-dependent items below are open. Release-critical engineering that does not
need the owner is listed under "Remaining engineering". Each row names its evidence, and an item without a receipt is not
claimed as passing.

## Branch and development CI

- Branch `v1.0.3/no-owner-tracks`. Commits in this checkpoint, on top of `a93f819c`, `c94efe62`, `54a33fdf` and `58943380`:
  - `6ae9be64`: GPU diagnostic-mode switch, stage list and local-only crash settings. Inert, not wired into the app.
  - `de392213`: attended G2 repeat harness. Preflight verified; the run loop has not run.
  - `5de135f1`: attended G1 stage probe. S0 and S1 ran locally; S2 to S6 wait for G1.
- Dev CI on `6ae9be64` (run `40248976254`), `41f8431d` (run `40252020545`) and `5103c444` (run `40258394170`): each success,
  6 of 6 jobs. The packager fix `0da4e880` (run `40262979132`) was in progress at the time of writing. The final head is
  dispatched after that run, and its result is recorded in the next update of this file.
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
- CLI: `joy-media update check | verify <file> | rollback`. The verifier checks an Ed25519 signature over the exact manifest
  bytes and fails closed with no pinned key (`4b0d72e3`). The app's update check uses the same verifier and no longer
  needs a subscription.
- **Not done:** the pinned release key list is empty until the owner's key ceremony (D2), so no signed update can
  verify yet. The lifecycle transitions `updateRefusedWhileFileHeld`, `tamperedUpdateRefused` and
  `wrongKeyManifestRefused` are in `tests/desktop/windows-lifecycle.ps1`, which is parse-checked only. They need a Windows
  lifecycle run. The positive path needs the owner's real key.

## GPU (L2, sessions G1 and G2)

- Built: `apps/desktop/src/main/gpu-diagnostics.ts`, an inert diagnostic module (not wired into `electron-entry.ts`);
  `tooling/diagnostics/src/redact-gpu-report.ts` with its tests; the stage probe in `tests/desktop/gpu-probe/`;
  and the repeat harness `tooling/diagnostics/run-default-export-repeat.ps1`.
- Stage probe, run locally on the `apps/desktop` Electron 44.3.0 build: S0 ok; S1 ok, WebGL 2 on ANGLE D3D11 with the
  RTX 5070 Ti and no child-process events. S2 to S6 exercise the encoder path under study, so they run only in G1.
- Repeat harness: `-PreflightOnly` passed with a stub install and a pnpm stub, and refused without pnpm. The run loop
  has not run. It needs pnpm on PATH, because the Playwright config's API server starts with pnpm, and it needs an installed
  build and the attended session.
- Electron is pinned exactly at `44.3.0` in `apps/desktop/package.json`.
- Not built: the minimal Media Foundation probe (`tooling/diagnostics/mf-probe/`) and the Electron variant builds for the
  bisect. The diagnostic switch is not wired, because its crash-reporter options and Chromium switches need G1 confirmation.
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
- Open: the full Windows lifecycle has not run with the caption check. The default-face change needs the owner's confirmation
  (D14).

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

- P0 timing baseline committed: `6d7657bf`.
- The "survives" flake (`local-worker.integration.test.ts`, Worker killed mid-job) was not reproduced in 31 loaded local runs:
  6 full-file runs and 25 survives-only runs under CPU stress, all exit 0. Diagnostics (`c94efe62`) report the Worker's state
  when the lease wait times out. The root cause is not confirmed.
- The Vitest `onTaskUpdate` RPC timeout was not reproduced. Pool concurrency has not been capped.
- CI v3: design only, `docs/plans/2026-10-26-ci-v3-design.md`. Implementation waits for D17.
- Scheduled `ci-repeat.yml`: not built. A GitHub `schedule` runs only from the default branch, so it needs D21 and a merge to
  `main`, which the owner has not authorized.
- Legacy workflow deletion (D22) and the branch-protection Worker check (D23): owner decisions, not done.

## Docs (F3, F4)

- `75da669e`: infrastructure detail scrubbed from the docs and plan, a scan added to enforce it, and matrix rows corrected.
  The scan was not re-run in this checkpoint.

## Plan phases

| Phase | Status                                | Why                                                                                                                 |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P0    | Mostly done                           | Timing baseline committed. Per-job durations for run `40148387453` are not measured. Owner decisions not collected. |
| P1    | Implemented locally, receipts pending | Tracks A, C, D, E, F, H, I. Track G partial (see GPU). Lifecycle and release-gate receipts pending.                 |
| P2    | Blocked                               | CI v3 needs approvals D17 to D23.                                                                                   |
| P3    | Blocked                               | Attended G1 (owner).                                                                                                |
| P4    | Blocked                               | Needs P2 and P3.                                                                                                    |
| P5    | Blocked                               | Attended G2 and A1 on the frozen artifact, then a release decision.                                                 |

## Owner items (open)

- D2: signing-key ceremony. The pinned key list stays empty until then.
- D17 to D23: CI v3 approvals and policy changes (D22, D23 included).
- G1 and G2: attended GPU sessions, with decisions D6 to D8 (diagnostics, driver changes, mitigations).
- A1: attended account and model sessions, with D9 to D12.
- D14 (default caption face), D16 (full disk), D25 and D26 (menu and keyboard scope; worker dispatch exposure).
- Release authorization: none requested, and `release-candidate-v2` has not been dispatched.

## Remaining engineering, not owner-gated

- The Media Foundation probe (C#). Compile-only checks are possible here; running it touches the encoder, so it waits for G1.
- The Electron variant builds for the bisect. These need network downloads and belong with G1.
- The Windows lifecycle run for the tampered and wrong-key transitions, in the Sandbox or the release gate.
- Root cause for the survives flake, and reproduction of the RPC timeout under synthetic load.
- A packaged-startup check in CI, so a packaged app that cannot import its main module fails the build. It needs a runner and a
  policy decision (owner).
- Final-head CI for the newest commit on the branch, after the fix run finishes.
- Refresh the readiness matrix rows once the receipts exist. Each row keeps its evidence source.
