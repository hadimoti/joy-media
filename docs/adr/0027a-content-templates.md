# ADR-0027a: Content templates (Templates panel)

Status: Proposed

Date: 2026-07-30

Supersedes: ADR-0027 (extended, not replaced)

## Context

The Expansion Plan commits to a Templates panel (§1.0) that lets users apply
pre-built content — HTML scene overlays — via a dock panel. Unlike ADR-0027
workflow templates (which build Dual Lens graph nodes and edges), content
templates place clips and visual objects directly on the timeline. A content
template is not a graph workflow; it is a bundle of timeline placements and
visual-object insertions that land as one undo step.

## Decision

**Extend ADR-0027.** Content templates are transactions, not saved manifests.
`buildContentTemplateTransaction` produces the same atomic unit: a single
`CommandTransaction` + `VisualObjectTransaction` pair dispatched through the
existing `EditorSession` methods. The mental model is the same: "apply a
template → one undoable unit."

## Key divergences from workflow templates

1. **Duplicate application is allowed.** A user may want two title overlays or
   two lower-thirds. The seed ensures deterministic IDs but the builder does
   not reject re-application.
2. **Both CommandTransaction and VisualObjectTransaction paths.** Content
   templates produce timeline commands and visual-object commands in one
   compound dispatch, not a `GraphTransaction`.
3. **No port validation.** Content templates place clips and objects; there
   are no graph ports to validate. The validation is at the project level
   (non-overlapping clips, unique IDs).

## How `addHtmlSceneToSelectedClip` maps to template apply

The existing pattern (App.tsx:1162–1273) is a three-step compound operation:
1. `dispatchVisualObjects` with `htmlScene.create` — creates a
   `VisualObjectV1` of `kind: 'html-scene'`
2. `dispatchTimeline` with `timeline.insertClip` (+ optionally
   `timeline.addTrack`) — places the clip on the timeline
3. `bindClipToObject` — binds clip → object in `pluginData['joy.clipObjects']`

A content template's `html-scene` action mirrors this exactly, but:
- IDs are derived from the seed (deterministic), not `Date.now()`
- Duration is a fixed 5 seconds, not bound to the selected clip
- Placement cascades (offset by 40px per scene) with non-overlapping time
- The template does NOT require a selection — it creates its own clips

## Consequences

- `buildContentTemplateTransaction` handles both html-scene and future action
  kinds in a single function
- The Templates panel calls this function and dispatches through the editor
  session
- Duplicate application is allowed; seed determinism keeps IDs stable
- Undo is a single step that reverses all clip placements and visual object
  insertions

## Validation plan

`apps/editor-web/src/content-template-transaction.test.ts` asserts:
- Each html-scene action produces one visual object + one timeline clip + one binding
- Multiple actions in one template batch into single dispatch calls
- Seed determinism: same seed → same IDs
- Two seeds: distinct IDs
- Duplicate apply: no rejection
- The result is a valid project

## Related ADRs

- ADR-0027 (workflow templates)
- ADR-0003 (deterministic IDs from seed)
