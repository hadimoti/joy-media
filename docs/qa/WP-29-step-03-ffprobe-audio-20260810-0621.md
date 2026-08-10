# WP-29 STEP-03 - Browser FFprobe and Audio Proof

Run ID: `wp29-closeout-20260810-0621`
Implementation commit: pending (server remux handoff)

## Report

- Status: PASS
- Three fresh authenticated 1080x1920 browser exports completed with exactly one
  download each.
- The browser's generic `video/mp4` recorder output is VP9/Opus on Chrome 151;
  the authenticated API remux handoff converts it to the required H.264/AAC
  artifact before the single download.
- No production or database mutation was made. Disposable projects were cleaned
  up and isolated listeners were stopped.

## Independent FFprobe evidence

Each artifact was saved with mode 0600 and independently probed after download.
Every file contains exactly one video stream and one audio stream.

| Evidence basename | Bytes | SHA-256 | Video | Audio | Dimensions | Rate | Duration |
| --- | ---: | --- | --- | --- | --- | ---: | ---: |
| `wp29-export-1786366135566-joy-media-export-1786366120573.mp4` | 108781 | `24fb3725df77afb7a768560dac7428379421deab2e038143289192e5a6473774` | H.264 | AAC | 1080x1920 | 30 | 12.566667 s |
| `wp29-export-1786366245335-joy-media-export-1786366231103.mp4` | 106337 | `4830c309581fc49ba4054961cfe09f13fe22f1248044d03fd0504c3103403a3b` | H.264 | AAC | 1080x1920 | 30 | 11.866667 s |
| `wp29-export-1786366265768-joy-media-export-1786366250485.mp4` | 108213 | `4fa876a12b7f418beebc8884eb79df182a9dadba6baa018e07e6510fef91b385` | H.264 | AAC | 1080x1920 | 30 | 12.600000 s |

The browser-side source remains generic MP4 (VP9/Opus on this host), but the
downloaded result is verified H.264/AAC. The server route also returns codec
headers and is covered by an authenticated HTTP test.

## Implementation and checks

- Added a temp-file-safe `ffmpeg` remux helper in `@joy-media/export-core`.
- Added owner-authorized `POST /v1/projects/:id/export/remux` with a 512 MiB
  request cap, fixed codec arguments, sanitized failures, and private response
  headers.
- Added the browser client method and changed App export to suppress the first
  download, remux through the bound control-plane project, then trigger exactly
  one final download.
- Focused tests: 32 passing; API, renderer, and editor production builds pass;
  `git diff --check` passes.
- Browser gate: 3/3 accepted; independent FFprobe: 3/3 H.264/AAC.

## Cleanup

Disposable projects, browser contexts, temporary remux files, and owned
listeners were removed/stopped. Evidence contains basenames and no tokens,
passwords, or personal paths.

## Next step

STEP-03 acceptance is closed. Review and commit this implementation, then
proceed to the remaining authenticated 37-case closure and controlled playback
performance runs.
