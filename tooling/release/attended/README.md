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
  installed JOY Media folder, or the main checkout. The preflight also refuses a run path inside the working folder.

## Preflight (no launch)

```
node --experimental-strip-types tooling/release/attended/attended-preflight.mjs \
  --exe <unpacked copy>\joy-media.exe --candidate <40-hex commit> \
  --profile <new profile folder> --library <scratch library with catalog.json> \
  --out <run folder>
```

It hashes the app, checks `resources\app\node_modules\playwright-core`, checks that the run paths are
outside the owner's folders and the working folder, checks that the owner library holds no link, counts the
owner's default library, checks ffmpeg and ffprobe, looks for a running joy-media.exe, checks the run folder again before it writes into it, and exports the joy://
key into the run folder. It writes `preflight.json` and exits 0 only when every check passes (2 when blocked).

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
  --project <project id> [--port 9339] [--owner-library-files <n>] [--launch]
```

- Without `--launch` the runner runs the preflight and the refusals, reads the source profile through
  a copy, and prints the plan. The copy is the source database and its write-ahead files, in plan-source, for reading. Nothing is started.
- With `--launch`, after the owner's yes that names the run, it copies the profile, checks that the
  copy's asset library is the scratch library, and runs the scenario. It writes `run.json`, and
  `receipt.json` only when every check passed and every guard held. An exception writes `error.json`.
- A run needs an empty run folder. A dry run and a launch each use their own folder, so no file from an earlier attempt
  is overwritten, appended to, or followed through a link. The preflight refuses a folder with any entry in it, before
  it writes anything.
- A launch refused by a guard after the profile copy (the count, the joy:// key or JOY processes) leaves `run.json` and
  the copy at `--profile` behind. The next attempt needs a new run folder and, for the restart scenario, a new `--profile` path.
- The guards (joy:// key, JOY processes, owner library, installed folder) are checked before launch,
  between the two launches, and after the run.

## What is not built yet

1. Done: the first live run of restart-save-export passed on 2026-11-09 (plan 17y), and the fresh-process
   scenario passed a live run on 2026-11-09 (plan sections 17aa to 17ar, kept outside the repository).
2. **Other scenario steps**: export semantics with a decode and a frame comparison, including a dissolve; the
   Windows entry points.
3. **Gate wiring**: the single-pass readiness generator must read these receipts for the attended
   scenarios. This changes gate policy, so it needs the owner's decision first.

Lifecycle receipts have their own producer and are not part of this contract.

## Decisions on the deferred items (9 Nov 2026, owner said "Decide them now")

1. A failed attach is not followed by a kill. The owner's rule is no kill without a yes. The candidate
   stays running, and the owner closes it; the process id is reported as a blocker if the process does not close. A
   failed attach drops only the harness's own connection to the app. The harness never kills the app, and never
   launches it without the owner's yes. The tool processes it starts stop only at their time limits, and the two Node
   helpers are never stopped (decision 5).
2. The owner library count is approved for each run with `--owner-library-files <n>`, and a launch needs it:
   `--launch` without the option is refused. The count is checked before the preflight writes anything, so a run whose
   count differs is refused with nothing written and nothing started, in a dry run too. A launch checks the count again
   in the scenario, before its first launch, so a change during the preflight or the profile copy is refused. The owner
   approves each run's count; on 9 Nov 2026 the owner library held 3221 files. An option the runner does
   not know, or one given twice, is refused, so a typo cannot drop the approval. A count of zero cannot be approved, so a
   run needs a non-empty owner library.
3. The command line is tested without `--launch`. An exe inside the installed folder is refused for both scenarios
   before anything is read, so the run folder stays empty. A missing exe is refused on the preflight's app-exe check;
   the preflight writes its own report, but no run file. A count that differs from the approved count is refused before the preflight runs, so
   the run folder stays empty. A launch without an approved count is refused as a usage error before anything is read.
   The preflight writes its own files (`preflight.json` and the key export) only when it runs. The tests are in
   `tooling/release/src/attended-cli.test.ts`.
4. A timeout does not close the app. In playwright-core 1.62.1, the version in the candidate copy, `browser.close()` on
   a browser connected over CDP closes only the harness's WebSocket. `Browser.close` is sent only to browsers that
   Playwright launched itself. Closing the connection is bounded at 15 seconds. A failed attach leaves the app running,
   and the owner closes it.
5. Time limits. The attach loop has 90 seconds, checked between its attempts and between its page checks. Each
   connection attempt and each page check has 5 seconds, so an attach can run a few seconds past 90. Each bridge call,
   including the library folder read and the export job's cancel, has 120 seconds, and each upload or derivative read
   has 300 seconds. In the fresh-process driver, each page read has 30 seconds; the download capture has 20 seconds at
   attach and 30 seconds before each download; the download session and setting have 5 seconds each. A captured file is
   waited for 60 or 120 seconds, polled between reads. A render waits up to 15 minutes for its job, then reads its
   status for 30 seconds and waits up to 120 seconds for the file. An export job is polled every 2 seconds until 15
   minutes have passed, but a status read and the cancel after it can each take up to 120 seconds, so the wait can run
   a few minutes past 15. The window close has 5 seconds, the wait for the app to exit 60 seconds, closing the
   connection 15 seconds, and a page snapshot 45 seconds (fresh-process scenario only); the snapshot's own calls can
   continue in the background for up to 60 seconds. Playwright actions keep a 30-second default, set on the editor
   page, and explicit waits keep their own limits of 60 to 900 seconds. Each tool the harness starts has a limit: reg,
   tasklist and PowerShell 20 seconds; ffmpeg and ffprobe -version 20 seconds; ffprobe 60 seconds; ffmpeg staging 300
   seconds. A tool that runs past its limit is stopped. The two Node helpers, which load the candidate's own database
   module, have 60 seconds and are never stopped: on timeout the run is refused, and the helper is left running for the
   owner to close. The runner gives its preflight child 300 seconds; a stop at that limit ends the preflight process
   only, and a tool it started keeps its own limit. Run directly, the preflight has only its own per-tool limits. The 60-minute limit covers a scenario, not the preflight or the profile copy. Tools run from full
   paths: reg, tasklist and PowerShell under the Windows system folder, and ffmpeg and ffprobe at the absolute paths the
   preflight finds on PATH. A PATH entry in the working folder, a relative entry, or a copy inside the installed or
   candidate folder is never used, and if the first copy on PATH is inside a JOY folder the preflight refuses rather
   than looking further. A link or a junction on any run path is refused, and the scratch
   library and a restart's source profile are walked for links too. The harness never kills the app. Local file
   counts, copies and walks run on the main thread, so no timer can interrupt them; they never wait on the app. A
   scenario that has not ended after 60 minutes is recorded as an error, and the app is left running for the owner to
   close.
6. Downloads. Both scenarios set two layers when the page is attached: the capture cancels the default save of an
   editor download, and the browser is asked to refuse downloads for the page. An attach that cannot set both fails.
   The Downloads folder is compared before and after each run, and a change fails the run. The layers do not cover
   other pages, popups or the main process, and the browser's answer is not read back, so a save from one of those
   would be found only by the after-run comparison. The owner library is compared the same way, by a digest of its
   entries: the resolved folder path (so a folder swapped for a link changes it), then each file's path, size, modified
   time and link count, each folder's path, and each link's path (a link is never followed). A rewrite that keeps the size
   and the modified time is not seen. A run whose owner library holds a link, a junction, a shared file or an unreadable
   folder is refused before the preflight, and the library is checked again as a tree just before anything is copied or
   seeded. The owner library's count is checked before the preflight and again in the scenario before the first launch;
   the profile copy in between does not touch the owner library. A link that appears in the owner library during a run
   changes its digest, so the run fails. A restart that finds a change after its scenario keeps its run.json, with the
   change as a blocker, and writes no receipt. A complete run can fail this way without any fault in the app: the
   candidate may write to the owner library when it starts, or the owner's browser may finish a download into Downloads
   during the run. Limits remain: the Desktop is not compared after a run; a reparse point other than a symbolic link or a
   junction is not detected. The run folder is checked for links again before the copies, the launch and each evidence
   file, and a link found then fails the write. A link can still appear between a check and the write that follows it, or
   during the scenario's own steps, and then it can redirect that write. A write redirected into the owner library is found
   by the after-run comparison, which fails the run, but the file is already there and the owner must remove it. A write
   redirected into a folder nothing compares is not found.
