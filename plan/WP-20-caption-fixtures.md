# WP-20 — Fixture-backed caption transcription

**Status:** superseded in part by [WP-23](WP-23-live-provider-residuals.md) (2026-07-23)

## Original (WP-20)

Captions FA/EN used committed FA/EN word fixtures via `createLocalWhisperProvider` (modelId `fixture-whisper-*-v1`, not `pending`). Manual captions unchanged on provider failure.

## Current (after WP-23)

- **Live path (authenticated):** `BrowserControlPlaneClient.transcribeSpeech` → `POST /v1/providers/speech/transcribe` → `faster-whisper` on the VPS API; provenance `joy.faster-whisper` / `faster-whisper-<model>`.
- **Fallback (unsigned / API down):** same FA/EN fixtures as WP-20 (`fixture-whisper-fa-v1` / `fixture-whisper-en-v1`).
- Fixture JSON under `apps/editor-web/src/fixtures/` remains the reviewable offline source of truth for the fallback path.
