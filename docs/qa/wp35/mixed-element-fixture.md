# WP-35 Mixed-Element Fixtures

WP-35 retains three complementary evidence layers:

1. The schema/evaluator fixture covers video, alpha image, text, shape, HTML
   scene, audio, caption, and nested composition bindings across neutral tracks.
2. `authenticated-mixed-elements.png` is captured by the authenticated
   Playwright case from the Timeline Elements Showcase. It displays backend-
   derived titles and mixed Timeline blocks in the real editor shell.
3. `gpu-worker-mixed-frame.png` is produced by the actual Worker GPU host on an
   NVIDIA RTX 5070 Ti. It contains a decoded RGBA video bitmap, overlapping GPU
   overlay, title, and caption plate at the default Quarter quality.

Reproduce the browser screenshot:

```powershell
$env:PLAYWRIGHT_WORKERS='1'
$env:WP35_SCREENSHOT_PATH='<repo>\docs\qa\wp35\authenticated-mixed-elements.png'
pnpm exec playwright test tests/e2e/wp35-universal-timeline.spec.ts `
  --project=desktop-primary --grep "backend track titles"
```

Reproduce the hardware pixel fixture after building the Worker:

```powershell
pnpm --filter @joy-media/worker build
node tooling/verify-wp35-gpu-preview.mjs
```

The source assertions remain in:

- `packages/project-schema/src/universal-timeline.test.ts`;
- `packages/evaluator/src/active-timeline-render-plan.test.ts`;
- `apps/editor-web/src/universal-placement.test.ts`;
- `apps/api/src/gpu-preview-transport.test.ts`;
- `packages/job-protocol/src/preview.test.ts`;
- `tests/e2e/wp35-universal-timeline.spec.ts`.
