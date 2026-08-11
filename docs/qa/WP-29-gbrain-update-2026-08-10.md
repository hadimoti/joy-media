---
title: JOY Media WP-29 first-project golden path reliability update
type: project-update
effective_date: 2026-08-10
tags:
  - joy-media
  - wp-29
  - reliability
  - export
  - browser
status: ready-for-deployment
---

# JOY Media WP-29 — 2026-08-10 update

## Delivered in the first reliability slice

- Unified project-media resolution now uses integrity-verified OPFS bytes first,
  then the owner-authorized private-original API, and only allowlisted bundled
  reference media as a final fallback.
- Imported asset metadata (kind, MIME, duration, dimensions, byte count, and
  SHA-256) persists in the creative document. Timeline drops and library
  placement preserve the real descriptor instead of inventing an opaque ID or
  hardcoding five seconds.
- Program Monitor, transcription, audio preparation, and export share the same
  resolver. Still images are decoded into hold frames for timeline export.
- Browser export now derives its duration from content bounds, records one
  authored offline audio mix, stages completed MP4 bytes in bounded OPFS,
  preflights codec/storage availability, supports cancellation, and offers a
  retryable history entry with the same operation ID.
- Audio Studio reports actual worker/provider availability and exposes the
  worker-independent Browser DSP path only when it can execute honestly.
- Worker audio jobs fail closed when the selected asset is unavailable; runtime
  errors become terminal failures, keepalive presence is refreshed, and pairing
  polling no longer requires a manual Worker restart.
- A project-scoped operation ledger now records logical IDs, fingerprints,
  revisions, attempts, terminal status, and result/error references; purge
  removes the project's records. Snapshot recovery warnings are surfaced to
  the user.
- Generated browser fixtures now include PNG/JPEG, H.264/AAC MP4, WAV, MP3,
  SRT, WebVTT, invalid, and corrupt inputs with checksum and descriptor
  metadata.
- Playwright/Axe smoke now runs at all three required viewports and passes the
  authenticated project lifecycle and authorized MP4 round-trip checks, plus
  the login safety envelope with no page errors, console errors, horizontal
  overflow, or Axe violations.
- The signed-in live JOY tab was checked after deployment: the project action
  menu is visible and keyboard-dismissible at all three viewports, and Audio
  Studio runtime cards remain equal at `40.9018px` with no horizontal overflow
  or warning/error logs. No destructive live action was submitted.

## Verification

- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm format:check`: pass after the isolated 81-file baseline commit
- focused export/resolver/audio tests: pass (19 tests; one expected environment-gated
  skip for the unprovisioned RNNoise model)
- full suite: 235 test files; 1,727 tests passed; two expected environment-gated
  skips for provisioned RNNoise/Whisper integrations
- `pnpm build` and production audit: pass
- `pnpm test:e2e`: pass (three Playwright projects at 1639×1066, 1366×768,
  and 1024×768)
- The repository-wide Prettier check is green; formatting is isolated in its
  own mechanical commit.

## Historical remaining gate (superseded)

WP-29 remains in progress. The next gate is the authenticated golden path and
the 37 previously un-run Chrome scenarios. Real Worker audio result insertion
after approval, browser-level post-encode verification, controlled playback
metrics, and live disposable-project evidence remain open. The browser export
attempt currently blocks on 1080×1920 GPU readback stalls; no open item is
silently reported as a pass.

## Historical slice deployment evidence

- Candidate: `ccdb031` pushed to `origin/main`.
- API release: `/opt/joy-media/releases/ccdb031-wp29-closeout-api`.
- Editor release: `/opt/joy-media/releases/editor-web-20260810-ccdb031-wp29-closeout`.
- Rollback releases retained: `e02f646-wp29-reliability-api` and
  `editor-web-20260810-035553-e02f646-wp29-reliability`.
- Database backup: `/opt/joy-media/data/backups/joymedia-pre-ccdb031-20260810T052857Z.sql.gz`.
- Post-cutover local health, public index hash parity, and `nginx -t` passed;
  authenticated API health remains protected as expected.
- GBrain pages `joy-media-state` and
  `joy-media-wp29-first-project-golden-path` were refreshed and verified;
  the companion `hadimoti/gbrain` commit is `760972a`.

## Safety and deployment

No credentials, tokens, private object paths, or personal file paths belong in
the project documents or browser state. Production deployment must use the
immutable API/editor release pattern and preserve the prior release as the
rollback target.

## Playback and timeline update — 2026-08-11

- `6d4db05` removed a redundant full-workspace render from each presented video
  frame. Three accepted desktop reruns measured 0.79%, 0.37%, and 1.33% drops,
  with p95 drift at or below 32 ms, maximum drift at or below 40 ms, and no
  stall. The R4 normal-play reference-host gate is now PASS.
- `1fce9c1` added true native-EOF loop playback and a generation guard that
  makes Space pause authoritative over pending asynchronous media work. Chrome
  verified a full 115.966633-second EOF wrap, a stable Space pause, and resume.
- `8567f3e` made Fit and the ruler use authored content bounds, added
  arbitrary-length sub-5 px/s fitting, paged playback following, sticky track
  controls, terminal padding, and Dual Lens duration parity.
- The current immutable frontend is
  `editor-web-20260811-013623-8567f3e-timeline-fit-follow`. The editor suite,
  focused tests, typecheck, production build, `nginx -t`, HTTP smoke, and
  signed-in Chrome acceptance passed.

WP-29 remains `in-progress`. The accepted playback/Fit work does not replace
the still-open R2 UI pairing/undo-redo, export-recovery, and R5 browser-case
evidence gates.

## Pre-deploy closeout checkpoint — 2026-08-11

The remaining-gate statements above describe earlier slices and are now
superseded. The reviewed pre-deploy candidate has the following accepted
evidence:

- `pnpm verify:ci`: PASS — 259 test files and 1,851 tests passed; one file and
  two named integration tests skipped; builds and production audit passed.
- R2 Worker insertion: 3/3 in installed Google Chrome, with complementary
  retained licensed real-Worker DSP bytes.
- R3 export/audio: 3/3 authenticated H.264/AAC browser exports. The retained
  duration/audio proof measured 3.013 s for a 3.000 s source (13,000 µs below
  the 33,334 µs tolerance), audible/gain-0.25/mute means of
  -21.1/-33.2/-91.0 dB, and a 12.1 dB gain-direction change.
- R4 playback: three accepted performance runs at 0.79%, 0.37%, and 1.33% drops,
  plus accepted EOF loop, Space pause/resume, Fit, and paged-follow behavior.
- Export recovery: 3/3 in installed Google Chrome for interruption, retry,
  cancel, reload, and durable re-download.
- R5: 108 direct installed-Chrome instances plus three reconciled R2 CASE-66
  instances, for 111/111 and all 37 former `NOT-RUN` cases closed.

The releases listed in the historical deployment section remain the currently
recorded live baseline. The final closeout SHA, immutable API/editor release
names, signed-in live cleanup evidence, and companion GBrain commit are
**PENDING**. This file is prepared as the GBrain handoff source; it does not
claim that the final candidate has been deployed or that GBrain has already
been updated.
