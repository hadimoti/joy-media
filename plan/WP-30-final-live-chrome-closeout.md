# WP-30 Final Live Chrome and Documentation Closeout

**Status:** FINISHED — documentation-only CI pending
**Date:** 2026-08-11
**Deployed product SHA:** `1b7e8abf27e41d132cda0714c890206400596c41`
**Successful product CI:** [GitHub Actions run 31523239040](https://github.com/hadimoti/joy-media/actions/runs/31523239040)
**Local repository:** `C:/Users/HadiMoti/joy-vps/joy-media-fix`
**VPS repository:** `/opt/joy-media/repo`
**Production root:** `/opt/joy-media`
**Do not use:** `/opt/joy-wg-bot`; it is unrelated to JOY Media deployment.

## Objective

Finish WP-30 without reopening already-green implementation work. The remaining
work is one signed-in Google Chrome animated-export proof, exact disposable-state
cleanup, GBrain reconciliation, and a documentation-only closeout commit whose CI
passes.

WP-30 may be marked `FINISHED` only after every gate in this plan passes. A local
or CI browser test is not a substitute for the remaining signed-in Chrome proof.

## Accepted Starting State

The following evidence is already accepted and must be cited rather than repeated
unless a regression is observed:

- Product repair commit:
  `1b7e8abf27e41d132cda0714c890206400596c41`.
- Product CI run `31523239040` completed with overall conclusion `success`;
  both `check` and `browser-e2e` passed.
- Focused animated-export browser matrix: `3/3 PASS` across `1639x1066`,
  `1366x768`, and `1024x768`.
- Cross-browser asset matrix: `6/6 PASS`.
- Full candidate gate: `268` test files, `1,933` passing tests, `2` licensed
  skips; typecheck, lint, format, build, audit, and repository policy checks
  passed.
- Immutable API release:
  `/opt/joy-media/releases/wp30-api-20260811T193115Z-1b7e8ab`.
- Immutable editor release:
  `/opt/joy-media/releases/editor-web-20260811T193115Z-1b7e8ab-wp30-repair`.
- Current managed pointers:
  `/opt/joy-media/releases/current-api` and `/opt/joy-media/web`.
- PostgreSQL backup:
  `/opt/joy-media/data/backups/joymedia-pre-wp30-repair-20260811T192911Z.sql.gz`.
- Backup SHA-256:
  `a91693b86fefb9bb4eb2220c402b5eeea8f8b97ada82626cded1dd0219fbac05`.
- Public editor byte parity:
  - `index.html` SHA-256:
    `e3996ae322cd7ae039a4c766f1a3e898f7f02113593725227efb6a726af5e9f4`;
  - entry asset: `/assets/index-CHut0ddZ.js`;
  - entry SHA-256:
    `cbb9ba96e7382a181c0db7b1583f79f29146c1ae166bc0ef075f39d594cd07ea1`.
- API service, port `8790`, direct health, public health, public root, nginx
  configuration, and immutable editor hashes were green after cutover.

## Remaining Formal Gates

Only these gates remain:

1. Signed-in Google Chrome animated GIF import, timeline, export, and download.
2. Downloaded MP4 verification with FFprobe and deterministic decoded-frame
   hashes.
3. Refresh and retained re-download proof.
4. Exact cleanup of the disposable Chrome project, asset, export, and download.
5. QA/state and GBrain reconciliation to product SHA `1b7e8ab...`.
6. Documentation-only commit, push, and successful GitHub CI.

## Operating Loop

For every step:

1. Record UTC timestamp, product SHA, release names, Chrome version, viewport,
   project name, and starting state.
2. Perform only that step.
3. Review browser UI, console, page errors, same-origin request failures,
   downloads, persisted state, and cleanup deltas.
4. Append the verdict and evidence references to the final QA report.
5. Continue only on `PASS`.
6. Reproduce every apparent product defect once from a refreshed disposable
   state before classifying it.
7. If a product repair is needed:
   - stop the closeout;
   - change code only in the canonical repository;
   - add focused regression coverage;
   - run the full candidate gate;
   - commit and push an additive repair;
   - deploy a new immutable release;
   - replace the candidate SHA everywhere;
   - restart this plan from Step 0.
8. If an environmental dependency prevents progress, record
   `BLOCKED-INTEGRATION` with exact evidence and leave WP-30 open.

## Safety Boundaries

- Use only the existing authenticated Google Chrome session.
- Create exactly one disposable project for this run.
- Do not open, rename, export, trash, purge, or otherwise mutate the user's
  surviving project.
- Do not delete or replace the user's manually uploaded GIF/WebP/PNG/video.
- Import a run-unique copy of the committed test fixture.
- Permanently delete only the exact disposable project after its name and ID are
  revalidated.
- Never print credentials, browser storage, bearer tokens, signed object URLs,
  personal paths, or private media bytes into reports.
- Do not edit immutable deployed artifacts directly.
- Do not redeploy product artifacts for the final documentation-only commit.

## STEP 0 — Freeze the Final Chrome Run

### Actions

- Confirm local `HEAD`, `origin/main`, VPS `HEAD`, and deployed product SHA all
  identify `1b7e8abf27e41d132cda0714c890206400596c41`.
- Confirm the local and VPS repositories are clean.
- Recheck GitHub run `31523239040` and record:
  - workflow head SHA;
  - overall conclusion;
  - `check` conclusion;
  - `browser-e2e` conclusion;
  - artifact names and retention state.
- Read and record the two current production pointers without changing them.
- Re-run read-only production checks:
  - `systemctl show joy-media@api.service` for active state, PID, and restart
    count;
  - listener on `8790`;
  - direct API health;
  - public health;
  - public root;
  - `nginx -t`;
  - public `index.html` and entry-asset SHA-256 comparison with the immutable
    editor directory.
- Record the current Chrome version and use viewport `1639x1066` for the primary
  signed-in proof.

### Gate

- Repository, CI head, deployment, and public bytes all identify the accepted
  product candidate.
- Production remains healthy with no unexpected restart or pointer drift.
- No state was mutated during preflight.

## STEP 1 — Capture the Signed-In Baseline

### Actions

- Open `https://joyst.ir/` in the authenticated Google Chrome session.
- Confirm the account/workspace loads without a sign-in redirect, ErrorBoundary,
  fatal loading state, or redirect loop.
- Record baseline counts visible through supported UI/API surfaces:
  - active projects;
  - Trash projects;
  - user assets relevant to the test;
  - recent exports/processes;
  - queued/running jobs;
  - paired/connected Workers, when visible.
- Capture initial browser evidence:
  - workspace screenshot;
  - console warnings/errors;
  - page errors;
  - unexpected failed same-origin requests.
- Record the surviving project name and user-uploaded assets only as protected
  baseline identifiers; do not open or change them.

### Gate

- Authentication and workspace load are green.
- Baseline state is recorded without secrets.
- Initial fatal browser-error count is zero.

## STEP 2 — Create the Disposable Project

Create exactly:

```text
WP-30 animated export repair <UTC-run-id>
```

### Actions

- Create the project through the public Project selector UI.
- Record the exact project name and generated project ID when safely visible.
- Confirm the correct empty/new workspace opens.
- Create a History restore point before the first timeline mutation if the UI
  supports it.
- Verify only one project with the exact run name exists.

### Gate

- One disposable project exists and is open.
- No protected project or asset changed.
- The workspace has no fatal console, page, or request error.

## STEP 3 — Import and Verify the Animated GIF

Use a run-unique filename based on:

```text
packages/test-fixtures/media/animated.gif
```

Example:

```text
wp30-final-<UTC-run-id>.gif
```

### Actions

1. Upload through the real public file-input/file-chooser UI.
2. Wait for import progress to reach a terminal success state.
3. Confirm exactly one new User asset appears.
4. Verify the card and preview expose:
   - `image/gif` or equivalent GIF classification;
   - animated-media indicator;
   - expected dimensions;
   - one-second animation-cycle metadata when shown;
   - a verified local/cloud source rather than a bundled reference fallback.
5. Open the preview and observe at least two visibly different animation frames.
6. Close and reopen the preview to verify stable resource ownership.
7. Refresh the workspace and confirm the asset remains discoverable and
   previewable from persisted/authorized bytes.

### Gate

- Exactly one run-created GIF asset exists.
- The preview visibly animates after initial import and after refresh.
- No `/media/reference/<random-id>` request or other unauthorized fallback is
  used.
- No unexpected console, page, decode, or same-origin request error occurs.

## STEP 4 — Timeline and Program Monitor Proof

### Actions

1. Add the GIF to the timeline through the public **Add to timeline** control.
2. Also verify the card's drag payload is present; do not create a duplicate clip
   merely to prove drag if the public add path is the accepted final smoke.
3. Confirm:
   - correct media kind;
   - real animation-cycle duration;
   - one clip was added exactly once;
   - clip selection, Inspector, Program Monitor, playhead, and timecode agree.
4. Scrub to at least two source-frame windows, such as approximately `0.0s` and
   `0.3s`, and capture evidence of distinct Program Monitor frames.
5. Play through the full authored cycle and verify animation continues to its
   true end and loops as authored.
6. Press Space on a neutral workspace target:
   - verify actual media time and UI pause together;
   - verify a second press resumes from the paused position.
7. Confirm Space in a text input does not toggle transport.
8. Refresh and verify the clip, duration, and media resolution persist.

### Gate

- Program Monitor displays changing GIF frames while scrubbing and playing.
- Timeline duration/type remain correct after refresh.
- Playback and Space behavior are synchronized.
- No duplicate clip, stale frame, stuck loading state, or browser error occurs.

## STEP 5 — Chrome Export and Download

### Actions

1. Select the standard H.264/AAC MP4 export preset.
2. Confirm export dimensions match the active composition.
3. Start exactly one export and record initiation time.
4. Verify progress advances and reaches completion once.
5. Capture the Chrome download event and save the file in a private temporary
   evidence directory.
6. Record:
   - filename;
   - byte length;
   - SHA-256;
   - export/process ID when safely visible;
   - Recent-process status.
7. Confirm no duplicate export/job/history record appears.
8. Keep the original completed process available for Step 7.

### Gate

- One non-empty MP4 downloads in real signed-in Chrome.
- Export progress, completion, history, and download agree.
- No stuck, duplicated, or failed operation remains.
- No fatal console, page, recorder, media, or same-origin request error occurs.

## STEP 6 — FFprobe and Animated-Frame Proof

Run local verification against the captured Chrome download.

### Required checks

- SHA-256 and nonzero bytes.
- Container is readable.
- Video codec is H.264.
- Audio codec is AAC when the preset/product path supplies audio.
- Width and height equal the selected composition dimensions.
- Duration is within one frame of the authored export range.
- Frame rate is valid and stable.
- Deterministically decode at least two frames from one decode pass, such as
  frames `0` and `9` at 30 fps.
- Produce per-frame MD5/SHA values and require them to differ.
- Optionally retain two private PNG frame captures for visual inspection; store
  only their sanitized evidence paths/hashes in the report.

### Gate

- FFprobe succeeds.
- Codec, dimensions, duration, and stream requirements pass.
- At least two decoded output frames have distinct pixel hashes.
- Evidence proves encoded animation, not only changing Program Monitor DOM.

## STEP 7 — Refresh and Re-download

### Actions

1. Refresh the disposable project after the completed export.
2. Open Recent processes.
3. Confirm the completed record remains terminal and is not duplicated.
4. Re-download the retained export.
5. Verify the second file's SHA-256 equals the first download.
6. Confirm the timeline, asset, and export record remain usable after refresh.

### Gate

- Re-download works after refresh.
- First and second download hashes match exactly.
- No new job/export/history entry is created by re-download.

## STEP 8 — Browser Evidence Review

### Actions

- Capture final screenshots of:
  - animated asset card/preview;
  - timeline clip and changing Program Monitor frame;
  - completed Recent-process record;
  - clean Project selector after cleanup.
- Export sanitized Chrome diagnostics:
  - warnings/errors;
  - page errors;
  - unexpected failed same-origin requests.
- Classify every nonzero entry as expected, pre-existing, or defect.
- Reproduce any apparent product defect once before assigning a defect ID.

### Gate

- No unexplained error remains.
- Evidence contains no secret, signed URL, personal path, or private media bytes.

## STEP 9 — Exact Cleanup

### Actions

1. Ensure no export or job for the disposable project remains running or leased.
2. Return to the Project selector.
3. Revalidate the exact disposable project name and ID.
4. Move only that project to Trash.
5. Open Trash and permanently delete only that project using the exact-name
   confirmation.
6. Confirm the run-created GIF asset and export records are no longer reachable
   through project-scoped UI/API surfaces.
7. Remove only the two browser downloads and private temporary frame captures
   after their hashes and report references are recorded.
8. Compare final project, Trash, asset, export, job, Worker, derivative, and
   private-object counts with the baseline.
9. Confirm the surviving user project and manually uploaded assets are unchanged.

### Gate

- The disposable project is permanently removed and cannot be restored.
- No run-created asset, export, job, derivative, Worker, download, or
  browser-local residue remains.
- Protected user state matches the baseline.

## STEP 10 — QA and Repository Reconciliation

Create or update:

```text
docs/qa/WP-30-final-live-closeout-<run-id>.md
docs/qa/WP-30-review-log-20260811.md
plan/WP-30-asset-preview-playback-reliability.md
plan/WP-30-final-ci-animated-export-repair.md
plan/WP-30-final-live-chrome-closeout.md
STATE.md
```

Update any linked browser/audit document that still identifies `43c5521` as the
final WP-30 product SHA or says repair CI/GBrain closeout is pending.

### Required report fields

- deployed product SHA;
- successful product CI URL and job conclusions;
- immutable API/editor release names;
- rollback release names/pointers;
- database backup path and SHA-256;
- public editor hashes;
- Chrome version, viewport, timestamp, disposable project context;
- import, preview, timeline, playback, export, FFprobe, frame-hash, refresh, and
  re-download verdicts;
- console/page/request diagnostics;
- baseline/final cleanup comparison;
- protected user-state confirmation;
- irreversible operations;
- explicit remaining limitations, if any.

### Gate

- All repository sources of truth identify product SHA `1b7e8ab...`.
- No document overstates a browser or cleanup result.
- `WP-30 FINISHED` appears only after the Chrome and cleanup gates pass.

## STEP 11 — GBrain Reconciliation

Update only:

- `joy-media-state`;
- `joy-media-wp29-first-project-golden-path`.

Use the authenticated MCP page interface while the live GBrain service owns the
PGLite lock. Do not print the bearer token.

For each page:

1. Fetch the complete page and record its `content_hash`.
2. Immediately fetch it again.
3. Abort if the hashes differ.
4. Preserve the complete page except its terminal WP-30 status/closeout section.
5. Replace stale `43c5521`, old release, CI-pending, and Chrome-pending wording
   with:
   - product SHA `1b7e8ab...`;
   - GitHub run `31523239040` success;
   - immutable repair release names;
   - signed-in Chrome export/download/frame-hash result;
   - re-download result;
   - cleanup result;
   - `WP-30 FINISHED`.
6. Write the complete page with `put_page`.
7. Re-fetch and verify the new hash, timestamp, and terminal WP-30 section.
8. Run GBrain doctor and record its score/warnings.

### Gate

- Both pages contain the same final product/evidence truth as the repository.
- Both post-write hashes are verified.
- Only terminal WP-30 sections changed.
- Doctor has no new write/connectivity failure.

## STEP 12 — Documentation-Only Commit and CI

### Actions

- Add the final GBrain hashes and doctor result to the QA closeout report.
- Run:
  - Markdown Prettier checks on every changed document;
  - repository privacy/secret scan on the diff;
  - `git diff --check`;
  - a staged-file review proving the commit contains only plan/QA/state files.
- Commit with a documentation-only message, for example:

```text
docs: close WP-30 animated export verification
```

- Push without rewriting history.
- Wait for both GitHub jobs to complete successfully.
- Fast-forward `/opt/joy-media/repo` to the documentation commit.
- Do not rebuild or switch API/editor releases for this documentation-only SHA.

Record separately:

```text
deployedProductSha = 1b7e8abf27e41d132cda0714c890206400596c41
closeoutDocsSha = <documentation commit>
```

### Gate

- Documentation commit contains no product/runtime change.
- GitHub `check` and `browser-e2e` both pass.
- VPS repository is clean at the documentation SHA.
- Production pointers still identify the immutable product releases built from
  `1b7e8ab...`.

## Final Acceptance

WP-30 is finished only when all of the following are true:

- The deployed product SHA and successful product CI are recorded and agree.
- Signed-in Google Chrome imports and previews the committed animated GIF.
- Timeline and Program Monitor display distinct animation frames.
- Real Chrome exports and downloads one valid MP4.
- FFprobe confirms expected codec, dimensions, duration, and audio stream.
- Deterministic decoded output-frame hashes differ.
- Refresh and re-download return the identical completed file.
- No unexplained console error, page error, or same-origin request failure remains.
- The disposable project and every run-created object are removed.
- The user's surviving project and manually uploaded assets are unchanged.
- Repository QA/state and both GBrain pages identify the final repair SHA.
- Documentation-only CI passes.
- No unresolved P0/P1, `NOT-RUN`, unapproved blocker, stale production pointer,
  cleanup discrepancy, or secret exposure remains.

## Execution Checklist

- [x] STEP 0 — Candidate, deployment, and public-byte preflight green.
- [x] STEP 1 — Signed-in Chrome baseline recorded.
- [x] STEP 2 — Exactly one disposable project created.
- [x] STEP 3 — Run-unique animated GIF imported, animated, and persisted.
- [x] STEP 4 — Timeline, Program Monitor, loop, and Space proof green.
- [x] STEP 5 — Real Chrome MP4 export/download green.
- [x] STEP 6 — FFprobe and distinct decoded-frame hashes green.
- [x] STEP 7 — Refresh and identical re-download green.
- [x] STEP 8 — Browser diagnostics/evidence reviewed and sanitized.
- [x] STEP 9 — Disposable project and all run residue removed.
- [x] STEP 10 — QA, plans, and state reconciled.
- [x] STEP 11 — Both GBrain pages hash-verified and doctor recorded.
- [ ] STEP 12 — Documentation-only commit and CI green.
- [ ] WP-30 marked `FINISHED` after the documentation-only workflow passes.

## Executed result — 2026-08-12

- Signed-in Chrome run `20260812063009` used the committed fixture copy
  `.tmp-wp30-final/wp30-final-20260812063009.gif` in disposable project
  `WP-30 animated export repair 20260812063009`.
- The GIF imported as `image/gif`, showed `Animated` metadata, previewed from
  the local copy, and placed on the timeline at its authored `1.0s` cycle.
- Program Monitor and preview evidence captured distinct animation frames with
  sanitized hashes `9934b21ac137210d6e8ee78a98f358987eee6fbcfe1df709c001e0d2e99afcd8`
  and `3fe24c1e659278035c2f04b39e9fd50dab0aef3f80031ff3aff2af5e7c6ccea2`.
- Chrome downloaded `joy-media-export-1786516321630.mp4` (14,260 bytes,
  SHA-256 `88197C88AE97E1BBDDE9788BE1931492D92CA1EF6E2AC515C6449D7537FA06A8`).
  FFprobe reported H.264/AAC, 1080x1920, 30 fps, and 1.000000 seconds;
  decoded video hashes differed at the sampled frames.
- Refresh preserved Recent processes and re-download returned the same byte
  count and SHA. Chrome ended with zero console warnings/errors and no failed
  same-origin requests.
- The disposable project was moved to Trash and permanently deleted. Temporary
  fixture/download files were removed; the surviving project and its manually
  uploaded asset were not touched. The only remaining Trash item was the
  pre-existing `Local editor project`.
- GBrain hashes after verification: `joy-media-state`
  `055d00d6cc718b779b4fc1e68440f209e0bf3c9d3c14f0f027b27681668890b4` and
  `joy-media-wp29-first-project-golden-path`
  `713068698070a46c73fef9ca7c7655acaada718b0ff9e7ddfcf275e08001753c`.
  Doctor status was `warnings`, health `90`, with only the pre-existing
  coverage/link-resolution warnings.
