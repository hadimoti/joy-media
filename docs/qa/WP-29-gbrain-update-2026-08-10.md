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
status: in-progress
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
  login safety envelope with no page errors, console errors, horizontal
  overflow, or Axe violations.
- The signed-in live JOY tab was checked after deployment: the project action
  menu is visible and keyboard-dismissible at all three viewports, and Audio
  Studio runtime cards remain equal at `40.9018px` with no horizontal overflow
  or warning/error logs. No destructive live action was submitted.

## Verification

- `pnpm typecheck`: pass
- `pnpm lint`: pass
- focused export/resolver/audio tests: pass (19 tests; one expected environment-gated
  skip for the unprovisioned RNNoise model)
- full suite: 232 test files; 1,722 tests passed; two expected environment-gated
  skips for provisioned RNNoise/Whisper integrations
- `pnpm build` and production audit: pass
- `pnpm test:e2e`: pass (three Playwright projects at 1639×1066, 1366×768,
  and 1024×768)
- The repository-wide Prettier check still reports the existing formatting
  baseline in untouched files; no bulk reformat was applied.

## Remaining gate

WP-29 remains in progress. The next gate is the authenticated golden path and
the 37 previously un-run Chrome scenarios. Real Worker audio result insertion
after approval, browser-level post-encode verification, controlled playback
metrics, and live disposable-project evidence remain open. The exact outcome is
recorded in `gpt-chrome-usage-audit-20260810-wp29.md`; no open item is silently
reported as a pass.

## Safety and deployment

No credentials, tokens, private object paths, or personal file paths belong in
the project documents or browser state. Production deployment must use the
immutable API/editor release pattern and preserve the prior release as the
rollback target.
