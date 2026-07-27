# ADR-0028: Applying change sets across buses

Status: Accepted

Date: 2026-07-27

## Context

ADR-0026 shipped specialists that propose and record change sets but do not
apply them, which left the product claim half true: the review could tell you
what should change and then not change it. §17's demo depends on the other
half — approve once, and the picture updates.

The obstacle was structural. Applying an approved change set touches the
creative document *and* records the change set as an artifact. Those live on
different buses, each with its own history, and the session's history stack held
exactly one operation per entry. Dispatching both would put two entries on the
stack, so one Undo would leave the project holding a record of a change that was
no longer applied.

## Decision

**A history entry names a list of operations, not one.** `dispatchCompound`
applies each part, lets each bus keep its own inverse record exactly as a single
dispatch would, and records one entry naming them. Undo walks the list in
reverse — a compound applied document-then-artifact undoes
artifact-then-document — so the halves cannot come apart.

**A document replacement carries its own before/after pair.** Replacement has no
command form, so the object history cannot compute an inverse for it. The
session keeps the pair under a `document-snapshot` operation rather than
inventing a synthetic command that would have to be inverted anyway.

**Replacement persists as a snapshot, not an empty transaction.** This surfaced
a real pre-existing bug: `replaceVisualProject` was calling `saveTransaction`
with `commands: []`, which the object adapter rejects outright — and even if it
had not, an empty transaction replays to the *previous* document, so the change
would have been lost on reload. `LocalProjectPersistence.saveSnapshot` is the
durable path for changes that have no command form, and `replaceVisualProject`
now uses it too.

**Application refuses to pretend.** Every edit resolves to something the editor
owns — the master grade, a caption clip's timing, or a timeline clip's audio
settings — and anything else is reported as unapplied. A change set claiming to
have been applied when it was not is worse than one admitting it could not be.
The whole result is discarded if it would produce a document the v1 validator
rejects, so a specialist cannot corrupt the project through this path.

**Timeline clip ids are passed in.** Audio settings are keyed by clip, and those
clips live in the timeline, not this document. Found while testing: without the
id set, an edit naming a clip that does not exist silently created an orphan
audio config instead of being reported.

**`Create Workflow from Selection`** is closed alongside this: templates take
the selection's label and bind their *source* nodes to its range. Downstream
nodes are left unbound because they derive their time from what they receive,
and binding them would assert a range the workflow has not established.

## Alternatives considered

- **Two history entries and asking users to undo twice.** Rejected — it is the
  multi-undo problem ADR-0019 already fixed for agent runs, reintroduced.
- **A synthetic command for document replacement.** Rejected: it would still
  need a hand-written inverse, so it buys nothing over keeping the pair.
- **Letting audio edits create configs for unknown ids.** Rejected once the test
  showed it silently succeeding on a clip that does not exist.

## Consequences

- An approved specialist change set now changes the project, durably.
- One Undo reverts the document change and its record together.
- `replaceVisualProject` is durable for the first time.
- Compound entries appear in history as `compound`.
- Cost: a document replacement writes a full snapshot rather than a delta.

## Amendment — review pass, 2026-07-27

A review of the whole Dual Lens body of work found two defects in this ADR's
own mechanism, both now fixed and covered:

- **A compound could apply partially.** `dispatchCompound` mutated each bus in
  sequence, so an artifact transaction that threw — a duplicate id, or the flag
  being off — left the document already replaced and persisted with no history
  entry naming it. That is precisely the split this method exists to prevent,
  reintroduced by its own failure path. Everything that can throw is now
  evaluated before anything is written.
- **Per-bus redo stacks were cleared unevenly.** A new dispatch cleared the
  unified redo stack and only its own bus's, leaving the others holding records
  no history entry referred to. Harmless while they sat below the top, but a
  hazard the moment the stacks fell out of step. `#recordCompound` now clears
  all of them.

**The render link is verified.** `buildRenderFrameOptions` reads
`project.colorGrade` from the same document the compound writes. Confirmed live:
applying the colour specialist put saturation `1.05` into the Color panel, and
one Undo returned it to `1.00`.

## Amendment — `saveSnapshot` collided revisions, 2026-07-27

The move to `saveSnapshot` above fixed one durability bug and introduced
another, which is worth recording rather than quietly fixing in ADR-0030.

`LocalProjectPersistence.latestRevision()` counted **transaction** revisions
only. A snapshot writes no transaction, so two consecutive document
replacements were assigned the *same* revision — and `recover()` picks the
first of a tie, so the second replacement was silently lost on reload. A
`saveTransaction` written after a `saveSnapshot` collided the same way and was
skipped during replay. Nothing surfaced this: the write succeeded, the in-memory
document was correct, and only a reload showed the loss.

Fixed in ADR-0030: `latestRevision` takes the max over transactions **and**
snapshots. The general lesson is that revision assignment has to consider every
writer to the log, not the one the author is thinking about at the time.

## Gaps deliberately left open

- ~~**Timeline-domain proposals are still not applied.**~~ Closed by ADR-0030:
  `PACING_AGENT` emits them, and `planChangeSet` splits an approved change set
  across the document and timeline buses into one `dispatchCompound` — so the
  mechanism this ADR built now carries a second domain, as intended.
- **No conflict re-check at apply time.** Conflicts are caught when combining;
  a project that changed between combine and apply is caught by the revision
  check instead, which is coarser.
- ~~**Snapshot growth is unbounded.**~~ Closed by ADR-0030: snapshots are
  retained newest-5 as part of the write.
- **Pixel output is not asserted.** The grade reaches the document the renderer
  builds from, and a consumer panel reflects it, but no test reads the canvas —
  the WebGL context has no `preserveDrawingBuffer`, so pixel comparison would
  need a renderer-side harness.

## Validation and rollback

`apps/editor-web/src/apply-change-set.test.ts` — 13 tests: grade set and
partially updated without resetting siblings, audio config written for a real
clip, caption retimed, input never mutated, unresolvable target reported,
timeline-domain edits refused, invalid results discarded whole, one compound
undo and redo moving both halves, a later timeline edit left untouched, the
revision advancing, and an empty compound recording nothing.

Verified in the browser: approving two of three specialists wrote
`colorGrade: {saturation: 1.05, lutId: 'rec709'}` and audio configs for all five
clips into the persisted snapshot; one Undo removed both the document change and
the artifact record, leaving the log holding the compensating transaction.

Rollback is contained: `applyChangeSet` and `dispatchCompound` are additive, and
the review surface renders only when `DUAL_LENS_FLAG_KEY` is `'on'`. The one
change outside that boundary is `saveSnapshot`, which replaces a call path that
could not succeed.

## Related contracts/tests

- ADR-0003 (undo semantics), ADR-0019 (one undo per agent run), ADR-0025
  (artifacts), ADR-0026 (specialists), ADR-0027 (templates)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §8.2, §10.4, §17
