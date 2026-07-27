# ADR-0029: Navigating a workflow graph — groups and keyboard traversal

Status: Accepted

Date: 2026-07-27

## Context

ADR-0024 made the workflow graph editable and ADR-0027 gave it templates, so
graphs in practice stopped being three nodes long. Two navigation gaps that were
tolerable at three nodes became structural at twenty, and both were named in
§12.5 and left open by ADR-0027:

- **No way to say "these nodes are one thing."** A graph that has grown by
  template insertion is a flat field of nodes with no stated structure, and
  nothing in the schema could record that a run of them is an ingest stage.
- **No keyboard traversal between connected nodes.** The Flow canvas could be
  reached by Tab, but not moved through. A fork's second branch was unreachable
  without a mouse — not a polish item but an accessibility hole, since the graph
  is the only surface where some edits can be made at all.

## Decision

**Grouping is organisation, not nesting.** `WorkflowGroupV2 { id, label,
nodeIds }` names a set of nodes. The node list stays flat and edges are
untouched, so a group can never change what the graph means or how it executes —
deleting every group in a project leaves an identical computation.

`WorkflowGraphV2.groups` is optional, so every graph authored before grouping
stays valid unchanged and `EMPTY_WORKFLOW_GRAPH` needs no migration.

**A node belongs to at most one group.** `validateGroups` enforces unique group
ids, a non-empty label, node ids that exist in the graph, and single ownership.
Two owners would make "which group am I in" unanswerable, and the breadcrumb is
exactly that question — so this is a schema invariant rather than a UI
convention.

**Cache keys are untouched.** `computeNodeCacheKey` reads only node fields and
upstream edges. Grouping therefore never invalidates a cached result, and a test
asserts it rather than leaving it to be rediscovered.

**Grouping is undoable like everything else.** Four commands —
`graph.group.create`, `.delete`, `.setNodes`, `.setLabel` — each with an
inverse. `graph.node.delete` drops the node from its group and records that
group in its inverse, and `graph.restoreNode` takes an optional `groupId`, so
undoing a deletion does not quietly return the node ungrouped.

**Boundary-crossing edges stay visible when drilled in.** Filtering to a group
hides the nodes outside it but keeps edges that cross the boundary listed.
Hiding them would make a group look self-contained when it is not, which is the
one lie this feature could tell.

**Traversal follows the graph, and stops at its edges.** `traverseGraph` is pure
and DOM-free: left/right follow edges in declaration order, up/down move within
a column (same `x`), which is how a fork's second branch becomes reachable, and
Home/End jump to first/last in layout order. It returns `undefined` at the ends
rather than wrapping — wrapping would claim a connection the graph does not
have, and the keyboard user is precisely the one who cannot see that it is
false.

`preventDefault()` is called only when the move actually happened, so an
unhandled arrow still scrolls the page.

## Alternatives considered

- **True nested subgraphs — a node containing a graph.** Rejected for now. It
  needs port proxying across the group boundary so an inner node can consume an
  outer input, and a recursive validator and cache key. Neither the engine nor
  the cache key is built for that, and the shape that answers "these nodes are
  one thing" does not require it.
- **Groups as a UI-only concern, stored outside the schema.** Rejected: a group
  that does not survive save/reload is not organisation, it is decoration. It
  also could not be undone, since undo runs over commands on the document.
- **Letting a node sit in several groups.** Rejected: the breadcrumb has no
  answer, and neither does the drill-in filter.
- **Wrapping traversal at the ends.** Rejected as above.
- **Deriving groups from layout proximity.** Rejected — it would silently
  regroup nodes whenever anything moved.

## Consequences

- A graph can state its own structure, and that statement is durable, validated,
  and undoable.
- The Flow canvas is operable without a mouse.
- Grouping cannot change execution, so it is safe to add to any existing project.
- Cost: `WorkflowGraphV2` gains an optional field that every consumer must treat
  as possibly absent. `exactOptionalPropertyTypes` is on, so it must be spread
  conditionally rather than assigned `undefined`.
- Cost: the group list is a second place where node ids appear, so node deletion
  now has to maintain two structures instead of one.

## Gaps deliberately left open

- **Nested subgraphs.** As above — grouping is flat. Real nesting is a separate
  decision with its own ADR.
- **Groups do not collapse into a single rendered node.** Drill-in filters the
  view; it does not substitute a proxy node in the parent view.
- **No group-level execution policy.** Capabilities remain per-node. A group
  cannot yet assert "everything in here requires approval."
- **Traversal has no notion of the drill-in filter.** Arrowing from inside an
  open group can move focus to a node outside it.
- **No Time ↔ Flow continuity animation** (§3.4 allows 160–220 ms anchored).
  The `prefers-reduced-motion` block is already in place for when it lands.

## Validation and rollback

`packages/project-schema/src/v2.test.ts` — 6 tests: a valid group validates
clean, an absent `groups` key stays clean, a group naming an absent node reports
`GRAPH_GROUP_NODE_MISSING`, a node in two groups reports
`GRAPH_GROUP_NODE_SHARED`, duplicate ids report `GRAPH_GROUP_DUPLICATE`, and an
empty label reports `GRAPH_GROUP_LABEL`.

`packages/commands/src/graph-commands.test.ts` — 8 tests covering the four
commands and their inverses, node deletion carrying group membership through
undo, and the assertion that `computeNodeCacheKey` is unchanged by grouping.
All 44 in that file pass.

`apps/editor-web/src/graph-traversal.test.ts` — 8 tests: edges followed in both
directions, column movement reaching a fork's second branch, Home/End, and
`undefined` at the ends rather than a wrap.

Rollback is contained. `groups` is optional and unread by the engine, so
dropping the UI leaves existing projects valid; the commands are additive to
`GRAPH_COMMAND_REGISTRY`; and the whole surface renders only when
`DUAL_LENS_FLAG_KEY` is `'on'`, which it is not in production.

**Verified in the browser**, 2026-07-27, against a running editor with the
`DUAL_LENS_FLAG_KEY` flag on:

- Grouping: checked two nodes from an inserted Auto Captions template, grouped
  them, renamed the group inline (committed on blur), opened it (breadcrumb
  read `Workflow / Captions`), confirmed the view filtered to the two members
  while the edge crossing the boundary (`Transcribe → Caption style`) stayed
  listed, returned to the top level, ungrouped, and confirmed one Undo restored
  the group with its label intact.
- Traversal: focused a clip node in the Flow graph and drove every key —
  Left/Right followed the edge to the node's source asset and back, Down/Up
  moved within the column to the sibling clip and back, Home/End jumped to the
  first/last node in layout order, and Left from the first node moved nothing
  and left `defaultPrevented: false`, confirmed via an instrumented capture-phase
  listener — matching the no-wrap design exactly.

No React key or ref warnings were observed in the console during any of this.

## Related contracts/tests

- ADR-0003 (undo semantics), ADR-0023 (workflow schema), ADR-0024 (editable
  graph commands), ADR-0027 (templates — closes its §12.5 traversal gap)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §12.5, §3.4
