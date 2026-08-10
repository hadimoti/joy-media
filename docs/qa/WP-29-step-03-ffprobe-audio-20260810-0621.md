# WP-29 STEP-03 — Browser FFprobe and Audio Proof

Run ID: `wp29-closeout-20260810-0621`  
Starting commit: `f436acd78e9a`

## Report

- Status: BLOCKED
- Three fresh primary-viewport browser downloads completed, but the independent
  H.264/AAC codec gate failed consistently.
- Product changes: none in STEP-03.
- Production mutation: none.

## Independent evidence

The authenticated runner registered the download listener before Export, saved
each file with mode 0600, and recorded one download per fresh run. Independent
`ffprobe` and FFmpeg `volumedetect` were run after each download.

| Evidence basename                                              |  Bytes | SHA-256                                                            | Video | Audio | Dimensions | Rate |    Duration |     Mean |
| -------------------------------------------------------------- | -----: | ------------------------------------------------------------------ | ----- | ----- | ---------- | ---: | ----------: | -------: |
| `wp29-export-1786360449513-joy-media-export-1786360437401.mp4` | 149236 | `cff088de3e04148808b041c822338fa584a94791016f5248f55e16cfd6416a7f` | VP9   | Opus  | 1080x1920  |   30 | 11.536367 s | -21.1 dB |
| `wp29-export-1786360491612-joy-media-export-1786360479384.mp4` | 149236 | `f21ff65094a475c17ac70b5491027ae3f5b7f537cd94ef7f4dfb7cf5f804bde8` | VP9   | Opus  | 1080x1920  |   30 | 11.814833 s | -21.1 dB |
| `wp29-export-1786360532253-joy-media-export-1786360520065.mp4` | 149236 | `507cf569ba8525731b757b325b3681bac535b93e19b96d5b4ff41fa5f247d61b` | VP9   | Opus  | 1080x1920  |   30 | 11.788833 s | -21.1 dB |

Each file had exactly one video and one audio stream. The audio is non-silent,
but the required H.264/AAC assertion fails: generic `video/mp4` produces
VP9/Opus in this Chrome. The exact `avc1.42E01E,mp4a.40.2` candidate is
unsupported.

## Classification and cleanup

Reproducible **BLOCKED-CAPABILITY**, ratio 0/3 H.264/AAC passes. No WebM fallback
or codec substitution is a PASS. Muted and gain-direction variants were not
run after the required codec gate failed. Disposable projects were purged,
browsers closed, and isolated listeners stopped. Reports contain basenames only.

## Next step

Remain on STEP-03. Add a browser-compatible H.264/AAC remux or verified export
handoff, then rerun this exact three-file FFprobe gate before STEP-04.
