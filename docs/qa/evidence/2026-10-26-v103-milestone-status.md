# JOY Media v1.0.3: milestone status, 2026-10-26

Not a release receipt. Nothing here merges into `main`, changes the release gate, deploys, or publishes a
release. Development CI runs on the feature branch only.

## Development CI

- Final head of the sandbox-lifecycle round: `64531d2e`, run `40238451437`
  (https://github.com/hadimoti/joy-media/actions/runs/40238451437): **success**, 6 of 6 jobs:
  static and unit/integration, browser desktop-compact, browser desktop-minimum, browser desktop-primary
  full, the Worker package build and self-test, and the development verification summary.
- The earlier run `40238191399` at `0420ced4` was cancelled by the concurrency group when `64531d2e` was
  pushed. It was not a failure.

## Installer milestone (Windows Sandbox, candidate built from `98505dfa` with the guest from `0420ced4`)

Evidence: [2026-10-26-windows-sandbox-lifecycle.md](2026-10-26-windows-sandbox-lifecycle.md).

- **Verified:** installation and upgrade from v1.0.1 to the candidate (installed-file SHA-256 match, shortcuts,
  registry, both CLI launchers in a fresh shell, PATH holds only `bin`). Sequence A 19 of 19, Sequence B 8 of 8.
- **Verified:** repair (a deleted renderer file is restored from the candidate) and uninstall (install folder,
  uninstall key, shortcuts and PATH entries removed).
- **Verified:** rollback to v1.0.1 as candidate uninstall followed by the previous setup. The previous setup
  cannot remove the `bin` PATH entry it does not know, so the candidate uninstall removes it first.
- **Not yet built (L1):** a true kept-previous rollback, which keeps the previous version on disk and swaps
  folders, and protected user-data restoration from a pre-update snapshot.
- **Scope of the Sandbox evidence:** the candidate that was tested does not include the app changes listed
  below. A new candidate needs a new Sandbox run before any release claim.

## L3: Persian captions in the canonical face

- Commit `69633e07`. Desktop captions now draw in the bundled Noto Sans Arabic face. The editor registers the
  WOFF2 only after its SHA-256 matches the manifest, under the family `JOY Caption Face`. Export waits for the
  registration and fails when it is missing.
- Packaged export spec (`tests/desktop/export-semantics.spec.ts`), unpacked build: **2 of 2 passed**. The caption
  case measured the caption face against two controls, drawn in the renderer:
  - differing pixels, caption face against a family nobody registers: 1370 (threshold 64);
  - differing pixels, caption face against Arial: 1378 (threshold 64);
  - glyph mismatch of the export against the caption-face reference: 0 (tolerance 0.2);
  - glyph mismatch against the Arial control: 0.54 (must exceed 0.2);
  - reversed word order: 0.46 (must exceed 0.2).
- CLI pinned pixel probe (`caption-face-pixels.reference.json`, FFmpeg `n8.1.3-20260922`): 16 of 16 tests pass.
- The lifecycle (`tests/desktop/windows-lifecycle.ps1`) no longer requires `arial.ttf`. It checks the installed
  WOFF2 and the libass TTF against their pinned manifests. The same logic ran against the standalone build:
  both faces match, and a wrong digest is refused. **The full Windows lifecycle has not run with this check.**

## L6: menu and keyboard coverage

- Commit `b42a284f`. The ledger's 24 open entries are all exercised by packaged tests that perform the action and
  check its effect. The ledger test in strict mode (`JOY_MEDIA_L6_RELEASE=1`) passes with 0 open items (8 of 8).
- `tests/desktop/keyboard-shortcuts.spec.ts`: all 15 shortcut actions, 1 test, 16 steps, passed.
- `tests/desktop/menu-actions.spec.ts`: File > Export (rendered MP4, ffprobe accepted), Clip > Split at Playhead,
  Joy Code > Execution Mode and Settings, Joy Code > Pause / Stop (withdraws a staged proposal), Window >
  Minimize, Zoom / Maximize and Close Window. 8 tests, all passed.
- `tests/desktop/menu-panels.spec.ts`: Window > Focus items activate their panel in the focused dock group.
- **No application defect was reproduced by these tests.** One UX gap is recorded for a decision: Joy Code >
  Pause / Stop is always enabled, and with no run in progress it does nothing and shows nothing.

## L7b: Worker capabilities

- Commit `2500fe3c`. The image upscaling model is ready only when its file's SHA-256 equals
  `JOY_MEDIA_REAL_ESRGAN_MODEL_SHA256`. A missing, malformed or wrong pin, and a file swapped after pinning, are
  refused. Tests: 3 of 3 in `apps/worker/src/local-upscaling.test.ts`.
- **Not done:** dispatch of `render.export` and `upscale.image` through the desktop orchestrator. Both need a job
  payload that the submit path does not carry, so enabling them now would queue jobs that always fail. This needs
  a design decision on payload storage before it is built.

## L1: signed release manifests (development keys)

- Commit `4b0d72e3`. The verifier checks an Ed25519 signature over the manifest's exact bytes, accepts several
  pinned keys for rotation, and fails closed with no pinned key. Tests: 7 of 7. The signing tool signs and verifies
  with a key named at run time and embeds none. Tests: 4 of 4.
- **Not done:** nothing in the app calls the verifier yet, the release key is not compiled in, and the `update`
  commands and installer changes are not built. The owner's production key was not generated or read.

## GPU diagnosis (L2, session G1 and G2)

- Read-only inventory (`tooling/diagnostics/src/gpu-inventory.ts`) and redactor (`redact-gpu-report.ts`) exist from
  earlier work.
- The launch-loop harness for the 30-launch receipt is **not built**. The plan makes G2 an attended session on the
  RTX 5070 Ti, so it was not run unattended. The default GPU path crashes on this host, per the 2026-10-24 note.

## Remaining tracks

- L1: wire the verifier into the update check, compile in the pinned release key, build the kept-previous rollback
  and protected-data restoration, then Sandbox-verify the new installer.
- L7b: payload plumbing for export and upscale dispatch.
- L2: the attended GPU session and the launch-loop harness.
- L10: the single fast pipeline, which needs the owner's approvals D17 to D23.
