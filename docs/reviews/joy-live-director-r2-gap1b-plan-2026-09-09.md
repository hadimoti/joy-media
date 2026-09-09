# GAP 1b + 5 — implementation plan and status

**2026-09-09, session `joy-media-62`.** Branch `codex/joy-live-director`.
GAP 1a local persistence is done (`842b4003`); server-sync is an open owner
decision (`joy-live-director-r2-look-sync-audit-2026-09-09.md`). GAP 1b/1c/5 do
not depend on that decision.

## Design (unchanged from the reconciliation, made concrete)

`prepareUpdate` / `resetOverrides` are **just a Look recompile** — a different
`LookCompileInput` fed to the same `prepareLookPlan` → `stageLookRun` → approve →
commit path the first apply uses. `detach` is instance-document-only (no keyframe
change). Every one of them writes the `LookInstance` record **atomically with any
keyframe change** through the approval compound.

**One code path for manual and agent (GAP 5):** the panel and an agent
capability both call the pure helpers in `look-instance-operations.ts` and
`stageLookRun` with identical inputs; the write rides
`EditorSession#prepareCompound`'s `lookInstances` part either way — one approval
boundary, one Undo grouping.

## Landed

| Commit     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0797e809` | `look-instance-operations.ts` — pure helpers: `buildLookInstanceRecord` (a reset drops exactly the reset bindings from `overriddenBindingIds`), `upsertLookInstance` / `detachLookInstance`, `lookInstanceUpdateCompileInput`, `markLookBindingOverridden` (idempotent), `orphanedLookInstanceIds`. 6 unit tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `4f41af53` | Threaded the `LookInstance` write through the approval compound. `JoyCodeCompoundCompilerInput` / `JoyCodeCompoundDraft` gain an optional `lookInstances`, folded into `operationDigest` (+ `compiledDigest`/`bindingDigest` via `canonicalDraft`). Every spread is `...(x === undefined ? {} : {...})` → a non-Look change's digest and serialized draft are **byte-identical** to before. `edit-proposal-staging` `lookInstancesWrite?`; `look-run-host` `LookRunInput.lookInstancesWrite?`; runner → `commitAgentCompound({ …, lookInstances })` + committed-payload readback verifies `session.lookInstances`. Tests: a Look draft commits the instance atomically with keyframes, one undo reverts BOTH; the digest moves on a `lookInstances` change, not on a non-Look change. |
| `13dfbdd9` | `AgentPanel.runLook` (apply) now builds a `LookInstance` from its `compileInput` and passes `upsertLookInstance(session.lookInstances, record)` as `lookInstancesWrite`. **A Look apply is now reopenable, and one Undo reverts the instance + keyframes together.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Remaining GAP 1b/5

### 1. Panel + input model — `LivingLooksPanel.tsx` / `AgentPanel.tsx`

- `LivingLooksPanel` lists the applied `LookInstance`s for the active composition
  (`session.lookInstances`, filtered by `compositionId`), with the pack title,
  the operator's control values, and an "override" marker on any binding in
  `overriddenBindingIds`. Orphaned instances (`session.orphanedLookInstanceIds`)
  render "target removed — rebind or remove".
- `LivingLooksRunInput` gains a discriminated `kind`: `apply` (as now),
  `update` (`instanceId` + `nextControlValues` / `nextEntityBindings`),
  `reset` (`instanceId` + `bindingIds`), `detach` (`instanceId`).
- `AgentPanel.runLook` branches on `kind`:
  - `update` / `reset` → `lookInstanceUpdateCompileInput(instance, change, ctx)` →
    `prepareLookPlan` → `stageLookRun` with
    `lookInstancesWrite = upsertLookInstance(doc, buildLookInstanceRecord(instance.id, updatedInput))`.
  - `detach` → no plan; `session.dispatchCompound('Detach Look', { lookInstances: detachLookInstance(doc, instanceId) })` directly (one document, trivially atomic, one Undo).

### 2. Agent capability — `runLook` / `updateLook` / `detachLook`

Add to the composer capability manifest (same registry the recipes use). Each
capability is a thin wrapper that constructs the same `LivingLooksRunInput` and
calls the identical host op. A user-directed `updateLook` and a manual panel
`update` with the same inputs must produce byte-identical change-sets (GAP 5
test).

### 3. Override marking — Inspector property-commit seam

When a manual Inspector edit (or a user-directed agent edit) commits a keyframe
on a binding that a `LookInstance` links, add that `bindingId` to the instance's
`overriddenBindingIds` **in the same compound** via `markLookBindingOverridden`.
Hook the existing visual-object property-commit path in `App.tsx` /
`dispatchVisualObjects` so manual and agent edits mark identically. A reapply
then leaves that binding alone until an explicit `reset`.

### 4. e2e — `tests/e2e/agent-living-looks.spec.ts` (extended)

apply a Look → reload the project → the Look is still listed and reopenable →
adjust a control → Approve → Undo/Redo restore exactly → hand-edit one bound
property → adjust a _different_ control → the hand-edit survives → `resetOverrides`
re-links it → export the project, re-import into a fresh session → the instance
and its overrides come back.

### 5. Full `pnpm -w run check` green before GAP 1b/5 is called done.
