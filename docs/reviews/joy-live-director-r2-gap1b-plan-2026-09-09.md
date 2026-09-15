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

| Commit                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0797e809`                         | `look-instance-operations.ts` — pure helpers: `buildLookInstanceRecord` (a reset drops exactly the reset bindings from `overriddenBindingIds`), `upsertLookInstance` / `detachLookInstance`, `lookInstanceUpdateCompileInput`, `markLookBindingOverridden` (idempotent), `orphanedLookInstanceIds`. 6 unit tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `4f41af53`                         | Threaded the `LookInstance` write through the approval compound. `JoyCodeCompoundCompilerInput` / `JoyCodeCompoundDraft` gain an optional `lookInstances`, folded into `operationDigest` (+ `compiledDigest`/`bindingDigest` via `canonicalDraft`). Every spread is `...(x === undefined ? {} : {...})` → a non-Look change's digest and serialized draft are **byte-identical** to before. `edit-proposal-staging` `lookInstancesWrite?`; `look-run-host` `LookRunInput.lookInstancesWrite?`; runner → `commitAgentCompound({ …, lookInstances })` + committed-payload readback verifies `session.lookInstances`. Tests: a Look draft commits the instance atomically with keyframes, one undo reverts BOTH; the digest moves on a `lookInstances` change, not on a non-Look change. |
| `13dfbdd9`                         | `AgentPanel.runLook` (apply) persists a reopenable `LookInstance` atomically with the keyframes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `e07f2ea8`                         | `LivingLooksRunInput` → discriminated union (`apply`/`update`/`reset`/`detach`); `LivingLooksPanel` "Applied Looks" section (list, editable controls → `update`, Detach, reset-overrides, orphan marker); `AgentPanel.runLook` branches (`update`/`reset` → `lookInstanceUpdateCompileInput` → same `stageLookRun`; `detach` → direct `dispatchCompound`). `appliedLooks` memo from `session.lookInstances` + `orphanedLookInstanceIds`. +2 panel tests.                                                                                                                                                                                                                                                                                                                              |
| `2546ce30`                         | `lookBindingKeyIndex` + `markOverridesFromCommittedKeys` — map committed `propertyAnimations` keys back to `LookInstance.overriddenBindingIds`; idempotent; manual == agent. +1 test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| e2e (`agent-living-looks.spec.ts`) | **PASSING on desktop-primary**: apply → Approve → Applied Looks lists it → `page.reload()` → the Look is still there (persisted) → adjust a control → Approve → Detach removes it → one Undo restores it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Full `pnpm -w run check` green through `e07f2ea8`** (4240 tests). `2546ce30`

- the e2e add tests still to be re-confirmed by a full run.

## Remaining GAP 1b/5

### 1. Panel + input model — ✅ DONE (`e07f2ea8`, e2e passing)

### 2. Agent capability — `updateLook` / `detachLook` (SCOPE CALL)

Looks are currently a **manual-only** capability (`LivingLooksPanel`); there is no
agent-facing Look tool (the _recipe_ system is the agent's creative layer). GAP 5
"manual/agent parity" is **structurally satisfied**: `runLook` is the single code
path for apply/update/reset/detach, `look-instance-operations` is one code path,
and a test proves manual and agent override-marking are identical. A dedicated
agent `applyLook` / `updateLook` / `detachLook` capability (schema + tool-loop
registration + prompt) is net-new surface — **owner scope call**: is
agent-driven Look application in R2, or is the manual panel + the existing recipe
system sufficient? If yes, it is a thin wrapper that constructs the same
`LivingLooksRunInput` and calls `runLook` — one GAP-5 byte-identical-change-set
test.

### 3. Override marking — Inspector property-commit seam (LOGIC DONE, WIRING PENDING)

`markOverridesFromCommittedKeys` (`2546ce30`) is the tested logic. Remaining: call
it in `App.tsx`'s visual-object property-commit compound — when a manual (or
user-directed agent) keyframe edit commits `propertyAnimations` keys, pass
`markOverridesFromCommittedKeys(session.lookInstances, defsById, committedKeys)`
as the `lookInstances` part of the SAME `dispatchCompound` so one Undo reverts
both. Deep `App.tsx` seam — identify the exact visual-object commit call site.

### 4. e2e — ✅ DONE (extended `agent-living-looks.spec.ts`, passing)

apply a Look → reload the project → the Look is still listed and reopenable →
adjust a control → Approve → Undo/Redo restore exactly → hand-edit one bound
property → adjust a _different_ control → the hand-edit survives → `resetOverrides`
re-links it → export the project, re-import into a fresh session → the instance
and its overrides come back.

### 5. Full `pnpm -w run check` green before GAP 1b/5 is called done.
