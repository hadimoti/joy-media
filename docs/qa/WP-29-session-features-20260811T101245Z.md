# WP-29 Session Features and Final Live Closeout

Run ID: `20260811T101245Z`

## Verdict

**PASS — candidate deployed and disposable live state cleaned.** The final
product SHA is `8756325dc1c336385008332f5200c706c0c09954`. The only intentional
limitation is that reverse Program Monitor preview is silent; the UI discloses
this and export includes reversed audio.

## Candidate and CI

- GitHub workflow: [31478310783](https://github.com/hadimoti/joy-media/actions/runs/31478310783)
- Head SHA, `origin/main`, and VPS checkout: `8756325dc1c336385008332f5200c706c0c09954`
- `check`: PASS; `pnpm verify:ci`, 264 test files passed plus one licensed-skip
  file (1,912 tests passed; 2 licensed skips), builds, lint, format, and audit green.
- `browser-e2e`: PASS; full three-viewport audit completed successfully.
- Browser evidence artifact: `playwright-evidence`, 10,857,985 bytes,
  retained by workflow artifact `9097196418`.
- Local session feature matrix: **9/9 PASS** across 1639×1066, 1366×768,
  and 1024×768. The aspect test includes Undo and refresh persistence.
- Candidate editor build: 1,288 transformed modules. Main JavaScript is
  468.65 kB; timeline chunk is 207.34 kB; no asset-policy violation.

## VPS backup and deployment

- Backup: `/opt/joy-media/data/backups/joymedia-20260811-101137.sql.gz`
- Backup SHA-256: `91f4b4e5aba395638988bc4f9f361e22fcab7170b0afe72acd2af962a64978f5`
- Backup readability: `gzip -t` PASS; rclone sync completed.
- API release: `wp29-final-api-20260811T101245Z-8756325`
- Editor release: `editor-web-20260811T101245Z-8756325-wp29-final`
- Previous API rollback: `wp29-final-api-20260811T085300Z-452ac04`
- Previous editor rollback: `editor-web-20260811T085300Z-452ac04-wp29-final`
- `joy-media@api.service`: active, PID `3594360`, `NRestarts=0`, port 8790 listening.
- Direct/public health: PASS; public root HTTP 200; `nginx -t`: PASS.
- Public `index.html` SHA-256: `6b142d9a32dc2b58626afd2e4ee130f171d7ac88736bfa2c587ba61382d6fb4a`
- Public entry JavaScript `/assets/index-0K40MTr-.js` SHA-256:
  `78a2d5bf9cd5f097a8bc8e81e12ab7011657b77bd85af2699cef0f8743ac0595`
- Staged and public hashes match exactly. Disk/inodes remained healthy (68G
  free; 8% inode use).

## Signed-in live verification

Disposable project: `WP-29 final live 20260811T0858Z`.

- Imported committed `video.mp4`; preview initially hydrated from local bytes,
  then reported `full` source during playback. Two 3-second clips were placed.
- Aspect footer exposed Fit, 16:9, 4:3, 3:2, 21:9, 1:1, 9:16, 4:5, 3:4, and 2:3.
  1:1 applied and Undo restored portrait dimensions. After the final deployment,
  16:9 remained `1920 × 1080` and selector state remained 16:9 after refresh.
- Context menu exposed Reverse and Merge; two contiguous clips merged, physical
  two-click drill-in showed child clips and Back, and Back restored the parent.
- Speed tab exposed manual rates, 2×, Reverse, and Ease In/Out/In-Out. Live
  checks observed 2×, the documented silent reverse toast, and a three-segment
  Ease In ramp. Nested duration-changing speed was correctly blocked.
- Fit-to-width metrics: timeline `scrollWidth=clientWidth=1097`, `scrollLeft=0`,
  document overflow `0`.
- Export: one completed H.264 export row named
  `joy-media-export-1786441458973.mp4`, displayed as `0.2 MB`; its download Blob
  link was present. After refresh/reopening Recent processes, the same row and
  Blob download link rehydrated.
- No visible ErrorBoundary or fatal UI state occurred during the live probes.

## Cleanup

- The disposable project was moved to Trash, then permanently deleted by exact
  name confirmation. Trash reported empty afterward.
- Final Projects view contained only the pre-existing `WP-29 remaining audit
1786378792577` and `Local editor project` entries.
- The surviving project and manually uploaded asset were not opened, renamed,
  deleted, or modified. No disposable Worker/job remained.
- The old audit project is pre-existing and intentionally retained; it is not a
  residue of this run.

## Retained evidence and limitations

R2 Worker insertion, R3 FFprobe/audio measurements, R4 playback/EOF/Space/Fit,
export recovery, and R5 37-case closure remain applicable to this candidate as
recorded in their accepted reports. R3 retained proof measures 13,000 µs
duration delta within a 33,334 µs frame tolerance, -21.1 dB audible mean,
-91 dB muted mean, and 12.1 dB gain-direction delta. Reverse preview silence is
intentional and disclosed; exported reversed audio remains required and covered
by retained export proof.

No paid Cloud operation or licensed Worker run was created during this closeout.

## GBrain verification

- `joy-media-state` content hash: `bb2747a74f7be9d835be0b4df10e74319d841a2db5682f9885efa16b7805e1e2`.
- `joy-media-wp29-first-project-golden-path` content hash: `d9f4bd7a4e988b3c3718fa0798730995d92186ec50f90de79adc51953ef66546`.
- Both pages were fetched twice with matching pre-write hashes, written through the MCP page API, re-fetched, and verified with `WP-29 FINISHED`.
- GBrain doctor completed with status `warnings`, health score `90/100`, and no warning checks in the final response. Existing contextual-retrieval and link-resolution advisories are unrelated to this closeout.

## Final documentation workflow rerun

- The first documentation workflow (`31482690590`) passed `check` but exposed
  one strict Playwright locator in the shared R5 harness; no product test or
  live release failed.
- The additive harness repair is `39a52816ba88d561ad7f79e9af5d167e16ff6825`.
  The final workflow `31485527770` passed both `check` and `browser-e2e`:
  135 tests passed and 3 expected tests were skipped across 138 browser cases.
- This test-only repair did not change the deployed product artifacts; the
  deployed product SHA remains `8756325dc1c336385008332f5200c706c0c09954`.
