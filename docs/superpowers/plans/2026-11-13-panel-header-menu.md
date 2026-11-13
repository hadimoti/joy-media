# T-P04 Panel Header Menu Implementation Plan

> **For agentic workers:** Use the native `superpowers:executing-plans` workflow. Do not stage or commit; CC owns commits.

**Goal:** Make T-P04 panel tabs, overflow, menu actions, reset behavior, and popover placement work at real Dockview widths.

**Architecture:** Measure available tab-header space from Dockview's fixed-width header structure and keep label changes stable near the threshold. Route the panel reset through the existing Reset Workspace callback, and render the action menu in a body portal positioned from its trigger while retaining PopupManager dismissal behavior.

**Tech Stack:** React 19, TypeScript, Dockview 4.13.1, Vitest/jsdom, CSS.

**Spec:** `C:\jgp\v111\evidence\T-P04\prompt-fix-cx.txt` and the T-P04 card in `C:\Users\HadiMoti\Desktop\joy-media-temps\fable-plan\07b-NEW-TASK-CARDS-part2.md`.

## Global Constraints

- Work only on `v111/panel-menu` at `4e39fdbc`.
- Preserve existing untracked `.pnpm-store/` and branch divergence.
- Do not stage, commit, merge, or checkout.
- Run typecheck, changed-file ESLint and Prettier, touched tests, and the editor-web suite with `--configLoader runner`.

## Review Focus

- Header width differs from the content-sized `.dv-scrollable` child: test the real nested shape and action/void widths.
- Widths near the label threshold: test hysteresis in both directions.
- Tabs all fit versus some hidden: document a real-app driver assertion if Dockview cannot be rendered reliably in jsdom.
- Reset with saved layouts across both modes/presets and legacy view-mode storage: verify all are cleared and defaults are selected.
- Short/floating groups and keyboard dismissal: verify the portal is visible, retains menu clicks, and returns focus.

### Task 1: Tab label measurement and stability

**Files:** `apps/editor-web/src/PanelTab.tsx`, `apps/editor-web/src/PanelTab.test.tsx`.

- [x] Replace the content-sized tab-strip measurement with the available width inside the Dockview group header, subtracting fixed action slots. The flexible void slot is not reserved because it consumes unused space.
- [x] Observe the header and its width consumers; add hysteresis around the 480 px threshold.
- [x] Test a Dockview-shaped header containing a content-sized `.dv-scrollable` child and verify wide, narrow, and threshold-transition behavior.

### Task 2: Hidden-tab overflow acceptance

**Files:** `docs/qa/v1.1.1/T-P04-DRIVER.md` and, if an existing driver seam is available, its focused test.

- [x] Record the wide/narrow browser assertions for the chevron and hidden-tab menu in the T-P04 driver document; jsdom cannot reproduce Dockview's layout-driven overflow.

### Task 3: Workspace reset behavior

**Files:** `apps/editor-web/src/App.tsx`, `apps/editor-web/src/editor-panel-context.ts`, `apps/editor-web/src/PanelHeaderMenu.tsx`, `apps/editor-web/src/workspace-presets.ts`, `apps/editor-web/src/workspace-presets.test.ts`, `apps/editor-web/src/PanelHeaderMenu.test.tsx`.

- [x] Reuse the same Reset Workspace callback from the panel context.
- [x] Replace the source-regex test with behavior tests proving all saved preset layouts, the UI preference key, and legacy view-mode key are cleared and default mode/preset are selected.

### Task 4: Menu naming and unclipped actions

**Files:** `apps/editor-web/src/ActionOverflowMenu.tsx`, `apps/editor-web/src/ActionOverflowMenu.test.ts`, `apps/editor-web/src/PanelHeaderMenu.tsx`, `apps/editor-web/src/PanelHeaderMenu.test.tsx`, `apps/editor-web/src/app.css`.

- [x] Include the active panel/group in the trigger's accessible name.
- [x] Portal the menu to `document.body`, anchor it with fixed coordinates, and preserve PopupManager inside/outside and Escape behavior.
- [x] Label floating as a group action with a tooltip; clarify which destination group the move actions use.
- [x] Test portal placement, dismissal/focus, accessible label, and the updated menu copy.

### Task 5: Verification

- [x] Run the touched Vitest files and `apps/editor-web` suite with `--configLoader runner`.
- [x] Run typecheck, ESLint on changed files, and Prettier `--write` on changed files.
- [x] Review the final diff and report in four lines; do not stage or commit.
