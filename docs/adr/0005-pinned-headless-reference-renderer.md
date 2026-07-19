# ADR-0005: Pinned headless reference renderer for initial parity tests

Status: Accepted
Date: 2026-07-19

## Context

WP-00.3 must make preview/export drift visible before a browser UI or FFmpeg pipeline exists. The project needs a reference path that can run deterministically in CI and a first golden-frame comparison (§16.1, §16.6).

## Decision

1. `@joy-media/renderer-headless` is the P00.3 reference path: a deterministic software rasterizer over `RenderFrameIR` with no browser, GPU, decoder, or wall-clock dependency.
2. `@joy-media/renderer-pixi` supplies a separate fixed-setting test-mode preview adapter. Its production retained PixiJS object implementation is deferred to P02; this spike does not claim GPU parity.
3. `@joy-media/golden-render` renders both paths for a 32×18 fixture at 0, 500,000, and 1,000,000 µs. The fixture contains one image, one resolved video frame, bitmap text, and an evaluated translate/scale animation.
4. The three FNV-1a 64 frame digests are pinned in source and preview/headless pixels must match exactly. The tolerance for this intentionally tiny software subset is zero.
5. The FNV digest is golden-test evidence, not a security or export-integrity checksum. Production render manifests will use a cryptographic output hash (P01+).

## Alternatives considered

- **Wait for FFmpeg/Puppeteer/real GPU infrastructure** — rejected: it postpones the Render IR boundary proof and makes CI environment-dependent.
- **Compare only adapter draw-call metadata** — rejected: it cannot detect compositing or transform drift.
- **Use a permissive perceptual tolerance immediately** — rejected: the P00.3 subset is fully deterministic; a tolerance would conceal a regression.

## Consequences

- The first golden project is intentionally synthetic; it has no copyright or media-codec dependencies.
- Future visual features may use documented perceptual tolerances only when their reference-render limitations require it, with an ADR explaining the threshold.
- This reference rasterizer is not yet a production export engine. FFmpeg muxing, asset decode, fonts, audio, color conversion, and full PixiJS behavior remain later work.

## Validation and rollback

`tooling/golden-render/src/index.test.ts` compares both renderers and all three pinned outputs. Revert a renderer change if it changes a digest without an intended, reviewed visual change and accompanying golden/ADR update.

## Related contracts/tests

`tooling/golden-render/src/index.ts` · `packages/renderer-headless/src/index.ts` · `packages/renderer-pixi/src/index.ts` · master plan §2.2, §15.2, §16.1, §16.6.
