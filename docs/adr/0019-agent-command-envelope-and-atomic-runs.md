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
`idempotencyKey`, `actor`, `preconditions`. It wraps *agent* commands only.
Human edits continue through `EditorSession.dispatchTimeline` unchanged, so the
editor's own undo semantics (ADR-0003) are untouched. The full core-bus
hardening reserved for P01 is explicitly **not** done here.

**Execute plans atomically** (`agent-tools/atomic.ts`). `runPlanAtomically`
stages every step against a scratch project, rebuilding the tool-facing context
per step so dependent steps (split→trim, trim→ripple) observe their
predecessor's result. Nothing touches the real project until every step has
succeeded; commit is a single `CommandTransaction`, hence a single undo.
`checkBaseRevision` runs immediately before commit and throws
`RevisionConflictError` rather than applying a stale plan.

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
- **`ToolScope` is coarse.** It is `affectsTimeline: boolean` and friends, not
  the read/write/spend split the architecture wants
  (`timeline.read` vs `timeline.write` vs `provider.spend`).
- **Two execution modes, not four.** Default and Permissive exist; "suggest
  only" and "auto-apply low-risk" do not, and paid or destructive actions have
  no policy separate from ordinary edits.
- **No agent/model/provider taxonomy.** `provider-sdk` exists but Hermes and
  KiloCode are not modelled as *adapters* distinct from reasoning models
  (GPT/Claude) and media providers (Flux/Kling), and nothing publishes a
  capability manifest.
- **No async job path in the agent loop.** `job-protocol` exists but plan steps
  of `mode: 'job'` are not dispatched to the Worker; only synchronous timeline
  commands run.
- **Revision is the editor's history cursor**, not a durable per-project
  revision id. It is monotonic within a session, which is enough to catch a
  concurrent edit, but it does not survive reload and is not the
  `collaboration-core` revision.
- **Determinism claim corrected.** The source proposal asserted "everything
  must be deterministic". That cannot hold once generative providers are
  involved. The rule adopted is: *command execution is deterministic and
  replayable; generative operations must record enough provenance (provider,
  model, version, prompt, seed, input hashes, cost) to be reproduced as closely
  as the provider permits.* Undo can remove a generated asset from the project;
  it cannot reverse credits already spent.

## Validation and rollback

`packages/agent-tools/src/shorten-intro.test.ts` — 22 tests covering the loop:
query, plan ordering, dry-run purity, one-transaction commit, exact rippled
result, other tracks untouched, envelope completeness, one-step undo,
all-or-nothing failure, policy blocking, and revision conflict in both
directions.

Rollback is contained: `runPlanAtomically` and `envelope.ts` are additive, and
the Agent panel can be pointed back at `PlanExecutor.execute` by reverting one
call site — at the cost of reintroducing the multi-step undo bug.

## Related contracts/tests

- ADR-0002 (time base), ADR-0003 (command/transaction/undo semantics)
- ADR-0012 (collaboration conflict model) — the durable revision this slice
  approximates with the session history cursor
- `plan/P06-agent.md`, `plan/WP-15-agent-editor-integration.md`
