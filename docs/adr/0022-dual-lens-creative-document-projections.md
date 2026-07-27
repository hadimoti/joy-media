# ADR-0022: Dual Lens as Creative Document projections

Status: Accepted

Date: 2026-07-26

## Context

A conventional timeline answers when media appears, but hides the dependency
chain between media, structured text, prompts, models, agent change sets, and
the rendered result. A node graph can explain that chain, but creating a second
editable graph document would introduce another source of truth and divergent
undo, revision, and collaboration behavior.

The editor currently persists timeline and visual-object schema slices through
one `EditorSession`. Until timeline commands graduate into the v1 project
document, the session revision is the boundary that joins those slices.

## Decision

- Dual Lens presents Time View, Flow View, and synchronized Split View.
- Both views are projections of the live `EditorSession` Creative Document
  state. The Flow graph has no separate persistence or mutation engine.
- Timeline and Flow share the editor playhead. Seeking in either projection
  updates the Program Monitor and all other playhead consumers.
- Frame-to-Flow Trace begins with objects and data whose placed ranges contain
  the current playhead, then follows only their upstream dependencies to the
  Program Output. It does not treat every input to the output as active.
- Text, audio, captions, scripts, prompts, model outputs, and agent change sets
  are data lanes. Advanced lanes are collapsed by default to preserve a
  familiar editing surface.
- Every durable edit still passes through the existing semantic command buses,
  revision checks, atomic run boundary, and unified undo history.
- The product promise for the lens is: “Edit in time. Understand in flow.”

## Amendment — crossing between the lenses, 2026-07-27

Projection alone is only half of "one document, two lenses". Flow was built as a
self-contained panel: it derived its own projection, held its own state, and had
no way to reach the editor's selection. Two views of one document that cannot
point at each other are still two views.

- **One projection, built once.** `buildDualLensProjection` moved into the
  editor and is published on the panel context. The timeline ribbon and the Flow
  panel read the same object, so they cannot disagree about what produced the
  selection.
- **Nodes declare their timeline bindings.** `DualLensNode.clipIds` records
  which clips a node stands for. Reveal and selection resolve through it rather
  than parsing the `kind:value` node id, which stays a display detail.
- **Selection is the editor's, mirrored in Flow.** The panel highlights the
  editor selection and never stores its own copy. Clicking a node selects its
  clips; it does not move the playhead. Navigation stays an explicit act —
  double-click, or the scrubber — because switching lenses must not silently
  change the Program frame.
- **`Reveal in Flow` / `Reveal on Timeline`.** A clip's context menu reveals it
  in Flow; a focused node reveals its clips on the timeline. Both select and
  activate the other panel, and neither dispatches a command.
- **Provenance ribbon above the real timeline.** The selected item's causal
  chain reads source-first (`asset-intro → intro → JOY → Program Output`).
  Ordering is by dependency depth, not display column: a provider and the asset
  it generated share a column, and ordering by column would claim the asset came
  first. Each step reveals its node in Flow.

Reveal is presentation and selection only. Nothing in this amendment can mutate
the project, which is what keeps Phase 2 safe to ship ahead of the artifact and
provenance schema.

## Consequences

Editors can keep the timeline they already understand, inspect a composable
media/data graph when needed, or compare both at once. Frame tracing explains
the picture and sound at the playhead without implying that inactive sources
are contributing.

The current projection joins the two schema slices in memory. Consolidating
timeline storage into `JoyProjectV1` remains a schema migration, not a reason to
create graph-specific project state.

## Gaps deliberately left open

Recorded so they are chosen, not forgotten:

- **No artifact or provenance schema.** Nodes are derived from the timeline,
  visual objects, caption documents, and asset generation records that already
  exist. `CreativeArtifact`, `TemporalBinding`, `ArtifactProvenance`, versions,
  and their migrations are not modelled, so a script, prompt, or analysis result
  has no durable identity of its own.
- **No persisted workflow graph.** Nodes and edges are recomputed per render.
  Typed ports, DAG validation, caching, and staleness are `workflow-engine`
  concerns not yet joined to this projection.
- **The graph is read-only.** No graph action dispatches a command, which is why
  a graph command family, its inversions, and grouping/subgraphs are absent.
- **Dual Lens is not behind a feature flag,** unlike what the phase plan asks
  for. It ships as an ordinary panel because it cannot mutate the project; a
  flag becomes necessary at the first editable graph command.
- **`Follow Selection` is not configurable.** Reveal always activates the other
  panel. A preference belongs with the settings surface that does not exist yet.

## Validation

`apps/editor-web/src/dual-lens-reveal.test.ts` — 11 tests covering selection in
both directions, shared-asset binding accumulation, unplaced nodes resolving to
no clip, and ribbon ordering including the provider-before-asset case.
`dual-lens-model.test.ts` continues to cover frame tracing and lane
classification.

Verified in the browser: revealing a clip switches to Flow, focuses its node,
and marks the clip, its asset, and its layer selected; revealing back selects
the clip on the timeline and updates the ribbon; the playhead does not move in
either direction.
