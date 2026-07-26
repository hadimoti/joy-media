# ADR-0019: Agent command envelope and atomic plan execution

Status: Accepted
Date: 2026-07-26

## Context

An "Agentic Editing Architecture v2" proposal was reviewed against this
codebase. Much of what the review asked for already existed in
`@joy-media/agent-tools` — a query API (`queries.ts`), a guarded tool registry
(`registry.ts`), dry-run change sets (`dry-run.ts`), idempotency keys, an audit
trail, cost estimation, preconditions, and `collaboration-core`'s
`baseRevisionId` conflict model. Commands were already domain-level
(`timeline.splitClip`, not UI events), which was the review's first objection.

Two things were genuinely missing, and both broke properties the architecture
depends on:

1. **Agent runs were not atomic.** `PlanExecutor.execute` dispatches each step
   through `context.dispatch` as it goes, so an N-step plan produced N entries
   on the editor's undo stack. "One Undo should revert the entire transaction"
   was therefore false. The Agent panel's own `undoLastRun` called `onUndo()`
   exactly once, so undoing a multi-step recipe (the shipped
   `recipe-split-trim`) reverted only its final step and silently left the rest
   applied. A plan that failed at step 3 also left steps 1–2 live, in a state
   the agent never intended and the user never approved.

2. **Commands carried no envelope.** An agent step reached the timeline as a
   bare `SpikeCommand` — no identity, no actor, no revision. A plan built
   against one version of the project could be executed against a newer one and
   would silently edit stale content, and nothing in the persisted log recorded
   that an agent rather than the user made the edit. `@joy-media/commands`
   already noted this as deferred work ("Envelope hardening … lands in P01").

## Decision

**Add a minimum agent command envelope** (`agent-tools/envelope.ts`):
`schemaVersion`, `commandId`, `projectId`, `baseRevision`, `transactionId`,
`idempotencyKey`, `actor`, `preconditions`. It wraps _agent_ commands only.
Human edits continue through `EditorSession.dispatchTimeline` unchanged, so the
editor's own undo semantics (ADR-0003) are untouched. The full core-bus
hardening reserved for P01 is explicitly **not** done here. `baseRevision` is
an opaque string revision id, matching ADR-0012's collaboration contract rather
than exposing one persistence implementation's counter shape.

**Execute plans atomically** (`agent-tools/atomic.ts`). `runPlanAtomically`
stages every step against a scratch project, rebuilding the tool-facing context
per step so dependent steps (split→trim, trim→ripple) observe their
predecessor's result. Nothing touches the real project until every step has
succeeded; commit is a single `CommandTransaction`, hence a single undo.
`checkBaseRevision` runs immediately before commit and throws
`RevisionConflictError` rather than applying a stale plan.

**Amendment — durable local revision, 2026-07-26.** `EditorSession` now retains
the verified revisions recovered from both durable project logs and exposes one
opaque `projectRevisionId`. Any successful timeline or document/Inspector
transaction advances the corresponding component, so a plan identifies the
complete creative document state and the same id is recovered after reload.
The Agent panel captures that id and the immutable project snapshot when the
plan is created; it no longer reads a history cursor at execution time.

Atomic runs also accept a durable transaction-level idempotency tracker. The
browser implementation stores project-scoped completion receipts. Retrying an
already completed logical plan, including after reload, is a successful no-op
before revision validation; a fresh replan receives a new key and can commit
against the current revision. Failed receipts remain retryable.

**Amendment — capability policy and execution modes, 2026-07-26.**
`ToolScope` now declares explicit read/write/import/provider/spend/render/export/
overwrite/plugin capabilities instead of approximate affected-area booleans.
The policy engine implements Suggest Only, Preview and Approve (the product
default), Auto-apply Low-Risk Changes, and Full Auto Within Explicit Limits.
Remote egress, provider spend, filesystem writes, export, project overwrite,
plugins, destructive edits, and credential-like tools cross separate gates
even in Full Auto.

A `requires-manual` decision is no longer sufficient to execute by itself.
The atomic runner requires a trusted-UI approval grant whose `planId` matches
the exact pending plan. Suggest Only cannot receive such a grant. This closes
the previous gap where the executor labelled a step manual but still staged
and committed it.

**Prove it with one vertical slice.** "Shorten the intro"
(`agent-tools/shorten-intro.ts`) is a ripple edit: trimming the opening clip
alone leaves a hole, so every later clip on the track must move back with it.
Its three commands are only correct together, which is precisely why it needs
atomicity. The Agent panel now executes through `runPlanAtomically`, which also
fixes the multi-step undo bug above.

Time stays in integer microseconds, as it already did. The review's suggestion
of a `{ticks, timebase}` pair is not adopted here — ADR-0002 already settled
rational frame mapping, and re-opening it was out of scope.

## Alternatives considered

- **Extend `PlanExecutor` in place.** Rejected: its per-step dispatch is the
  correct behaviour for interactive single-step intents, and changing it would
  alter existing behaviour that tests depend on. The atomic runner is a second
  path, and `PlanExecutor.executeStep` is still the per-step primitive.
- **Put the envelope in `@joy-media/commands`.** Rejected for now: that is the
  P01 change and would apply to human edits too. Doing it under an agent slice
  would have widened the blast radius to every command in the editor.
- **Undo N times to revert a multi-step run.** Rejected: it is not atomic, it
  is visible to the user as N history entries, and it cannot recover from a
  partial failure that left the project mid-plan.

## Consequences

- A multi-step agent run is one undo entry and one history row.
- A failed step commits nothing; the user's project is never left mid-plan.
- A plan built against a stale revision fails loudly instead of overwriting.
- Revisions and completed-run receipts survive browser reload.
- An exact retry cannot apply the same agent transaction twice.
- Every agent-issued command is attributable to an actor and a transaction.
- The staged project is available before commit, so a change-set preview can be
  rendered from real applied state rather than predicted diffs.
- Cost: the staged run applies commands twice (once staged, once committed).
  Irrelevant at timeline-command scale; would matter if a step ever ran a job.

## Gaps deliberately left open

Recorded so they are chosen, not forgotten:

- **No Agent menu or settings UI.** The menubar is still
  `File · Edit · Clip · View · Window`; `app-menu.ts` types it as a closed
  union. Provider/model/budget configuration has no home yet.
- **No agent/model/provider taxonomy.** `provider-sdk` exists but Hermes and
  KiloCode are not modelled as _adapters_ distinct from reasoning models
  (GPT/Claude) and media providers (Flux/Kling), and nothing publishes a
  capability manifest.
- **No async job path in the agent loop.** `job-protocol` exists but plan steps
  of `mode: 'job'` are not dispatched to the Worker; only synchronous timeline
  commands run.
- **No collaboration transport is wired.** The local revision id is durable and
  deliberately opaque/ADR-0012-compatible, but it is not yet a remotely
  accepted `collaboration-core` head. When transport lands, the accepted head
  id replaces the local adapter value without changing the envelope schema.
- **Determinism claim corrected.** The source proposal asserted "everything
  must be deterministic". That cannot hold once generative providers are
  involved. The rule adopted is: _command execution is deterministic and
  replayable; generative operations must record enough provenance (provider,
  model, version, prompt, seed, input hashes, cost) to be reproduced as closely
  as the provider permits._ Undo can remove a generated asset from the project;
  it cannot reverse credits already spent.

## Validation and rollback

`packages/agent-tools/src/shorten-intro.test.ts` — 22 tests covering the loop:
query, plan ordering, dry-run purity, one-transaction commit, exact rippled
result, other tracks untouched, envelope completeness, one-step undo,
all-or-nothing failure, policy blocking, and revision conflict in both
directions.

`apps/editor-web/src/agent-durable-revision.test.ts`,
`editor-session.test.ts`, and `agent-idempotency-store.test.ts` add seven tests
for cross-document conflict detection, replan, reload-stable revision,
reload-stable idempotency, failed-stage immutability, and one-step undo from a
reopened durable session.

`packages/agent-tools/src/approval-modes.test.ts` adds 15 capability-policy
tests. `shorten-intro.test.ts` now has 25 tests, including proof that an absent
or wrong-plan approval grant cannot commit and a matching grant can.

Rollback is contained: `runPlanAtomically` and `envelope.ts` are additive, and
the Agent panel can be pointed back at `PlanExecutor.execute` by reverting one
call site — at the cost of reintroducing the multi-step undo bug.

## Related contracts/tests

- ADR-0002 (time base), ADR-0003 (command/transaction/undo semantics)
- ADR-0012 (collaboration conflict model) — the durable revision this slice
  approximates with the session history cursor
- `plan/P06-agent.md`, `plan/WP-15-agent-editor-integration.md`
