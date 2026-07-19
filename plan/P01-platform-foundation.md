# P01 — Platform Foundation

**Status:** not-started · **Gate to enter:** P00 exit criteria all checked · **Master plan:** §36 Phase 1, §39 items 1–39 (foundation/workspace/asset-worker groups), §9, §12, §27
**Goal:** durable creative core, editor shell, local persistence, minimal control plane + Worker skeleton. At exit, JOY Media is a real (if tiny) product skeleton, not spikes.

**Decisions needed at entry:** Q1 (target surface), Q3 (sync default), Q9 (single-user), Q10 (identity), Q16 (repo split). See DECISIONS.md.

## Work packages

- [ ] **WP-01.1 — Creative core hardening.** Promote spike results to production packages: project schema v1 + migration harness + v0 fixture; runtime validators; command registry with inverse tests; transactions/coalescing/undo-redo. _(§39-2…9, §10–§12)_
- [ ] **WP-01.2 — Local persistence + recovery.** Snapshot + command-log storage (IndexedDB/desktop); crash recovery; two-tab/project-lock handling; autosave states per §12.3. _(§39-10,11)_
- [ ] **WP-01.3 — Evaluator + Render IR v1 + minimal Pixi adapter.** Active-interval queries, static property evaluation, IR for sprite/video-frame/text/group, editor-overlay separation, deterministic render-host harness with golden frame. _(§39-12…16, §14–§15)_
- [ ] **WP-01.4 — Editor shell.** React/Vite app, error boundary, theme/ui-kit baseline, Dockview default workspace + layout recovery, command palette + shortcut registry, ephemeral selection/playhead state, schema-driven Inspector for transform/opacity, History + diagnostics panels. _(§39-17…21,26, §17–§18)_
- [ ] **WP-01.5 — Control plane skeleton.** `apps/api`: auth boundary (per Q10), project metadata/revision sync, Worker pairing/revocation, PostgreSQL job/attempt/event schema with lease tests, WebSocket event cursor. Runs locally in dev; VPS deployment happens only through X01. _(§39-29…32, §27)_
- [ ] **WP-01.6 — Worker skeleton.** Tray/service skeleton, device identity, heartbeat/capability handshake, job runner with cancellation/bounded logs/temp dirs, ffprobe/FFmpeg detection, structured logs. _(§39-30…34, §26)_

## Exit criteria (§36 Phase 1)

- [ ] Create/open/save/recover a project locally.
- [ ] Connect/disconnect a Worker safely.
- [ ] Execute a sample job end-to-end (submit → lease → progress → verify).
- [ ] Workspace restores after restart.
- [ ] All durable project changes go through commands.
- [ ] Schema/command/job contract tests pass.
- [ ] Existing joy-vps services demonstrably unaffected (X01 isolation rules respected).
