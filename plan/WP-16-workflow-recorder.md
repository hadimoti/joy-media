# WP-16 — Agent → Workflow Recorder (+ editor UX overhaul)

**Status:** done 2026-07-23 · **Parts:** P06 (agent) → P07 (workflows) bridge · **Decisions:** DECISIONS.md “WP-16 workflow-recorder decisions” (all four used as DEFAULT — see flags below)

## Scope shipped

- **Recorder** ([workflow-recorder.ts](../apps/editor-web/src/workflow-recorder.ts)): converts a successful `AgentEditPlan` into a first-class `JoyWorkflow` (formatVersion 1, `user.workflows.<slug>` id per W16-Q4), persists to `window.localStorage` under `joy-media.workflow.v1:*` with an in-memory fallback for Node tests. Save/load/list/delete covered by tests.
- **Runner** ([workflow-runner.ts](../apps/editor-web/src/workflow-runner.ts)): browser-safe Kahn topological executor dispatching recorded `editor.commandTransaction` nodes through the real `createAgentCommandBus` (same undo stack as the human Timeline panel); honors `policy.failure === 'stop'`.
- **Workflows panel** ([WorkflowsPanel.tsx](../apps/editor-web/src/WorkflowsPanel.tsx)): list, run, delete recorded workflows.
- **Agent panel**: after a successful agent execution, an explicit **Save as workflow** button records the plan (audited as `workflow-saved`, saved id shown inline). *History note:* the first implementation auto-saved every run — a W16-Q1 deviation flagged in DECISIONS.md and resolved the same day (2026-07-23) by shipping the button the decision called for.
- **W16-Q3 parameterization** ([workflow-recorder.ts](../apps/editor-web/src/workflow-recorder.ts)): `trackId`, `clipId`, `startUs`, `durationUs`, `sourceInUs`, and text inputs are promoted to workflow input parameters with `__parameter` markers and a recorded `__inputs` JSON-Schema on each node; `assetId` and `compositionId` remain baked in as constants. The Workflows panel Run action opens a modal (DESIGN.md tokens, `unicode-bidi: plaintext`) that defaults to the selected clip/playhead when available.

## Defects found in the 2026-07-23 handoff and fixed the same day

The handoff claimed “typecheck clean / build unblocked / browser execution implemented”. Verification found three real gaps:

1. **Typecheck was NOT clean** — `workflow-recorder.test.ts:48` violated `noUncheckedIndexedAccess` (TS2532). Fixed; dead helpers and unused imports in the new tests/panel removed.
2. **The app was broken at runtime in the browser.** The handoff’s `crypto-browserify` swap made `vite build` pass, but the bundle crashed at module evaluation (`Buffer.from` on vite-externalized `buffer`), so React never mounted — a blank page. `vite build` never executes the bundle, which is how the claim slipped through. **Fix:** `crypto-browserify` removed entirely; [sha256.ts](../packages/workflow-engine/src/sha256.ts) is a dependency-free synchronous FIPS 180-4 SHA-256 used by `computeRunKey`, verified against NIST vectors and `node:crypto` (incl. UTF-8 Persian/emoji inputs). Lockfile shed 52 packages; both `crypto-browserify.d.ts` shims, the `as any` cast, and `run-key.ts.backup` are gone.
3. **The Workflows panel was unreachable** — `workspace.ts` never registered `workflows` in `PANEL_IDS`/`DEFAULT_WORKSPACE`, so no tab ever appeared. Registered; stale saved workspace preferences self-heal via the existing length check.

## Editor UX overhaul (owner direction, 2026-07-23)

Owner asked for a professional Adobe-style editor: icon-only SVG buttons, modern neutral-gray theme (no blue), drag-and-drop, keyboard shortcuts.

- **Keyboard shortcuts** ([keyboard-shortcuts.ts](../apps/editor-web/src/keyboard-shortcuts.ts), pure resolver + tests): Space play/pause · Ctrl/Cmd+Z undo · Ctrl+Shift+Z / Ctrl+Y redo · Ctrl/Cmd+K command palette · Esc close palette · S split at playhead · Del/Backspace ripple delete · ←/→ seek ±1s (Shift = ±100ms) · Home/End. Guarded so typing in inputs never triggers actions; Esc still closes the palette from its search field.
- **Timeline**: time-scaled lanes (20 px/s), clips absolutely positioned by `startUs`, amber playhead marker, click-empty-lane-to-seek, and **pointer-based drag-to-move** with 100 ms grid snap, 4 px click/drag threshold, invalid drops snapping back (engine rejection caught), locked tracks refusing moves.
- **Icons** ([icons.tsx](../apps/editor-web/src/icons.tsx)): shared inline SVG set (play/pause/skip/undo/redo/scissors/trim/trash/export/⌘/lock/mute/solo/save). All common buttons are icon-only with `aria-label` + `title` tooltips (header, timeline toolbar, track Lock/Mute/Solo, History, Workflows).
- **Theme**: full neutral-gray palette across [app.css](../apps/editor-web/src/app.css) (#1e1e1e/#232324/#2b2b2d surfaces, #e9b949 amber accent, no blues) and dockview chrome themed via `--dv-*` variables (`#root .workspace` selector wins over `dockview.css` load order).

## Validation

- Root `pnpm typecheck` clean (verified independently, after fixing the handoff's error).
- `apps/editor-web`: 20 files / 63 tests pass (incl. new parameterization + live-gate tests). `packages/workflow-engine`: 91 tests pass (incl. new SHA-256 vectors).
- Monorepo: 1191/1191 pass.
- `vite build` passes; **live browser verification** (dev server, in-app browser): app mounts, Workflows tab reachable with parameter modal, clip select/split(S)/ripple-delete(Del)/undo(Ctrl+Z) all exercised for real, drag moved `product` 10s→13.3s with snap and undo restored it, gray icon-only UI screenshotted.

## Follow-up session (2026-07-23, same day): design system + all-panels alignment

- Repo-root **[DESIGN.md](../DESIGN.md)** codifies the D-UI-GRAY system: color tokens, icon-button rules (icon-only default; short label only where sibling icons would be ambiguous, e.g. SRT/VTT, FA/EN), dockview theming contract, interaction standards, a11y non-negotiables, and a new-panel checklist. All future UI work follows that file.
- **Every panel aligned:** Captions (export/import/add/transcribe toolbar + per-row revert/delete), Assets (refresh/backup/close-preview/thumbnail/preview), Jobs (revoke/cancel/retry), Camera (create), Motion (apply preset), Agent (approve/reject/execute/dismiss/undo), Workflows (+ refresh button so saves from the Agent panel appear without remount). Icon set grew by check/close/plus/download/upload/mic/image/refresh/cloud.
- **W16-Q1 resolved:** explicit Save-as-workflow button replaces auto-save; `workflow-saved` added to the agent-tools `AuditAction` union (additive).
- Verified in-browser on a fresh load: all 9 tabs mount with zero console errors.

## Cleanup

Deleted from the repo: stray `command` file (a Debian MOTD accidentally captured from the VPS), `run-key.ts.backup`, duplicate `crypto-browserify.d.ts` (root + src), `crypto-browserify` dependency (lockfile −52 packages).
