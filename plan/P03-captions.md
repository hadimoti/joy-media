# P03 — Captions and Transcript-First Editing

**Status:** done* (2026-07-23) · Manual captions + live Whisper API with fixture fallback · See [WP-20](WP-20-caption-fixtures.md) / [WP-23](WP-23-live-provider-residuals.md) · **Gate to enter:** owner authorized early start · **Master plan:** §36 Phase 3, §39 items 51–61, §20.5, §2.7, §33.4
**Goal:** captions become a first-class reason to use JOY — structured language data, Persian/RTL first-class, transcription as a replaceable adapter.

**Decisions needed:** Q7 (Persian quality benchmarks), Q12 (brand kit draft).

## Work packages

- [x] **WP-03.1 — Caption core.** `captions-core` document/word/segment/speaker schemas; caption track timeline integration; caption layout → Render IR nodes. _(§39-51,52,55)_
- [x] **WP-03.2 — Editing surfaces.** Transcript/caption panel; manual timing/text editing that preserves source tokens; search; confidence warnings; transcript↔timeline selection primitives. _(§39-53, §20.5)_
- [x] **WP-03.3 — Interchange + styling.** SRT/WebVTT import/export; schema-driven caption style registry; safe-area/responsive line layout; ≥3 original JOY caption templates; active-word karaoke animation. _(§39-54,56,57)_
- [x] **WP-03.4 — Persian/RTL fixtures** _(done 2026-07-19)_. Versioned mixed-script, RTL, emoji, and long-text Persian fixtures run through the shared templated layout into identical preview/headless Render IR frames; tests enforce logical RTL start alignment, safe-area bounds, karaoke span integrity, and no display-text loss. _(§39-58)_
- [x] **WP-03.5 — Local transcription adapter** _(done 2026-07-19)_. Provider manifest/invocation/result contracts and a local Whisper-family executor seam normalize aligned words, speakers, and provenance into a durable `caption.replaceDocument` payload. Missing local models become typed availability errors and leave manual caption editing untouched. _(§39-59…61, §21)_

## Exit criteria (§36 Phase 3)

- [x] Transcribe a reference Persian AND English project locally. _(local adapter normalization + Chrome verification)_
- [x] Edit transcript text/timing without corrupting source tokens. _(durable command/inverse tests)_
- [x] Apply at least three original JOY caption templates. _(template-registry tests)_
- [x] Export burned-in and sidecar captions. _(shared preview/headless Render IR plus SRT/WebVTT tests)_
- [x] Captions stay inside configured safe areas across long/RTL/emoji stress fixtures. _(golden-render tests)_
- [x] Model unavailability does not break manual caption editing. _(typed provider failure and non-blocking panel status)_
