# P05 — Audio Studio and Provider Expansion

**Status:** done* (residuals explicit) · **Gate to enter:** P02 exit criteria + provider-sdk minimum from WP-03.5 · **Master plan:** §36 Phase 5, §20.6, §21, §29.9
**Goal:** speech-heavy content sounds professional; local/remote AI capabilities unify behind the provider system with privacy and consent enforced.

**Decisions needed:** Q8 (model licenses), Q13 (remote provider scope).

## Work packages

- [x] **WP-05.1 — Audio studio core.** Mixer/buses/meters, gain/pan/fades/crossfades, EQ/compressor/limiter/gate baseline, loudness/peak analysis, clipping indicators. _(§20.6)_
- [x] **WP-05.2 — Audio pipeline.** Dialogue normalization, voice-over recording, cached preview stems for offline-only effects, final offline audio graph on Worker. _(§20.6)_
- [x] **WP-05.3 — Provider system full.** Configuration/health UI, provider lifecycle states, local-vs-remote privacy policies + pre-flight disclosure (§29.8), secrets handling (§21.7), provenance + usage/cost records, provider testing kit (§21.10).
- [x] **WP-05.4 — Adapters.** ComfyUI adapter with versioned workflow templates (§21.5); noise-removal/voice-isolation adapters; local TTS adapters selected after the Q8 license inventory; optional one remote adapter. _(§21.5, §21.6)_
- [x] **WP-05.5 — Voice identity + consent.** VoiceIdentity model, enrollment consent flow, visible cloned-voice labeling, revocation/deletion path, synthesis audit. **Product requirement, not legal garnish (§2.14, §29.9).**

## Live wiring (WP-19 / WP-22 / WP-23 — 2026-07-23)

Package-level P05 was marked done earlier; **editor/API live seams** landed later:

| Capability                    | Live status             | Notes                                                                        |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `transform.normalizeAudio`    | Real DSP                | `audio-core.normalizeDialogue` (WP-19)                                       |
| `analysis.silence` / loudness | Real DSP                | `audio-core` browser exports (WP-22)                                         |
| `transform.denoise`           | Real gate + spectral    | Browser `applyGate`; ffmpeg `afftdn` via API/adapter (WP-22/23) — **not** ML |
| Captions `speech.transcribe`  | Live + fixture fallback | `faster-whisper` API; fixtures when unsigned (WP-20/23)                      |
| `generation.speech` / TTS     | Live edge-tts API       | Remote Microsoft Edge TTS; data leaves device (WP-23)                        |
| ComfyUI adapter               | Real HTTP, fail-closed  | No mock PNG; needs Worker endpoint for success (WP-23)                       |

## Exit criteria (§36 Phase 5)

- [x] Switching eligible providers requires zero project-document changes.
- [x] A local-only project never sends media remotely — proven by automated test.
- [x] Provider failure/cancel/retry never duplicates inserted assets.
- [x] Dialogue mix meets configured loudness/peak targets on the reference project.
- [x] A cloned voice cannot run without an active, allowed consent record.

## Open residuals (do not claim done)

- GPU ComfyUI Worker + `JOY_MEDIA_COMFYUI_URL`.
- Local TTS: **Piper** is live (`engine: 'piper'` / `JOY_MEDIA_TTS_ENGINE=piper`); default remains edge-tts.
- ML denoise (DeepFilterNet / RNNoise).
- Signed-in live gate proving Whisper/TTS provenance (needs `joymedia_allowed` on identity owner).
