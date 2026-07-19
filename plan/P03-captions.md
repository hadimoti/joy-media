# P03 — Captions and Transcript-First Editing

**Status:** in-progress · **Gate to enter:** owner authorized early start; P02 completion remains tracked · **Master plan:** §36 Phase 3, §39 items 51–61, §20.5, §2.7, §33.4
**Goal:** captions become a first-class reason to use JOY — structured language data, Persian/RTL first-class, transcription as a replaceable adapter.

**Decisions needed:** Q7 (Persian quality benchmarks), Q12 (brand kit draft).

## Work packages

- [x] **WP-03.1 — Caption core.** `captions-core` document/word/segment/speaker schemas; caption track timeline integration; caption layout → Render IR nodes. _(§39-51,52,55)_
- [ ] **WP-03.2 — Editing surfaces.** Transcript/caption panel; manual timing/text editing that preserves source tokens; search; confidence warnings; transcript↔timeline selection primitives. _(§39-53, §20.5)_
- [ ] **WP-03.3 — Interchange + styling.** SRT/WebVTT import/export; schema-driven caption style registry; safe-area/responsive line layout; ≥3 original JOY caption templates; active-word karaoke animation. _(§39-54,56,57)_
- [ ] **WP-03.4 — Persian/RTL fixtures.** Mixed-script, RTL, emoji, long-text stress fixtures rendered in preview AND headless export; right-aligned templates; §33.4 checklist as tests. _(§39-58)_
- [ ] **WP-03.5 — Local transcription adapter.** `provider-sdk` minimum (manifest/capability/result contracts); one local Whisper-family adapter behind `speech.transcribe` via `provider.invoke`; word alignment + speaker metadata when supported; insert-result transaction with provenance. _(§39-59…61, §21)_

## Exit criteria (§36 Phase 3)

- [ ] Transcribe a reference Persian AND English project locally.
- [ ] Edit transcript text/timing without corrupting source tokens.
- [ ] Apply at least three original JOY caption templates.
- [ ] Export burned-in and sidecar captions.
- [ ] Captions stay inside configured safe areas across long/RTL/emoji stress fixtures.
- [ ] Model unavailability does not break manual caption editing.
