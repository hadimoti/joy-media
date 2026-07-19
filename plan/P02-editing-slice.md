# P02 — Usable Editing Vertical Slice

**Status:** in-progress · **Gate to enter:** P01 reviewed; owner authorized start with live API/Worker integration tracked · **Master plan:** §36 Phase 2, §39 items 22–50, §13, §15, §16, §19
**Goal:** a small but coherent manual editor: import local media → multi-track edit → deterministic local 1080p export. This part makes JOY Media _usable_.

**Decisions needed:** Q4 (VPS media retention), Q5 (browsers), Q6 (codec matrix).

## Work packages

- [ ] **WP-02.1 — Timeline editing.** Ruler/viewport coordinates, virtualized track/clip view, selection/drag-preview/snapping with command commit, zoom/pan/playhead/markers, move/split/trim/ripple-delete, track enable/lock/mute/solo, linked video+audio. _(§39-22…25, §19)_
- [ ] **WP-02.2 — Media pipeline.** Asset record/location/derivative schemas in practice: browser import registration, missing-asset states, ffprobe descriptor normalization, thumbnails, waveform peak format + timeline display, proxy profile/job/cache invalidation, exact-hash relink. _(§39-27…39, §13)_
- [ ] **WP-02.3 — Objects + Inspector breadth.** Image/text/shape clips, position/scale/rotation/opacity/crop, nested compositions, markers; Inspector multi-selection semantics. _(§36-P2, §18.3)_
- [ ] **WP-02.4 — Playback.** Source-time mapping + decoder interface, HTML-media/proxy decode tier, frame request cancellation/cache, audio preview clock + linked playback, scheduler metrics + dropped-frame state, quality governor v0. _(§39-40…44, §15)_
- [ ] **WP-02.5 — Deterministic export.** Worker render job with frozen revision + manifest, headless frame stream → FFmpeg, offline audio mix baseline, encode/mux preset v1 (Q6 matrix), ffprobe validation, atomic output/failure cleanup. _(§39-45…49, §16)_
- [ ] **WP-02.6 — Reference E2E + benchmarks.** Complete reference-project end-to-end test; benchmark fixtures from §30.3 (scaled-down first pass); golden project in `test-fixtures`. _(§39-50, §30, §32)_

## Exit criteria (§36 Phase 2)

- [ ] Complete a 30–60 s social edit from local files; reopen with all decisions intact.
- [ ] Undo/redo every core edit.
- [ ] Play through using proxies on reference hardware.
- [ ] Export valid 16:9 and 9:16 H.264/AAC files through the configured Worker.
- [ ] Survive Worker and VPS interruption without project loss.
- [ ] Golden reference project passes.
