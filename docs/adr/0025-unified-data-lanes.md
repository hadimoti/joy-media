# ADR-0025: Unified data lanes and artifact authoring

Status: Accepted

Date: 2026-07-27

## Context

ADR-0023 gave scripts, prompts, analyses, and change sets a durable shape.
ADR-0024 made the workflow graph authorable. Neither made the _data_ authorable:
`artifact.*` commands did not exist, so the schema could describe a project that
no code path could produce, and the timeline had nowhere to show it.

Phase 4 asks for that data to appear against time, and attaches a constraint
that shapes the whole design: **normal projects must stay uncluttered by
default**. A drawer that shows everything is easy; one that earns each row it
takes is the actual requirement.

## Decision

**Artifacts are a command family** (`artifact-commands.ts`), in the same form as
timeline and graph commands: pure over an immutable store, inverse from
pre-state, validated before return, caller-supplied ids.

**Versioning is the reason the store is not a plain record.** §5.3 requires
non-destructive change, so replacing content pushes the prior state onto the
artifact's version list, and `promoteVersion` moves an old state back to current
by the same mechanism — retaining the one it replaces, so going back does not
depend on undo. A **rename does not create a version**, and neither does a
content write that changes nothing; otherwise history fills with entries that
differ in nothing a user can see.

**Lanes are derived, and empty lanes are omitted.** `buildDataLanes` reads
artifacts, the workflow graph, and existing document slices. A lane appears only
when it has items, because a row of nothing is exactly the clutter the phase
forbids. Plain media and metadata are deliberately excluded — they are already
on the tracks above, and repeating them would double-count one thing in one
drawer.

**Unplaced artifacts stay visible.** An artifact bound to `none` renders as a
chip rather than being hidden. "We have a script but it is not attached to
anything yet" is a real state the editor has to be able to show and let the user
fix; dropping it would make the drawer lie about what the project contains.

**The drawer is collapsed by default** and shares the tracks' `timeToPixel`, so
a prompt bound to 00:12–00:28 sits under the footage it describes rather than
near it.

**Staleness is per-item.** An artifact produced by a workflow node inherits that
node's stale status, so invalidation is visible where the data lives and does
not spill onto unrelated artifacts.

**Non-renderable data is kept out of Render IR by construction.**
`selectRenderableArtifacts` is the single sanctioned filter for anything that
renders. Stating the rule in prose is not enforceable; making it the one
function every render path calls is, because a caller that wants a script in the
picture has to visibly bypass it. Scripts, prompts, analyses, and change sets
influence the picture by producing commands — never by being handed to the
renderer.

**Authoring is limited to what a person actually writes by hand:** script,
prompt, and note. Transcripts, generated media, and change sets arrive from
workflows and agents, and offering a button to fabricate them would invite
artifacts whose provenance claims a producer that never ran.

## Alternatives considered

- **Put data lanes only in the Dual Lens panel.** Rejected: §6.2 puts them in
  the timeline the editor already uses, and a second mini-timeline would be a
  second thing to keep in sync.
- **Version on every update.** Rejected — renames would flood the tray.
- **Hide unplaced artifacts until bound.** Rejected: it makes the project look
  emptier than it is and leaves no way to find the thing that needs binding.
- **Migrate caption documents into artifacts.** Rejected, consistent with
  ADR-0023: they are read from where they already live rather than duplicated
  into a second identity.
- **A `renderableArtifacts` boolean on each artifact.** Rejected: renderability
  follows from kind, and a per-artifact flag could disagree with its own kind.

## Consequences

- Scripts, prompts, analyses, generated output, agent change sets, review gates,
  and running work are visible against the time they affect.
- Data edits are one Undo, on the same history as timeline and graph edits.
- A project with no artifacts shows no artifact lanes at all.
- Artifact edits advance `projectRevisionId`, so a plan built before a script
  changed is correctly stale.
- Cost: lanes are rebuilt per render rather than memoized, because the session
  exposes stable references and signals change through a counter — a memo keyed
  on those references would go stale. It walks artifacts and nodes once.

## Gaps deliberately left open

- **Artifact content is not editable in the UI.** Creation binds an empty inline
  value; there is no editor for the text, so the version tray can be exercised
  by promotion but not yet by typing.
- **`track`, `item`, and `selection` bindings render as unplaced.** They are
  representable and resolvable in principle; resolving them to a span needs the
  timeline lookup that Phase 5 will want anyway.
- **Turning the flag off does not delete logs already written.** Off stops all
  reading and writing, and a project that never had it on stores nothing — but a
  project that did keeps its artifact and graph logs until something removes
  them. Deleting user data on a flag toggle would be worse.
- **No partial caption invalidation.** Caption items never report stale, because
  caption documents are not artifacts and carry no producing node.
- **Nothing consumes `selectRenderableArtifacts` yet**, because no render path
  takes artifacts at all. That is the strongest form of "does not leak", and
  also means the guard is currently unexercised in production code.

## Validation and rollback

`packages/commands/src/artifact-commands.test.ts` — 16 tests: create/delete
inverses, restore with versions, versioning only on real content change,
promotion retaining the replaced state, pin/unpin inversion, binding rejection
leaving the store untouched, and transaction atomicity.

`apps/editor-web/src/data-lanes.test.ts` — 13 tests: no lanes without
artifacts, empty lanes omitted, media not duplicated, range/point/unplaced
placement and ordering, per-item staleness without spill, gates and runs as
lanes, renderable selection dropping script/prompt/analysis/changeSet, and
artifact edits sharing the one history.

Verified in the browser: the drawer is collapsed by default and absent entirely
with the flag off; adding a script places it at 0–5 s beside the caption lane;
the version tray opens; one Undo removes the artifact and leaves all five clips
untouched.

Rollback is contained: the editor path is inert unless `DUAL_LENS_FLAG_KEY` is
`'on'`, so production behaviour is unchanged.

## Related contracts/tests

- ADR-0003 (command/transaction/undo), ADR-0019 (provenance and determinism)
- ADR-0022 (Dual Lens projections), ADR-0023 (artifact schema), ADR-0024 (graph)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §5.3, §5.4, §6, §16
