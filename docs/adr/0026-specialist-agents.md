# ADR-0026: Specialist agents that propose but cannot apply

Status: Accepted

Date: 2026-07-27

## Context

Phase 5 asks for caption, audio-cleanup, and colour specialists. §8.2 rules out
the shape they naturally suggest — an agent per node, each with its own session
and its own write access — and names the failure it is avoiding: specialists
racing to mutate the project. The prescription is one orchestrator, scoped
invocations, least privilege, explicit budgets, and a single transaction
authority, with parallel reads and serialized, revision-checked writes.

## Decision

**A specialist structurally cannot mutate.** `SpecialistContext` carries the
timeline, the creative document, and a scope — and no dispatcher, no commit, no
registry. The guarantee is the absence: there is nothing on the context to call
even if a specialist tried. Only `commitCombinedChangeSet` takes a commit
callback, and it is the single transaction authority.

**Permission is checked before invocation, not after.** A specialist requesting
capabilities the run does not hold is never called at all, so it never sees the
project. Denying it after the fact would already have handed it the content —
which matters because project content is untrusted data (§14.1).

**Analysis is concurrent, writing is serialized.** `Promise.allSettled` runs the
permitted specialists together; one failing does not lose the others' work. That
asymmetry — parallel reads, one serialized revision-checked write — is exactly
what §8.2 asks for.

**Conflicts are surfaced, never merged.** If two specialists propose edits to
the same target, the combined change set is refused. Last-write-wins is the easy
choice and the wrong one: the point of a parallel review is a combined result
the human can trust, and silently discarding one specialist's edit produces a
result nobody proposed.

**Approval is per specialist, and covers every role that contributes an edit.**
A specialist that proposed nothing is excluded from that requirement — found in
the browser, where a clean caption review blocked applying the audio and colour
results. Requiring approval for a result that changes nothing blocks a
legitimate apply.

**Analyses are deterministic, deliberately.** A specialist is "a capability and
policy bundle" (§8.1), and the bundle is what this phase proves: scoping,
permission, budget, parallelism, conflict detection, transaction authority.
Swapping in a provider-backed analysis later changes the body of `analyse` and
nothing around it; building the orchestration against a non-reproducible
analysis would have made every one of those properties untestable.

**Results are parameter change sets, not flattened media** (§5.1), recorded as
`changeSet` artifacts — inspectable in the Agent changes data lane from
ADR-0025, and removable with one Undo.

**The panel shows findings, warnings, and proposed edits — never reasoning
traces** (§8.4).

## Alternatives considered

- **One agent session per node with write access.** Rejected by §8.2, and it is
  the exact race the phase exists to prevent.
- **Merging conflicting edits by priority.** Rejected: a priority order is a
  guess about intent, and the result is one no specialist proposed.
- **Applying change sets straight to the timeline.** Deferred. Committing
  parameter edits across the timeline and document buses in one transaction
  needs cross-bus transactions the session does not have; recording an
  inspectable change set is the honest half that works today.
- **Provider-backed analyses now.** Rejected for this phase — see above.

## Consequences

- Three specialists analyse in parallel and cannot touch the project.
- A combined result is refused unless it is conflict-free and approved.
- A stale review fails loudly instead of committing against moved state.
- Approved change sets are one transaction and one Undo.
- Every proposal and every commit or refusal lands in the audit trail.
- Cost: proposals are held in component state, so a review is lost on reload.

## Gaps deliberately left open

- ~~**Change sets are recorded, not applied.**~~ Closed by ADR-0028: an
  approved parameter change set now changes the creative document, in the same
  compound transaction that records it, undoable in one step. Timeline-domain
  proposals remain unapplied.
- **No budget in money.** `SpecialistBudget` caps specialists and edits per run;
  `provider.spend` is gated by capability, but no currency limit is enforced
  because no specialist spends yet.
- **Scope is clip ids only.** A time range is representable in
  `SpecialistScope` but not yet used to narrow analysis.
- **No specialist nodes in the workflow graph.** `AgentAssignmentV2` exists in
  the schema and the graph can carry it, but the review panel runs the built-in
  list rather than graph-assigned specialists.
- **Review state is not durable.** Reloading mid-review loses the proposals.

## Validation and rollback

`packages/agent-tools/src/specialists.test.ts` — 27 tests: context carrying no
mutation surface, project unchanged after a run, concurrency proved by
completion order, one failure not losing others, capability denial before
invocation, specialist and edit budgets, audit records, conflict detection
including the same-specialist-twice case, single commit call, per-edit envelopes
attributed to the specialist, refusal on conflict and on unapproved
contributors, the zero-edit exemption, revision conflict, failed commit
reporting, and the three built-in analyses including scope narrowing.

Verified in the browser: all three ran on the real project; Apply stayed
disabled until approval; approving two of three applied them as one transaction;
both landed in the Agent changes lane; one Undo removed both and left the other
data and all five clips intact.

Rollback is contained: the specialist modules are additive and the panel renders
only when `DUAL_LENS_FLAG_KEY` is `'on'`.

## Related contracts/tests

- ADR-0019 (envelope, capability policy, determinism), ADR-0022–0025
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §5.1, §8, §14.1, §16
