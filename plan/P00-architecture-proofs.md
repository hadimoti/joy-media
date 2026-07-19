# P00 — Architecture Proofs and Risk Retirement

**Status:** not-started · **Gate to enter:** none (first part) · **Master plan:** §36 Phase 0, §39 items 1–16 partially, §41.1
**Goal:** prove the hardest boundaries with minimal spikes _before_ building a large UI. Spikes may be throwaway, but their ADRs and golden fixtures are permanent.

## Work packages

Each WP ≈ one session. WP-00.0 first; the seven spikes afterward in any order (00.3 needs 00.1's time utilities).

- [x] **WP-00.0 — Repo bootstrap** _(done 2026-07-19)_. Standalone `joy-media` repo created (Q16 DECIDED); pnpm workspace, strict TypeScript, ESLint+Prettier, Vitest, `pnpm check` script + GitHub Actions CI, package scaffolds ONLY for packages the spikes touch (`project-schema`, `commands`, `evaluator`, `render-ir`, `job-protocol`, `test-fixtures`, `tooling/golden-render`). _(§39-1, §45.2)_
- [ ] **WP-00.1 — Time/evaluation spike.** Integer-`TimeUs` + rational frame-rate utilities; two video clips, source ranges, one nested composition; exact frame evaluation tests. _(§36-P0-1, §10.5)_
- [ ] **WP-00.2 — Command spike.** insert/move/trim/split/property-change; transaction, undo/redo, serialization/replay; randomized invariant tests (command+inverse restores state). _(§36-P0-2, §11)_
- [ ] **WP-00.3 — Preview/export parity spike.** One image, one video frame, one text object, transform animation → Pixi preview AND pinned headless output; first golden-frame comparison in `tooling/golden-render`. _(§36-P0-3, §16.6)_
- [ ] **WP-00.4 — HTML Scene spike.** Parameterized React scene; sandboxed preview; deterministic 30/60 fps frame capture; no-network test; seeded randomness. _(§36-P0-4, §2.3, §20.4)_
- [ ] **WP-00.5 — Worker spike.** Outbound pairing/handshake; capability report; one proxy-or-thumbnail job with progress/cancel/retry; asset never leaves the machine. _(§36-P0-5, §26)_
- [ ] **WP-00.6 — Browser/desktop asset spike.** Select a multi-GB local asset, register an opaque location, generate thumbnail/proxy without routing the original through the VPS. _(§36-P0-6, §13.1)_
- [ ] **WP-00.7 — Audio sync spike.** Waveform, playback, seek, simple Worker export; measure drift over a reference clip. _(§36-P0-7)_

## ADRs owed by this part (§41.1)

1 time base · 2 persistence (snapshot+log) · 3 command semantics · 4 render boundary/IR · 5 reference render path · 6 HTML sandbox · 7 browser/desktop/bridge roles · 8 asset identity · 9 Worker protocol.

## Exit criteria (all must be evidenced before P01 opens)

- [ ] ADRs above written and Accepted.
- [ ] A saved spike project reproduces the same reference frames and audio alignment on re-open.
- [ ] No spike put Pixi objects, raw paths, or provider-specific fields into the project schema.
- [ ] Known preview/export differences measured and documented.
- [ ] Owner has seen and approved the vertical-slice user experience direction.
