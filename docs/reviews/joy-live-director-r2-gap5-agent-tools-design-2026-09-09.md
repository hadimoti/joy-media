# GAP 5 — real agent Look capability — design

Owner: "real agent capability is REQUIRED in R2. A shared internal helper is not
user-visible manual/agent parity. Implement agent-accessible `applyLook`,
`updateLook`, `resetLookOverrides` and `detachLook` through the canonical
operation path. Preserve approval, stale-revision checks, atomic persistence,
Undo and live UI activity. Do not bypass agent approval merely because detach
skips a visual preview. Test **actual tool-loop execution** — not only direct
helper calls."

## Where the tools live

`JOY_AGENT_HOST_TOOL_NAMES` (`apps/editor-web/src/joy-agent/host-tool-contract.ts`)
is the "one closed, product-owned vocabulary for model-visible browser host
calls". These are **deterministic host tools** (like `validate_proposal`, not
model-freeform): the model supplies intent, the HOST compiles the exact Look
plan. Add:

```
'look_apply', 'look_update', 'look_reset_overrides', 'look_detach'
```

## Tool schemas (bounded, `agent-tools`)

- `look_apply` — `{ definitionId: enum(BUILT_IN pack ids), entityBindings: {slotId: entityId}, controlValues: {controlId: number|string|boolean} }`
- `look_update` — `{ instanceId, nextControlValues?: {...}, nextEntityBindings?: {...} }`
- `look_reset_overrides` — `{ instanceId, bindingIds: string[] }`
- `look_detach` — `{ instanceId }`

All ids constrained to `LOOK_ID_PATTERN` / the enum; control values bounded by
the definition's control kinds. The tool schema **cannot widen** what the Look
compiler will accept — it just names intent.

## Flow (per tool)

1. Model emits the tool call in a scoped run (`runJoyAgentTask` / bounded
   tool-loop), same as `validate_proposal`.
2. Host handler builds a `LivingLooksRunInput` (the SAME discriminated union the
   panel emits) and calls **`runLook`** — the one code path.
3. `runLook` runs `stageLookRun` → `createJoyAgentProposalStagingHandler` →
   staged live preview → returns opaque change-set identity. Stale-revision and
   host-lease checks are already enforced inside the staging handler.
4. The **approval card** appears (live UI activity). The operator Approves →
   `JoyCodeCompoundRunner.apply` → `commitAgentCompound({..., lookInstances})` —
   atomic, one Undo, digest-bound.
5. `look_detach` from the **agent** must ALSO stage for approval (owner: "do not
   bypass agent approval merely because detach skips a visual preview"). The
   manual panel Detach button commits directly because the operator clicked it;
   the agent path does not have that direct authority. So `runLook`'s `detach`
   branch needs a mode: **manual detach = direct `dispatchCompound`; agent detach
   = a staged, zero-visual-operation, `lookInstances`-only change** through the
   approval compound.
   - `stageLookRun` / `prepareLookPlan` currently reject `operations.length === 0`.
     Add a `lookInstancesOnly` staging path: `compileJoyCodeCompoundDraft` already
     tolerates zero operations only via the error branch — instead, thread a
     `lookInstances`-only draft directly (no `validate_proposal` operations, just
     the `lookInstances` part folded into `operationDigest`). The approval card
     shows "Detach <pack>" with no preview diff. Approve → same compound commit.

## Preserve (owner list)

| Requirement           | How                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approval              | every agent Look tool stages a change-set for the approval card; nothing auto-applies                                                                                     |
| stale-revision checks | `stageLookRun` captures `scope.revision`; `createJoyAgentProposalStagingHandler` rejects if `session.projectRevisionId !== baseRevision`; `commitAgentCompound` re-checks |
| atomic persistence    | `commitAgentCompound({..., lookInstances})` — one prepared-journal compound (proven in GAP 1b)                                                                            |
| Undo                  | one history entry (`recordCompound`), reverts visual + instance together                                                                                                  |
| live UI activity      | `runLook` drives `beginRunLifecycle` / `acceptRunLifecycle` phases + appends thread messages, same as the manual path                                                     |

## Tests — ACTUAL tool-loop execution

Extend the existing bounded-tool-loop / `agent-director-skills` test pattern with
a **fake provider** that emits each Look tool call:

1. Fake provider emits `look_apply` → the tool-loop stages a change → the test
   approves the resulting change-set through `JoyCodeCompoundRunner` → assert
   `session.lookInstances` has the instance + the keyframes landed + one Undo
   reverts both.
2. `look_update` on that instance → recompiled keyframes + updated controlValues,
   staged + approved, one Undo.
3. `look_reset_overrides` → the named bindings leave `overriddenBindingIds` and
   are re-compiled.
4. `look_detach` (agent) → a change-set is STAGED (not auto-applied) → approve →
   instance gone, keyframes stay, one Undo restores.
5. **GAP 5 parity test**: a manual `LivingLooksRunInput{kind:'update',...}` and
   an agent `look_update` with identical inputs produce a **byte-identical
   change-set** (`operationDigest` + the committed `lookInstances`).
6. e2e (`agent-living-looks.spec.ts` or `agent-director-skills.spec.ts`): drive a
   Look apply _through the agent thread_ (fake provider), Approve, reload,
   reopen, adjust via the agent, Detach via the agent — all through the approval
   card.

## Surface

`host-tool-contract.ts` (+4 names) · `agent-tools` tool schemas · `bounded-tool-loop.ts`
(catalog + `toolDefinitionFor` + handler dispatch) · `protocol.ts` (Worker
protocol validation of the new tool names) · `engine.worker.ts` (pass-through) ·
`AgentPanel.tsx` (`runLook` gains an `origin: 'manual' | 'agent'` so detach can
branch; the agent tool handlers call it) · tests as above.

Kept out of scope: the model does not get freeform keyframe authorship — Look
compilation stays deterministic host-side.
