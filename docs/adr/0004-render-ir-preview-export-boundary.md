# ADR-0004: Evaluated Render IR is the preview/export boundary

Status: Accepted
Date: 2026-07-19

## Context

WP-00.3 needs the preview and export paths to agree without allowing PixiJS, DOM objects, decoders, or headless-renderer implementation details into the saved project model. The master plan requires a renderer-independent, ephemeral Render IR (§14.2) and golden parity tests (§2.2, §16.6).

## Decision

1. Preview and headless rendering consume the same evaluated `RenderFrameIR`, versioned independently from the project schema.
2. The IR is ephemeral: it represents one composition at one exact `timeUs`, with a viewport, evaluated transforms, resolved visual node values, and draw order. It is not saved in a project or command log.
3. The P00.3 subset contains only `sprite`, resolved `video-frame`, and bitmap `text` nodes. All nodes have stable IDs, explicit z-order, opacity, and an evaluated affine transform subset.
4. Evaluation/decoding happens before the boundary. The IR never contains Pixi objects, DOM/canvas objects, raw paths, decoder handles, or provider-specific fields.
5. Renderer adapters validate the IR at their boundary and reject malformed frames. Unsupported node types must be reported, never silently represented as a different semantic node.

## Alternatives considered

- **Render the project directly in each adapter** — rejected: duplicate timing/property logic would make preview/export drift inevitable.
- **Persist renderer-specific scene graphs** — rejected: nonportable, nonserializable state would leak into the creative document.
- **Use a generic JSON blob as IR** — rejected: it loses exhaustive type coverage and boundary validation.

## Consequences

- The current model is intentionally small; P01 extends it with property evaluation, more node kinds, diagnostics, color pipeline, and audio.
- Production PixiJS retained-object lifecycle and real media decoding remain out of scope for this spike. The P00 adapter proves the IR contract in fixed test mode only.
- Any future preview-only degradation must surface diagnostics rather than change the IR's intended output invisibly.

## Validation and rollback

`packages/render-ir/src/model.test.ts` verifies the contract boundary. `tooling/golden-render/src/index.test.ts` verifies that both adapters consume the same animated frame IR. A change to this boundary requires a superseding ADR and updated golden evidence.

## Related contracts/tests

`packages/render-ir/src/model.ts` · `packages/renderer-pixi/src/index.ts` · `packages/renderer-headless/src/index.ts` · master plan §14.1–§14.2, §15.2, §16.6.
