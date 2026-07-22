# WP-15 — Agent Wired Into the Real Editor

**Status:** in-progress (1/5) · **Gate to enter:** P06 exit criteria (unit-level) + WP-11 live editor · **Master plan:** §36 Phase 6, §22, §11.7, D-AGENT (plan/DECISIONS.md)

**Goal:** turn `@joy-media/agent-tools` — a complete, unit-tested agent core
that has never once touched a real project — into an agent that actually
edits the live `editor-web` timeline through the same command bus, undo
stack, and persistence log the human Timeline panel uses. No parallel editor,
no flattened output, exactly as P06's own goal statement already required.

## Why this is next

STATE.md's P01–P10 status audit (2026-07-22) left one gap unlike the others:
P06 ("Agent-Assisted Editing") shows 5/5 WPs done and every exit criterion
checked in `plan/P06-agent.md`, yet the same table honestly flags "Command-bus
logic unit-tested only; agent not wired into editor-web." A fresh read-only
audit for this WP confirmed the gap precisely, and found it was worse than
"missing UI":

- `apps/editor-web` had **zero** references to `@joy-media/agent-tools` —
  not in `package.json`, not in any import.
- There was no chat box, command palette, or "Ask Hermes" surface anywhere in
  the editor.
- `EditTool.execute()` (the function an `AgentEditPlan` step actually calls)
  never touched a project at all: every one of the 11 edit tools
  (`insertClip`, `removeClip`, `moveClip`, `trimClip`, `splitClip`,
  `joinClips`, `setGain`, `setPan`, `setMute`, `setFade`, `addEffect`) returned
  a **fabricated** `ToolDiff` — e.g. `createInsertClipTool`'s `execute` just
  echoed `{ created: [input.clip.id] }` back, regardless of whether such a
  clip could legally exist. `PlanExecutor.execute(plan, context, _projectState)`
  took a project-state parameter and never read it (`_projectState: unknown`).
  Naive shape-only preconditions ("is `trackId` a string?") were the only
  validation; real domain rules (overlap, unknown track, duplicate id) were
  never checked because nothing was ever applied to a real project.

This is exactly the kind of gap WP-11 (live preview canvas) and WP-12–14
(control plane, Worker, media) each closed for their own subsystem: a part
marked "done" at the unit level that had never actually reached the live
editor. D-AGENT (plan/DECISIONS.md) makes this the owner's standing highest
priority ("everything becomes agentic … over time all operations should be
executable by the agent"), so it is the correct next milestone rather than
the other flagged gaps (P07 workflows, P08 plugin host wiring, P03
transcription stub), which remain separately open and untouched by this plan.

## Real integration points found (not assumed)

- `apps/editor-web/src/editor-session.ts`'s `EditorSession` is the actual
  live bridge: `dispatchTimeline(transaction: CommandTransaction)` applies a
  `SpikeCommand[]` through `@joy-media/commands`' `ProjectHistory`, persists
  it via `LocalProjectPersistence`, and folds it into one shared undo/redo
  stack alongside `dispatchVisualObjects`. `App.tsx` already exposes this
  exact callback to the human Timeline panel as `context.dispatchTimeline`.
- The real command set editor-web dispatches through is the **P00 spike**
  timeline model (`SpikeProject`/`SpikeCommand`: insert/remove/move/trim
  start/trim end/split/join/setTrackEnabled) — not the richer `JoyProjectV1`
  visual-object model captions/motion/camera use. Six of the eleven edit
  tools map onto this directly; see scope boundaries below for the other five.

## Work packages

- [x] **WP-15.1 — Real command-bus dispatch.** Added `CommandDispatcher` to
      `EditorContext` (`packages/agent-tools/src/context.ts`, optional field,
      additive) and wired the six timeline `EditTool`s
      (`insertClip`/`removeClip`/`moveClip`/`trimClip`/`splitClip`/`joinClips`)
      to build a real `SpikeCommand` (or, for `trimClip` with both boundaries,
      a two-command transaction) and dispatch it when a bus is bound;
      real `applyCommand` failures (overlap, unknown target, duplicate id)
      now surface as genuine `success: false` results instead of a fabricated
      diff. When no bus is bound (planning/estimation/legacy test contexts),
      tools fall back to their historical preview-shaped result — unchanged
      behavior, verified by the full pre-existing test suite passing unedited
      in that mode. `apps/editor-web/src/agent-command-bus.ts` implements the
      bus by wrapping the real `EditorSession.dispatchTimeline` — the exact
      function the human Timeline panel calls; its own test proves a real
      `EditorSession` mutation, undo/redo, a real rejected overlap
      (`COMMAND_VALIDATION_OVERLAP`, not a crash or silent success), and
      persistence across a session reload.
      **Bug found and fixed during this WP, unrelated to the wiring itself:**
      root `tsconfig.json` never listed `packages/agent-tools` in its
      `references`, and nothing referenced the package before now — so root
      `tsc -b` had _never once_ type-checked this package since P06 began;
      every prior "typecheck clean" claim in P06's session-log entries was
      against a build graph that silently excluded it. A clean rebuild
      surfaced real, pre-existing errors across `approval.ts`, `context.ts`,
      `dry-run.ts`, `estimation.ts`, `execution.ts`, `registry.ts`,
      `verification.ts`, the `benchmarks/` suite, and four test fixtures
      (an invalid `const` assertion on a ternary; several
      `exactOptionalPropertyTypes` violations; a non-generic `readonly Array<T>`;
      mutation through fields typed `readonly`; a dead `'caption'`/`'audio'`
      comparison against a `Track.kind` that is `'video'`-only by design; two
      nonexistent `SpikeProject` fields referenced from `extractProjectSummary`;
      a missing `noUncheckedIndexedAccess` guard; a missing type import; and
      fixtures built as loosely-typed literals instead of real
      `SpikeProject`/`Clip` values). All fixed for
      real, not suppressed; root `pnpm typecheck` is now clean including this
      package for the first time. Full suite: 1149/1153 (the 4 failures are
      a pre-existing headless-Chromium environment issue in
      `html-scene-runtime`/`golden-render`, confirmed to reproduce identically
      on unmodified `main` — unrelated to this WP, not edited). Lint: the
      same 8 accepted `plugin-sdk`/foreign-worktree findings. Format: clean
      except the same pre-existing `ORCHESTRATION.md`.
- [ ] **WP-15.2 — Editor agent UI surface.** A real panel in `editor-web`
      (intent input → `AgentEditPlan` → dry-run diff → approve/reject →
      execute), using the context builder and the WP-15.1 bus. No natural-
      language model call is required to close this WP — a structured or
      templated intent surface is sufficient; NL parsing may ride an
      existing provider per Q13/Q14 as a later enhancement.
- [ ] **WP-15.3 — History and audit visibility.** Every agent-run mutation is
      one ordinary entry in the same visible Undo/History UI the human uses
      (already true structurally per WP-15.1's `EditorSession` integration —
      this WP proves and polishes the on-screen presentation, including the
      audit-trail/one-action-revert surfaces `revert.ts`/`audit.ts` already
      implement at the unit level).
- [ ] **WP-15.4 — Live approval gate.** Paid/remote/destructive actions
      (`approval.ts`'s policy engine) actually block and prompt in the
      browser, not just in unit tests.
- [ ] **WP-15.5 — Live gate.** Real signed-in browser session: type an
      intent, see a real dry-run diff, approve, watch the real timeline
      mutate, undo it as one action, confirm History/audit show it, clean
      console/network. Evaluation suite (`benchmarks/`) run against the live
      bridge. STATE.md gate closed only after this evidence, matching the
      WP-11 through WP-14 precedent.

## Exit criteria (from P06 §36 Phase 6, now to be proven live not just in unit tests)

- [ ] Agent completes real benchmark intents using ordinary commands against
      the live editor project, not a mock context.
- [ ] Every agent mutation is visible in the real editor's History.
- [ ] Paid/remote/destructive actions request approval correctly, live.
- [ ] Failed plans leave the live project valid and recoverable (proven for
      the six timeline tools in WP-15.1; extends to WP-15.2+ scope as it
      grows).
- [ ] An agent edit reverts as one named action, live.
- [ ] No hidden flattened output ever substitutes for editable work.

## Scope boundaries

- The five audio `EditTool`s (`setGain`/`setPan`/`setMute`/`setFade`/
  `addEffect`) remain preview-only after WP-15.1. `editor-web` has no live
  `AudioState`/history-equivalent to dispatch into yet — a pre-existing P05/
  editor-web gap this WP did not introduce and does not silently paper over.
  Wiring them is future work, gated on that audio-state integration existing.
- `JoyProjectV1` visual-object/caption/camera commands (property-system,
  `dispatchVisualObjects`) are not in this WP's scope; the agent's tool set
  today only covers the timeline (`SpikeProject`) side.
- No natural-language model integration, Hermes-specific wiring, or D-HERMES
  scope is implied; WP-15.2's "intent input" may be structured/templated.
- Do not weaken WP-11's render/export path, WP-12–14's control-plane/Worker/
  media boundaries, or turn the agent into a second, parallel mutation path
  outside `EditorSession`.
