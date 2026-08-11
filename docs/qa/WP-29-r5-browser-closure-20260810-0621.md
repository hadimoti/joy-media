# WP-29 R5 — Closure of the 37 former NOT-RUN browser cases

Run IDs: `wp29-r5-aggregate-20260811-0710` and
`wp29-r5-case67-fixture-20260811-0722`; CASE-66 complementary browser run:
`tests/e2e/wp29-r2-worker-insertion.spec.ts`; CASE-16/53/54 closure run:
`wp29-r5-cases16-53-54-20260811-0804`

## Verdict

**CLOSED — all 37 original cases are closed.** Every case now has retained
Playwright coverage at all three required viewports. CASE-66 is closed by the
combined licensed Worker runtime proof and its three-viewport browser
protocol-fixture lifecycle; CASE-67 is closed by the no-egress
deterministic-provider browser proof described below.

The aggregate, CASE-66 complementary browser run, CASE-67 deterministic-provider
follow-up, and CASE-16/53/54 closure run executed every strict case at all three
required viewports. Substituting the accepted external-boundary proofs for the
six original structured skips, the reconciled current matrix is:

- 111 instances attempted (`37 cases × 3 viewports`)
- 111 passed
- 0 blocked, skipped, failed, or flaky
- Functional closure: 37/37
- UI/A11y closure: 37/37

## Run identity and command

- Aggregate timestamp: `2026-08-11T07:10:32+03:30`
- CASE-67 follow-up timestamp: `2026-08-11T07:22:35+03:30`
- Build: working tree based on `10751b1856debc588a8ed950878593fa0346f63f`
- Authentication: deterministic authenticated `joy-media-e2e-token` session
- Viewports: `1639×1066`, `1366×768`, and `1024×768`
- Browser runner: installed Google Chrome through
  `PLAYWRIGHT_USE_SYSTEM_CHROME=1`, one worker, isolated browser context per case
- Command:

```powershell
pnpm exec playwright test tests/e2e/wp29-r5-batch-a.spec.ts tests/e2e/wp29-r5-batch-b.spec.ts tests/e2e/wp29-r5-batch-c.spec.ts tests/e2e/wp29-r5-batch-d.spec.ts tests/e2e/wp29-r5-batch-e.spec.ts tests/e2e/wp29-r5-batch-f.spec.ts tests/e2e/wp29-r5-batch-g.spec.ts --workers=1
pnpm exec playwright test tests/e2e/wp29-r5-batch-d.spec.ts --grep "CASE-67" --workers=1
pnpm exec playwright test tests/e2e/wp29-r5-batch-d.spec.ts --workers=1
pnpm exec playwright test tests/e2e/wp29-r2-worker-insertion.spec.ts --workers=1
pnpm exec playwright test tests/e2e/wp29-r5-batch-a.spec.ts tests/e2e/wp29-r5-batch-c.spec.ts --grep "CASE-(16|53|54)" --workers=1
```

Base aggregate result: `96 passed, 6 skipped, 0 failed (3.2m)`. CASE-67 was then
rerun at all viewports with the deterministic provider (`3 passed`) and the full
updated Batch D passed with `9 passed, 3 skipped, 0 failed`; these replace the
three former CASE-67 skips. The complementary CASE-66 Worker insertion spec then
passed `3/3`; together with the separately recorded real licensed Worker DSP run,
these replace the final three structured skips. The R5 suites directly passed
108 instances; the complementary R2 installed-Chrome run supplies CASE-66's
three reconciled instances, producing the 111/111 total above.

The final CASE-16/53/54 closure command passed `9/9` in 19.1 seconds. CASE-16
uses a run-unique real MP4 upload name, verified Blob-backed preview, and timeline
placement. CASE-53 exposed and then regression-tested a real manual-caption defect:
the panel had rendered source tokens instead of the edited display override. The
caption row now exposes a named text control, Revert, Delete, and one-step recovery.
CASE-54 applies all three templates and proves the selected RTL template survives
reload.

## Strict 37-case matrix

`PASS-FIXTURE` means the browser exercised the real UI and application boundary
with deterministic local/in-memory external data; by itself it does not claim a
live paid provider or independent Worker process. Separately cited runtime
evidence remains a distinct evidence layer.

| Case | Functional   | UI/A11y      | Browser evidence                                                                                                                                                                                                                 |
| ---: | ------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   10 | PASS         | PASS         | Sign-out confirmation was opened and cancelled; the authenticated session remained available.                                                                                                                                    |
|   15 | PASS         | PASS         | Real file input imported PNG and JPEG; cards, categories, and metadata advanced from their per-run baselines.                                                                                                                    |
|   16 | PASS         | PASS         | A run-unique real MP4 imported once, opened a controlled Blob-backed preview, and produced one selectable timeline clip.                                                                                                         |
|   17 | PASS         | PASS         | Real file input imported WAV and MP3 with correct audio categorization.                                                                                                                                                          |
|   18 | PASS         | PASS         | Invalid text, corrupt MP4, and empty input were rejected without partial cards.                                                                                                                                                  |
|   24 | PASS         | PASS         | Cloud, AI, and confirmed bulk-delete actions targeted only selected disposable media.                                                                                                                                            |
|   25 | PASS         | PASS         | A real imported asset card was dragged onto the intended timeline track with the correct media ID and clip kind.                                                                                                                 |
|   32 | PASS         | PASS         | Pointer drag moved one clip across tracks and preserved valid timeline state.                                                                                                                                                    |
|   33 | PASS         | PASS         | Semantic trim handles accepted keyboard edits and retained focus/shortcut metadata.                                                                                                                                              |
|   37 | PASS         | PASS         | Freeze produced the expected segments; freeze and 0.5× rate changes each undid in one creative-history step.                                                                                                                     |
|   46 | PASS-FIXTURE | PASS-FIXTURE | Fullscreen entered through the visible monitor control; headless Chromium retained fullscreen after synthetic Escape, so the visible toggle verified safe exit and state reset.                                                  |
|   53 | PASS         | PASS         | The accessible text control edited one caption; Revert and Delete targeted it, and each operation recovered with one Undo.                                                                                                       |
|   54 | PASS         | PASS         | Clean, Karaoke, and RTL template active states updated exclusively; the selected RTL template persisted across reload.                                                                                                           |
|   55 | PASS         | PASS         | Multiline SRT imported with exact cue text and `1.00–4.25s` timing.                                                                                                                                                              |
|   56 | PASS         | PASS         | Persian WebVTT imported with RTL resolution; malformed cues produced actionable feedback.                                                                                                                                        |
|   57 | PASS         | PASS         | Actual SRT and WebVTT downloads were captured and their bytes, encoding, text, and timing parsed.                                                                                                                                |
|   58 | PASS-FIXTURE | PASS-FIXTURE | Authenticated MP4 transcription request used the committed English fixture; progress, confidence, result placement, and 503 recovery passed.                                                                                     |
|   59 | PASS-FIXTURE | PASS-FIXTURE | Authenticated Persian fixture verified RTL direction, punctuation, 94% confidence, and timeline seek.                                                                                                                            |
|   63 | PASS-FIXTURE | PASS         | The real offer/approve/claim/hello protocol produced the exact connected Worker and capability row in UI.                                                                                                                        |
|   66 | PASS-FIXTURE | PASS         | UI Pair/Approve plus real claim/hello/lease/upload/complete HTTP flow reached Review/Replace; one-click Undo/Redo, reload/no-duplicate, and revoke→401 passed 3/3. This complements the recorded real licensed Worker DSP bytes. |
|   67 | PASS-FIXTURE | PASS-FIXTURE | Browser DSP passed; consent cancel sent zero requests; confirm sent one authenticated deterministic request and applied one output; reload reused the applied ledger record without another request or snapshot.                 |
|   71 | PASS         | PASS         | Effect add, enable/disable, parameter edit, reorder, and removal targeted the selected clip.                                                                                                                                     |
|   72 | PASS         | PASS         | Effect Studio validation, save, recipe card creation, and application passed.                                                                                                                                                    |
|   74 | PASS         | PASS         | Transition favorite, apply, replace, reload persistence, and removal passed at a real timeline junction.                                                                                                                         |
|   75 | PASS         | PASS         | Manual grade edits, Undo, and complete reset stayed synchronized.                                                                                                                                                                |
|   76 | PASS         | PASS         | LUT selection persisted and Parade scope updated without blocking the editor.                                                                                                                                                    |
|   77 | PASS         | PASS         | Inspector transform, crop, keyframe, expression, effect, and audio edits targeted the active clip.                                                                                                                               |
|   79 | PASS         | PASS         | A motion opened and its semantic keyframe control authored a keyframe at the playhead with preview feedback.                                                                                                                     |
|   80 | PASS         | PASS         | Motion rename, duplicate, and delete affected only their intended record.                                                                                                                                                        |
|   81 | PASS         | PASS         | Motion favorite persisted across reload and the selected preset applied.                                                                                                                                                         |
|   82 | PASS         | PASS         | An HTML scene was added to and removed from the selected clip without an ErrorBoundary.                                                                                                                                          |
|   83 | PASS         | PASS         | Spatial path creation, save, preview, and reopen passed.                                                                                                                                                                         |
|   84 | PASS         | PASS         | Camera creation and position/roll/FOV/active-state persistence passed.                                                                                                                                                           |
|   85 | PASS         | PASS         | Template browse, apply, author display, typed delete confirmation, and target-only deletion passed.                                                                                                                              |
|   89 | PASS-FIXTURE | PASS         | Confirmed cancel/retry/revoke actions mutated only the labeled in-memory job or Worker record.                                                                                                                                   |
|   93 | PASS         | PASS         | A Markdown attachment was selected through the real file input, previewed, and removed in Joy Code.                                                                                                                              |
|  100 | PASS-FIXTURE | PASS         | Reload reattached to one queued in-memory operation without creating a duplicate, then performed controlled cancellation cleanup.                                                                                                |

## External execution closure basis

### Case 66 — Worker result insertion

`tests/e2e/wp29-r2-worker-insertion.spec.ts` passed at all three viewports. It
used the Jobs UI for Pair/Approve and the production HTTP protocol for
claim/hello, capability advertisement, lease, derivative upload, and completion.
The browser verified SHA-256/length/MIME, reviewed and replaced the selected clip
audio once, undid and redid in one click, survived reload without duplication,
then revoked the exact Worker and proved another lease returned 401.

The protocol fixture deliberately returned committed `audio.wav` bytes; it does
not claim to perform ML. The separate licensed `audio.ml-denoise` Worker run in
`docs/qa/WP-29-r2-worker-result-20260810-0621.md` proves actual independent DSP
execution and real processed bytes. The two evidence layers together close the
browser and runtime requirements without conflating them.

### Case 67 — Cloud consent and exactly-once application

The configured provider and WAV response are Playwright-local. Cancel sent no
request and created no ledger/output. Confirm sent one authenticated request with
project and operation IDs, applied one generated audio asset, and recorded one
`applied` operation. Reload plus a second confirmed attempt produced the
already-applied notice with no second request or snapshot. This closes UI policy,
transport, application, and deduplication behavior without claiming provider
quality, availability, billing integration, or any paid call.

## Fixes verified by the matrix

- Resumable authenticated browser harness with stable panel activation, semantic
  hooks, baseline-relative imports, real uploads/downloads, and structured blocks.
- Cross-track pointer movement and keyboard-accessible trim handles.
- Caption download URL lifetime, transcription pending/progress semantics, and
  Persian `dir`/`lang` rendering; manual captions now render/edit their display
  override instead of showing an empty source-only value.
- Target-specific asset status, effect reorder, transition lifecycle/favorites,
  template author/delete confirmation, and Worker/job confirmation controls.
- Audio routes now require the `audio.ml-denoise` capability and expose truthful
  Local Worker, Browser DSP, and Cloud Brain states.
- The CASE-66 paired Worker browser journey now proves the full production HTTP
  lifecycle, verified review/replace, one-step Undo/Redo, reload deduplication,
  and revocation at all three viewports; licensed Worker evidence separately
  proves real DSP output.
- The CASE-67 test-only provider seam exposes configured discovery and returns a
  committed WAV locally. It proved paid/remote disclosure, cancel safety,
  authenticated confirm, exactly-one application, and reload deduplication
  without credentials, egress, or a chargeable call.
- Motion keyframe diamonds now add/remove keys at the playhead and expose active
  state; motion, scene, spatial, camera, and template journeys are stable.
- StrictMode media/audio and Pixi renderer teardown were repaired; the motion
  batch passed 21/21 and a separate renderer stress run passed 18/18.
- Derived audio synchronization no longer adds a creative undo step, and timeline
  lookup uses `rootCompositionId`; freeze/rate Undo now passes 3/3.
- Transition junctions use the timeline project, closing apply/replace/remove at
  all three viewports.

## Evidence and cleanup

- Latest CASE-67 contract follow-up output: `test-results/` (three viewport
  directories and a passing `.last-run.json`).
- CASE-66 browser specification:
  `tests/e2e/wp29-r2-worker-insertion.spec.ts`; combined runtime/browser report:
  `docs/qa/WP-29-r2-worker-result-20260810-0621.md`.
- Motion/Pixi viewport and stress runs: retained transient evidence labels
  `wp29-r5-batch-f-all-viewports` and `wp29-r5-batch-f-stress`.
- Fullscreen dynamic-verdict evidence label: `wp29-case46.json`.
- Browser specifications and structured evidence payloads:
  `tests/e2e/wp29-r5-harness.ts` and `tests/e2e/wp29-r5-batch-{a..g}.spec.ts`.
- CASE-16/53/54 structured verdicts are emitted by Batch A/C through
  `recordEvidence`; the final local `.last-run.json` records a passing run with no
  failed test IDs.

Each case used a fresh browser context. Disposable local projects vanished with
their contexts, and API assets, jobs, pairings, and Workers were held only by the
temporary in-memory Playwright server, which terminated after the run. No live
`joyst.ir` project, production Worker, paid provider, cloud object, or user file
was mutated. The retained items are test evidence only.

Static validation after the aggregate:

- `pnpm verify:ci` — PASS: 259 test files, 1,851 tests passed, one file and two
  tests explicitly skipped; typecheck, lint, formatting, builds, and production
  audit are green
- Installed-Chrome direct R5 matrix — 108/108 PASS
- Installed-Chrome complementary R2 CASE-66 matrix — 3/3 PASS
- `git diff --check` — PASS

Historical evidence remains in `docs/qa/gpt-chrome-usage-audit-20260809.md`,
`docs/qa/WP-29-r2-worker-result-20260810-0621.md`, and
`docs/qa/WP-29-r4-playback-20260810-0621.md`.
