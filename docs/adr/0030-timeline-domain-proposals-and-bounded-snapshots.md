# ADR-0030: Timeline-domain proposals, and bounding the snapshot log

Status: Accepted

Date: 2026-07-27

## Context

ADR-0028 left three gaps open. Two of them turned out to be the same gap seen
from both ends, and the third hid a data-loss bug in ADR-0028's own mechanism.

- **Timeline-domain proposals were never applied.** The domain existed in the
  proposal schema and the apply path reported such edits as unapplied — honest,
  but inert. No built-in specialist emitted one either, so the honesty had never
  been tested against a real proposal.
- **Snapshot growth was unbounded.** Every document replacement writes a
  snapshot and nothing pruned them.
- Investigating that growth surfaced a **silent data-loss bug** in
  `latestRevision`, described below. It matters more than either gap.

## Decision

**`latestRevision` counts snapshots as well as transactions.** This is the data
loss fix, and it is a defect in ADR-0028's own `saveSnapshot`.

`LocalProjectPersistence.latestRevision()` counted transaction revisions only.
`saveSnapshot` writes no transaction, so two consecutive document replacements
were assigned the *same* revision number — and `recover()` picks the first of a
tie, so the second replacement was silently lost on reload. A `saveTransaction`
written after a `saveSnapshot` collided the same way and was skipped during
replay. `latestRevision` now takes the max over both.

Recording this plainly: ADR-0028 moved replacement onto `saveSnapshot` to fix
one durability bug and introduced another in the same move. The lesson is that
revision assignment must consider every writer to the log, not the one the
author happens to be thinking about.

**Retention is part of the write, not a prune pass.**
`ProjectStore.writeSnapshot` takes an optional `retainSnapshots`, a shared
`retainNewestSnapshots()` helper appends and trims, and all three stores
implement it. `LocalProjectPersistence` retains 5 by default.

A separate prune call was the obvious shape and is the wrong one here: the
browser and desktop stores serialize the whole database per write, so pruning
after writing would double the cost of the exact path being bounded.

**A specialist emits timeline edits, so the path is exercised.** `PACING_AGENT`
is a 4th built-in. It finds gaps of 500 ms or more *between* clips and proposes
`domain: 'timeline'` edits carrying `startUs`.

Gaps before the first clip are excluded — a hole at the top of a sequence is
usually a deliberate beat, and an agent that closes it is destroying intent
rather than fixing pacing. The cursor accumulates across proposals, so a run of
gaps closes up instead of each proposal contradicting the one before it. Clips
outside the run's scope are reported as warnings, not silently proposed for.

**Conflicts are keyed on domain + target, not target alone.**
`ProposalConflict` gained a `domain` field. Without this the pacing agent and
the audio agent conflict on every clip they both touch, even though a clip's
position and its gain cannot overwrite one another — the review would fill with
conflicts that are not conflicts, and users would learn to approve through them.

**An approved change set is still exactly one undo.** `planChangeSet` splits
proposals by domain so neither half reports the other's work as unapplied, and
returns a document transaction and an optional timeline transaction. Both go
through the single `dispatchCompound` that ADR-0028 built.

**The timeline half is dry-run whole, then kept or discarded whole.**
`buildTimelineChangeSet` resolves each edit to `timeline.moveClip` and/or
`timeline.trimClipEnd` and dry-runs the entire transaction, discarding all of it
if any command would be refused. This matches the document half's existing
all-or-nothing rule: a partially applied pacing pass leaves a sequence in a state
no one asked for and no single Undo describes.

`applyChangeSet` keeps its old signature and its guard against timeline edits,
for direct callers.

## Alternatives considered

- **Pruning snapshots in a background pass.** Rejected: it doubles the
  serialization cost of the write it bounds, and it makes the bound eventual
  rather than an invariant of the store.
- **Giving snapshots their own revision sequence.** Rejected — replay orders
  snapshots and transactions against each other, so they must share one
  ordering. Two sequences would only move the tie somewhere harder to see.
- **Keying conflicts on target alone and letting the user sort it out.**
  Rejected: it trains people to approve through warnings, which defeats review.
- **Letting the pacing agent close the gap before the first clip.** Rejected as
  above — it cannot distinguish a mistake from an intended opening beat.
- **Applying the document half even when the timeline half is refused.**
  Rejected: one approval must mean one outcome.

## Consequences

- Two consecutive document replacements both survive a reload. Previously the
  second was lost.
- The snapshot log is bounded at 5 per project and still recovers the newest.
- Approving a pacing finding actually moves clips, and one Undo puts them back
  together with the document half.
- Cost: retention is a silent data-discarding policy. Five is a guess informed
  by nothing but the size of a replacement, and recovery beyond five
  replacements ago is now impossible by design.
- Cost: `combineProposals` conflict output changed shape; a consumer reading
  conflicts by target alone will now see them split by domain.

## Gaps deliberately left open

- **Transaction logs are still unpruned.** Only snapshots are bounded. Deltas
  are small, but the log grows without limit in a long session.
- **No conflict re-check at apply time.** Inherited from ADR-0028 and unchanged:
  conflicts are caught when combining, and a project that moved in between is
  caught only by the coarser revision check.
- **Review state is not durable.** Reloading mid-review loses the proposals.
- **No budget in money.** `SpecialistBudget` caps specialists and edits;
  `provider.spend` is capability-gated but no currency limit is enforced.
- **Pixel output is still not asserted.** Unchanged from ADR-0028 — the WebGL
  context has no `preserveDrawingBuffer`.

## Validation and rollback

`packages/project-persistence/src/persistence.test.ts` — 3 tests: two
consecutive replacements both survive, a transaction written after a replacement
replays, and the log stays bounded at retention 3 while still recovering the
newest. Uses a local `insertAt(id, startUs)` helper, because the existing
`insert()` always inserts at 0 and a run of them overlaps.

`packages/agent-tools/src/specialists.test.ts` — 4 pacing tests and 2
conflict-domain tests; 33 pass. One existing test was corrected: `caps how many
specialists one run may use` now asserts `BUILT_IN_SPECIALISTS.length - 1`
rather than the literal 2, which was only ever right by coincidence.

`apps/editor-web/src/apply-change-set.test.ts` — 5 new tests over a `gapped()`
fixture builder, covering the split by domain, the whole-transaction dry run,
and the refusal path.

`npx tsc -b` clean; full suite 1574 passing with 2 pre-existing
environment-only failures (`faster_whisper` absent, RNNoise model at a VPS-only
path).

Rollback: the `latestRevision` fix should not be rolled back — reverting it
restores silent data loss. Retention can be disabled by passing a large
`snapshotRetention`. `PACING_AGENT` can be removed from `BUILT_IN_SPECIALISTS`
without touching the apply path, and the whole review surface renders only when
`DUAL_LENS_FLAG_KEY` is `'on'`, which it is not in production.

**Not yet verified in a browser.** The pacing round trip — open a gap, run
review, approve, confirm the clip moves and one Undo restores it — has not been
exercised in a running editor.

## Related contracts/tests

- ADR-0003 (undo semantics), ADR-0010 (snapshot and command log persistence),
  ADR-0019 (one undo per agent run), ADR-0026 (specialists — closes its
  timeline-domain gap), ADR-0028 (applying change sets — closes two of its gaps
  and amends its `saveSnapshot`)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §8.2, §10.4, §17
