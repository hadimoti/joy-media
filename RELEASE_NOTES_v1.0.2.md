# JOY Media v1.0.2

**Released 2026-10-25** from commit `7f2b826ded19aa1cffc35b04ede3fc5159480a9d` (tag `v1.0.2`), which passed the exact-candidate two-pass release gate on its first attempt: `release-candidate-v2` run `40148387453`, all 18 jobs, 17 of 17 gate checks. The files attached to this release are the build output of that exact commit. This release is not deployed to any production service.

---

### Important Notice for Windows Users (Unsigned Installer)

The Windows installer and portable package are **unsigned**. SmartScreen will warn on first launch. Installing this unsigned build is a manual step. There is no automatic update or rollback (see the known gaps).

---

### Changes since v1.0.1

This release is 339 commits after v1.0.1. The user-visible changes are:

**Desktop**

- **Local Windows Worker route.** The desktop starts a local Worker over a loopback job API, with an editor-to-Worker media bridge. Jobs can be dispatched, observed, cancelled and recovered after a crash or restart (status: Limited, see below).
- **Missing Media.** A new section lists media the project cannot find. It verifies replacement media before relinking, relinks single files or batches by content, and supports an override with undo.
- **GPU fallback.** If the GPU process fast-fails on first use, the app relaunches once with the Media Foundation video encoder turned off. Normal launches keep hardware encoding.
- **Export.**
  - Colours are self-consistent under the BT.709 tags. Chromium's recorder converts with BT.601 but tags BT.709, so the remux now decodes with BT.601 and encodes with an explicit BT.709 matrix. Pure blue no longer exports as (0,14,255).
  - Captured frames keep their authored index. Irregular recorder timestamps used to shift every frame from frame 30 onward by one.
  - The audio track is always 48 kHz AAC. Before, it followed the recording machine's audio device (44.1 kHz on a machine with no 48 kHz device).
  - A silent video exports, and a video with audio keeps its sound.
- **Editor.** A Joy Code tab close control. The View menu toggles full screen, and the Program Monitor full-screen control works.
- **Security hardening.** The editor checks the owner's project scope before each project-bound request, including long operations, the Asset Library, the Jobs panel and uploads, and it uses only the token it was probed with.
- Local AI model features are labelled experimental for this release.

**CLI**

- Usage errors (unknown commands, sub-commands and actions) exit 2 in text and `--json` modes, with `{type, code, message}` under `--json`. Runtime failures exit 1. Help and unknown-command errors are machine-readable under `--json`.
- A failed preview publish is a structured error and leaves no staged file.
- A Windows configuration directory that its ACL hides from `stat` is repaired.

**Dependencies**: advisories in zod, undici and nodemailer are patched.

---

### Verification

- **Gate:** `release-candidate-v2` run `40148387453` on the exact SHA. All 18 jobs succeeded on attempt 1, with retries disabled. `gate-summary` reported 17 of 17 checks passed: `command-health`, `source-provenance`, `readiness-evidence`, `tests` (6,355 collected, 0 failed), `generated-artifacts`, `fixture-registries`, `deployment-manifests`, `builds`, `static-assets`, `font-assets`, `manifest`, `sbom`, `browser-journey`, `performance-evidence`, `operational-evidence`, `windows-acceptance` and `feature-status`.
- **Windows:** the installed lifecycle ran in two exact passes in the Windows Docker container (install, update, repair, rollback, app and CLI checks, uninstall), together with the packaged editor, export, fresh-process persistence and CLI render acceptances.
- **Release files:** the gate re-hashed the Windows release files against `SHA256SUMS.txt`, the manifest and both Windows receipts, and the readiness builder checked their bytes.
- **Independent review:** claude-sonnet-5-5 at high effort, read-only. No blocker and no code-level major finding.
- **Where the receipts live:** the readiness evidence and gate report are in the acceptance runner's durable evidence store. The Windows release files travelled to the gate as a one-day CI artifact, so the unsigned candidate binaries were downloadable from the run page for one day. The owner accepted that.

The readiness matrix (`docs/qa/READINESS-MATRIX.md`) has the per-scenario detail and the evidence trail.

---

### Known gaps and limits

- **Unsigned; no update path.** `desktop.update-and-rollback` is NOT SUPPORTED. The workaround is an owner-approved manual install of a newer unsigned package.
- **GPU fallback.** On a machine whose GPU process fast-fails (seen on an NVIDIA GeForce RTX 5070 Ti with driver 617.42), the app restarts once, and work in progress in the first session is lost. The root cause is not established, and the hardware-encode path is not qualified on that machine.
- **Persian captions through the canonical font.** The canonical Noto Sans Arabic face is a WOFF2 file, and no Windows FFmpeg build tested can open it. The CLI refuses captions that need it with `SETUP_REQUIRED` instead of rendering them wrongly. The release gate accepts that refusal and asserts it exactly. The owner accepted the refusal on 2026-10-20 for the P0 caption step, and this candidate applies the same acceptance to the lifecycle case. The packaged desktop export is checked with Windows Arial, not the canonical face.
- **Optional frame count.** The export remux route takes an optional `x-joy-frame-count` header. Without it the recorder's timestamps are kept, and a jittered capture can duplicate a frame. No production path omits the header. Making it mandatory is planned for the next API revision.
- **Disk exhaustion.** Physical full-disk behaviour is not qualified (owner decision, 2026-10-23). SQLite failure and recovery tests pass. Publishing into a file another process holds is not covered by a controlled Windows test yet.
- **Partial desktop coverage.** Menu actions, timeline edit depth, effects and transitions, broad keyboard coverage and batch-relink follow-ups are Partial in the matrix. Account connection is Limited and was verified with synthetic accounts only. Worker jobs are Limited, and `cli.worker` is excluded from this release as experimental because real model output is not qualified.
- **Runtime contract (CLI).** The shipped CLI runs only on Electron's bundled Node runtime. `joy-media.cmd` sets `ELECTRON_RUN_AS_NODE=1` and runs `joy-media.exe` with `resources\app\cli\joy-media-bundle.mjs`. With no Node on PATH, `joy-media.cmd --version` prints `JOY Media CLI v1.0.2` and exits 0. Arbitrary system Node versions are outside the supported runtime.

---

### Downloads & Assets

The files attached to this release are the build output of the tagged commit. Their digests are in `SHA256SUMS.txt`, which the release gate verified:

| File                               | SHA-256                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `joy-media-setup.exe`              | `6d8089467afaecc1d78d272f5c029d6c186a81f7aac90a7cd584045e847bdabe` |
| `joy-media-windows-x64-v1.0.2.zip` | `e59ee15f2f881cd6620ad59e9f1d9fdc4f9b82efaf221f4e6041c079978d59ca` |
| `joy-media.exe`                    | `e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80` |
| `joy-media-bundle.mjs`             | `7dad525c6764601634918bc6a60e7f390b644b9f76912ef4c9c2e4aa9548fb3e` |
| `joy-worker.exe`                   | `ddefa4075a4e3403f3e093630da2ec9df310459706eb8ea09cc16033ab2ab0f7` |
