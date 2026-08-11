# WP-29 STEP-03 - Browser FFprobe and Audio Proof

Run ID: `wp29-closeout-20260810-0621`
Candidate commit: pending final WP-29 closeout SHA; the evidence below was
verified in the pre-deploy working tree based on `10751b1`.

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

| Evidence basename                                              |  Bytes | SHA-256                                                            | Video | Audio | Dimensions | Rate |    Duration |
| -------------------------------------------------------------- | -----: | ------------------------------------------------------------------ | ----- | ----- | ---------- | ---: | ----------: |
| `wp29-export-1786366135566-joy-media-export-1786366120573.mp4` | 108781 | `24fb3725df77afb7a768560dac7428379421deab2e038143289192e5a6473774` | H.264 | AAC   | 1080x1920  |   30 | 12.566667 s |
| `wp29-export-1786366245335-joy-media-export-1786366231103.mp4` | 106337 | `4830c309581fc49ba4054961cfe09f13fe22f1248044d03fd0504c3103403a3b` | H.264 | AAC   | 1080x1920  |   30 | 11.866667 s |
| `wp29-export-1786366265768-joy-media-export-1786366250485.mp4` | 108213 | `4fa876a12b7f418beebc8884eb79df182a9dadba6baa018e07e6510fef91b385` | H.264 | AAC   | 1080x1920  |   30 | 12.600000 s |

The browser-side source remains generic MP4 (VP9/Opus on this host), but the
downloaded result is verified H.264/AAC. The server route also returns codec
headers and is covered by an authenticated HTTP test.

## Retained duration and authored-audio proof

`packages/export-core/src/wp29-step03-proof.test.ts` is a deterministic
integration proof for the measurements that were omitted from the original
browser evidence. It creates three three-second browser-recorder-style
VP9/Opus inputs, passes each through the production `remuxBrowserMp4` path,
validates the result with `verifyExportAgainstManifest`, and independently runs
FFmpeg `volumedetect` on the H.264/AAC output.

| Authored state  | Expected duration | Probed duration | Absolute delta | Mean volume | Max volume |
| --------------- | ----------------: | --------------: | -------------: | ----------: | ---------: |
| Audible, gain 1 |        3.000000 s |      3.013000 s |      13,000 µs |    -21.1 dB |   -16.7 dB |
| Gain 0.25       |        3.000000 s |      3.013000 s |      13,000 µs |    -33.2 dB |   -26.8 dB |
| Muted, gain 0   |        3.000000 s |      3.013000 s |      13,000 µs |    -91.0 dB |   -91.0 dB |

The one-frame tolerance at 30 fps is 33,334 µs, so all three duration deltas
pass. The measured mean-volume change is 12.1 dB in the authored direction;
the expected change for gain 1 to gain 0.25 is 12.041 dB. The muted output is
69.9 dB below the audible mean and retains one decodable AAC stream rather than
removing the audio program.

This proof is retained in the test source and is reproducible without account,
network, or browser state. It supplements the three authenticated browser
downloads above; it does not invent unavailable expected-range metadata for
those historical files.

## Implementation and checks

- Added a temp-file-safe `ffmpeg` remux helper in `@joy-media/export-core`.
- Added owner-authorized `POST /v1/projects/:id/export/remux` with a 512 MiB
  request cap, fixed codec arguments, sanitized failures, and private response
  headers.
- Added the browser client method and changed App export to suppress the first
  download, remux through the bound control-plane project, then trigger exactly
  one final download.
- Original focused tests: 32 passing; API, renderer, and editor production
  builds pass; `git diff --check` passes.
- Retained duration/audio integration proof: 1/1 passing in 541 ms with FFmpeg
  8.1.1 and FFprobe 8.1.1.
- Browser gate: 3/3 accepted; independent FFprobe: 3/3 H.264/AAC; deterministic
  duration, audible, mute, and gain-direction assertions: PASS.

## Cleanup

Disposable projects, browser contexts, temporary remux files, and owned
listeners were removed/stopped. Evidence contains basenames and no tokens,
passwords, or personal paths.

## Next step

STEP-03 acceptance is closed. R2, R4, R5, export recovery, and required CI are
also green; only the final reviewed commit, immutable production deployment,
live cleanup, and GBrain reconciliation remain.
