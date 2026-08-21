# render-host

Deterministic render host for Worker-owned exports.

The package exposes two surfaces:

- `src/render-page.ts`: the pinned offline Chromium page entry. It consumes shared `RenderFramePlan` objects and paints them through the browser Pixi adapter.
- `src/index.ts`: the Worker-side driver used by tests and local exports. It plans frames from `RenderBundleV1`, preflights opaque media through a Worker-private resolver, renders frames lazily, and streams RGBA pixels into FFmpeg.

The host never serializes local filesystem paths into receipts or protocol payloads. Worker-private path mappings stay behind the resolver boundary.
