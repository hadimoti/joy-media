# ADR-0023: Creative artifact, provenance, and workflow schema (v2)

Status: Accepted

Date: 2026-07-27

## Context

ADR-0022 made Flow a projection of live session state, and its 2026-07-27
amendment made the two lenses cross: selection, reveal, and a provenance ribbon.
Everything that projection shows is _derived_ — from timeline clips, visual
objects, caption documents, and `AssetRecordV1.generationProvenance`.

Derivation is enough to explain what already exists, and not enough for what
the phase after it needs. A script, a prompt, an analysis result, a proposed
agent change set, or a generated alternative has no durable identity in the
document. Without one it cannot be versioned, pinned, bound to a time range, or
cited as the source of something else — so there is nothing for a graph edge to
connect, and nothing for a re-run to invalidate.

The workflow graph has the same gap in reverse. `workflow-engine` can execute a
graph, but the project cannot _store_ one, so a graph cannot survive a reload,
be validated on import, or be edited through the command bus.

## Decision

**Artifacts get identity without being flattened.** `CreativeArtifact` records
kind, content reference, temporal binding, provenance, and revision.
Unification is by id, project ownership, binding, and typed relationship —
deliberately not by pretending a transcript is a video clip. `contentRef`
distinguishes `inline` structured data, an existing `asset`, another durable
`document` slice, and an `external` URI, so adding provenance to captions does
not copy them.

**Renderability is a property of kind, and it is enumerated.**
`RENDERABLE_ARTIFACT_KINDS` lists what may reach Render IR. Analysis, prompts,
scripts, and change sets influence the picture only through commands. This is
the schema-level form of plan §5.4: non-renderable data must never become a
fake layer.

**Temporal binding is a closed union in integer microseconds** (ADR-0002).
`none` is distinct from `global`: "not placed yet" is a state the Data Lane
drawer renders, not an absence to hide. A zero-length `range` is rejected —
it is a `point` wearing the wrong type, and allowing both would give "does this
contain the playhead" two answers.

**One capability vocabulary.** `CreativeCapability` lives in `project-schema`
because a workflow node persists the capabilities it requires, and
`@joy-media/agent-tools` now _aliases_ `ToolCapability` to it rather than
keeping the parallel copy it had. Two lists would drift, and a capability the
policy engine does not recognise grants nothing while still looking declared —
a failure in the direction of "the gate never fired". The dependency runs
agent-tools → project-schema, so the schema is the correct home.

**The graph is persisted, and cycles are rejected at the document level.**
`validateWorkflowGraph` checks node id uniqueness, edge endpoints, port
existence, capability names, and acyclicity. Cycle detection lives in the
schema and not only in `workflow-engine` because a cyclic graph must not be
_storable_: a hand-edited or imported project that round trips a cycle would
fail much later, at execution, far from the edit that caused it. Port _type_
compatibility stays in `workflow-engine`, so adding a node type does not
require a schema migration.

**v2 is additive.** `JoyProjectV2` is the v1 document plus three optional
containers. Every v1 field keeps its meaning and position, so a v1 document is
a valid v2 document with no graph. `migrateV1ToV2` adds empty containers and
nothing else, and `validateJoyProjectV2` delegates the v1 body to
`validateJoyProjectV1` rather than reimplementing it, so the two cannot
disagree about what a composition is.

**Migration does not synthesise artifacts** from existing assets, caption
documents, or visual objects. The Flow projection already derives nodes from
those; creating durable artifact records for the same things would give one
thing two identities — the derived node and the stored artifact — with no rule
for which wins. Artifacts are created when something actually authors one.

**The flag's off state is a property of the document, not the screen.**
`projectWithoutDualLens` returns exactly the v1 document, and
`applyDualLensFlags` routes through it when disabled. "Graph-disabled behavior
remains identical" is therefore asserted by a test rather than claimed by a
comment, and a user who turns the feature off cannot be left holding a document
the old path does not understand. The flag reads `'on'` and nothing else, and
a storage that throws fails closed.

## Alternatives considered

- **Reshape `JoyProjectV1` in place.** Rejected: it would force every consumer
  to move at once for a feature none of them use yet. Additive v2 lets the
  schema land with no editing surface touched.
- **Derive artifacts during migration.** Rejected above — two identities for
  one thing, and it would make a "no visible change" migration untestable.
- **Keep `ToolCapability` separate from the schema.** Rejected: it is the same
  vocabulary, and drift between them is silent.
- **Validate port type compatibility in the schema.** Rejected: node types are
  extensible, and pinning their type algebra into the document format would
  turn every new node type into a migration.
- **Persist the graph UI library's node format.** Rejected outright (plan
  §13.2). `ui.position` is explicitly view state; creative meaning and
  execution must not depend on pixel coordinates.

## Consequences

- Scripts, prompts, analyses, and change sets can be stored, versioned, bound
  to time, and cited as sources — the prerequisite for Phases 3 through 5.
- A stored graph is validated on load, edit, and import; a cycle cannot be
  written to disk.
- Agent tools and workflow nodes request authority from one enumerated list.
- Existing projects are unaffected: nothing reads the new containers yet.
- Cost: two document versions exist while consumers migrate, and
  `validateJoyProjectV2` runs the v1 validator over the same body.

## Gaps deliberately left open

- ~~**No commands write any of this.**~~ Closed for the graph by ADR-0024:
  `graph.node.*` and `graph.edge.*` exist with inverses, transactions, and
  dry-run. `artifact.*` commands (plan §9.3) are still absent, so artifacts
  remain unauthorable.
- **No Creative API facade.** `CreativeEditingFacade` (§9.1) is not built;
  queries still go through existing per-package APIs.
- **`workflow-engine` is not joined to these contracts.** It has its own node
  definitions; reconciling them is Phase 3 work.
- **No editor consumes v2.** `EditorSession` still holds v1. The flag exists
  and is off; wiring it into persistence is Phase 3.
- **Artifact versions have no retention policy.** Nothing prunes them, and
  nothing yet stops a pinned version from keeping media alive indefinitely.
- **No round-trip against a real persisted project.** Round-trip is tested
  through JSON in-memory; OPFS/control-plane persistence still stores v1.

## Validation and rollback

`packages/project-schema/src/v2.test.ts` — 29 tests: migration validity,
no-visible-change, no invented artifacts, `migrateToLatest` idempotency, JSON
round trip, flag-off equivalence to v1, flag fail-closed and hostile-storage
behavior, key/id agreement, orphan version rejection, provenance requiring a
model whenever a provider is claimed, renderable-kind separation, integer-only
time, zero-length range rejection, and graph rejection of cycles, self-edges,
dangling endpoints, unknown ports, duplicate ids, and unknown capabilities.

Rollback is contained: `creative.ts`, `v2.ts`, and `dual-lens-flag.ts` are
additive and unreferenced by any editing surface. The one non-additive change
is `ToolCapability` becoming an alias, which is type-level and reverts by
restoring the literal union.

## Related contracts/tests

- ADR-0002 (integer microsecond time), ADR-0003 (command/transaction/undo)
- ADR-0012 (collaboration revision model), ADR-0019 (agent envelope, capability
  policy, corrected determinism claim), ADR-0022 (Dual Lens projections)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §5, §7, §14.2, §16
