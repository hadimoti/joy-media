# WP-35 Closeout — Universal Timeline, Marquee Selection, Atomic Keyboard Delete, and GPU Preview

**Owner:** Luna  
**Status:** **FINISHED** — timeline closeout, paired GPU Worker, browser/resource evidence, immutable deployment, and GBrain complete
**Prepared:** 2026-08-16  
**Repository:** `C:\Users\HadiMoti\joy-vps\joy-media-fix`  
**Target branch:** current working branch; do not discard or overwrite the existing uncommitted WP-35 work

## Execution result — 2026-08-16

Implemented, validated, and deployed: universal-track marquee selection with
replace/additive semantics, four-way normalized hit testing, pointer-capture
cancellation and edge scrolling, atomic non-ripple Delete/Backspace for the
complete selection, locked-track all-or-nothing rejection, universal binding /
property-animation / audio cleanup, and one-step Undo/Redo. The local release
gates pass (`pnpm verify:ci`, 334 files / 2,256 tests, production audit, and the
3/3 WP-35 desktop E2E). The real paired RTX 5070 Ti GPU renderer/client
transport, authenticated mixed-element production evidence, browser
resource-release counters, and Agent/Worker/template/caption placement rollback
audit are all complete. Product and responsive closeout SHAs, immutable release
paths, hashes, and GBrain receipt are in `docs/qa/wp35/README.md`; there are no
remaining blockers.

## 1. Mission

Finish WP-35 without rebuilding the parts that already work, then add a professional box-selection workflow and reliable keyboard deletion for every timeline element type.

WP-35 may be marked complete only when:

1. all supported timeline element kinds can share generic tracks, be selected individually or by marquee, move between compatible tracks, render in Monitor, and survive save/reload;
2. `Delete` and `Backspace` remove the complete timeline selection in one atomic, undoable operation;
3. Monitor preview uses the shared frame-render plan and defaults to Quarter quality, with Half and Full switching verified;
4. the local preview path releases decoder/frame resources correctly;
5. the real GPU Worker path, secure transport, browser client, fallback policy, and paired hardware proof are complete;
6. required CI, browser, accessibility, persistence, pixel, and resource-lifecycle evidence is green or every unrelated failure has a written, owner-approved disposition.

This document supersedes the implementation sequence in the two source plans below while preserving their valid requirements:

- `C:\Users\HadiMoti\joy-vps\joy-media-fix\plan\WP-35-remaining-universal-timeline-gpu-preview.md`
- `C:\Users\HadiMoti\Downloads\JOY Media Timeline — Box Selection - Marquee Selection.md`

## 2. Audited starting point

The repository already contains substantial, uncommitted WP-35 implementation. Luna must preserve and extend it, not restart it.

### Already implemented and previously verified

- generic universal timeline tracks and explicit universal element bindings;
- atomic primary placement through the shared `place-timeline-element` path;
- semantic move, reorder, and rename operations;
- clip drag feedback, edge auto-scroll, and Escape cancellation;
- one shared render-plan path used by Monitor and Export;
- bounded frame and decoder pools;
- Quarter preview as the default quality;
- a fail-closed GPU protocol, capability probe, and request gate;
- Ctrl/Meta-click add/toggle selection in the timeline;
- global `Delete` and `Backspace` shortcut resolution with editable-target guards.

### Latest recorded evidence from the preceding plan

- `pnpm check`: pass;
- production build: pass;
- audit checks: pass;
- focused browser suite: 9/9 pass;
- full Vitest: 310 files pass, 1 skipped; 2168 tests pass, 2 skipped;
- focused WP-35 Vitest: 8 files, 25 tests pass;
- full E2E: 135 pass, 15 fail, 3 skipped.

Treat these figures as historical evidence only. Re-run all required gates after the changes in this plan.

### Confirmed gaps and integration defects

1. Empty-lane pointer-down currently clears selection and seeks immediately. That makes a marquee gesture impossible without deferring empty-click behavior until pointer-up.
2. Keyboard deletion and selected-clip actions find only the first selected clip.
3. The existing delete shortcut calls single-item ripple delete. Repeating that operation for a multi-selection would create order-dependent timing changes and multiple history entries.
4. presentation/document cleanup currently derives only the first `timeline.removeClip` payload, so a batch transaction could leave metadata or animation state behind.
5. context-menu deletion and selection-derived command state are still single-item oriented.
6. Worker/template/caption placement and injected-failure rollback still require proof.
7. legacy migration still requires real byte/pixel fixtures.
8. authenticated mixed-element browser, accessibility, pixel, quality-switching, resource-release, and memory-pressure evidence remains open.
9. the paired physical GPU render host and its secure browser-to-Worker path remain open.

## 3. Locked product contract

Luna must implement this contract exactly unless a discovered architectural constraint is documented and approved before changing it.

### 3.1 Universal timeline compatibility

- All normalized timeline element kinds are valid timeline items: video, audio, image, text, shape, sticker, caption, effect, template, and composition.
- Compatibility must be derived from explicit element kind, track capability, and binding metadata—never display names, labels, or regular expressions.
- Generic tracks may contain multiple compatible element kinds.
- Moving an item vertically changes its track and layer order deterministically.
- Moving or reordering never creates a duplicate primary placement.
- Monitor, Export, persistence, Undo/Redo, and deletion must consume the same canonical timeline/document state.

### 3.2 Click selection

- Plain click on an element replaces the selection with that element.
- Ctrl-click on Windows/Linux and Meta-click on macOS toggles that element without discarding the rest of the selection.
- Plain click on valid empty timeline space clears the selection and preserves the existing seek behavior.
- Ctrl/Meta-click on valid empty timeline space preserves the selection and preserves the existing seek behavior.
- Clip drag and trim retain their current gesture ownership and threshold behavior.
- Selection order must be deterministic: visual track order, then `startUs`, then stable element ID.

### 3.3 Marquee selection

- A primary-button drag may start only from valid empty timeline lane/canvas space.
- It must not start from a clip, trim handle, playhead, marker, track header/control, scrollbar, property/data lane, context menu, resize handle, or any other interactive child.
- The pending gesture becomes a marquee only after a 4 px movement threshold. Movement is measured in both axes.
- The rectangle is normalized with min/max coordinates and therefore works left-to-right, right-to-left, top-to-bottom, and bottom-to-top.
- Every visible, eligible element whose rendered rectangle intersects the marquee rectangle is selected continuously.
- Plain marquee replaces the pointer-down baseline selection.
- Ctrl/Meta-marquee adds intersecting elements to the pointer-down baseline selection. The modifier mode is snapshotted at pointer-down and does not change mid-gesture.
- An under-threshold pointer-up remains an ordinary empty click: it applies the click-selection rule and performs the existing lane seek.
- A completed marquee must not seek the playhead.
- Escape, `pointercancel`, lost pointer capture, or unmount cancels the marquee and restores the exact baseline selection.
- The controller must use pointer capture and remove every listener/animation-frame loop during all exit paths.
- The marquee overlay is visual only: `pointer-events: none` and `aria-hidden="true"`.
- Markers, playhead, track headers, property lanes, and keyframes are excluded from marquee v1. They remain governed by their existing interaction models.
- Items on locked tracks are excluded from new marquee selection.

### 3.4 Hit testing, scroll, zoom, and performance

- Use the rendered `.timeline-clip[data-clip-id]` targets inside the active timeline viewport and compare normalized client-space rectangles using `getBoundingClientRect()`.
- Do not infer element geometry from media type or assume unscrolled world coordinates.
- Rebuild or invalidate the rectangle cache after horizontal scroll, vertical scroll, zoom, lane height/layout change, virtualization changes, or marquee edge auto-scroll.
- Only currently rendered/visible items may intersect. Off-screen items become eligible when scrolling or edge auto-scroll reveals them.
- Coalesce pointer-move work with `requestAnimationFrame`.
- Publish at most one selection update per animation frame and publish nothing if the ordered ID set did not change.
- Support horizontal and vertical edge auto-scroll during an active marquee. Stop the loop immediately when the gesture ends or cancels.

### 3.5 Keyboard deletion

- `Delete` and `Backspace` remove **all selected timeline elements**, not just the first selected clip.
- Keyboard deletion is a normal non-ripple delete: unselected items retain their authored `startUs` values. Existing explicit `Ripple Delete` remains a separate menu action.
- One keypress creates one compound transaction and one history entry. One Undo restores the entire selection; one Redo removes it again.
- Never implement batch deletion by calling `rippleDelete` repeatedly.
- The batch order is deterministic: visual track order, then `startUs`, then element ID.
- The playhead does not move.
- Clear the selection only after a successful commit. If validation or dispatch fails, keep the original selection unchanged.
- If any selected item is locked or otherwise non-deletable, reject the whole batch, make no mutation, and show an accessible reason. Never partially delete a selection.
- If timeline items are selected, they take precedence over marker deletion. If no timeline item is selected and the existing marker-selection model has a selected marker, preserve the current marker-delete behavior.
- Ignore the shortcut while a clip drag, trim, marquee, modal operation, or text edit is active.
- Preserve the existing editable/interactive target guards for inputs, textareas, selects, contenteditable nodes, and relevant controls.
- Call `preventDefault()` only when JOY handles the key. This prevents Backspace navigation without swallowing unrelated keyboard input.
- Keep or restore focus on the timeline canvas after a successful deletion.

### 3.6 Deletion ownership and cleanup

Deleting a timeline instance removes instance-owned state but does not blindly delete shared definitions or source assets.

For every selected ID, the compound deletion must remove or reconcile:

- the canonical timeline clip/placement;
- the universal element binding and companion/prefixed IDs owned by that placement;
- clip-owned visual objects when no other placement references them;
- clip-owned audio rows;
- clip transitions, effects, and property animations;
- template/composition instance bindings;
- caption placement state while preserving a shared caption document if another placement still references it;
- preview/decode/cache ownership that is keyed to the removed item;
- selection and any stale active-item pointer after the transaction commits.

It must preserve:

- shared asset-library/source records;
- reusable template and composition definitions;
- nested composition contents when only an instance is removed;
- shared caption documents and visual objects that still have live references.

Reloading the project after deletion must not resurrect a ghost clip, orphan binding, hidden audio row, or Monitor layer.

### 3.7 GPU preview and quality

- Quarter remains the initial Monitor preview quality.
- Quarter, Half, and Full use the same frame-render semantics and differ only in requested/rendered resolution and resource budget.
- Quality changes must invalidate stale frames, release obsolete resources, and preserve playhead/timeline state.
- The real GPU Worker must use the existing versioned, fail-closed protocol and capability negotiation.
- Unsupported, stale, unauthenticated, timed-out, malformed, or mismatched Worker replies must never be shown as valid rendered frames.
- Fallback is explicit and observable. No silent claim of GPU rendering is allowed when the request used the local fallback.

## 4. Implementation sequence

Execute the phases in order. Do not begin a later phase until the current phase gate passes.

### Phase 0 — Freeze and re-baseline the existing WP-35 work

Tasks:

1. Record `git status --short`, branch, and HEAD before editing.
2. Save a patch/diff inventory of the existing uncommitted work. Do not reset, checkout, clean, or rewrite unrelated files.
3. Re-run the fastest existing static and focused WP-35 checks to confirm the audited baseline still reproduces.
4. Map every modified file to implemented, unfinished, or unrelated work.
5. Create a short evidence note under the existing WP-35 evidence location with command, result, date, branch, and commit.

Gate:

- the dirty baseline is preserved and attributable;
- no existing user change is lost;
- any drift from the recorded test counts is explained before feature work begins.

### Phase 1 — Centralize selection behavior without changing gestures

Likely files:

- `apps/editor-web/src/TimelinePanel.tsx`
- `apps/editor-web/src/App.tsx`
- a new focused selection utility/controller module under `apps/editor-web/src/`
- colocated unit tests

Tasks:

1. Define pure helpers for ordered selection normalization, equality, additive union, and eligibility.
2. Keep the existing `selectedIds` state as the sole selection source of truth. Do not create a second marquee-only selection store.
3. Preserve existing plain-click and Ctrl/Meta-click behavior.
4. Make selection order deterministic using the product contract.
5. Add explicit selection eligibility for locked tracks and non-item timeline controls.
6. Add a single timeline status announcement that reports the final selected count without announcing on every pointer move.

Gate:

- click selection tests pass unchanged or with intentional updated assertions;
- Ctrl/Meta behavior works on supported platforms;
- no clip drag, trim, playhead, marker, context-menu, scroll, or zoom regression.

### Phase 2 — Add the contained marquee state machine

Implement a minimal controller with these states:

1. `idle`;
2. `pending-empty-click` containing pointer ID, origin, baseline IDs, modifier mode, lane/viewport identity, and initial scroll position;
3. `marquee-active` containing the normalized rectangle, hit cache, edge-scroll state, and last published ordered selection.

Tasks:

1. Change empty-lane pointer-down so it enters `pending-empty-click` instead of clearing and seeking immediately.
2. Require primary left pointer: `event.button === 0` and `event.isPrimary`.
3. Reject interactive origins using a central `closest(...)`/data-attribute guard.
4. Capture the pointer at gesture start.
5. Promote to `marquee-active` only after the 4 px threshold.
6. Render a theme-compatible rectangle above lane content without capturing input.
7. Implement normalized intersection geometry and DOM target collection.
8. Coalesce hit testing and selection publishing in `requestAnimationFrame`.
9. Add horizontal and vertical edge auto-scroll and invalidate geometry after scrolling.
10. On pointer-up:
    - under threshold: run ordinary empty-click selection semantics and existing seek;
    - active marquee: finalize selection, announce the count, and do not seek.
11. On Escape, pointer cancel, lost capture, or unmount: restore baseline IDs and remove all transient state/listeners.

Gate:

- all four drag directions work;
- plain and additive marquee semantics are correct;
- scrolling and zooming do not offset hit testing;
- a marquee never starts from clips, trim handles, playhead, markers, headers, controls, property lanes, or scrollbars;
- pointer cleanup and cancellation are leak-free;
- existing clip drag/trim/scrub E2E cases remain green.

### Phase 3 — Implement one atomic multi-element delete service

Create a pure planning module, suggested name:

- `apps/editor-web/src/delete-timeline-elements.ts`

The service should accept the current session/document state plus ordered selected IDs and return either:

- a validated compound deletion plan containing the timeline transaction and document cleanup; or
- a typed rejection containing the user-facing reason and no mutations.

Tasks:

1. Resolve selected IDs to canonical placements and validate that every target exists and is deletable.
2. Reject the entire operation if any target is locked, stale, or invalid.
3. Generate non-ripple `timeline.removeClip` commands for all targets inside one transaction.
4. Generalize the existing first-only `removedClipPresentationTarget(...)` path to return all removed presentation targets.
5. Clean all per-clip animations, effects, transitions, audio rows, universal bindings, and unreferenced clip-owned objects for every removed ID.
6. Preserve shared sources, assets, documents, and nested definitions according to section 3.6.
7. Dispatch exactly one `EditorSession.dispatchCompound(...)` call.
8. Update the global `clip.delete` shortcut to use the batch service.
9. Update `runSelectedClipAction('delete')` and selection-derived command state so they use the same service.
10. Keep the explicit context-menu `Ripple Delete` behavior separate and label it clearly. Do not route keyboard Delete through it.
11. Clear selection and stale active pointers only after a successful commit.
12. Preserve existing marker deletion only when the timeline selection is empty.
13. Update shortcut/help text from “selected clip” to “selected timeline element(s).”

Gate:

- Delete and Backspace remove every selected element across multiple tracks and element kinds;
- unselected clip times do not shift;
- one Undo restores all deleted items and metadata; one Redo removes all again;
- locked or invalid batches cause zero mutation;
- save/reload and Monitor show no ghost state;
- editable targets and active gestures are safe.

### Phase 4 — Close remaining universal placement and migration work

Tasks:

1. Audit every creation entry point: agent actions, Worker responses, template insertion, caption insertion/import, paste/duplicate, composition nesting, and any legacy adapter.
2. Route every primary placement through the shared placement service. Remove direct/manual placement writes where they can create duplicates or incomplete bindings.
3. Add injected-failure tests at each compound boundary and prove full rollback of timeline plus document state.
4. Build real legacy fixtures from historical saved project bytes, not synthetic objects alone.
5. Migrate each fixture, verify the canonical model, render before/after reference frames, and compare pixels within an approved tolerance.
6. Re-save migrated projects and verify a second load is idempotent.
7. Confirm every normalized element kind can be selected, marquee-selected, moved, deleted, undone, redone, rendered, saved, and reloaded.

Gate:

- no primary placement bypass remains without a documented reason;
- injected failures leave byte-equivalent pre-operation state;
- legacy migration is deterministic, pixel-safe, and idempotent;
- no type/name heuristic is used for compatibility.

### Phase 5 — Complete local Monitor quality and resource lifecycle

Tasks:

1. Add browser coverage proving Quarter is selected on a fresh/default project.
2. Verify Quarter, Half, and Full render the same frame content at their expected resolutions.
3. Switch quality during playback and while paused; prove stale requests cannot overwrite the new quality.
4. Verify quality switches release obsolete bitmaps, video frames, decoder leases, and cached GPU resources.
5. Exercise rapid seek, play/pause, project switch, element deletion, route/unmount, and tab visibility transitions.
6. Add bounded memory/resource-pressure coverage and record decoder/frame-pool high-water marks.
7. Add an authenticated mixed-element browser journey that includes several simultaneous timeline elements, layer ordering, marquee selection, multi-delete, Undo/Redo, reload, and Monitor pixel evidence.
8. Cover desktop-primary, compact, and minimum supported viewport layouts.

Gate:

- no leaked `VideoFrame`, `ImageBitmap`, decoder, object URL, Worker request, or cache lease;
- default and switched quality behavior is observable and correct;
- simultaneous mixed elements render with the same layer order as the timeline;
- browser, accessibility, and pixel evidence is attached.

### Phase 6 — Complete the real GPU Worker path

Do not call WP-35 complete based only on a protocol stub, simulated backend, local fallback, or mocked Worker.

Tasks:

1. Provision or identify the paired physical GPU render host.
2. Implement the server-side renderer for the versioned protocol already present in the repository.
3. Add secure transport with authentication, authorization, request size/time limits, and replay/stale-response protection.
4. Implement browser request serialization and response decoding for every supported frame-plan operation.
5. Enforce correlation ID, project/revision identity, frame time, quality, dimensions, protocol version, and capability match before presenting a frame.
6. Implement cancellation, timeout, backpressure, and latest-request-wins semantics.
7. Make the fallback policy explicit in UI/telemetry and test fail-closed behavior.
8. Run paired hardware evidence at Quarter, Half, and Full with mixed elements and compare GPU Worker output to the shared reference render plan.
9. Capture latency, throughput, error rate, cancellation, reconnect, and resource-release measurements.

Gate:

- real paired hardware renders frames through the production browser path;
- invalid or stale replies are rejected;
- fallback is visible and truthful;
- Worker and local paths meet the approved visual parity tolerance;
- secrets remain runtime-only and no credential is committed.

If the paired GPU host or required infrastructure is unavailable, stop at this gate and report WP-35 as **blocked**, not complete. Do not silently reduce scope.

### Phase 7 — Regression, release evidence, and closeout

Required commands/gates:

1. focused unit tests for geometry, selection, deletion, placement, render-plan, and GPU protocol;
2. full Vitest suite;
3. `pnpm check`;
4. production build;
5. repository audit checks;
6. focused WP-35 browser suite;
7. full E2E suite;
8. accessibility checks at desktop-primary, compact, and minimum layouts;
9. persistence/reload, Undo/Redo, pixel, and resource-lifecycle evidence;
10. deployment preflight required by the repository instructions.

The previously observed 15 full-E2E failures included Cloud/audio, motion, WP32 journey, compact bulk/reload, and one minimum-layout import/environment case. For each reproduced failure:

- fix it if caused by WP-35 or this plan;
- otherwise link it to an existing owned issue and obtain explicit release approval;
- quarantine only with named owner, reason, expiry/review date, and approval;
- never omit or silently ignore it.

Required closeout artifacts:

- final implementation commit list;
- commands and exact results;
- browser screenshots/video for marquee, multi-delete, Undo/Redo, quality switching, and GPU mode/fallback;
- pixel comparison artifacts;
- resource/memory measurements;
- migration fixture results;
- known limitations and approved waivers;
- operational notes for GPU Worker health, fallback, and rollback;
- final WP-35 state marked complete only after every mandatory gate passes.

## 5. Detailed test matrix

### Geometry and controller unit tests

- rectangle normalization in all four drag directions;
- inclusive edge intersection and non-intersection;
- exact 4 px threshold behavior;
- ordered hit results;
- plain replace and Ctrl/Meta additive union;
- baseline restoration on Escape, pointer cancel, lost capture, and unmount;
- no duplicate dispatch when the hit set is unchanged;
- no more than one selection publish per animation frame;
- target-cache invalidation on scroll, zoom, layout, and edge auto-scroll.

### Timeline component tests

- empty lane click still seeks and clears selection;
- Ctrl/Meta empty click seeks and preserves selection;
- empty lane drag becomes marquee and does not seek;
- clip/trim/playhead/marker/header/control/scrollbar origins never start marquee;
- pointer leaving the timeline can still finalize through capture;
- plain click replaces; Ctrl/Meta-click toggles;
- plain marquee replaces; Ctrl/Meta-marquee adds;
- locked-track items are excluded;
- rectangle is `aria-hidden` and clips preserve `aria-pressed`;
- final count announcement is correct and not noisy.

### Atomic deletion tests

- Delete and Backspace each remove all selected items;
- selection spans multiple tracks and all ten normalized element kinds;
- targets are ordered deterministically;
- unselected `startUs` values remain byte-for-byte unchanged;
- exactly one compound dispatch and one history entry;
- one Undo and one Redo cover the entire batch;
- any locked/stale target rejects the batch with zero partial mutation;
- editable/control focus does not trigger deletion;
- active drag, trim, or marquee does not trigger deletion;
- timeline selection takes precedence over marker deletion;
- empty timeline selection preserves existing marker deletion;
- selection clears only after success;
- failed dispatch preserves selection;
- presentation targets, animations, transitions, effects, audio rows, bindings, and clip-owned objects are cleaned for every ID;
- shared assets/documents/definitions remain referenced and intact;
- nested composition deletion removes only the instance;
- save/reload contains no ghost items.

### Browser journeys

1. Add multiple mixed elements and verify all appear on the timeline and Monitor.
2. Move items between compatible tracks and verify layer order in Monitor.
3. Select A, Ctrl/Meta-select B, toggle A, and verify state.
4. Marquee in each direction at multiple zoom levels and scroll positions.
5. Add to a baseline selection with Ctrl/Meta-marquee.
6. Edge-scroll while marquee-selecting horizontally and vertically.
7. Delete a mixed multi-track selection; verify no ripple.
8. Undo once, Redo once, save, reload, and compare timeline plus Monitor.
9. Attempt deletion with a locked selected item and verify an atomic rejection.
10. Switch Quarter → Half → Full during playback and rapid seeking.
11. Verify real GPU mode, stale-response rejection, visible fallback, and reconnect.
12. Repeat critical paths at desktop-primary, compact, and minimum viewports.

Existing interaction regression cases, including CASE-16, CASE-25, and CASE-32, must remain green.

## 6. Performance and accessibility acceptance

- Test a timeline with at least 500 rendered/virtualized items and a marquee crossing at least 250 items.
- No long-lived document/window pointer listeners after gesture completion.
- No avoidable layout shift from the overlay.
- Pointer work is rAF-coalesced and selection is not dispatched redundantly.
- Keyboard users receive the updated Delete/Backspace help and final selection/deletion status.
- Screen readers do not announce the moving rectangle itself.
- Focus and `aria-pressed` state remain coherent after selection, delete, Undo, and Redo.
- Contrast and visibility of the marquee rectangle pass in every supported theme.

## 7. Suggested commit sequence

Keep commits reviewable and do not mix generated artifacts or unrelated cleanup.

1. `test(timeline): lock selection and empty-lane gesture contract`
2. `feat(timeline): add marquee selection controller and overlay`
3. `test(timeline): cover marquee scroll zoom cancellation and accessibility`
4. `feat(timeline): add atomic multi-element keyboard delete`
5. `fix(editor): clean all removed universal presentation bindings`
6. `test(editor): cover batch delete undo reload and locked rejection`
7. `fix(editor): close universal placement and legacy migration gaps`
8. `test(preview): prove quality switching and resource release`
9. `feat(gpu): complete secure paired Worker rendering path`
10. `test(wp35): add authenticated mixed-element release evidence`
11. `docs(wp35): record final gates operations and closeout`

Commit only after the relevant phase gate passes. Follow repository ownership rules: edit in the canonical repository, then commit and push before any authorized deployment. Do not edit the live runtime tree directly.

## 8. Non-goals

- lasso/freeform selection;
- marquee selection of markers, keyframes, or property lanes;
- a new shortcut for multi-track ripple delete;
- deleting shared source assets merely because their timeline instances were deleted;
- a rewrite of the existing clip drag, trim, scrub, or history architecture;
- hiding known CI failures or treating a mocked GPU backend as production completion.

## 9. Stop conditions

Stop the current phase, preserve evidence, and fix or escalate if any of these occurs:

- existing clip drag, trim, scrub, scroll, zoom, or context-menu behavior regresses;
- marquee begins on an interactive child;
- hit testing is offset after scroll or zoom;
- a keypress creates more than one undo step;
- a failed or locked batch partially mutates state;
- any deleted item leaves an orphan binding, animation, audio row, visual object, or Monitor layer;
- a shared asset/definition is deleted while still referenced;
- selection forks into multiple sources of truth;
- stale Worker output is presented as current;
- local/Worker resources grow without bounds;
- a secret enters Git;
- deployment preflight detects live drift or a rollback boundary;
- required real GPU infrastructure is unavailable.

## 10. Definition of done

WP-35 is closed only when all of the following are true:

- every normalized timeline element works on compatible generic tracks;
- multiple elements are visible and correctly layered in Timeline and Monitor;
- click, Ctrl/Meta-click, marquee replace, and Ctrl/Meta-marquee add all satisfy the locked contract;
- Delete and Backspace atomically delete the entire selection without ripple;
- locked/invalid selections are rejected without partial changes;
- Undo/Redo, save/reload, migration, and cleanup contain no ghost state;
- Quarter is the default and Quarter/Half/Full switching is visually and resource-lifecycle correct;
- the real secure GPU Worker path is proven on paired hardware and fallback is explicit;
- all mandatory tests and audits pass, or unrelated failures have formal owner-approved dispositions;
- closeout evidence, operational notes, commits, and deployment preflight are recorded.

## 11. Luna’s first action

Start with Phase 0. Before changing code, preserve the current dirty WP-35 diff, re-run the focused baseline, and add failing tests for:

1. empty-lane pending click versus marquee promotion;
2. all-direction rectangle intersection and scroll/zoom correctness;
3. Delete/Backspace removing a mixed multi-track selection in one non-ripple compound transaction;
4. one-step Undo plus complete universal metadata cleanup;
5. atomic rejection when any selected item is locked.

Then implement Phase 1 and continue through the gates in order.
