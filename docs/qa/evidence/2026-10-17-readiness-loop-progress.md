# JOY Media readiness loop progress

Date: 2026-10-17. Work was performed in the isolated `codex/joy-media-readiness`
worktree from baseline `c1fffd59d5078902e031e7684e69c27df40ce607`.

This note records local implementation checks as a progress snapshot. It is not a
candidate-bound release receipt: the source/artifact pair has not gone through the
required two-pass workflow, and exact-candidate external approvals are still pending.
Full logs and
red/green traces remain in the plan's ignored `.superpowers/sdd/2026-10-17-joy-media-readiness-loop/`
workspace on the originating machine.

`pnpm verify:ci` passed in an isolated Windows profile with provider credentials
removed from the test process and `JOY_MEDIA_EDGE_URL=off`: 625 test files passed,
1 skipped; 5,551 tests passed, 26 skipped after the two POSIX-only recovery cases
were added; typecheck, lint, formatting, workspace
builds, and production dependency audit passed with no known vulnerabilities. One
earlier attempt used a nested `TEMP` directory and failed a worker fixture because
its generated path exceeded the Windows legacy path limit. Keeping `TEMP` at the
short OS temp root while still isolating `USERPROFILE`/app data resolved the harness
setup issue; no product code changed for it.

`pnpm test:harness` passed with 22 tests passed and 11 platform skips. The new
installed-CLI environment test ran on Windows and verified that child `PATH` contains
only `System32` and the selected media-tool directories, and rejects relative tool
paths. Its negative control failed when inherited `PATH` was deliberately restored.

The browser audit passed 826 tests with 7 optional cloud/local-worker scenarios
skipped. The packaged Electron acceptance passed its cold-launch, local test API,
project/import, preview-playback, timeline-add, restart/restore, and playable-export
journey. The packaging checks passed all 7 checks; packaged and standalone launch
smokes passed. The installer and archive remain unsigned staging artifacts, and no
real install/update/rollback/uninstall cycle was run.

The CLI acceptance loop now requires playable media from `render`, checks FFprobe
streams and a full decoder pass, validates failure recovery, and rejects unsupported
render features instead of reporting a misleading partial success. The source and
single-file bundle render suites passed on Windows. Prior `joy.cmd` and
`joy-media.cmd` acceptance passed. The final frozen artifact hashes and result must be
attached to the existing exact-candidate receipt; this progress snapshot does not carry
that binding.

The editor is not yet ready for an unqualified release claim. Full edit semantics,
desktop preview/export parity, wiring the SQLite project store into packaged editor
open/save, actual Windows installer lifecycle, optional service/GPU qualification,
the 200-edit and 30-minute soak, external Claude Code review, candidate-specific
GPT-6.1-sol approval (GPT-6 Astra is prohibited by owner instruction), the owner's
release decision, and the required Gbrain closeout
remain open.

## Continuation on October 17

The local worktree was `codex/joy-media-readiness`, based on local HEAD
`b873cfcd5a6399d27b30b9578a55a9dfdd07d4ba`. This continuation is still local
implementation evidence, not a candidate-bound release receipt.

The CLI render signal path now marks tracked renders for cancellation and lets the
render handler clean up before returning exit code 130. It removes partial output
and releases the output lock instead of exiting immediately from the process-level
signal handler. The real POSIX Ctrl-C render case passed in the final Linux suite.

The odd-size fixture was genuinely encoded as 160x90 because FFmpeg's default
4:2:0 `color` source rounded 161x91 before FFV1. The generator now forces
`yuv444p` at the source and encoder. The corrected Windows FFmpeg 8.1.1 fixture
probes as visible and coded 161x91, `yuv444p`; its SHA-256 is
`fa433c6081d3bb81008373a98b7701a132f30e9da715bdd210dd64357e6b2a72` (7,921
bytes). Only this fixture and its manifest entry were replaced; a disposable full
regeneration changed unrelated media bytes and was not imported.

The project-recency test now seeds ordered timestamps before editing and asserts
that the timeline edit advances the selected project's timestamp. This removes
real-clock ordering from the fixture while preserving a check that edits refresh
`updatedAt`.

Fresh verification on this worktree:

- Windows `pnpm verify:ci` passed, including typecheck, lint, formatting, the full
  repository Vitest run, workspace builds, and production dependency audit.
- Windows no-file-parallelism matrix: 30 files, 494 passed, 21 skipped. The
  corrected media semantic suite separately passed 17/17 on Windows.
- Ubuntu 24.04, Node 24.19.0, pnpm 11.15.0, FFmpeg 6.1.1, unprivileged `nobody`,
  sanitized environment: 30 files, 507 passed, 8 skipped.
- Windows runner harness: 22 passed, 11 POSIX-only skips. Ubuntu harness: 31
  passed, 2 Windows-only skips.
- `package:unpacked`, packaged renderer smoke, and the no-retry packaged Electron
  acceptance passed; the acceptance imported, played, saved, restarted, and
  exported a playable project.

The generator change came from Kilo session `ses_eb4c544dcffeqZzHa1io6mu9BM`
on `kilo/byteplus-coding/deepseek-v4-flash` with `--agent lean --pure`; its
reported costs were zero and its actual one-file diff was independently verified.
A second scoped Kilo test-helper run (`ses_eb4b89875ffeXPviTmS91p3odf`) also
reported zero cost, but stalled before producing a diff and was stopped; none of
its output was used.

Still open: clean Windows install/update/rollback/uninstall in the disposable
host; complete supported-editor workflow and preview/export parity; real-service,
GPU, restore, and calibrated 200-edit/30-minute soak qualification; exact-candidate
two-pass release evidence; candidate-specific GPT-6.1-sol approval; the separate
Claude Code review gate; owner release decision; and final VPS Gbrain write/read/
export/receipt. No push, merge, active-profile install, distribution, or deployment
was performed.

## Cancellation review follow-up on October 17

A read-only GPT-6.1-sol review of `80a3c61ab3e8c3d93c439a1ed6e3ad66eaee97f6`
found two render cancellation regressions and asked for a stronger odd-fixture
contract. No GPT-6 Astra was used. Before the fixes, Linux reproduced SIGTERM
returning 130 instead of 143, and a SIGINT manifest-only run completed and emitted
all 1,000 queued clip events before exiting.

The CLI now carries the initiating conventional exit status through render cleanup,
checks cancellation before claiming more clip work and after each event-loop yield,
and stops before emitting clip-complete events. The odd 161x91 fixture assertion
now pins visible and coded dimensions, FFV1, and `yuv444p`.

The focused signal and fixture selection passed 5/5. On Ubuntu 24.04 with Node
24.19.0, pnpm 11.15.0, and FFmpeg 6.1.1, the no-file-parallelism CLI,
project-persistence, and fixture matrix passed 30 files (508 passed, 9 skipped).
The cancellation review also identified an ordering-sensitive assertion in the
manifest-only signal test; it now allows clips completed before signal delivery
while still requiring cancellation before the full queued render. That exact
Linux signal and fixture selection passed again (5 passed, 75 unrelated tests
skipped).
Windows `pnpm verify:ci` passed on the same source changes, including typecheck,
lint, formatting, the full Vitest suite, workspace builds, and the production
dependency audit. The code-level read-only review is not a candidate deployment
approval and does not close the separate Claude Code or owner release gates.

The local readiness branch contains the cancellation and output-recovery follow-ups
on top of `80a3c61`; it remains isolated and has not been pushed, merged, packaged for
distribution, or deployed. Installer lifecycle, packaged editor/store wiring and full edit parity,
real service/GPU qualification, the soak,
frozen-candidate two-pass evidence, exact-candidate GPT-6.1-sol approval, and final
Gbrain closeout remain open.

## Permission-denied output recovery follow-up on October 17

A new unprivileged POSIX end-to-end scenario removed output-directory write
permission after FFmpeg had opened its staged file. It proved that the previous
media and manifest stay byte-identical, the CLI reports a terminal `output`
error rather than an `internal` error, and the next render removes the stale
partial/lock and publishes successfully. The first red run exposed cleanup
exceptions masking the actual filesystem failure. Render cleanup now treats
partial removal and lock release as best-effort while leaving the journal for
the next process to recover.

A Linux-only `LD_PRELOAD` interposer also makes a staged-media `write(2)` return
`ENOSPC` and writes a marker proving that the injection fired. FFmpeg reports
the write failure, the previous media/manifest pair stays byte-identical, and a
clean retry succeeds. This is a real errno injection, not a file-size cap. On
Ubuntu 24.04 with Node 24.19.0 and FFmpeg 6.1.1, the entire
`render-recovery.e2e.test.ts` file passed as unprivileged `nobody` (7 passed, one
Windows-only skip). The ENOSPC case skips where Linux `cc` is unavailable; the
permission-denied case runs for non-root POSIX users.

## Fresh-profile project portability follow-up on October 17

The CLI has a verified cross-profile portability path: export from one disposable
HOME, import into another with no original asset registry, confirm a missing source
fails as `media-missing`, explicitly relink by media directory, and produce an MP4
with video and audio streams that FFprobe inspects. On Windows the asset-recovery
scenario passed 1/1; the combined project-persistence, project robustness, and
portability matrix passed 46/46. The full Windows `project-lifecycle.e2e.test.ts`
passed 61/61, including every historical schema, malformed/dangling/cyclic input,
and a new future-schema import case. The new case confirms the unsupported file
stays byte-for-byte unchanged and the preexisting project database contents remain
unchanged. The editor project-package suite passed 7/7.

These results close the planned CLI parallel-registration, fresh-profile
export/import/relink, and schema-migration acceptance items for this local source.
SQLite commit and export-rename process-kill boundaries are now tested, along with
fresh-profile media relink. The renderer still uses
its guarded browser-storage contract; the desktop SQLite project store is not wired
into editor open/save. This is local scenario evidence only, not a frozen-candidate
receipt or release approval.

## Persistence crash-boundary follow-up on October 17

Two process-kill tests now stop the real CLI at durable-write boundaries. Killing
immediately before SQLite `COMMIT` leaves the previous project revision readable
and the retry commits the next revision. Killing after an export's sibling temp is
written but before rename leaves the previous export byte-identical; the next
atomic write recognizes the dead writer PID, removes only the matching orphan temp,
and completes successfully. The initial red test reproduced the orphan-temp leak.

A separate engine-error injection makes SQLite return `SQLITE_FULL` at commit. The
CLI now returns stable `DATABASE_FULL` guidance; a fresh process confirms the
previous revision remains intact and a later write succeeds. This injects the
SQLite-reported full condition at the transaction boundary; it is not evidence of
a physically exhausted Windows volume.

A separate Node process held the actual SQLite `BEGIN IMMEDIATE` write lock while
the CLI attempted an edit. It returned bounded `DATABASE_BUSY` guidance, kept the
revision and timeline unchanged, and succeeded at revision 2 after the holder
exited. The full Windows `project-robustness.e2e.test.ts` passed 31/31 with the lock,
crash, `SQLITE_FULL`, concurrency, corruption, and read-only scenarios.

The fake-provider CLI delivery journey now runs against the real CLI binary and a
checked-in MP4 fixture. It starts from help, creates a project, adds the fixture,
feeds a malformed typed proposal through the tool-error response, applies a
corrected split/trim, renders a playable H.264 MP4, probes its codec and duration,
and reopens revision 3 in a fresh CLI process. Stdout remains machine-readable and
ANSI-free; stderr retains human progress but contains neither the synthetic key nor
a SQLite startup warning. Both shipped `bin` and single-file `bundle` entries pass.
Versioned JSON schemas and the broader Node-version warning matrix remain open.

The combined agent-delivery, agent-run, CLI-contract, and real-render selection
passed 80 tests with 9 platform skips. A separate Windows run of agent secret,
agent resilience, project robustness, and timeline editing passed 109 tests with 4
platform skips; this included private Windows ACLs, `taskkill` process-tree
termination, the real separate-process SQLite lock test, and explicit database-path
selection. An earlier 46/46 persistence/robustness/asset-recovery selection covered
media paths containing Persian text and spaces. The installed `joy.cmd` acceptance
has not been run against a staged package.

The expanded Windows project persistence/lifecycle/portability/editor-package
selection passed 117/117. Both process-kill cases passed again after converting the
test preload to ESM; root workspace typecheck and lint passed, and all changed files
are Prettier-clean. Read-only SQLite and stale-lock recovery are covered. A real
physical full-volume/held-file failure, editor SQLite-store wiring, and the
installed Windows app lifecycle remain open; these local checks do not form a
candidate release receipt.

## Versioned CLI contracts on October 18

Added Draft 7 schemas for help text, command errors, doctor reports, project
list/create/show/export/import, timeline mutations, agent-run results, and all six
render NDJSON event types. The `bin` and `bundle` black-box test validates success
and error output, including Persian/space-containing project export paths and
manifest-only completion. The real-media render and fake-agent delivery journeys
also validate emitted events and results against the schemas. The focused schema,
delivery, and real-render selection passed 16 tests with 2 platform skips. Current
Node 24.19.0 passed; additional Node versions remain open. The schemas are source-tree
contracts and are not copied into the CLI bundle. The installed-launcher schema gap
was subsequently closed by the October 18 acceptance extension recorded below.

The pinned-Pnpm follow-up including CLI contract, agent-run, schema, agent-delivery,
and real-render files passed 82 tests with 9 platform skips.

## Staged Windows CLI and packaged editor follow-up on October 18

The test-first Windows reserved-device output-path guard and full CLI suite are
recorded in [the staged CLI acceptance note](2026-10-18-windows-staged-cli-acceptance.md).
That suite passed 25 files (470 passed, 25 platform skips); the targeted regression
was first observed returning exit 0 for `NUL`, then passed with an exit-2 JSON usage
error. Typecheck, lint, formatting, and whitespace checks passed.

On the package built from source commit `4bc719b0f9e15147079f4a62ffdff11b0a24ae92`,
`joy.cmd` and `joy-media.cmd` each rendered a fully decoded 3-second H.264/AAC output
from a fresh temporary profile. Packaged Electron Playwright acceptance passed one
journey with retries disabled (12.9s): import, playback, save, restart, reopen, export.
This does not close full editor semantics, preview/export parity, or SQLite project-store
integration. Only Node 24.19.0 is installed on this host; cross-version CLI evidence
remains open.

After this integration, `pnpm dlx pnpm@11.15.0 run verify:ci` exited 0, including
workspace typecheck, lint, formatting, the full Vitest run, workspace builds, and
production audit (`No known vulnerabilities found`). The tool returned a truncated
final test summary, so no aggregate count is claimed here. `pnpm dlx pnpm@11.15.0 run
test:harness` passed 22 tests, skipped 11 platform-specific Bash/Perl and POSIX process
cases, and failed none.

## Self-hosted runner closeout — October 18

The full Windows browser audit completed with retries disabled: 826 passed, 7 optional
environment skips, 0 failures across all seven desktop viewport projects (15.3 minutes).
The staged `joy.cmd` and `joy-media.cmd` harness now validates all ten versioned CLI
schemas, uses only a loopback fake provider for agent output, rejects the Windows `NUL`
export path with a structured usage error, and verifies the real H.264/AAC render. Both
launchers passed; schema hashes and artifact identities are in the staged CLI acceptance
note.

Docker was confirmed running with the isolated PostgreSQL 17 and MinIO CI services in
the Ubuntu 24.04 WSL Docker engine. The repository's three self-hosted runners were
online and idle at the last inventory check. No service credentials were read or copied.
Three exact-SHA workflow dispatches reached the Windows Docker runner and failed before
acceptance. The first exposed that a clean install omits Electron's prebuilt runtime;
the second downloaded it but Electron's bundled native ZIP extractor could not load its
Windows binding; the third passed runtime installation and version verification, then
found that the clean checkout had not built `apps/editor-web/dist`. None produced
Windows lifecycle passes or a candidate-readiness receipt; remaining lanes were canceled
to release the self-hosted runners.

Open closeout limits remain: a disposable Windows user/VM is required for actual app
install/update/rollback/uninstall because the generated setup and uninstaller modify
user shortcuts, PATH, and uninstall registry state. The desktop edit/preview/export
parity matrix and SQLite-store integration are partial, and only Node 24.19.0 is
installed locally. No active-profile install, deployment, publication, or candidate
approval was performed. GPT-6 Astra remains prohibited by the owner; no replacement
review approval is claimed here.

The final local `pnpm verify:ci` run for the current candidate worktree exited 0 on
October 18, including workspace typecheck, lint, formatting, full Vitest, workspace
builds, and production audit (`No known vulnerabilities found`). The installer
package integrity harness passed all eight checks, focused release/evidence
contracts passed, and the Windows lifecycle PowerShell script parsed successfully.
These are source/worktree checks; they do not replace fresh artifact-bound Windows
acceptance.

The Windows job now uses `install-electron-windows.mjs`: `@electron/get` downloads the
locked Electron artifact with its published SHA-256, and PowerShell's built-in
`Expand-Archive` extracts it without Electron's failing native ZIP binding. The helper
checks the extracted version and executable; unit tests cover checksum selection,
idempotence, missing-checksum rejection, and safe PowerShell quoting. The Windows build
now builds the editor web package and its workspace dependencies before packaging; a
workflow test enforces that ordering. The bin and bundle schema journeys passed focused
validation; their full-suite per-test limit is now 60
seconds because a full run timed out at 30 seconds under host-wide suite load, while the
same test passed in 6.9 seconds in isolation. The subsequent complete local
`pnpm verify:ci` run exited 0; `pnpm test:harness` passed 29 tests, skipped 11
platform-specific cases, and failed none.

The corrected exact-SHA `release-candidate-v2` dispatch remains the next closeout gate.
GitHub inventory showed all required self-hosted runners online: Linux CI, Linux
acceptance, and the isolated Windows Docker worker runner. Exact-candidate evidence,
the 30-minute soak, real-GPU qualification, remaining service checks, independent
review, and candidate approval remain open until separately evidenced.

## Packaged persistence and CLI atomic-write follow-up — October 18

The editor now routes its allow-listed project documents through a synchronous
desktop bridge into the app's SQLite profile. Authentication and UI preferences
remain in browser storage; legacy browser project values remain readable and move
to SQLite on the next write. The packaged Electron acceptance was rerun after a
fresh `package:unpacked` build: 1 test passed in 22.5 seconds with retries disabled.
It verified that timeline edits, effects, keyframes, transitions, audio and a Persian
caption survive an Electron restart, and that the project exports playable media.

The CLI's Windows atomic replacement now retries only bounded transient
`EPERM`/`EACCES` rename failures before failing closed. The injected transient-error
regression and multi-process import/render coverage passed in the full suite. The
Windows installer lifecycle fixture now launches the lockfile-pinned Electron
runtime directly instead of invoking the installed app with unsupported
`--run-as-node`; PowerShell parsing and the safe-storage fixture pass locally. This
fixes the harness path but does not claim installed lifecycle acceptance.

Fresh source verification on October 18: `pnpm verify:ci` exited 0, including
typecheck, lint, format, the full Vitest suite, workspace builds and production audit
(`No known vulnerabilities found`). `pnpm test:harness` passed 32, skipped 11
platform-specific cases, and failed none. The full retry-free Playwright audit and
the candidate-bound two-pass workflow are separate acceptance gates.

GitHub-hosted Ubuntu remains assigned to portable validation and renderer build;
the available self-hosted runners handle real services and Windows Docker lifecycle
acceptance where hosted runners lack the needed capabilities. Candidate-bound
acceptance is still pending; no release approval, install, or deployment is claimed.

## Windows lifecycle command quoting follow-up — October 18

Exact-candidate workflow run `39101545683` for commit `68b9b6bcadc4cf011deae1fabd0f43ac899b37be` passed hosted validation, editor bundle, production smoke, and both Linux real-service/P3 passes. The isolated Windows Docker runner built the frozen artifacts and completed update, repair, rollback, app/CLI, and DPAPI checks, then failed when `cmd.exe` tried to invoke the installed `uninstall.cmd` from a path containing spaces. Cleanup and evidence retention succeeded. The dependent acceptance lanes were skipped, so this run is not candidate acceptance.

Root cause was harness argument encoding: Windows CRT escaping passed `\"path\"` through `cmd.exe /c`, which CMD parsed as invalid syntax. The lifecycle acceptance and cleanup invocations now pass CMD-native `/d /s /c ""path""` raw arguments. A regression test checks both call sites and executes a generated batch file under `JOY Media` in the OS temp directory. The focused Windows harness passed 5 tests, the full `pnpm verify:ci` passed, and `pnpm test:harness` passed 34 tests with 11 platform skips and no failures.

The correction was committed as `f14c1ae355a692c07e6ee25f523ebce445ab3bd5` and dispatched as exact-SHA `release-candidate-v2` run `39103645259`. Hosted validation, renderer build, public production smoke, and both Linux real-service passes are green; Windows two-pass lifecycle and P3 qualification are still running. This run predates the additional packaged Monitor acceptance below and does not yet produce a candidate-ready receipt.

## Packaged editor Monitor, text, and scale acceptance — October 18

The unpacked Electron journey now verifies Local preview status, visible Monitor
frame changes after seeking to 0.5 and 1.5 seconds, transport progression, and a
successful keyboard seek reset. It captures screenshots and runs axe at 1024x768,
1366x768, and 1920x1080. A second packaged launch with Chromium's
`--force-device-scale-factor=1.5` verifies the reported display scale and scans the
created project for accessibility violations.

The restart journey decodes a 250ms AAC sample beginning 100ms after the actual
audio clip start and requires normalized PCM16 RMS above 0.02, in addition to
FFprobe's H.264/AAC and duration checks. A separate simple-project journey captures
Monitor frames at 0.5 and 1.5 seconds, decodes the same samples from the exported
MP4, and requires normalized 64x64 RGB mean absolute difference below 0.20 for each
sample.

The packaged main journey now moves a video clip, authors a Persian/Latin mixed-bidi
title, selects RTL, and confirms the moved clip, title text/direction, keyframe,
effects, transition, audio, and Persian caption after restart. The Text editor axe
scan exposed low-contrast template previews and five unnamed range controls. Template
previews now choose a contrasting solid surface, the Direction select has a stable
accessible name, and each range control is linked to its visible PropertyRow label.
The regression run passes the editor's axe scan and asserts all five slider names.

The packaged Electron suite passed all 3 journeys with retries disabled in 42.3s:
playable editor journey, 150% display-scale accessibility, and Monitor/export frame
parity. Typecheck, targeted ESLint, and Prettier checks passed. This source/test
update is not included in run `39103645259`; a new commit and exact-SHA two-pass
workflow are required to bind these results to a candidate. The edit-panel keyboard
route now creates a title, replaces its content, and selects RTL without pointer
input. All export presets/scenes/overlays and export cancellation/crash recovery
remain open in Task 4.

## Full-source verification under shared-runner load — October 18

Two local `pnpm verify:ci` attempts completed typecheck, lint, and formatting, then
reached the full Vitest suite (630 files, 5,603 tests passed, 28 skipped). The first
attempt had one `render-parity` test exceed Vitest's 30-second test timeout even
though its real CLI child has a 60-second hang guard; the isolated case passed in
about 1 second, so the file now allows 90 seconds for the child guard to report a
structured failure. The rerun passed that suite but hit a Vitest worker watchdog in
the `agent-run` setup hook. That isolated file passed 24/24 in 13.2 seconds.

Both attempts overlapped the exact-candidate run `39103645259` on this same host's
self-hosted acceptance runner, so neither is recorded as a passing full verification.
After that workflow completed, a fresh local `pnpm verify:ci` passed the full source
check, builds, and production audit; `pnpm test:harness` also passed. The isolated
render-parity and agent-run suites were green. The exact candidate's separate
real-service locator failure and its fix are recorded below.

## Packaged output and exact-candidate harness follow-up — October 18

Run `39103645259`, pinned to `f14c1ae355a692c07e6ee25f523ebce445ab3bd5`, finished
failed. Hosted candidate/build/smoke lanes, responsive and desktop browser acceptance,
Windows lifecycle, Linux real-service infrastructure/P3, and both P3 passes passed.
Only the two authenticated real-service desktop journeys failed. Each timed out at
`.panel-tab[aria-label="Enhance"]`; teardown verified that the disposable schema,
bucket, temp root, and web process were removed. The shared browser helper and mounted
UI use Dockview tabs, so the harness now selects `.dv-tab[role="tab"]` for Create,
Enhance, Inspector, Joy Code, and 3D Scene. This fix requires a fresh candidate run.

The packaged export regression reproduced a separate bug: cancelling Social H.264
left the history row interrupted when Retry was clicked, because the retry guard
omitted `social-h264-aac`. After adding that supported preset, the test passes and
FFprobe plus a full FFmpeg decode confirm playable H.264/AAC output. The updated
five-journey packaged suite passes with retries disabled in 1.2 minutes. It verifies
project edits including split/undo, trim/undo/redo, move, Persian title/caption,
effects, keyframes, transitions, audio, SQLite reopen, decoded audio channels, all
five output presets, HTML scene Monitor/export frame parity, 150% scaling, and
cancel/retry recovery. High-bitrate dimensions now scale proportionally through a
shared project-schema preset resolver; its export-core tests pass 12/12.

The current CLI real-render suite passes 12 tests with two expected POSIX signal
skips on Windows. Its source and single-file-bundle cases probe playable H.264/AAC,
decode the output, and check picture, timeline timing, audio, and recovery. The final
local `pnpm verify:ci` run passed TypeScript, lint, formatting, the complete Vitest
suite, workspace builds, and production audit (`No known vulnerabilities found`).
`pnpm test:harness` passed 34, skipped 11 expected Linux-only cases, and failed none.

The exact-candidate source-bound workflow for these current changes is pending. The
local tests do not replace its retry-free two-pass evidence, independent review, or
release decision. Real GPU qualification remains unavailable because the local model
runtimes and weights are absent; no model download or external paid provider was used.
