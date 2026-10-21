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

### Readiness status (see `docs/qa/READINESS-MATRIX.md`)

| Area                                                                                  | Status                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `desktop.worker-jobs`                                                                 | **NOT SUPPORTED** for this release (dispatch and completion not implemented)               |
| `desktop.update-and-rollback`                                                         | **NOT SUPPORTED** for public distribution; owner-approved manual install is the workaround |
| `desktop.account-connection`                                                          | **LIMITED** (partial coverage; synthetic accounts only)                                    |
| `desktop.file-project-package`, `desktop.menu-actions`, `desktop.timeline-and-panels` | Partial; open                                                                              |
| `project.persistence.fresh-process` (packaged case)                                   | Open                                                                                       |
| `desktop.windows.installed-lifecycle`                                                 | Open (needs a disposable Windows user or VM; unsigned distribution is owner-gated)         |
| `release.exact-candidate-two-pass`                                                    | Open (not run on a frozen candidate; needs an approved `release-candidate-v2` dispatch)    |

### Not yet confirmed

- **Owner confirmation of CLI readiness has not been given.** Only Codex and Claude Sonnet reviews have approved the CLI changes.
- The candidate has not been frozen, committed to a release branch, pushed, or run through `release-candidate-v2`.
- Release-gate scripts (`tooling/release/src/readiness-evidence.ts`) are not updated for the newly accepted desktop rows.

---

### Downloads & Assets

None yet. Checksums and CI receipts will be added only after a frozen candidate passes the two-pass gate and the owner approves release.
