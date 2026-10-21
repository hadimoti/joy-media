# JOY Media v1.0.2 — Release Candidate Notes (DRAFT, not released)

**Status: not released.** This draft records what the local candidate has verified and what is still open. It is not a release, it has no checksums, and no CI or release-candidate receipt is attached. Release, deploy and publish remain owner-gated.

---

### Important Notice for Windows Users (Unsigned Installer)

The Windows installer and portable package are **unsigned**. SmartScreen will warn on first launch. Installing an unsigned candidate is an owner-approved manual step; no automatic update or rollback is claimed (see below).

---

### Changes on this candidate

- **Export colour is self-consistent.** Chromium's MediaRecorder converts canvas RGB with BT.601 coefficients but tags the MP4 BT.709. The remux (`packages/export-core`) now decodes with the BT.601 content matrix and encodes with explicit BT.709 matrix and tags. The RGBA export path converts with BT.709 explicitly. Before this change, pure blue exported as (0,14,255) on players that honour the tag.
- **CLI exit codes for usage errors.** Unknown commands, worker sub-commands, agent sub-commands, agent model actions and agent provider actions exit 2 in text and `--json` modes. Runtime failures keep exit 1. `--json` usage errors use `{type, code, message}`.
- **Renderer transition layer.** A missing transition layer is treated as `null` (Pixi returns `null` from `getChildByName`), and the `uTextureTo` sampler is registered before Pixi builds resource accessors. Regression tests cover both.
- **Desktop export-semantics acceptance.** A packaged spec checks decoded picture, stereo tones, timing, the alpha centre, the dissolve midpoint, the Persian caption glyph bounds, and Monitor-to-export parity.

### Verification on this candidate (local, Windows)

- `export-semantics.spec.ts`: 2/2 passed, first attempt, zero retries.
- `editor-acceptance.spec.ts` (packaged editor import, play, save, restart, export; cancellation; all presets; 150% scaling; Monitor-to-export samples): 5/5 passed, first attempt.
- Consumer suites (`packages/export-core`, `apps/api`, `apps/worker`, `tooling/golden-render`): 682 passed, 4 skipped, 0 failed.
- `packages/export-core` and `packages/renderer-pixi`: 40 passed.
- Prettier and ESLint clean on the changed files.

The full CLI suite was last run on the commit before these changes and was not re-run on this tree (no CLI source changed after it).

---

### Candidate and approvals

- **Candidate commit:** `1482aa7b13afde7b5d35b661b1029ba42454404e`, pushed to the branch `hadimoti/joy-v102-rc`. No PR is open.
- **Candidate CI run:** `release-candidate-v2` run `39644275784` on that commit. Checked 2026-10-21 (server time 18:17Z), the run is still in progress.
  - Completed and passed (10 of 11 jobs): `validate-candidate`, `windows-p0-real-services`, `node-contracts (Node 22.17.0)`, `node-contracts (Node 24)`, `prod-build-smoke (shipped bundle, public UI)`, `editor-web-bundle (standard hosted Linux)`, `linux-real-services (pass 1)`, `linux-real-services (pass 2)`, `p3-real-services (pass 1)`, `p3-real-services (pass 2)`.
  - In progress: `windows-worker-clean (two exact passes)` on runner `joy-media-worker-docker`. Its steps so far (checkout, renderer artifact, bundle verification, clean Worker host check, frozen install, Chromium and Electron install) passed. It is building the frozen Windows desktop, CLI and Worker candidate. The step `Exercise Worker and installed desktop lifecycle in two exact passes` has not started.
  - Not yet known: the exact-candidate two-pass gate receipt and the Windows installed-lifecycle result. Neither is recorded as passed.
- **CLI readiness:** the owner approved the CLI as ready for the v1.0.2 candidate. Desktop rows are reported as the matrix shows them.
- **Release:** none. This candidate is documented only. Release, deploy and publish need a separate owner approval.

### Readiness status (see `docs/qa/READINESS-MATRIX.md`)

| Area                                                | Status                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `desktop.worker-jobs`                               | **NOT SUPPORTED** for this release (dispatch and completion not implemented)                                  |
| `desktop.update-and-rollback`                       | **NOT SUPPORTED** for public distribution; owner-approved manual install is the workaround                    |
| `desktop.account-connection`                        | **LIMITED** (partial coverage; synthetic accounts only)                                                       |
| `desktop.file-project-package`                      | Partial: packaged export and fresh-profile import pass; cross-device, relink and malformed-package cases open |
| `desktop.menu-actions`                              | Partial: File and Edit menus, focus and axe scans pass; other menu actions open                               |
| `desktop.timeline-and-panels`                       | Partial: panel tabs reachable with axe scan passing; timeline edit depth, effect and transition coverage open |
| `desktop.export-media-semantics`                    | Passes its acceptance spec (picture, sound, timing, caption, Monitor/export parity); deeper parity still open |
| `project.persistence.fresh-process` (packaged case) | Open: the gate-required packaged case needs the SQLite-backed open/save proof                                 |
| `desktop.windows.installed-lifecycle`               | Open: unrun locally; runs in the release workflow's Windows Docker container lane                             |
| `release.exact-candidate-two-pass`                  | Open: result pending from run `39644275784`                                                                   |

### Path to full readiness (not yet done)

- **Gate:** the `windows-worker-clean` lane must finish with two passes on the frozen head. The gate result and the installed-lifecycle result must both pass with zero retries. Any failure must be diagnosed from its job log first.
- **Installed lifecycle:** the generated setup still writes the user PATH, uninstall registry key and shortcuts even when given a temporary install path. The test needs a disposable Windows user or VM run, and the setup must be made clean for it.
- **Release-gate evidence:** `tooling/release/src/readiness-evidence.ts` and `create-readiness-evidence.mjs` must derive scenario results from the real run artifacts, not mark them passed. Only then can the desktop rows be made required. This change needs owner approval.
- **File-project package:** verified locally: cross-device round trip, collision, malformed-package rejection, and the Missing media relink flow (exact relink with restart persistence, mismatch refusal, Use different file with undo, cancellation). Still open: batch relink end-to-end, render or export after relink and override, and persistence of an override across a restart.
- **Menu actions:** File (account, projects, media export, sign out), Edit (undo, redo, delete, duplicate, command palette, asset folder), clip split, Joy Code, view and fullscreen, and window controls each need a packaged test.
- **Timeline and panels:** timeline edit depth, each panel's function (not only reachability), effects and transitions, and keyboard coverage need packaged tests.
- **Project persistence (fresh process):** the packaged case needs a scenario result that the gate can require.
- **Export parity:** deeper preview-to-export parity beyond the sampled frames, and the Persian caption canonical-face check (currently SETUP_REQUIRED on this host).
- **NOT SUPPORTED:** worker jobs need dispatch and completion implemented and tested. Update and rollback needs signed distribution, which is owner-gated.
- **LIMITED:** account connection needs the real-service acceptance harness with a synthetic account.

### Known gaps in this candidate

- Release-gate scripts (`tooling/release/src/readiness-evidence.ts`) are unchanged. The generator marks every scenario as passed without measuring it, so the new desktop rows are not required by the gate.
- Caption acceptance step 10 refuses with SETUP_REQUIRED on this host. The owner accepted that refusal on 2026-10-20.

---

### Downloads & Assets

None yet. Checksums and CI receipts will be added only after a frozen candidate passes the two-pass gate and the owner approves release.
