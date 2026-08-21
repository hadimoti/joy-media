# Task 8 Implementer Report

## Scope

- Added `@joy-media/render-planner`, a pure package that builds `RenderFrameIR` plus bounded frame requirements from timeline/visual snapshots.
- Defined `RenderBundleV1` with opaque asset descriptors, output preset, seed, visual snapshot, and timeline snapshot; local filesystem refs are rejected.
- Added `planRenderFrame` coverage for video source samples, transition dual inputs, playback-rate/freeze semantics, still-image bitmap requirements, HTML-scene capture requirements, caption burn-in, object effects, audio samples, output preset, missing-media findings, and path rejection.
- Switched editor monitor paint and browser export frame building to `planRenderFrame`, leaving DOM/video/canvas/fetch acquisition in the editor fulfillment layer.
- Follow-up: moved monitor partner-frame capture, monitor source-time selection, export clip preloading,
  export transition partner capture, and export decoder seeks onto `plan.videoSamples` so preview and
  browser export consume the same source-time plan.
- Review fix: HTML-scene capture requirements now preserve the requested frame `timeUs`, with an exact
  regression assertion in `plan-frame.test.ts`.
- Review fix: Monitor and browser export now derive HTML-scene/still fulfillment targets directly from
  planner-authored `captureRequirements`, reusing planner requirement ids plus object/asset refs while
  keeping DOM/OPFS/network work in the editor layer.
- Added focused helper/tests so capture-requirement consumption is exercised independently from the
  broader editor flow.
- Wired workspace references, Vitest alias, Vite alias, editor dependency, and lockfile metadata.

## Files

- `packages/render-planner/package.json`
- `packages/render-planner/tsconfig.json`
- `packages/render-planner/src/types.ts`
- `packages/render-planner/src/render-bundle.ts`
- `packages/render-planner/src/plan-frame.ts`
- `packages/render-planner/src/index.ts`
- `packages/render-planner/src/plan-frame.test.ts`
- `apps/editor-web/package.json`
- `apps/editor-web/src/App.tsx`
- `apps/editor-web/src/html-scene-surfaces.ts`
- `apps/editor-web/src/html-scene-surfaces.test.ts`
- `apps/editor-web/src/render-plan-capture-targets.ts`
- `apps/editor-web/src/render-plan-capture-targets.test.ts`
- `apps/editor-web/tsconfig.json`
- `apps/editor-web/vite.config.ts`
- `tsconfig.json`
- `vitest.config.ts`
- `pnpm-lock.yaml`

## Verification

Command:

```powershell
pnpm --filter @joy-media/render-planner build
```

Result: passed.

Review-fix command:

```powershell
pnpm --pm-on-fail=ignore -C C:\Users\HadiMoti\joy-media exec vitest run packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/editor-web-live-gate.test.ts apps/editor-web/src/render-plan-capture-targets.test.ts apps/editor-web/src/html-scene-surfaces.test.ts
```

Result: passed.

Key output:

```text
Test Files  4 passed (4)
     Tests  11 passed (11)
```

Review-fix command:

```powershell
pnpm --pm-on-fail=ignore -C C:\Users\HadiMoti\joy-media --filter @joy-media/render-planner build
```

Result: passed.

Review-fix command:

```powershell
pnpm --pm-on-fail=ignore -C C:\Users\HadiMoti\joy-media --filter @joy-media/editor-web build
```

Result: passed; Vite build completed with the existing large-chunk warning.

Review-fix command:

```powershell
pnpm --pm-on-fail=ignore -C C:\Users\HadiMoti\joy-media exec prettier --check packages/render-planner/src/plan-frame.ts packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/App.tsx apps/editor-web/src/html-scene-surfaces.ts apps/editor-web/src/html-scene-surfaces.test.ts apps/editor-web/src/render-plan-capture-targets.ts apps/editor-web/src/render-plan-capture-targets.test.ts
```

Result: passed; all matched files use Prettier code style.

Review-fix command:

```powershell
git -C C:\Users\HadiMoti\joy-media diff --check
```

Result: passed.

Command:

```powershell
pnpm exec vitest run packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/editor-web-live-gate.test.ts
```

Result: passed.

Key output:

```text
Test Files  2 passed (2)
     Tests  6 passed (6)
```

Command:

```powershell
pnpm --filter @joy-media/editor-web build
```

Result: passed; Vite build completed with the existing large-chunk warning.

Command:

```powershell
pnpm exec prettier --check packages/render-planner/src/plan-frame.test.ts packages/render-planner/src/plan-frame.ts packages/render-planner/src/render-bundle.ts packages/render-planner/src/types.ts packages/render-planner/src/index.ts packages/render-planner/package.json packages/render-planner/tsconfig.json apps/editor-web/src/App.tsx apps/editor-web/package.json apps/editor-web/tsconfig.json apps/editor-web/vite.config.ts tsconfig.json vitest.config.ts
```

Result: passed; all matched files use Prettier code style.

Command:

```powershell
git -C C:\Users\HadiMoti\joy-media diff --check
```

Result: passed.

Follow-up command:

```powershell
pnpm exec vitest run packages/render-planner/src/plan-frame.test.ts apps/editor-web/src/editor-web-live-gate.test.ts
```

Result: passed.

Follow-up command:

```powershell
pnpm --filter @joy-media/editor-web build
```

Result: passed; Vite build completed with the existing large-chunk warning.

Follow-up command:

```powershell
pnpm --filter @joy-media/render-planner build
```

Result: passed.

Follow-up command:

```powershell
pnpm exec prettier --check apps/editor-web/src/App.tsx packages/render-planner/src/plan-frame.test.ts packages/render-planner/src/plan-frame.ts packages/render-planner/src/render-bundle.ts packages/render-planner/src/types.ts packages/render-planner/src/index.ts packages/render-planner/package.json packages/render-planner/tsconfig.json apps/editor-web/package.json apps/editor-web/tsconfig.json apps/editor-web/vite.config.ts tsconfig.json vitest.config.ts
```

Result: passed.

Follow-up command:

```powershell
git -C C:\Users\HadiMoti\joy-media diff --check
```

Result: passed.

## Commit

```text
7615a89 feat(render): share one frame plan across preview and export
f485a5c fix(render): drive browser export from frame planner
```

## Review Package

```text
.superpowers/sdd/P18-joy-media-finalization/review-f12c1f2..7615a89.diff
.superpowers/sdd/P18-joy-media-finalization/review-0746699..f485a5c.diff
```
