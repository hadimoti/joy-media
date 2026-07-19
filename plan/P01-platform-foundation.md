# P01 — Platform Foundation

**Status:** in-progress · **Gate to enter:** P00 exit criteria all checked · **Master plan:** §36 Phase 1, §39 items 1–39 (foundation/workspace/asset-worker groups), §9, §12, §27
**Goal:** durable creative core, editor shell, local persistence, minimal control plane + Worker skeleton. At exit, JOY Media is a real (if tiny) product skeleton, not spikes.

**Decisions needed at entry:** Q1 (target surface), Q3 (sync default), Q9 (single-user), Q10 (identity), Q16 (repo split). See DECISIONS.md.

## Work packages

- [x] **WP-01.1 — Creative core hardening** _(done 2026-07-19)_. Added a runtime-validated v1 project subset, pure v0→v1 migration harness and fixture, command registry coverage, and coalesced continuous history interactions while retaining semantic inverses/undo-redo. _(§39-2…9, §10–§12)_
- [x] **WP-01.2 — Local persistence + recovery** _(done 2026-07-19)_. Desktop-first atomic JSON snapshot/log adapter, verified recovery with corrupt-entry truncation, write-ahead recovery copies, project locks, and all §12.3 autosave states. _(§39-10,11)_
- [x] **WP-01.3 — Evaluator + Render IR v1 + minimal Pixi adapter** _(done 2026-07-19)_. Pure active-interval/static-property helpers; v1 sprite/video-frame/text/group IR; separate editor overlays; group-flattening preview host; pinned deterministic preview/headless golden frames. _(§39-12…16, §14–§15)_
- [x] **WP-01.4 — Editor shell** _(done 2026-07-19)_. React/Vite/Dockview shell with error containment, recoverable local layout, command palette/shortcuts, ephemeral selection/playhead state, transform/opacity schema descriptors, and History/Diagnostics panels; durable mutations stay behind the command-history controller. _(§39-17…21,26, §17–§18)_
- [x] **WP-01.5 — Control plane skeleton** _(done 2026-07-19)_. Local API runner plus authenticated project revisions, Worker pairing/revocation, expiring job leases, PostgreSQL job/attempt/event DDL, and cursor-based event protocol. VPS deployment remains reserved for X01. _(§39-29…32, §27)_
- [ ] **WP-01.6 — Worker skeleton.** Tray/service skeleton, device identity, heartbeat/capability handshake, job runner with cancellation/bounded logs/temp dirs, ffprobe/FFmpeg detection, structured logs. _(§39-30…34, §26)_

## Exit criteria (§36 Phase 1)

- [ ] Create/open/save/recover a project locally.
- [ ] Connect/disconnect a Worker safely.
- [ ] Execute a sample job end-to-end (submit → lease → progress → verify).
- [ ] Workspace restores after restart.
- [ ] All durable project changes go through commands.
- [ ] Schema/command/job contract tests pass.
- [ ] Existing joy-vps services demonstrably unaffected (X01 isolation rules respected).
