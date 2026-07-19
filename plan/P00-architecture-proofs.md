# P00 — Architecture Proofs and Risk Retirement

**Status:** in-progress · **Gate to enter:** none (first part) · **Master plan:** §36 Phase 0, §39 items 1–16 partially, §41.1
**Goal:** prove the hardest boundaries with minimal spikes _before_ building a large UI. Spikes may be throwaway, but their ADRs and golden fixtures are permanent.

## Work packages

Each WP ≈ one session. WP-00.0 first; the seven spikes afterward in any order (00.3 needs 00.1's time utilities).

- [x] **WP-00.0 — Repo bootstrap** _(done 2026-07-19)_. Standalone `joy-media` repo created (Q16 DECIDED); pnpm workspace, strict TypeScript, ESLint+Prettier, Vitest, `pnpm check` script + GitHub Actions CI, package scaffolds ONLY for packages the spikes touch (`project-schema`, `commands`, `evaluator`, `render-ir`, `job-protocol`, `test-fixtures`, `tooling/golden-render`). _(§39-1, §45.2)_
- [x] **WP-00.1 — Time/evaluation spike** _(done 2026-07-19, ADR-0002)_. Integer-`TimeUs` + rational frame-rate utilities with exact BigInt ceil/floor frame mapping (`project-schema/src/time.ts`); spike model with two video clips, source ranges, one nested composition + cycle detection (`model.ts`); pure evaluator with exact NTSC frame evaluation tests (`evaluator/src/evaluate.ts`). 38 tests green. _(§36-P0-1, §10.5)_
- [x] **WP-00.2 — Command spike** _(done 2026-07-19, ADR-0003)_. Discriminated-union commands (insert/remove/move/trimStart/trimEnd/split/join/setTrackEnabled) with pure apply + inverse-from-pre-state, result-validity guard (cycle-safe), coded CommandErrors; atomic transactions via immutability; linear ProjectHistory undo/redo with labels; JSON serialization/replay; randomized invariant tests (25 seeds × 40 ops: validity, inverse round-trip, undo-all, redo-all, replay). Fixture builders added to `test-fixtures`. _(§36-P0-2, §11)_
- [x] **WP-00.3 — Preview/export parity spike** _(done 2026-07-19, ADR-0004 + ADR-0005)_. Versioned evaluated Render IR (sprite/video-frame/text), fixed-setting Pixi-facing test adapter, and independent deterministic headless reference rasterizer. Pinned 32×18 golden frames at 0/500 ms/1 s cover an image, resolved video frame, bitmap text, and evaluated translate/scale animation; paths match exactly. _(§36-P0-3, §14, §16.6)_
- [x] **WP-00.4 — HTML Scene spike** _(done 2026-07-19, ADR-0006)_. Parameterized React scene runtime with typed variables, JOY-controlled rational-frame time, frame-local seeded randomness, and deterministic 30/60 fps capture. P00's Node harness denies network, storage, wall clock, timers, host process, and module loading; ADR-0006 explicitly reserves real iframe/process isolation for P04. _(§36-P0-4, §2.3, §20.4)_
- [x] **WP-00.5 — Worker spike** _(done 2026-07-19, ADR-0009)_. Worker-initiated pairing and capability hello; local-only `asset.thumbnail` job matched by opaque local asset ID and capability. In-memory coordinator proves progress, cancel delivery, bounded retry, raw-path rejection, and no original asset bytes in the protocol. _(§36-P0-5, §26)_
- [x] **WP-00.6 — Browser/desktop asset spike** _(done 2026-07-19, ADR-0007 + ADR-0008)_. A permission-scoped local bridge registers a simulated 8 GiB selection with `AssetId` + opaque Worker location, then produces local thumbnail/proxy references. Public/control-plane records contain display metadata and opaque IDs only—no original path or bytes. _(§36-P0-6, §13.1)_
- [ ] **WP-00.7 — Audio sync spike.** Waveform, playback, seek, simple Worker export; measure drift over a reference clip. _(§36-P0-7)_

## ADRs owed by this part (§41.1)

1 time base · 2 persistence (snapshot+log) · 3 command semantics · 4 render boundary/IR · 5 reference render path · 6 HTML sandbox · 7 browser/desktop/bridge roles · 8 asset identity · 9 Worker protocol.

## Exit criteria (all must be evidenced before P01 opens)

- [ ] ADRs above written and Accepted.
- [ ] A saved spike project reproduces the same reference frames and audio alignment on re-open.
- [ ] No spike put Pixi objects, raw paths, or provider-specific fields into the project schema.
- [ ] Known preview/export differences measured and documented.
- [ ] Owner has seen and approved the vertical-slice user experience direction.
