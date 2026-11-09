# Attended receipts (owner-at-PC desktop checks)

Status: the receipt contract, the preflight and the first scenario (restart, save and export) are
built and tested. The discovery run is done (2026-11-09, below). The first live run of the scenario
passed on 2026-11-09 (plan section 17y). Its receipt is in the run folder. It is not committed, not
published, and not yet read by the gate.

## What a receipt is

A receipt is a JSON file that a **scripted** run writes for one attended scenario. It is accepted
only when it binds to the candidate commit and the app binary, every required check passed on the
first attempt, and the guards show that the joy:// key and the owner's asset library did not change.
The contract and the refusal rules are in `tooling/release/src/attended-receipt.ts`, with tests in
`attended-receipt.test.ts`.

Manual runs are never receipts. A run driven by hand is partial evidence, and it is recorded as such.

## Rules

- Each run needs the owner at the PC and a yes that names the run. Building and the preflight do not
  launch the app.
- The run stops if the joy:// key is not the expected value, or if a JOY process is already running.
- Run folders go under a scratch area. Never the owner's asset library, Desktop, Downloads, the
  installed JOY Media folder, or the main checkout.

## Preflight (no launch)

```
node --experimental-strip-types tooling/release/attended/attended-preflight.mjs \
  --exe <unpacked copy>\joy-media.exe --candidate <40-hex commit> \
  --profile <new profile folder> --library <scratch library with catalog.json> \
  --out <run folder>
```

It hashes the app, checks `resources\app\node_modules\playwright-core`, checks that the run paths are
outside the owner's folders, counts the owner's default library, checks ffmpeg and ffprobe, looks for a
running joy-media.exe, and exports the joy:// key into the run folder. It writes `preflight.json` and
exits 0 only when every check passes (2 when blocked).

## Bridge findings (source reads, 2026-11-09)

- The app exposes `window.joyDesktop.invoke(channel, payload)` in the page's main world
  (`apps/desktop/src/preload/preload.cjs`). A remote-debugging client can call it, so a run does not
  need native dialogs.
- Channels the editor uses for a run (`apps/editor-web/src/local-media-client.ts`):
  - `desktop.media.asset.register` with `{ id, kind, displayName, sha256, bytes, descriptor }`
  - `desktop.media.asset.upload-original` with `{ assetId, bytes }`; above a size threshold, the chunked
    path is `upload-original-chunk` with `{ assetId, offset, bytes }` and then `upload-original-finish`
  - `desktop.media.project.document.get` and `desktop.media.project.document.put` with `{ projectId, ... }`
  - `desktop.media.render.enqueue` with `{ refId, payload }`, which returns `{ jobId }`
  - `desktop.media.job.status` with `{ jobId }`, and `desktop.media.derivative.bytes` with `{ jobId }`,
    which returns `{ mimeType, bytes }`
- No project-create channel is in the allowlist. A run needs the project document format to create a
  project and its timeline. The discovery run records that format.

## Discovery run (2026-11-09, owner at the PC)

Partial evidence, not a receipt. The owner said "Yes, launch it".

- The preflight (preflight-5) returned `ready` just before launch. The candidate copy
  `C:\jgp\attended-ded976c8-20261109\app\joy-media.exe` ran on profile A with
  `--user-data-dir=...\profile-a --remote-debugging-port=9339` (PID 69032). It exited after the probe
  closed the window.
- The data folder comes from Electron's userData path (`electron-entry.js`:
  `resolveDesktopPaths(app.getPath('userData'))`), so the `--user-data-dir` switch sent the app to
  profile A.
- The bridge works from the editor page. `desktop.media.project.document.get` returned
  `{ projectId, revisionId, document, lookInstances }` for the profile's one project. That project row
  was unchanged after the run.
- Read-only calls only: `desktop.media.project.document.get`, `desktop.asset-library.get-settings`,
  `desktop.media.workers.list`, and `desktop.window-close` at the end. Nothing was put, registered,
  uploaded or rendered.
- The app reported the scratch library (`...\library`, not the default, catalog present, 3 entries).
- One worker was up, with `asset.thumbnail`, `render.export` and `text.lm-studio`.
- After the run: the joy:// key was af05be55 again, no JOY process was left, the owner library still had
  3,221 files, and the installed folder and `AppData\Roaming\@joy-media` were not modified.
- The profile A database file was written at launch (probably the worker's hello). The project row was not.

### Document shape (JoyProjectV1, from the stored document)

- Top level: `schemaVersion`, `id`, `title`, `createdAt`, `updatedAt`, `exportPreset`, `settings`,
  `rootCompositionId`, `assets`, `audio`, `captionDocuments`, `compositions`, `markers`, `pluginData`,
  `timelineTrackDeck`, `universalTimeline`, `variables`, `visualObjects`.
- `assets` is keyed by asset id (`joylib-<sha256>`). Each has `id`, `kind`, `displayName`, `sha256`,
  `bytes` and `descriptor` (`mimeType`, `width`, `height`, `durationUs`).
- `compositions.root`: `id`, `name`, `width`, `height`, `frameRate {num, den}`,
  `pixelAspectRatio {num, den}`, `durationUs`, `background`, and `tracks[]` (`id`, `kind`, `name`,
  `order`, `enabled`, `locked`, `clips`).
- `universalTimeline.items[]` holds the clip placement: `id`, `compositionId`, `elementKind`,
  `source {kind, id}`, `trackId`, `startUs`, `durationUs`, `sourceInUs`, `withinTrackOrder`.
- `visualObjects` is keyed by element id: `id`, `kind`, `assetId`, and `transform {x, y, scaleX, scaleY,
  rotationDeg, opacity, crop {top, right, bottom, left}}`.
- `audio`: `buses[]` (`id`, `name`, `gain`, `pan`, `mute`, `solo`, `inputs`), `clips` keyed by clip id,
  and `effects[]`.
- The `lookInstances` envelope is `{ id, instances, schemaVersion }`.

The raw response is in the run folder as `raw-document-result.json`, and the shape summary is in
`probe-result.json`. Neither is a receipt.

## The first scenario: restart, save and export

Code: `tooling/release/src/attended-scenario.ts` (the steps and the rules, no I/O), with the driver
`attended/scenario-driver.mjs` and the runner `attended/run-scenario.mjs`. Tests: `attended-scenario.test.ts`
(fake driver) and `attended-rules.test.ts`.

The steps use the bridge calls the editor uses. The project is saved through the document channel,
the app is restarted on the same profile, the project is reopened, and an export runs through the
worker. The export input is an MP4 that ffmpeg encodes to the render manifest, so this scenario does
not check the browser compositor or the picture. The semantics scenario covers those.

```
node --experimental-strip-types tooling/release/attended/run-scenario.mjs \
  --scenario desktop.app.restart-save-export --exe <unpacked copy>\joy-media.exe \
  --candidate <40-hex commit> --expected-exe-sha256 <64-hex build hash> \
  --profile-source <profile holding the project> --profile <new folder>\profile \
  --library <scratch library with catalog.json> --out <new run folder> \
  --project <project id> [--port 9339] [--launch]
```

- Without `--launch` the runner runs the preflight and the refusals, reads the source profile through
  a copy, and prints the plan. It copies no profile and starts nothing.
- With `--launch`, after the owner's yes that names the run, it copies the profile, checks that the
  copy's asset library is the scratch library, and runs the scenario. It writes `run.json`, and
  `receipt.json` only when every check passed and every guard held. An exception writes `error.json`.
- The guards (joy:// key, JOY processes, owner library, installed folder) are checked before launch,
  between the two launches, and after the run.

## What is not built yet

1. Done: the first live run of restart-save-export passed on 2026-11-09 (plan 17y).
2. **Other scenario steps**: fresh profile through the editable project; export semantics with a decode
   and a frame comparison, including a dissolve; the Windows entry points.
3. **Gate wiring**: the single-pass readiness generator must read these receipts for the attended
   scenarios. This changes gate policy, so it needs the owner's decision first.

Lifecycle receipts have their own producer and are not part of this contract.
