# WP-23 — Live provider residuals (Whisper, TTS, ComfyUI, denoise, identity)

**Status:** done 2026-07-23 · **Tip:** `869d6f1` · **Live:** `media.joyteam.ir` web + API `releases/869d6f1`

## Goal

Close the honest residuals after WP-17–22: fixture-only Whisper, sine-stub TTS, mock ComfyUI PNG, byte-copy “denoise”, and confusing unsigned identity 401s — without inventing a Media auth bypass (ADR-0016).

## Defaults used

| Topic          | Choice                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------- |
| Inference host | VPS API for Captions Whisper + edge-tts now (`faster-whisper`, `edge-tts` already on host). |
| Identity       | Fail-closed; unsigned 401 → `signed-out`; no test tokens.                                   |
| ComfyUI        | Real HTTP; fail with `COMFYUI_UNAVAILABLE` when endpoint missing/down.                      |
| Denoise        | Keep browser noise-gate; add ffmpeg `afftdn` spectral path (not ML).                        |

## Exit checklist

- [x] **Whisper helper** — [`apps/api/scripts/whisper_transcribe.py`](../apps/api/scripts/whisper_transcribe.py); models under `/opt/joy-media/data/whisper-models`.
- [x] **API** `POST /v1/providers/speech/transcribe` (auth required) — JSON `{ language, referenceAssetId }` or raw media + `?language=`.
- [x] **Captions** — [`local-transcription.ts`](../apps/editor-web/src/local-transcription.ts) tries live API then FA/EN fixtures.
- [x] **TTS** — `edge-tts` engine in [`adapter-tts`](../packages/adapter-tts); API `POST /v1/providers/speech/synthesize`; workflow speech port drops `__stub`, discloses remote deferral.
- [x] **ComfyUI** — real `/prompt` → `/history` → `/view`; no mock PNG.
- [x] **Denoise** — [`adapter-noise-removal`](../packages/adapter-noise-removal) ffmpeg `afftdn`; API `POST /v1/providers/audio/denoise`; workflow gate vs deferred spectral.
- [x] **Identity UX** — expected unsigned 401 documented; STATE note that `joymedia_allowed` is identity-owner work.

## Honest residuals after WP-23

- Live Whisper/TTS need a JOY Media assertion (unsigned users stay on fixtures).
- No GPU Comfy until `JOY_MEDIA_COMFYUI_URL` / Worker Comfy exists.
- No DeepFilterNet/RNNoise ML denoise — gate + `afftdn` only.
- edge-tts sends text off-device (disclosed in manifest/API).
- `analysis.transcribe` workflow port still stub for sync browser demos (Captions UI is the live path).

## Related

- Plan that drove this slice: Cursor plan `live_provider_residuals_c7ab0a7e`.
- Prior: WP-19 normalize, WP-20 fixtures, WP-22 silence/loudness/gate.
