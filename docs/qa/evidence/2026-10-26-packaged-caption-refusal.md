# Packaged caption face: refusal on a corrupted installed face, on this Windows host, 2026-10-26

Scope: development evidence for plan L3, the end-to-end part that earlier evidence did not cover. Earlier evidence tested the
caption probe and the planning chain in-process, from source. This run uses the packaged CLI, from the standalone folder, the
way an installed copy runs it. **Not a gate receipt**: the owner-gated release lifecycle runs the same case in CI.

## What the check does

`tooling/fonts/packaged-caption-refusal.mjs` (Windows only) does this:

1. Hard-links the standalone folder into an empty work folder outside the repository, so the original is never written.
2. Writes a Persian caption project and an empty operations file, shaped like the parity test writes them.
3. Runs the packaged launcher `bin\joy-media.cmd plan prepare` on the project. This is the healthy layout. It must exit 0 and
   write a plan.
4. Replaces the work copy of `noto-sans-arabic-arabic-400-normal.ttf` with random bytes of the same length. The file no longer
   matches its pinned length and digest. It runs the same command again. It must exit 1 with `SETUP_REQUIRED` and kind
   `canonical-caption-face-unavailable`, and it must write no plan.
5. Checks that the original packaged face still matches the digest in the libass manifest.

## Result

| Layout                                           | Exit code | Result                                                                                                                                           |
| ------------------------------------------------ | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| healthy (packaged)                               |         0 | plan written                                                                                                                                     |
| corrupted copy of the Arabic 400 face (packaged) |         1 | `SETUP_REQUIRED`, kind `canonical-caption-face-unavailable`, limitation: the face "does not match its pinned length and digest"; no plan written |

The original packaged face is unchanged. The script's summary is `passed: true`.

## What this does not establish

- It runs on this host, from the standalone folder, not from the installed Start-menu layout. The Windows Sandbox guest could add an
  installed-layout run; the owner-gated release lifecycle is the gate receipt.
- It covers one face (Arabic, weight 400). The Arabic 700 face and the Latin faces are not corrupted here.
- The caption render itself is covered by `render-parity.e2e.test.ts` (2 of 2 on this host, with the lifecycle's variable set).

## Reproduction

```bash
node tooling/fonts/packaged-caption-refusal.mjs --packaged <standalone folder> --ffmpeg <ffmpeg.exe> --ffprobe <ffprobe.exe> --source packages/test-fixtures/media/readiness-hard-cut.mkv --work <empty folder outside the repository>
```
