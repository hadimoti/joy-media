# workflow-engine

> **Status: active — runtime, authoring, operations, and first-party definitions are landed.**
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §23 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** Deterministic automation graphs: typed nodes/edges, checkpoints, idempotent runs, approval nodes.

**Landed (WP-07.1).** Versioned `JoyWorkflow` format (§23.3) with §23.2 node categories; DAG validation with coded issues and deterministic topological ordering; canonical-JSON sha-256 run keys (§23.5); a checkpointed synchronous runtime with retry policies, cooperative cancel, failure modes (`stop` / `continue-independent` / `manual`), and resume that never duplicates completed work (deterministic nodes reused by run key; nondeterministic reuse is policy-gated).

**Landed (WP-07.2).** Node library v1: `NodeRegistry` with typed per-node param validation and registry-level workflow checks; 22 concrete node types spanning all nine §23.2 categories, wired to narrow dependency-inverted ports (missing ports fail with coded, non-retryable errors); typed `ValueRef`s and pure `decision.condition` evaluation; §23.6 `decision.approval` parks runs as `waiting_for_input` without holding Worker resources (independent branches keep running, recorded decisions stay authoritative across resumes); `control.map` map/batch execution runs a sub-workflow per item with per-item run keys, partial-progress persistence, and resume that re-runs only unfinished items.

**Landed (WP-07.3).** JSON/code authoring, structural and DAG validation, schema-checked inputs/outputs, run dashboards, recorder/instrumentation, checkpoint JSON round-trip, and a headless CLI all ship in the package.

**Landed (WP-07.4).** First-party workflow definitions are versioned, pinned, and consumed by the editor-side runner/recording flow. Human-approval checkpoints remain honest: runs park as `waiting_for_input` until resumed with a decision.

**Must not:** Depending on free-form agent conversation for production automation (§2.10).

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.
