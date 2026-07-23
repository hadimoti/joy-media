# WP-20 — Fixture-backed caption transcription

**Status:** done 2026-07-23

Captions FA/EN use committed FA/EN word fixtures via `createLocalWhisperProvider` (modelId `fixture-whisper-*-v1`, not `pending`). Manual captions unchanged on provider failure.
