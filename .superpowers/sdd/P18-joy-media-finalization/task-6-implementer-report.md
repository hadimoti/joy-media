# Task 6 Implementer Report

## Scope

- Added a repo-local Playwright browser smoke package.
- Added the editor e2e spec wrapper for the real-media reopen journey.
- Added a redistributable synthetic MP4 fixture with visual timecode and audible tone because no equivalent existed under `packages/test-fixtures/media/`.
- Updated the smoke package command to be self-contained: without `JOY_MEDIA_BROWSER_URL` it starts the repo editor Vite server, waits for the port, runs the journey, and terminates the child process; with `JOY_MEDIA_BROWSER_URL` it reuses the caller-provided server.
- No app runtime defects required fixing; issues found during red runs were confined to the new runner.

## Files

- `apps/editor-web/e2e/real-media-loop.spec.ts`
- `tooling/browser-smoke/package.json`
- `tooling/browser-smoke/tsconfig.json`
- `tooling/browser-smoke/src/run.ts`
- `tooling/browser-smoke/src/run.test.ts`
- `packages/test-fixtures/media/timecode-tone.mp4`
- `pnpm-lock.yaml`

## Browser Journey Proven

The smoke runner performs:

1. Fresh browser context with seeded JOY Media token and mocked `/api` boundary.
2. Waits for `networkidle`, inspects rendered DOM, then acts through visible UI controls.
3. Creates a blank project.
4. Imports `packages/test-fixtures/media/timecode-tone.mp4` through the Assets local import drawer.
5. Drags the imported local asset to the timeline.
6. Asserts exactly one timeline clip near the beginning of the composition.
7. Reloads the page and asserts the one clip reopens.
8. Seeks into the clip and proves the monitor video source is `blob:`.
9. Captures two decoded frames and asserts nonblank/changing pixels.
10. Asserts audio readiness through captured audio tracks / decoded audio bytes.
11. Reopens Assets and confirms the imported video is visible.

The runner does not use `/media/reference/*`.

## Verification

### Editor build

Command:

```powershell
pnpm --filter @joy-media/editor-web build
```

Result: passed.

Key output:

```text
$ vite build
vite v7.3.6 building client environment for production...
transforming...
✓ 1266 modules transformed.
rendering chunks...
computing gzip size...
✓ built in 4.86s
```

Note: Vite emitted the existing large chunk warning for `three` / app bundles.

### Browser smoke runner unit test

Command:

```powershell
pnpm --filter @joy-media/browser-smoke exec tsx --test src/run.test.ts
```

Result: passed.

Key output:

```text
# tests 2
# suites 1
# pass 2
# fail 0
```

### Browser smoke command

Command:

```powershell
pnpm --filter @joy-media/browser-smoke smoke:real-media-loop
```

Result: passed. This run did not set `JOY_MEDIA_BROWSER_URL` and did not use `with_server.py`; the package command started and stopped the editor dev server itself.

Captured console output:

```text
$ tsx src/run.ts
[smoke] starting editor server: pnpm.cmd --filter @joy-media/editor-web dev --host 127.0.0.1 --port 5173 --strictPort
[server] $ vite "--host" "127.0.0.1" "--port" "5173" "--strictPort"
[server]
  VITE v7.3.6  ready in 188 ms

[server]   ➜  Local:   http://127.0.0.1:5173/
[smoke] editor server ready on http://127.0.0.1:5173
[browser:debug] [vite] connecting...
[browser:debug] [vite] connected.
[browser:info] %cDownload the React DevTools for a better development experience: https://react.dev/link/react-devtools font-weight:bold
[smoke] initial DOM {"buttonLabels":["New project","Local editor projectLast updated: Aug 21, 2026, 07:32 PM","Delete Local editor project"],"panelLabels":["New project","Delete Local editor project"],"fileInputs":0}
[browser:pageerror] Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.
[browser:error] Failed to load resource: the server responded with a status of 404 (Not Found)
[browser:pageerror] Failed to load /transitions/preview/transition2.png
[browser:warning] [.WebGL-0x93c001afc00]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels
[smoke] registered asset {"id":"real-media-loop","projectId":"project-486d4da5-cc2b-4602-a28b-76e2f8922e1a","kind":"video","displayName":"timecode-tone.mp4","sha256":"904080fda237ac3b2c8a29d16b440860d0ae545d0fb2aba483c67f19b4ad40d1","bytes":146012,"descriptor":{"mimeType":"video/mp4"},"tags":["category-video","browser-smoke"],"createdAt":1787328171591}
[smoke] timeline after import [{"label":"Real-media-loop-1787328171821","title":"Real-media-loop-1787328171821 · 0.5s–5.5s"}]
[browser:debug] [vite] connecting...
[browser:debug] [vite] connected.
[smoke] timeline after reload [{"label":"Real-media-loop-1787328171821","title":"Real-media-loop-1787328171821 · 0.5s–5.5s"}]
[smoke] frame probe {"firstHash":"6c42809b","secondHash":"4d88257f","firstMean":125.30112268518519,"secondMean":124.86521990740741,"changedPixels":14604,"width":320,"height":180,"readyState":4,"duration":3,"currentSrcScheme":"blob"}
[smoke] audio probe {"readyState":4,"duration":3,"audioTracks":0,"captureStreamAudioTracks":1,"webkitAudioDecodedByteCount":41832}
[smoke] reopened Assets with imported media visible
```

Non-fatal browser console noise observed during the passing run:

- Sandboxed HTML-scene frames attempt to read `localStorage` without `allow-same-origin`.
- Transition preview thumbnail URLs such as `/transitions/preview/transition2.png` return 404.
- Chromium logged WebGL `ReadPixels` performance warnings.

### Smoke package typecheck

Command:

```powershell
pnpm --filter @joy-media/browser-smoke exec tsc -p tsconfig.json --noEmit
```

Result: passed.

### Post-smoke server cleanup check

Command:

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess
```

Result: exit code 1 with no rows, confirming the self-started server was no longer listening after the smoke command returned.

## Suggested Commit

```text
test(editor): make browser smoke self-contained
```
