# A10 export media semantics report

The attended `desktop.export-media-semantics` scenario is wired into `run-scenario.mjs`. It runs the seven required checks: export completion, preset stream layout, duration, decoded frame count, audio presence, three picture comparisons against Monitor captures, and a separate dissolve check. The fake-driver dry run writes a clearly labeled `dry-run.json` and omits the synthetic in-memory receipt, so it cannot be mistaken for live evidence.

The picture comparison scales both frames to 160 pixels wide, then requires luma SSIM of at least **0.90** and mean absolute RGB difference of at most **12 levels on the 0–255 scale**. Both limits must pass, and neither frame may be black. SSIM checks that the same picture remains in the same place; the RGB limit catches color changes that luma SSIM can miss. The tolerances allow small H.264/YUV and color-matrix shifts between an export frame and a Monitor capture. The stream layout check also requires stereo AAC at **48 kHz**, matching the export presets.

## Verification

- `pnpm typecheck`: passed.
- `pnpm exec prettier --check` on all nine changed source and test files: passed.
- `pnpm exec eslint` on all nine changed source and test files: passed.
- Focused post-review suites (`attended-export-semantics.test.ts` and `attended-frame-compare.test.ts`): 56 passed.
- The new 44.1 kHz regression test failed before the implementation change and passed afterward.
- The runner-level fake dry-run CLI test passed earlier in the turn.
- Before the review-driven sample-rate assertion, the complete release suite passed: 710 passed, 4 skipped. The required plain `pnpm exec vitest run tooling/release` invocation cannot load the config in this sandbox (`Cannot read directory "../..": Access is denied`). The `--configLoader runner` workaround passed then. After the final assertion, the complete rerun with temp output redirected into this checkout reported 28 failures, 683 passed, and 4 skipped; the failures were retention tests rejecting their deliberately outside-checkout paths. Using `C:\tmp` instead returned `EPERM` when Vitest created worker folders. I did not use AppData for another full-suite attempt. The focused feature suites passed after the final change.
- No live app run was performed. Committed on branch v111/a10 by Claude Code after review; no push or merge was made by the helper.

## Live run handoff

After the owner is at the PC and gives a yes naming that run, run from the repository root, replacing each placeholder with the selected candidate/build and approved scratch paths/count:

```powershell
node --experimental-strip-types tooling/release/attended/run-scenario.mjs `
  --scenario desktop.export-media-semantics `
  --exe "<unpacked candidate folder>\joy-media.exe" `
  --candidate <40-hex candidate commit> `
  --expected-exe-sha256 <64-hex executable SHA-256> `
  --library "<new scratch library containing catalog.json>" `
  --out "<new empty run folder outside the checkout>" `
  --fixtures "C:\jgp\v111\fixtures" `
  --owner-library-files <owner-approved current file count> `
  --launch
```

Preconditions: the exe must be an unpacked candidate copy, not the installed app; its commit and SHA-256 must match the supplied values; the new run folder and `profile` path must be unused and free of links; both fixtures (`h264-16x9-audio.mp4` and `picture-tiny.png`) must exist in the fixture folder; the scratch library must contain `catalog.json`; port 9339 (or the supplied `--port`) must be free; preflight must find `ffmpeg`, `ffprobe`, and the app database module; and the owner library count must be explicitly approved. The runner guards the owner library and Downloads around the run.

Expected live artifacts include `preflight.json`, a newly seeded `profile`, `export.mp4`, four `preview-frame-*.png` Monitor captures (three picture sample times plus the dissolve midpoint), and `run.json`. `receipt.json` is written only if all required checks and guards pass. A stopped or failed run can write `error.json` or a `run.json` without a receipt. The separate fake mode uses `--dry-run` and writes only `dry-run.json`.

## Still missing or blocked

- The live application scenario remains to be run by Claude Code with the owner's named approval. Other T-A10 matrix and media tasks were outside this continuation's item-1 scope.
- The requested report destination `C:\jgp\v111\cc\a10-report-codex.md` is outside this session's writable root. This local copy is at `a10-report-codex.md` in the worktree.
- The required GBrain start/sync gate failed because Git reported dubious ownership for `C:\Users\HadiMoti\Desktop\gbrain-pc` under identity `CodexSandboxOffline`. No VPS write, export, or receipt publish was attempted; GBrain sync is pending.
- Earlier test runs inherited the OS temp path under AppData before I caught the task restriction; the test harness removed its own transient fixtures. The separate diagnostic folder below remains.
- A test diagnostic directory remains at `C:\Users\HadiMoti\AppData\Local\Temp\codex-a10-cli-debug`; cleanup was blocked by the sandbox. A `.codex-temp` test-output directory also remains in this worktree because the cleanup command was rejected. Both contain test-generated artifacts rather than user project data.
