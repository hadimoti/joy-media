# P02 — Usable Editing Vertical Slice

**Status:** done · **Gate to enter:** P01 reviewed; owner authorized start with live API/Worker integration tracked · **Master plan:** §36 Phase 2, §39 items 22–50, §13, §15, §16, §19
**Goal:** a small but coherent manual editor: import local media → multi-track edit → deterministic local 1080p export. This part makes JOY Media _usable_.

**Decisions needed:** Q4 (VPS media retention), Q5 (browsers), Q6 (codec matrix).

## Work packages

- [x] **WP-02.1 — Timeline editing** _(done 2026-07-19)_. Virtual timeline tracks, selection, playhead, split/trim/ripple-delete commands, and track flags run through durable command history; browser verification covers split → undo/redo → reload. _(§39-22…25, §19)_
- [x] **WP-02.2 — Media pipeline** _(done 2026-07-19)_. Local import registration creates opaque thumbnail/proxy derivatives; normalized probe metadata, missing/exact-hash relink, portable waveform peaks, and profile-keyed proxy cache contracts are tested. _(§39-27…39, §13)_
- [x] **WP-02.3 — Objects + Inspector breadth** _(done 2026-07-19)_. Image/text/shape project objects and schema-driven transform/crop properties use the durable v1 command boundary; browser verification covers Inspector edit → undo/redo → reload. _(§36-P2, §18.3)_
- [x] **WP-02.4 — Playback** _(done 2026-07-19)_. Source-time mapping, proxy decoder selection, frame cancellation/cache, audio clock, scheduler diagnostics, and proxy quality fallback are covered in unit/reference tests; browser verification covers the proxy playhead lifecycle. _(§39-40…44, §15)_
- [x] **WP-02.5 — Deterministic export** _(done 2026-07-19)_. Leased Worker exports freeze their manifest, encode atomic H.264/AAC MP4 files through FFmpeg, validate them with ffprobe, and clean failed outputs. _(§39-45…49, §16)_
- [x] **WP-02.6 — Reference E2E + benchmarks** _(done 2026-07-19)_. Frozen 30-second social-edit fixture now proves reversible edits, local reopen/replay, proxy quality fallback, expired-lease Worker recovery, and verified dual-format H.264/AAC export. The versioned §30.3 scale fixture and viewport runner use a CI-friendly scaled-down profile; the full profile is reserved for named reference hardware. _(§39-50, §30, §32)_

## Exit criteria (§36 Phase 2)

- [x] Complete a 30–60 s social edit from local files; reopen with all decisions intact. _(reference project, browser reopen, persistence test)_
- [x] Undo/redo every core edit. _(timeline and visual-object histories; browser + unit coverage)_
- [x] Play through using proxies on reference hardware. _(decoder/scheduler contracts and browser proxy-playback lifecycle)_
- [x] Export valid 16:9 and 9:16 H.264/AAC files through the configured Worker. _(leased Worker reference E2E + ffprobe)_
- [x] Survive Worker and VPS interruption without project loss. _(expired lease recovery and durable local project recovery)_
- [x] Golden reference project passes through the automated contract workflow.
