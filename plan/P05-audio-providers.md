# P05 — Audio Studio and Provider Expansion

**Status:** not-started · **Gate to enter:** P02 exit criteria + provider-sdk minimum from WP-03.5 · **Master plan:** §36 Phase 5, §20.6, §21, §29.9
**Goal:** speech-heavy content sounds professional; local/remote AI capabilities unify behind the provider system with privacy and consent enforced.

**Decisions needed:** Q8 (model licenses), Q13 (remote provider scope).

## Work packages

- [ ] **WP-05.1 — Audio studio core.** Mixer/buses/meters, gain/pan/fades/crossfades, EQ/compressor/limiter/gate baseline, loudness/peak analysis, clipping indicators. _(§20.6)_
- [ ] **WP-05.2 — Audio pipeline.** Dialogue normalization, voice-over recording, cached preview stems for offline-only effects, final offline audio graph on Worker. _(§20.6)_
- [ ] **WP-05.3 — Provider system full.** Configuration/health UI, provider lifecycle states, local-vs-remote privacy policies + pre-flight disclosure (§29.8), secrets handling (§21.7), provenance + usage/cost records, provider testing kit (§21.10).
- [ ] **WP-05.4 — Adapters.** ComfyUI adapter with versioned workflow templates (§21.5); noise-removal/voice-isolation adapters; local TTS adapters selected after the Q8 license inventory; optional one remote adapter. _(§21.5, §21.6)_
- [ ] **WP-05.5 — Voice identity + consent.** VoiceIdentity model, enrollment consent flow, visible cloned-voice labeling, revocation/deletion path, synthesis audit. **Product requirement, not legal garnish (§2.14, §29.9).**

## Exit criteria (§36 Phase 5)

- [ ] Switching eligible providers requires zero project-document changes.
- [ ] A local-only project never sends media remotely — proven by automated test.
- [ ] Provider failure/cancel/retry never duplicates inserted assets.
- [ ] Dialogue mix meets configured loudness/peak targets on the reference project.
- [ ] A cloned voice cannot run without an active, allowed consent record.
