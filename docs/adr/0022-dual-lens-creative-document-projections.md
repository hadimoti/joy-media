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

## Consequences

Editors can keep the timeline they already understand, inspect a composable
media/data graph when needed, or compare both at once. Frame tracing explains
the picture and sound at the playhead without implying that inactive sources
are contributing.

The current projection joins the two schema slices in memory. Consolidating
timeline storage into `JoyProjectV1` remains a schema migration, not a reason to
create graph-specific project state.
