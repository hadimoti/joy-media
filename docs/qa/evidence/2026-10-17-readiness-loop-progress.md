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
Process-kill injection at SQLite commit and file-rename boundaries, plus a real
locked/full-destination publication failure, remain open. The renderer still uses
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

The expanded Windows project persistence/lifecycle/portability/editor-package
selection passed 116/116. Both process-kill cases passed again after converting the
test preload to ESM; root workspace typecheck and lint passed, and all changed files
are Prettier-clean. Read-only SQLite and stale-lock recovery are covered. A real
full/locked project-database publication failure, editor SQLite-store wiring, and
the installed Windows app lifecycle remain open; these local checks do not form a
candidate release receipt.
