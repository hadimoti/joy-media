# editor-web

> **Status: P01.4 editor-shell baseline in progress.** React/Vite shell, recoverable user workspace preference, command palette/shortcuts, ephemeral selection/playhead state, and a schema-driven transform/opacity Inspector are in place.
> Contract: [`JOY_MEDIA_MASTER_PLAN.md`](../../JOY_MEDIA_MASTER_PLAN.md) §6.1, §8.1, §17 · Work plan: [`ORCHESTRATION.md`](../../ORCHESTRATION.md)

**Role.** React/Vite editor application: workspace, timeline interaction, Inspector, preview controls, command dispatch, job monitoring.

**Visible copy.** Panel titles and controls remain English. Explanatory copy,
guidance, empty states, live status, and placeholders are Persian and use
`lang="fa"`. They are centered with Modam Pro and must not set an explicit RTL
or LTR direction; isolate inline technical tokens with `<bdi>` or `<code>`.
See [`DESIGN.md`](../../DESIGN.md) §4d–§4f. The visible shell lockup reads
**JOY Studio**; repository, API, storage, package, and domain identifiers remain
JOY Media.

**First built in part:** P01. Do not scaffold code here before that part is marked active in [`STATE.md`](../../STATE.md).

**Must not:** Direct database writes, model-specific logic, trusted arbitrary plugin code, putting the project document into React state.

Dependency rule (§9.1): the graph points inward — apps depend on packages, packages depend on schema/primitives, never the reverse, and core packages never import from `apps/*`.

## Release evidence

The authenticated 1.0 browser journey must cover project open, timeline edit, Motion Studio
publish/place/preview, save/reopen, undo/redo, and verified export. Record it as
`authenticated-editor-1.0` evidence for the repository release gate; never claim a browser journey
from a build-only check.
