# ADR-0024: Editable workflow graph through the command bus

Status: Accepted

Date: 2026-07-27

## Context

ADR-0023 gave the workflow graph a durable shape but nothing that could author
one: the document could represent a graph that no code path was able to create,
change, or undo. Phase 3 of the unified data timeline plan closes that, under a
constraint its non-goals state twice — do not build a second project document,
and do not build a second undo/redo system.

That constraint is the whole design problem. A graph editor naturally wants its
own model and its own undo stack, and both would be wrong here: the user makes
one sequence of edits, some in Time and some in Flow, and expects one Undo to
step back through it in the order they worked.

## Decision

**Graph edits are a command family, not a subsystem.** `applyGraphCommand`
mirrors `applyCommand` exactly: pure over an immutable value, returning the next
graph and its inverse computed from pre-state, with the result validated before
it is returned. Ids are supplied by callers, never generated, so serialization
and replay stay deterministic (ADR-0003). This follows the precedent already set
by `audio-commands` and `voice-commands`, which are command families over their
own state without owning history.

**There is deliberately no `WorkflowGraphHistory`.** `applyGraphTransaction`
returns inverses in the same shape `applyTransaction` does, and the editor's
single unified history holds the record alongside timeline, audio, and document
records. A graph-only stack would break "one Undo = one thing I did" the moment
a user touched both lenses in one session.

**Deleting a node takes its edges with it, and the inverse restores both.**
`graph.restoreNode` carries the node and the edges that were detached — the same
shape `timeline.restoreTrackClips` uses to invert a compound timeline edit.
Leaving the edges would strand them pointing at a node that no longer exists,
which the validator rejects; dropping them without recording them would make
undo lossy.

**Port compatibility is declared by ports, not by a central type table.** An
input's `accepts` list names extra upstream `dataType`s it will take; `any` on
either side is a wildcard. There is no subtype hierarchy, because an inheritance
tree living in the document format would be a migration every time it changed —
the same reasoning that kept type compatibility out of the schema in ADR-0023.
A single-value input refuses a second connection, since otherwise which upstream
value it receives would depend on edge ordering.

**Invalidation returns commands.** `invalidateDownstream` produces
`graph.node.setStatus` commands rather than a mutated graph. Marking nodes stale
is a project mutation, and writing it directly would be a back door around the
bus: it would not undo, would not appear in history, and would not show up in a
dry run. It skips already-stale nodes so an invalidation cannot land on the undo
stack as an entry that changed nothing, and it honours pinned nodes so a re-run
cannot quietly discard a version the user kept.

**Cache keys exclude `ui`.** Moving a node on the canvas must cost no
recomputation. This is ADR-0023's view-state/creative-meaning split enforced at
the point where blurring it would have a real price. Config is serialized with
sorted keys, so re-saving a project cannot invalidate every node over property
order.

**Dry-run diffs the real applied result** rather than predicting from the
command list, so a knock-on effect — deleting a node dropping its edges — is
reported truthfully instead of as the single change the user asked for.

## Alternatives considered

- **A dedicated graph history class.** Rejected: it is precisely the second
  undo system the plan forbids, and it desynchronises cross-lens editing.
- **A central port type registry in `workflow-engine`.** Rejected: it would
  make `@joy-media/commands` depend on the engine, and every new node type
  would need a central registration to be connectable.
- **Letting invalidation mutate the graph directly.** Rejected: faster, but it
  puts a project mutation outside the command bus and therefore outside undo.
- **Generating node and edge ids inside commands.** Rejected by ADR-0003 —
  replay and serialization must be deterministic.
- **Storing status as a required field defaulting to `idle`.** Rejected after
  it produced a real bug: undoing a status change on a node that had never run
  wrote `status: 'idle'`, so the node came back from undo claiming a history it
  did not have. Status is optional and its inverse restores absence.

## Consequences

- Every graph mutation is a command, so all of them undo, appear in history,
  and can be dry-run or proposed by an agent through the same path.
- A cycle, dangling edge, unknown port, type mismatch, or unknown capability
  cannot be written, so an invalid graph is unstorable rather than merely
  unexecutable.
- A multi-command graph edit is one undo step.
- Unrelated branches keep their cached results when a node changes.
- Cost: `applyGraphCommand` validates the whole graph after each command, which
  is O(nodes + edges) per command. Irrelevant at authoring scale; it would need
  batching if a transaction ever carried thousands of commands.

## Gaps deliberately left open

- **No editor UI.** Nothing in `editor-web` dispatches a graph command; Flow
  remains the read-only projection from ADR-0022. Wiring these commands into a
  panel, behind `DUAL_LENS_FLAG_KEY`, is the remaining Phase 3 work.
- **No grouping or subgraphs.** Listed in Phase 3 deliverables, not built. The
  node schema has no group or parent reference, so this will need a schema
  addition rather than only commands.
- **Graph state is not yet in `EditorSession`.** The commands operate on a
  `WorkflowGraphV2` value; nothing persists one in a project yet, so the "one
  unified history" property is a property of the design here, not yet an
  observed behaviour of the running editor.
- **`workflow-engine` still has its own node definitions.** Reconciling its
  runtime nodes with these persisted contracts is not done.
- **Cache keys are not persisted.** `reportStaleness` compares against a
  recorded map that nothing yet writes.
- **No execution.** Running a node, cancellation, retries, and job dispatch are
  Phase 5.

## Validation and rollback

`packages/commands/src/graph-commands.test.ts` — 35 tests against the four
Phase 3 exit criteria: every mutation invertible (including compound delete and
partial update), cycles and self-edges rejected, port type mismatch and missing
ports rejected, single-value inputs protected while `multiple` inputs fan in,
rejected commands leaving the input untouched, multi-command transactions
reverting in one step, failed transactions discarding everything, dry-run
reporting knock-on effects and failures without throwing, cache keys responding
to config and upstream changes while ignoring canvas position and key order,
invalidation as commands with pinned-node protection, and UI state separable
from the domain graph.

Rollback is contained: `graph-commands.ts`, `graph-history.ts`, and
`graph-cache.ts` are additive and referenced by nothing outside their tests.

## Related contracts/tests

- ADR-0003 (command/transaction/undo semantics, deterministic ids)
- ADR-0022 (Dual Lens projections), ADR-0023 (artifact and graph schema)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §7, §9.3, §16, §20
