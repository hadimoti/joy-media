# ADR-0027: Workflow templates

Status: Accepted

Date: 2026-07-27

## Context

Phase 6 asks for four templates — Auto Captions, Podcast Cleanup, Reel Finish,
Generate B-roll — plus polish: onboarding hints that disappear after use,
reduced-motion support, and a one-minute demo.

A template is the first thing in this plan that a user meets before
understanding anything else, so the risk is not technical. It is that a template
looks like a workflow without being one — a picture of a chain rather than a
graph the engine will actually run.

## Decision

**A template is a transaction, not a saved graph.** `buildTemplateTransaction`
returns a `GraphTransaction`, so everything Phase 3 established still holds: the
result is validated, checked port by port, and lands as one undo. A template
that could not be built by hand cannot be built by a button either.

**Nodes and links are declared separately, not as a chain.** Two of the four are
not chains — Reel Finish runs colour and audio review in parallel into one gate
(§11.2), and Podcast Cleanup forks one recording into a caption branch and a
cleanup branch (§11.4). A linear model would have forced those into a line that
does not type-check: colour review's change set is not something audio cleanup
can read. This was caught while writing the templates, and the model changed
rather than the description being softened.

**Port types carry the meaning.** Auto Captions connects only because
audio → transcript → caption style → caption track is compatible end to end.
Adding `accepts` entries where a template needed them (sequence into colour
review, audio or sequence into audio cleanup) is a declaration on the port, not
a special case in the template — consistent with ADR-0024's reason for keeping
compatibility off a central table.

**Every write to the sequence sits behind a review gate.** The templates that
end in `timeline.write` all pass through `review.gate` first, and generation
declares `provider.spend` up front so the policy engine can refuse before
anything runs. There is a test asserting this across all templates, so a future
template cannot quietly add an ungated writer.

**Ids derive from a seed**, so the same seed rebuilds the same graph (ADR-0003
determinism) and a second copy under the same seed is refused rather than
duplicating ids.

**The hint disappears on first use and stays gone.** It is keyed in local
storage and cleared the moment a workflow exists, not on a timer.

**Reduced motion covers the Dual Lens surfaces**, not only the one animation
that predated them.

## Alternatives considered

- **Ship templates as pre-built graph JSON.** Rejected: it bypasses the command
  bus, so a stale template would produce a graph the validator rejects at load
  rather than at authoring time.
- **A linear chain model with exceptions.** Rejected once Reel Finish showed
  the parallel shape is the point of the template, not a variation on a line.
- **Generating node ids randomly.** Rejected by ADR-0003; the seed keeps replay
  deterministic and makes double-application an explicit refusal.

## Consequences

- Four templates build real, validated, type-checked graphs in one undo.
- A template cannot introduce an ungated write or an incompatible connection.
- Applying the same template twice is refused rather than silently duplicating.
- New node types are available to both the palette and templates.

## Gaps deliberately left open

- **Templates create graphs; they do not run them.** Execution is Phase 5's
  specialist path and the async job path, neither of which the graph triggers.
- **`Create Workflow from Selection` is not wired.** Templates seed a
  `scopeLabel` but ignore the actual selection, so a template is currently
  project-wide.
- **No Time ↔ Flow continuity animation.** §3.4 allows a 160–220 ms anchored
  transition between lenses; only hover/transition polish landed, and the
  reduced-motion block is in place for when the real one arrives.
- **The one-minute demo is not truthful yet.** §17 step 8 requires the timeline,
  captions, Inspector, and Program Monitor to update together on approval —
  which needs change-set application (ADR-0026's open gap). The demo can show
  reveal, trace, templates, and undo today; it cannot yet show an approved
  change reaching the picture.
- **Accessibility is partial.** The graph and lane surfaces are buttons and
  lists, so they are keyboard reachable and screen-reader legible, but there is
  no keyboard traversal between connected nodes (§12.5).

## Validation and rollback

`apps/editor-web/src/workflow-templates.test.ts` — 20 tests: every template
applies cleanly through the real command bus, validates, reverts in one undo,
and names only node types that exist; Reel Finish's two specialists converge on
one gate; Podcast Cleanup forks the recording; Generate B-roll declares provider
spend and approval; every timeline writer across all templates requires
approval; the same seed is deterministic; two seeds coexist; the same seed twice
is refused.

Verified in the browser: all four templates offered with the hint shown on a
fresh graph; Reel Finish produced 5 nodes and 5 edges in exactly the parallel
shape; the hint disappeared and stayed gone; one Undo removed the whole
template.

Rollback is contained: templates are additive and the surface renders only when
`DUAL_LENS_FLAG_KEY` is `'on'`.

## Related contracts/tests

- ADR-0003 (deterministic ids), ADR-0024 (graph commands, port compatibility),
  ADR-0026 (specialists)
- `JOY_MEDIA_UNIFIED_DATA_TIMELINE_AND_AGENT_FLOW_PLAN.md` §3.4, §11, §16, §17
