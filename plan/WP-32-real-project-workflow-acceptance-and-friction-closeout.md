# WP-32 — Real-Project Workflow Acceptance and Friction Closeout

- Date: 2026-08-12
- Planning status: FINISHED — execution, deployment, signed-in acceptance, and exact cleanup completed 2026-08-12
- Depends on: WP-29, WP-30, and WP-31
- Accepted starting commit: `e6b0addd3fede4647cae6166c3fa2ddea4df0e1f`
- Final candidate: `6d3b4677e0616bd6e0219ee9b871f941cb2c6ac1`
- Final CI: GitHub workflow `31622521087` (`check` and `browser-e2e` passed)

## Summary

WP-32 proves that the UI and reliability work delivered by WP-29 through WP-31
forms one coherent real-project workflow. It does not begin with a feature
backlog. It begins with an exact disposable project, deterministic real media,
and a signed-in end-to-end acceptance journey:

```text
Projects
  -> create disposable project
  -> import and preview real media
  -> place and edit timeline clips
  -> add captions and adjust audio
  -> reload and continue
  -> export and inspect the output
  -> recover or re-download in Process Center
  -> remove all run-created state
```

Any defect or usability problem discovered during that journey enters a
friction ledger. WP-32 repairs only reproducible problems that block or
materially degrade this path. A finding that requires a new provider, codec,
project model, Worker protocol, or major feature surface becomes a separately
approved follow-on WP instead of silently expanding WP-32.

The WP may close with test/evidence/documentation changes only if the accepted
candidate passes without a product defect. Code churn is not a success metric.

## Objective

Demonstrate, with repeatable automated evidence and one signed-in production
run, that a user can complete a small but representative media project without:

- losing or leaking project media;
- encountering a dead end or ambiguous next action;
- switching to a paid or remote execution path unintentionally;
- seeing preview, timeline, caption, audio, export, and Process Center disagree;
- losing authored state after refresh or project reopen;
- receiving a corrupt, stale, or unverified export;
- leaving disposable projects, assets, operations, or downloads in production.

## Accepted starting state

WP-32 starts from the deployed WP-31 candidate below. These are baseline facts,
not steps to repeat or claims to broaden.

| Item                | Accepted value                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Git commit          | `e6b0addd3fede4647cae6166c3fa2ddea4df0e1f`                                                                              |
| Branch              | `main` tracking `origin/main`                                                                                           |
| GitHub CI           | Run `31582746204`, completed successfully                                                                               |
| Live API            | `/opt/joy-media/releases/wp31-api-20260812T100237Z-e6b0add`                                                             |
| Live editor         | `/opt/joy-media/web-releases/editor-web-20260812T100237Z-e6b0add-wp31-ia`                                               |
| Services            | `nginx` and `joy-media@api` active                                                                                      |
| API health          | `{"ok":true,"service":"joy-media-api","controlPlane":true}`                                                             |
| Public entry point  | `https://joyst.ir/`                                                                                                     |
| Local check         | 272 test files passed, 1 skipped; 1,943 tests passed, 2 skipped                                                         |
| Local browser audit | 143 passed, 3 skipped, 1 retry-resolved flaky case                                                                      |
| Live smoke          | Projects, WP-31 workspace presets, Assets, Deliver controls, and Process Center loaded signed in with no console errors |

The retry-resolved local browser case was the compact WP-29 Worker-insertion
scenario. It is a recorded baseline observation. WP-32 changes Worker code only
if the integrated journey reproduces a product defect rather than scheduling
variance.

## Success definition

WP-32 is successful only when all of the following are true:

1. One hermetic desktop-primary test completes the entire integrated journey.
2. The navigation and critical-action checkpoints pass at `1639×1066`,
   `1366×768`, and `1024×768`.
3. Imported video, image, audio, and caption fixtures remain bound to the exact
   disposable project and do not appear as another project's My media assets.
4. Representative edit, caption, and audio changes survive refresh and reopen.
5. Undo and Redo change exactly the intended authored operation and do not
   include workspace/panel preference changes.
6. Program Monitor, timeline state, and final export agree on source ordering,
   visible duration, caption timing, and audible content.
7. The downloaded MP4 passes container/stream inspection and has a nonzero byte
   length and SHA-256 digest.
8. Process Center reaches truthful running, interrupted/cancelled, completed,
   and downloadable states without duplicate logical operations.
9. A completed export re-downloads byte-for-byte identically after refresh.
10. No unexpected page error, console error, failed same-origin request,
    inaccessible dialog, focus escape, or page-level horizontal overflow occurs.
11. All P0/P1 findings are closed; every P2/P3 finding has an explicit
    disposition and owner/follow-on.
12. The signed-in production run uses one exact disposable project and cleanup
    returns projects, assets, jobs, operations, and downloads to the recorded
    baseline.

## Scope

### In scope

- Project Library creation, reopen, Trash, restore if tested, and permanent
  deletion of the exact disposable project.
- My media versus Cloud library source clarity and project-scoped asset listing.
- Import, preview, and Timeline placement for existing deterministic video,
  image, and audio fixtures.
- Workspace selection and the visible Media, Edit, Enhance, and Deliver paths.
- Program Monitor playback and source-time behavior for the test composition.
- Timeline selection, trim, split, move/placement, Undo, Redo, and persistence.
- Inspector selection context and one representative visual property change.
- Caption import, cue editing/style, monitor visibility, persistence, and
  caption-file export where already supported.
- Browser-local audio adjustment and Quick Voice Polish where already supported.
- Export preflight, browser MP4 export, Process Center state, cancellation or
  reload recovery, retry, and re-download.
- Keyboard, focus, overflow, zoom, reduced-motion, coarse-pointer, and axe review
  on the checkpoints touched by the journey.
- Minimal repairs for reproducible P0/P1 and directly related P2 findings.
- Automated acceptance coverage, redacted QA evidence, deployment, rollback,
  live acceptance, and cleanup.

### Out of scope

- New media engines, codecs, export formats, transition renderers, or decoders.
- New AI/media providers, model selection, paid Cloud operations, or credentials.
- New Worker pairing or execution protocols.
- A second editor, replacement of Dockview, or a new project schema.
- Mobile-phone editing; `1024×768` remains the supported minimum workspace.
- Broad visual redesign, new panel families, or another information-architecture
  pass.
- Analytics/telemetry collection from real users.
- Performance optimization without a measured regression in the WP-32 journey.
- Repair of unrelated P2/P3 backlog items encountered outside the journey.
- Mutation, rename, trash, or upload against a protected existing user project.

## Product and architecture decisions

### D-WP32-1 — Acceptance precedes implementation

The first candidate run records what actually fails. No product repair begins
from assumption, screenshot taste, or a stale backlog entry.

### D-WP32-2 — One disposable project owns every mutation

The production project name is:

```text
WP32 Journey <UTC-run-id> <short-sha>
```

The run records the returned project ID immediately. Every imported asset,
operation, job, export, and cleanup assertion is matched to that ID. Existing
projects are read only and are never opened for an authored edit.

### D-WP32-3 — Deterministic fixtures are real media

The existing generated fixture pack supplies actual encoded/decoded media. It
is not replaced by seeded reference IDs or mocked pixels during the integrated
journey. Network/provider seams may still be deterministic in isolated tests,
but the main browser path uses the actual fixture bytes.

### D-WP32-4 — Local execution is the default acceptance path

The required journey uses browser-local processing. Paired Worker and Cloud
paths remain visible and truthful but are not required to complete the project.
No paid, remote, or licensed operation may begin without a separate explicit
test authorization.

### D-WP32-5 — Preferences are not authored content

Workspace preset, panel arrangement, filter, sort, and view density changes may
persist as UI preferences, but they must not advance the project revision,
create an Undo entry, alter project JSON, or change export bytes.

### D-WP32-6 — Preview and export share project truth

The accepted project-media resolver, timeline/document revisions, render
controllers, caption data, and audio graph remain authoritative. WP-32 must not
introduce a special acceptance-only preview or export path.

### D-WP32-7 — Recovery reuses logical operation identity

Reload, cancel, and retry may change an operation's state and attempt metadata,
but they must not silently create duplicate logical exports or discard a prior
verified output.

### D-WP32-8 — Cleanup is part of acceptance

The run is not complete when the MP4 downloads. It completes only after the
disposable project is permanently deleted, run-created server/browser state is
verified absent or terminal, and protected-state counts/digests match baseline.

## Safety and privacy envelope

- Record the local and VPS commit, clean-tree status, deployed symlink targets,
  service health, and rollback targets before production mutation.
- Use the existing signed-in browser session without reading cookies, passwords,
  session stores, or authentication tokens.
- Production browser evidence must not expose contact details, private project
  names, private thumbnails, authorization headers, signed URLs, personal file
  paths, or media bytes.
- Evidence may store the disposable project ID and fixture asset IDs. Existing
  project identifiers must be represented by counts or salted run-local digests.
- Capture raw Playwright traces/videos only as short-lived CI artifacts. Commit
  only redacted text/JSON summaries and deliberately reviewed screenshots.
- Do not enable Cloud consent, upload fixture originals to a paid provider, or
  pair/revoke a real Worker merely to satisfy this WP.
- Cleanup targets only IDs created by the current run. A missing or ambiguous ID
  is a stop condition, not permission to delete by name pattern.
- Keep the prior immutable API/editor releases until final acceptance is signed
  off and the rollback window is closed.

## Friction ledger and repair policy

Every observation receives a stable ID such as `WP32-F01` and these fields:

| Field        | Requirement                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------- |
| Checkpoint   | Exact journey stage and viewport                                                              |
| Expected     | Observable accepted behavior                                                                  |
| Actual       | Observable result without speculation                                                         |
| Reproduction | Steps, fixture, project/run ID, and repeat count                                              |
| Severity     | P0, P1, P2, or P3                                                                             |
| Domain       | project, media, edit, captions, audio, export, process, responsive, accessibility, or cleanup |
| Evidence     | Screenshot/trace/log/test attachment reference                                                |
| Root cause   | Confirmed code/data seam, or `unknown` while investigating                                    |
| Disposition  | fix-now, duplicate, expected, follow-on, or cannot-reproduce                                  |
| Verification | Focused test and integrated checkpoint that closes it                                         |

Severity is assigned as follows:

- **P0:** security/privacy boundary violation, cross-project data exposure,
  unrecoverable data loss, corrupt output accepted as valid, or production-wide
  outage.
- **P1:** the required journey cannot complete; state is lost after refresh;
  Undo/Redo mutates the wrong content; export is wrong; recovery duplicates or
  strands work; or cleanup cannot prove its target.
- **P2:** the journey completes only through a confusing workaround, hidden
  action, misleading status, broken keyboard path, or supported-viewport layout
  failure.
- **P3:** cosmetic inconsistency or low-impact polish with a clear workaround.

Repair rules:

1. Reproduce an observation at least once before assigning a product severity.
2. Close every P0/P1 before deployment.
3. Fix a P2 in WP-32 only when it is directly on the required journey, has a
   bounded root cause, and does not require an out-of-scope architecture change.
4. Record P3 items; do not delay closeout for them.
5. Add a focused regression first or in the same commit as every product repair.
6. Re-run the checkpoint and the complete desktop-primary journey after repair.
7. If a repair requires a new schema, provider, codec, Worker protocol, or major
   feature surface, stop and draft a separately approved WP.

## Deterministic acceptance project

### Fixture inventory

Reuse `packages/test-fixtures/media/manifest.json` and its generated bytes:

| Fixture           | Purpose                        | Required proof                                                          |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `video.mp4`       | Real H.264/AAC visual source   | Preview, timeline playback, trim/split, refresh, and export             |
| `image.png`       | Still visual source            | Preview, overlay/placement, Inspector change, and export visibility     |
| `audio.wav`       | Independent mono 48 kHz source | Timeline audio, local enhancement/mix, persistence, and export stream   |
| `captions-en.srt` | Deterministic caption cue      | Import, cue/style edit, monitor timing, persistence, and caption export |

The test records and verifies each fixture's manifest SHA-256 and byte length
before browser use. It does not regenerate fixtures during ordinary CI.

### Authored project recipe

The exact recipe is intentionally small:

1. Create the disposable project from Projects.
2. Choose the Edit workspace and record the initial authored canvas/export
   preset without changing it unless the scenario explicitly tests that change.
3. Import the four fixtures through their user-facing import surfaces.
4. Preview the video, image, and audio; close each Preview using a labeled action.
5. Add video, image, and audio to the Timeline with visible Add to timeline
   actions and record their stable asset/clip IDs.
6. Select the video clip, trim one boundary, split once at a deterministic
   playhead, and move/select the resulting clip through existing semantic
   controls.
7. Select the image clip and change one supported Visual/Transform property.
8. Undo and Redo the visual change, proving one authored transaction each.
9. Import the SRT cue, edit its text or accepted style once, and verify the cue at
   an in-range playhead.
10. Apply one browser-local audio adjustment and, when available without remote
    execution, one Quick Voice Polish operation.
11. Refresh, reopen the same project from Projects, and verify clip identities,
    timings, caption state, audio state, and the intended UI preferences.
12. Play through at least two visual boundaries and the caption interval while
    observing Program Monitor and transport state.
13. Export the bounded composition to MP4 and verify the completed Process
    Center entry and browser download.
14. Refresh and re-download that completed export; require identical bytes and
    SHA-256.
15. In automated coverage, start one additional export, interrupt or cancel it,
    retry the same logical entry, and prove one terminal output.
16. Return to Projects, move only the disposable project to Trash, permanently
    delete it by exact ID/name confirmation, and verify cleanup.

If an existing command cannot express a recipe step semantically, that is a
friction finding. The test must not use coordinate clicks or direct production
storage mutation to hide it.

## Required evidence model

Each run creates a redacted manifest under:

```text
docs/qa/evidence/wp32-<UTC-run-id>/
```

Required committed evidence:

- `baseline.json` — candidate SHA, branch, CI URL, viewport/browser versions,
  safe service state, active/rollback release paths, fixture manifest digest,
  and protected-state counts/digests.
- `journey.json` — ordered checkpoint IDs, timestamps, project/fixture IDs,
  expected result, actual result, and verdict.
- `friction-ledger.md` — every finding and final disposition.
- `export-verification.json` — filename, bytes, SHA-256, `ffprobe` summary,
  authored revision fingerprint, operation ID, and re-download match.
- `cleanup.json` — exact created IDs and terminal/absent cleanup result.
- `WP-32-closeout.md` — concise human-readable acceptance report.

Raw traces, videos, browser downloads, and unredacted network logs remain in
temporary local/CI evidence storage and are not committed.

## Execution plan

### WP-32.0 — Freeze baseline and safety boundaries

- [ ] Confirm the local checkout is clean and record `HEAD`, `origin/main`, and
      the expected starting commit.
- [ ] Confirm `/opt/joy-media/repo` is clean and at the same approved SHA before
      any future production deployment.
- [ ] Record current and rollback API/editor symlink targets.
- [ ] Verify `nginx`, `joy-media@api`, loopback API health, public HTML, and the
      current content-hashed JS/CSS assets.
- [ ] Record the successful GitHub CI run for the starting candidate.
- [ ] Validate the deterministic fixture manifest and local FFmpeg/FFprobe
      availability.
- [ ] Create a unique run ID and the evidence directory skeleton.
- [ ] Record protected production state as safe counts/digests without opening
      or mutating an existing project.
- [ ] Capture baseline Project Library, editor-ready, and Process Center
      checkpoints at all three viewports without project mutation.

**Gate:** The candidate, health, rollback pointers, fixtures, run ID, and
protected-state baseline are reproducible. No production mutation has occurred.

### WP-32.1 — Integrated browser harness and evidence contract

- [ ] Add `tests/e2e/wp32-real-project-journey.spec.ts` for the complete
      desktop-primary journey.
- [ ] Add `tests/e2e/wp32-responsive-checkpoints.spec.ts` for compact/minimum
      navigation, overflow, keyboard, and accessibility checkpoints.
- [ ] Add `tests/e2e/wp32-harness.ts` only if shared WP-29 helpers cannot be
      extended without coupling unrelated suites.
- [ ] Reuse `authenticate`, `openDisposableWorkspace`, `openPanel`, and fixture
      paths from the WP-29 harness where their contracts remain correct.
- [ ] Extract/reuse one exact-ID disposable cleanup helper from WP-30 coverage;
      cleanup must be safe in `afterEach` after partial failure.
- [ ] Attach checkpoint JSON and export verification to Playwright results.
- [ ] Fail on unexpected `pageerror`, console error, failed same-origin request,
      unhandled dialog, or page-level horizontal overflow.
- [ ] Use role/name locators. Stable asset/track/clip hooks are permitted only
      for identity and drag geometry already inaccessible by role.
- [ ] Ensure test-only authentication remains isolated in the local E2E server
      and cannot activate against production.

**Gate:** A no-repair baseline run produces a complete PASS/FAIL checkpoint
manifest and reliably deletes its local disposable project even after failure.

### WP-32.2 — Project start, import, preview, and asset ownership

- [ ] Create the disposable project from the visible Projects CTA.
- [ ] Verify search/sort/view preferences do not create a project revision.
- [ ] Import video, image, and audio fixtures with visible progress and one
      terminal success state per file.
- [ ] Import the caption fixture through Captions rather than misclassifying it
      as ordinary visual media.
- [ ] Verify My media shows exactly the disposable project's imported assets and
      Cloud library remains a distinct source.
- [ ] In hermetic automation only, verify a second disposable/control project
      does not see those assets in My media, then remove that control project.
- [ ] Preview each imported media kind and verify playback/metadata/source status.
- [ ] Add each media asset to the Timeline through its labeled primary action.
- [ ] Verify no reference-fixture URL is invented for the imported asset IDs.
- [ ] Record asset IDs, descriptor hashes, clip IDs, and project ownership.
- [ ] Triage and minimally repair only reproducible findings on this checkpoint.

**Gate:** The exact fixture bytes are previewable and project-scoped before and
after refresh, and each Timeline placement is bound to its imported asset ID.

### WP-32.3 — Core edit, selection context, Undo/Redo, and persistence

- [ ] Verify Edit workspace selection reveals Assets, Monitor, Inspector, and
      Timeline without changing authored content.
- [ ] Select the imported video by stable clip identity.
- [ ] Trim one boundary and split once at a deterministic playhead.
- [ ] Verify the two resulting clips retain correct source-time mapping and do
      not duplicate the underlying asset.
- [ ] Select/place the image and change one supported Visual/Transform value.
- [ ] Verify Inspector summary, Program Monitor, Timeline selection, and the
      persisted render controller identify the same object/clip.
- [ ] Undo and Redo the transform as exactly one authored operation.
- [ ] Verify workspace/panel/filter changes never enter authored Undo history.
- [ ] Refresh during a stable state, return through Projects, and reopen the
      exact disposable project.
- [ ] Verify revision IDs, clip IDs, timing, selection-safe state, UI preferences,
      and Program Monitor output after reopen.
- [ ] Triage and minimally repair only reproducible findings on this checkpoint.

**Gate:** Timeline/document revisions advance only for authored edits; one Undo
and Redo restore the exact expected state; refresh/reopen loses no project data.

### WP-32.4 — Captions and browser-local audio

- [ ] Import `captions-en.srt` and verify the accepted cue timing/text.
- [ ] Edit one caption text or style value through the visible Track/Add/Style
      hierarchy and verify one Undo/Redo transaction.
- [ ] Seek inside and outside the cue interval and verify Program Monitor
      visibility changes at the correct times.
- [ ] Export the caption file where the existing UI supports it and compare the
      normalized cue timing/text with the authored project.
- [ ] Select the imported audio asset/clip through visible source and target
      controls.
- [ ] Change one local mix value such as gain, pan, or mute and verify preview
      behavior plus persisted state.
- [ ] Run Quick Voice Polish only through the default browser-local path and
      verify the operation's source asset, target, status, and output binding.
- [ ] Confirm unavailable Worker/Cloud paths remain explanatory and do not become
      implicit fallbacks.
- [ ] Refresh/reopen and verify caption and audio state remains intact.
- [ ] Triage and minimally repair only reproducible findings on this checkpoint.

**Gate:** Captions and audio use the user's imported sources, survive reopen,
remain undoable where authored, and require no Worker, Cloud consent, or fixture
fallback disguised as success.

### WP-32.5 — Export, output proof, Process Center, and recovery

- [ ] Verify export preflight names any missing media before encode and allows the
      valid disposable project to proceed.
- [ ] Start one normal MP4 export and observe one running Process Center entry.
- [ ] Require the operation fingerprint to match the latest timeline/document
      revisions used by the encode.
- [ ] Download the completed MP4 and record byte length and SHA-256.
- [ ] Run `ffprobe` against the downloaded artifact and require:
  - a readable MP4 container;
  - at least one video stream;
  - an audio stream when the accepted browser export path promises project audio;
  - dimensions consistent with the authored canvas;
  - duration within the accepted frame/timebase tolerance;
  - no decode/container error.
- [ ] Verify selected representative frames differ where the source is animated
      and the caption/image visibility checkpoints match authored timing.
- [ ] Refresh, reopen Process Center, and re-download the completed output.
- [ ] Require identical bytes and SHA-256 for the re-download.
- [ ] In hermetic browser coverage, interrupt or cancel one additional export,
      retry the same logical row, and require one terminal verified output.
- [ ] Verify a failed/retried attempt does not remove the prior verified output.
- [ ] Triage and minimally repair only reproducible findings on this checkpoint.

**Gate:** Export bytes are verified against the current project revision;
Process Center remains truthful through refresh/cancel/retry; re-download is
byte-identical; no logical operation is duplicated.

### WP-32.6 — Evidence-backed friction repair loop

For each `fix-now` ledger item:

1. Freeze the failing checkpoint evidence.
2. Reproduce it in the smallest focused test.
3. Identify the authoritative state owner and root cause.
4. Implement the smallest contract-preserving repair.
5. Add focused unit/component coverage.
6. Re-run the failing checkpoint at its original viewport.
7. Re-run the complete desktop-primary journey.
8. Review diff, keyboard/focus behavior, console/network output, and evidence.
9. Commit one coherent repair with its friction ID in the message/body.

Required controls:

- [ ] No finding is fixed by hard-coding the fixture name, run ID, project ID,
      timing, or browser viewport into product code.
- [ ] No test passes by suppressing unexpected console/network errors globally.
- [ ] No UI workaround bypasses the shared project-media, command, operation,
      or export contracts.
- [ ] No unrelated refactor is bundled into a friction repair.
- [ ] Every P0/P1 is closed or the WP is stopped and production remains on the
      prior accepted release.

**Gate:** The ledger has no open P0/P1; accepted P2 fixes pass focused and
integrated coverage; all deferred items clearly exceed this WP's scope.

### WP-32.7 — Responsive, keyboard, accessibility, and regression matrix

Run the complete journey once at `1639×1066`. At `1366×768` and `1024×768`, run
the same critical checkpoints through export initiation without repeating the
expensive encode unless a viewport-specific defect requires it.

- [ ] Projects Create/Search/Sort/Grid/List/Trash controls remain reachable.
- [ ] Workspace preset, Export MP4, and Process Center remain visible or in one
      labeled overflow path.
- [ ] Asset source/category/search/preview/Add to timeline remain reachable
      without hover.
- [ ] Timeline transport and primary edit commands remain reachable at panel
      widths at or above the supported minimum.
- [ ] Inspector, Captions, Audio, and Process Center scroll internally without
      page-level horizontal overflow.
- [ ] Menus, tabs, dialogs, segmented controls, and overflow controls pass
      keyboard navigation, initial focus, Escape, focus return, and disabled
      semantics.
- [ ] Dialogs trap focus and preserve values on actionable asynchronous failure.
- [ ] Axe passes at Projects, imported Assets, Edit workspace, Captions, Audio,
      export pending, and Process Center completed checkpoints.
- [ ] 200% zoom preserves all primary actions.
- [ ] Coarse-pointer emulation exposes card actions without hover.
- [ ] Reduced-motion disables nonessential progress animation.
- [ ] Persian/RTL caption content does not reverse editor chrome or break logical
      alignment.
- [ ] No new screenshot, readiness, or browser-suite regression is introduced.

**Gate:** All three viewport projects pass functional and UI/accessibility
verdicts, and the complete existing WP-29/WP-30/WP-31 audit remains green.

### WP-32.8 — Candidate gate, immutable deployment, and rollback

- [ ] Require a clean committed candidate and record its full SHA.
- [ ] Run focused tests, `pnpm check`, `pnpm build`, and the full Playwright audit.
- [ ] Push the candidate and require both GitHub `check` and `browser-e2e` jobs
      to pass for that exact SHA.
- [ ] Confirm the VPS checkout is clean before fast-forwarding it to the approved
      SHA.
- [ ] Rebuild from the lockfile on the VPS and verify typecheck/build output.
- [ ] Create a new immutable editor release. Create a new immutable API release
      only if WP-32 contains an API change.
- [ ] Record old and new symlink targets before switching.
- [ ] Run `nginx -t`, pre-switch API health, and release-file/hash checks.
- [ ] Atomically switch only the required symlinks and restart the API only when
      an API release changed.
- [ ] Use a bounded readiness poll after restart; an immediate first connection
      refusal is not accepted as a final health verdict.
- [ ] Automatically restore the captured API/editor targets if health, public
      assets, or release checks fail.
- [ ] Verify active symlinks, services, loopback health, public HTTP 200, no-store
      HTML, and content-hashed assets after the switch.

**Gate:** The exact CI-approved SHA is live from immutable releases; services and
public bytes are healthy; prior targets remain intact for rollback.

### WP-32.9 — Signed-in production acceptance and exact cleanup

- [x] Open `https://joyst.ir/?deploy=<short-sha>` in the approved signed-in
      browser to avoid stale HTML.
- [x] Confirm the expected content-hashed candidate assets loaded.
- [x] Re-record safe protected-state counts/digests before mutation.
- [x] Create one primary disposable project using the required WP-32 name;
      the separately created Chrome-recovery disposable project was also
      purged exactly and is recorded as WP32-F08.
- [x] Execute the authored project recipe with the reviewed fixture bytes.
- [x] Capture only redacted checkpoint evidence.
- [x] Complete and verify one normal production export and one re-download.
- [x] Cancellation/retry was not required after the green automated recovery
      coverage and remained out of the bounded production run.
- [x] Confirm no unexpected console/page/request error and no horizontal overflow.
- [x] Return to Projects and delete the disposable project by exact identity.
- [x] Permanently purge only that project after typed confirmation.
- [x] Verify its project, asset, job, operation, export-history, and object-store
      state is absent or terminal according to existing retention contracts.
- [x] Verify protected-state counts/digests equal baseline.
- [x] Remove run-created local downloads/evidence that are not retained as
      reviewed artifacts.
- [x] Recheck public/API health and active release pointers after cleanup.

**Gate:** The real signed-in journey passes on the deployed SHA, cleanup returns
to baseline, protected user state is unchanged, and no rollback condition exists.

### WP-32.10 — QA, state, and final closeout

- [x] Commit the redacted evidence manifest, friction ledger, export proof,
      cleanup proof, and human-readable closeout report.
- [x] Update `STATE.md` only with evidence-backed status and next action.
- [x] Update GBrain only after repository, CI, VPS, browser, and cleanup evidence
      agree.
- [x] Record all deferred P2/P3 findings with owner and proposed follow-on; do
      not label them completed.
- [x] Retain the prior immutable releases through the agreed rollback window.
- [x] Run documentation formatting/link checks and one final clean-tree check.
- [x] Push the documentation closeout commit and require CI if tracked executable
      content changed after the deployed candidate.
- [x] Mark WP-32 `FINISHED` only after every completion checkbox is supported by
      a concrete artifact or command result.

**Gate:** Code, CI, production, browser evidence, cleanup, QA, STATE, and GBrain
tell the same story; there is no open P0/P1 or ambiguous run-created state.

## Test plan

### Focused unit and component coverage

Add or extend tests only where findings require them. Expected seams include:

- project-scoped My media query and ownership filtering;
- project lifecycle cleanup and exact-ID purge behavior;
- media descriptor/import rollback and preview source recovery;
- timeline clip identity, trim/split source mapping, and one-operation Undo/Redo;
- Inspector selection and render-controller persistence;
- caption import/style/export normalization;
- audio graph persistence and browser-local enhancement targeting;
- export fingerprint/readiness and operation-ledger transitions;
- Process Center grouping, action availability, retry identity, and re-download;
- UI preference isolation from authored revision/history.

### Browser coverage

New required specs:

```text
tests/e2e/wp32-real-project-journey.spec.ts
tests/e2e/wp32-responsive-checkpoints.spec.ts
```

Retain and rerun:

- `authenticated-project-library.spec.ts`;
- `timeline-editing-features.spec.ts`;
- `wp29-export-recovery.spec.ts`;
- all WP-29 R2/R5 suites;
- `wp30-cross-browser-assets.spec.ts`;
- `wp30-animated-timeline-export.spec.ts`.

### Candidate commands

```bash
pnpm exec vitest run <focused-test-files>
pnpm exec playwright test tests/e2e/wp32-real-project-journey.spec.ts \
  --project=desktop-primary
pnpm exec playwright test tests/e2e/wp32-responsive-checkpoints.spec.ts \
  --project=desktop-primary --project=desktop-compact --project=desktop-minimum
pnpm check
pnpm build
CI=true pnpm test:e2e:audit
pnpm audit:prod
```

The final release gate is the repository's `pnpm run verify:ci` plus the full
three-project Playwright audit in GitHub Actions for the exact candidate SHA.

### Output verification

The export evidence records the equivalent of:

```bash
ffprobe -v error \
  -show_entries format=duration,size:stream=index,codec_type,codec_name,width,height,sample_rate,channels \
  -of json <downloaded-wp32-output.mp4>
```

The checker must compare facts with authored project state rather than merely
asserting that fields exist.

## Likely implementation surfaces

These files are inspection candidates, not pre-authorized change requirements:

- `tests/e2e/wp29-r5-harness.ts`
- `tests/e2e/wp29-export-recovery.spec.ts`
- `tests/e2e/wp30-cross-browser-assets.spec.ts`
- `tests/e2e/wp30-animated-timeline-export.spec.ts`
- `apps/editor-web/src/ProjectLibrary.tsx`
- `apps/editor-web/src/AssetLibraryPanel.tsx`
- `apps/editor-web/src/project-lifecycle.ts`
- `apps/editor-web/src/project-media-resolver.ts`
- `apps/editor-web/src/TimelinePanel.tsx`
- `apps/editor-web/src/TimelineCanvas.tsx`
- `apps/editor-web/src/InspectorPanel.tsx`
- `apps/editor-web/src/CaptionsPanel.tsx`
- `apps/editor-web/src/AudioPanel.tsx`
- `apps/editor-web/src/export-history.ts`
- `apps/editor-web/src/opfs-export-cache.ts`
- `apps/editor-web/src/project-operation-ledger.ts`
- `apps/editor-web/src/App.tsx`
- `apps/editor-web/src/control-plane-client.ts`
- `apps/api/src/http-server.ts`

No file in this list should change unless a reproduced finding points to it.

## Stop and rollback conditions

Stop implementation or revert the candidate before continuing if any of these
occurs:

- imported media becomes visible across project ownership boundaries;
- an existing protected project or asset changes;
- cleanup cannot identify its exact target;
- a project revision or export fingerprint regresses or becomes ambiguous;
- Undo/Redo mutates more than the intended operation;
- preview succeeds from bytes that export cannot resolve, or vice versa;
- the exported container/stream fails verification;
- Process Center duplicates a logical operation or loses a verified prior output;
- paid/remote execution begins without explicit authorization;
- production authentication or secrets appear in source, logs, or evidence;
- CI fails for the candidate SHA;
- post-switch health/public byte/signed-in acceptance fails;
- the required repair exceeds the stated scope.

Deployment rollback restores the captured prior API/editor symlink targets,
restarts only the changed service, verifies health/public bytes, and leaves the
failed immutable candidate available for diagnosis. It does not overwrite or
delete either release tree.

## Final acceptance criteria

- The deterministic integrated journey passes locally and in GitHub CI.
- The signed-in production journey passes on one exact disposable project.
- Imported media ownership and source resolution remain project-correct.
- Timeline edits, captions, audio, Undo/Redo, and refresh/reopen agree.
- MP4 output is container/stream verified and re-downloads byte-identically.
- Process Center states and recovery actions remain truthful and nonduplicating.
- All supported viewports pass critical workflow, keyboard, and accessibility
  checkpoints.
- Existing WP-29/WP-30/WP-31 regression suites remain green.
- No open P0/P1 remains; P2/P3 dispositions are explicit.
- The live candidate is an immutable release built from the CI-approved SHA.
- The disposable project and every run-created artifact are cleaned exactly.
- Protected state and service health match baseline after cleanup.
- QA, STATE, GBrain, Git, CI, VPS, and browser evidence agree.

## Completion checklist

- [x] WP-32.0 — Baseline and safety envelope approved.
- [x] WP-32.1 — Integrated harness and evidence contract green.
- [x] WP-32.2 — Project/import/preview/asset-ownership checkpoint green.
- [x] WP-32.3 — Edit/selection/Undo/Redo/persistence checkpoint green.
- [x] WP-32.4 — Captions and browser-local audio checkpoint green.
- [x] WP-32.5 — Export/Process Center/recovery/output proof green.
- [x] WP-32.6 — Friction ledger has no open P0/P1.
- [x] WP-32.7 — Three-viewport responsive/accessibility/regression matrix green.
- [x] WP-32.8 — Exact-SHA CI and immutable deployment green.
- [x] WP-32.9 — Signed-in live acceptance and exact cleanup green.
- [x] WP-32.10 — QA, STATE, GBrain, and documentation closeout green.
- [x] WP-32 marked `FINISHED` only after every gate has retained evidence.

## Suggested execution prompt

```text
Execute plan/WP-32-real-project-workflow-acceptance-and-friction-closeout.md
from the clean tracked main branch after e6b0add.

Begin with WP-32.0 and a no-repair baseline. Use one exact disposable project
and the existing deterministic fixture pack. Record every observation in the
friction ledger before changing product code. Repair only reproducible P0/P1
and directly related bounded P2 findings. Require focused coverage, the complete
desktop-primary journey, all three viewport checkpoints, full CI, immutable
deployment, signed-in production acceptance, and exact cleanup. Do not mutate
protected user projects, use paid Cloud operations, or expand into a new codec,
provider, Worker protocol, schema, or feature surface.
```
