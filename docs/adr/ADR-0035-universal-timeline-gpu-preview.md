# ADR-0035: Universal Timeline and Preview Renderer Contract

Status: Accepted and implemented

## Decisions

- Normal Timeline tracks are universal compatibility layers. Track names and
  icons are presentation metadata; they never reject an element by kind.
- The top visible Timeline row is the front visual layer. The active render
  projection emits lower layers first and assigns stable `zIndex` values.
- Monitor and export filter bound objects through active Timeline intervals;
  legacy unbound objects remain global for compatibility.
- Preview quality is a per-browser preference (`Quarter`, `Half`, `Full`) and
  never changes authored composition or export dimensions. New profiles use
  Quarter (0.25× each axis).
- The Worker capability `render.preview.gpu` is additive and fail-closed. It is
  not a durable job type and must only be advertised after a real hardware
  renderer probe. The browser keeps a local Pixi/WebGL fallback and reports the
  renderer actually in use.
- Timeline placement and its creative-document binding are committed through
  `EditorSession.dispatchCompound()` when the placement entry point owns both
  documents.

## Compatibility matrix

| Element                | Any normal track | Timeline block | Monitor           | Audio graph                | Export          |
| ---------------------- | ---------------- | -------------- | ----------------- | -------------------------- | --------------- |
| Video                  | yes              | yes            | decoded frame     | embedded/replacement audio | yes             |
| Audio                  | yes              | yes            | no visual node    | yes                        | yes             |
| Image/GIF/WebP         | yes              | yes            | alpha-aware frame | no                         | yes             |
| Text/shape/caption     | yes              | yes            | IR node/burn-in   | no                         | yes             |
| HTML scene             | yes              | yes            | captured surface  | optional                   | yes             |
| Composition            | yes              | yes            | nested plan       | nested audio               | yes             |
| Camera/null controller | yes              | yes            | controller only   | no                         | controller only |

## Implementation record

The durable Worker job channel remains unchanged. GPU preview uses a separate,
in-memory, latest-wins relay with random project/subject/Worker-bound sessions,
replay and rate limits, strict frame/PNG bounds, and `no-store` responses. The
Worker advertises the capability only after a WebGL2 hardware probe rejects
software renderers. A long-lived Edge/Chrome page renders evaluated
`RenderFrameIR`, decoded RGBA video surfaces, text, and captions in z-order.

The browser keeps local Pixi rendering active for playback and fallback. While
paused or scrubbing it can display the latest matching Worker PNG; late frames
cannot replace a newer request. Hardware identity and a deterministic Quarter
pixel fixture are recorded under `docs/qa/wp35`.
