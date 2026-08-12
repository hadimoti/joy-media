# WP-30 Final Live Chrome Closeout — 2026-08-12

**Status:** PASS
**Product SHA:** `1b7e8abf27e41d132cda0714c890206400596c41`
**Product CI:** [run 31523239040](https://github.com/hadimoti/joy-media/actions/runs/31523239040) — success
**Chrome run:** `20260812063009`
**Disposable project:** `WP-30 animated export repair 20260812063009`
**Browser:** authenticated Google Chrome extension session at `https://joyst.ir/`
**Viewport:** Chrome default viewport; the three-viewport deterministic matrix is retained from CI.

## Import and preview

- The committed fixture was copied with a run-unique filename:
  `wp30-final-20260812063009.gif`.
- Chrome imported the non-empty `12,552`-byte GIF through the public Import media
  flow and registered it as a User asset (`image/gif`, `12.3 KB`, Cloud original).
- The verified preview opened from the browser's local copy.
- Preview screenshots changed between samples:
  - first: `9934b21ac137210d6e8ee78a98f358987eee6fbcfe1df709c001e0d2e99afcd8`;
  - second: `3fe24c1e659278035c2f04b39e9fd50dab0aef3f80031ff3aff2af5e7c6ccea2`.

## Timeline and monitor

- The public Add to timeline control placed exactly one clip:
  `wp30-final-20260812063009.gif, 1.0s`.
- Program Monitor screenshots changed while the animated source advanced:
  - first: `d85a12aabd69a06c5248baee8b4119ba49a069dcea86b27296c300e244b117ce`;
  - second: `abb19728d43a682fc69bb839dee7b399c115a6e4b2de79796b71c5a1e7515fb2`.
- The monitor footer exposed the aspect-ratio selector with landscape, square,
  and portrait options.

## Chrome export and byte proof

- One export completed and appeared in Recent processes as
  `joy-media-export-1786516321630.mp4`.
- Downloaded file size: `14,260` bytes.
- Download SHA-256:
  `88197C88AE97E1BBDDE9788BE1931492D92CA1EF6E2AC515C6449D7537FA06A8`.
- FFprobe verified:
  - H.264 video;
  - AAC audio;
  - `1080 × 1920` dimensions;
  - `30/1` frame rate;
  - `1.000000` second duration.
- Deterministic `framemd5` decoding produced distinct video frames:
  - frame 0: `d6fe81e6b3032c0baccb324816656bf2`;
  - frame 9: `a4683bba1701218e49ceddf9991c1a88`.

## Recovery and diagnostics

- Refresh preserved the completed Recent-process record and retained download
  link.
- Re-download returned the same `14,260`-byte file and identical SHA-256.
- Final Chrome warning/error diagnostics were empty.

## Cleanup

- The disposable project was moved to Trash and permanently deleted by exact-name
  confirmation.
- Final Trash count was `1`; the pre-existing `Local editor project` item was left
  untouched.
- Run-created downloads and the temporary fixture copy were removed after hashes
  and FFprobe evidence were recorded.
- The surviving project and manually uploaded asset were not changed.

## GBrain verification

- `joy-media-state` was hash-guarded and updated to WP-30 FINISHED; post-write
  hash: `055d00d6cc718b779b4fc1e68440f209e0bf3c9d3c14f0f027b27681668890b4`.
- `joy-media-wp29-first-project-golden-path` was hash-guarded and updated to
  WP-30 FINISHED; post-write hash:
  `713068698070a46c73fef9ca7c7655acaada718b0ff9e7ddfcf275e08001753c`.
- GBrain doctor remained `warnings`, health `90`; no write or connectivity error
  was reported. Existing warnings are unrelated coverage/link-resolution notices.

## Verdict

All remaining WP-30 live Chrome, export, recovery, cleanup, and GBrain gates pass.
The earlier Chrome file-upload permission blocker is closed. WP-30 can be marked
`FINISHED` after the documentation-only closeout commit and its CI pass.
