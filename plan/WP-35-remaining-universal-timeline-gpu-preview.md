# WP-35R — Remaining Work for Universal Timeline and GPU Preview

**Status:** **FINISHED** — R0–R10, paired GPU Worker, production browser, deployment, and GBrain gates closed
**Owner:** Luna  
**Audit date:** 2026-08-16  
**Audited source HEAD:** accepted closeout `ffa9ea0` (`main`)
**Working tree:** implementation committed, pushed, and deployed immutably
**Latest gates:** `pnpm verify:ci` PASS · 334 files / 2,256 tests PASS · WP-35 browser 3/3 PASS · production GPU/browser/health/hash receipt PASS
**Source plan:** `plan/WP-35-universal-timeline-gpu-preview.md`  
**Production domain:** `https://joyst.ir/`

## Final closure — 2026-08-16

This remaining-work plan has been fully executed. The real Worker client and
hardware WebGL2 renderer, latest-wins authenticated relay, shared RenderFrameIR
path, complete placement/rollback audit, browser resource-release proof,
authenticated mixed-element screenshots, formatting cleanup, permanent local
Worker, immutable deployment, responsive Monitor correction, and GBrain update
are all closed. See `docs/qa/wp35/README.md` for the accepted source hashes,
release paths, public hashes, tests, screenshot hashes, and operational receipt.
All partial/open verdicts below describe the pre-execution audit and are kept as
historical context only.

## 1. Purpose

This plan replaces the unfinished portion of WP-35. It does not ask Luna to redo the useful partial implementation already in the working tree. Its purpose is to turn that partial implementation into one coherent, tested, deployable feature with:

- Universal Compatibility Mode for every supported Timeline element;
- atomic element placement and movement;
- one authoritative active-element render plan for Monitor, Worker, and Export;
- correct multi-element decoding, compositing, and layer order;
- Quarter-by-default Monitor quality without changing Full Export;
- an honestly detected, secure GPU Worker current-frame path with local fallback.

The dependency order is intentional. Do not build the real GPU transport before the universal schema, placement transaction, render projection, and local compositor are stable.

## 2. Audit verdict

WP-35 is **partially implemented, locally verified, and not ready to deploy**.

Verified during this audit:

```text
pnpm typecheck
  PASS

Focused WP-35 Vitest run
  8 test files passed
  25 tests passed

Full local run
  310 test files passed | 1 skipped
  2,168 tests passed | 2 skipped
```

A current full local run reports 310 test files and 2,168 tests passing with 2 skipped. The focused Add/import/drag browser matrix is 9/9 across primary, compact, and minimum viewports. The latest three-project browser audit reports 135 passed, 15 failed, and 3 skipped; the failures are outside the focused WP-35 timeline cases (Cloud/audio, motion, WP-32 journey, two compact bulk/reload cases, and one minimum import-environment case). This still does not close the missing mixed-element browser, integration, real Worker, security, performance, CI, or production gates below.

There is no WP-35 production entry in `STATE.md`, no immutable release record, and no deployment corresponding to the current dirty working tree. Retrospective QA evidence now exists under `docs/qa/wp35/`.

## 3. Completed baseline — preserve and extend

The following work exists and should not be reimplemented unless a failing test proves it must change:

1. Timeline track presentation is generic in the active UI: new tracks use `track-N`, `T1/T2`-style codes, optional names, and generic `Layer N` labels.
2. Media import selects an unlocked normal track without using media kind as a compatibility gate.
3. Pointer drag activation measures both X and Y movement, so pure vertical motion can activate a drag.
4. Cross-track clip movement already has a basic remove-and-insert transaction.
5. Ordinary image placement creates an `image` object instead of a non-rendering `null` object in the primary placement path.
6. The primary asset-to-Timeline path uses `EditorSession.dispatchCompound()` and updates selection/playhead after commit.
7. `withVideoFrameNodes()` and partial Monitor/Export multi-video composition support exist.
8. The visual object renderer accepts Timeline-derived z-index overrides; the old image-specific magic z-index was removed.
9. A pure `buildActiveTimelineRenderPlan()` skeleton exists in the evaluator package.
10. Quarter, Half, and Full Monitor quality helpers exist; Quarter is the default and the preference is persisted.
11. Browser Pixi resolution can be changed without modifying project/export dimensions.
12. Monitor shows a quality selector, actual dimensions, a current-frame action, and actual local-fallback status when GPU is requested but unavailable.
13. `render.preview.gpu` capability and preview request/response/latest-request protocol types exist.
14. ADR-0035 exists and records the intended product invariants.

These are foundations, not final acceptance evidence.

## 4. Remaining-gap matrix

| Original phase                | Audit status                           | What exists                                                                                                                                                        | Required remaining gate                                                                                       |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 0. Reproduce/evidence         | Complete (retrospective)               | Deterministic ten-kind fixture, QA index, source SHA, and focused evidence exist                                                                                   | Add authenticated mixed-element screenshots/pixel evidence; keep retrospective labeling                       |
| 1. ADR/contract               | Implemented; review gate open          | ADR-0035, versioned protocol DTOs, and validation contracts exist                                                                                                  | Reconcile final claims with the implementation and record review status                                       |
| 2. Universal schema/migration | Implemented; gate partial              | Versioned bindings, normalizer, validation, legacy fallback, copy-on-write migration, and fixtures exist                                                           | Add byte/pixel-equivalence and first-edit migration evidence for real legacy documents                        |
| 3. Atomic placement           | Partial                                | Media Add/import/drop, sticker, HTML, and media binding paths use the shared `place-timeline-element` planner plus compound commits                                | Audit agent/Worker/template/caption routes and prove injected rollback/one-Undo behavior                      |
| 4. Movement/order interaction | Core implemented; gate partial         | Semantic move/reorder/rename commands, 2D drag threshold, live ghost/target status, edge auto-scroll, Escape cancellation, keyboard trim, and order controls exist | Complete touch/pen coverage and add invalid/locked browser evidence                                           |
| 5. Universal Timeline UI      | Core implemented; gate partial         | All ten normalized kinds receive capability metadata/classes; generic tracks support rename/order                                                                  | Add mixed-element browser/accessibility evidence at all supported widths                                      |
| 6. One render plan            | Core implemented; gate partial         | Shared evaluator plan is consumed by Monitor and Export with explicit z-order                                                                                      | Route a real Worker client through the same serialized plan and add Monitor-vs-Export pixel proof             |
| 7. Multi-element decoding     | Partial                                | Bounded keyed frame store, bounded keyed partner-decoder LRU, and a bounded keyed primary live-decoder pool with deterministic disposal exist                      | Add browser resource-release proof and validate multi-source playback under real memory pressure              |
| 8. Preview quality            | Implemented locally; browser gate open | Quarter default, persistence, backing-size helpers, bounded cache, and quality tests exist                                                                         | Add browser parity/invariance evidence and verify quality changes during playback                             |
| 9. GPU Worker                 | Contract only                          | Fail-closed probe, capability name, DTOs, latest-pending queue, and bounded replay/rate/response gate exist                                                        | Build real hardware detection, render host, secure transport, browser client, fallback, and performance proof |
| 10. Cleanup/docs/release      | Not done                               | None                                                                                                                                                               | Remove obsolete paths, update design/state/deploy docs, pass all gates, commit/push/deploy immutably          |

## 5. Remaining execution sequence

Luna must execute the phases in order. Each gate must be green before starting work that depends on it. Keep changes reviewable and do not deploy an intermediate state.

### R0 — Stabilize and preserve the partial baseline

1. Inspect the current dirty working tree and separate WP-35 changes from unrelated user changes. Never discard or overwrite unknown work.
2. Record `762a80c`, the full status, changed-file list, and current focused/full test results under `docs/qa/wp35/`.
3. Add a deterministic disposable project fixture containing overlapping:
   - two videos;
   - one alpha image;
   - one text object;
   - one shape;
   - one HTML scene;
   - one audio item;
   - one caption;
   - one nested composition or the smallest supported nested fixture.
4. Capture tests or screenshots for the still-missing behaviors. Because product code was already changed, label Gate 0 evidence as retrospective; do not claim a tests-first history that did not occur.
5. Run `pnpm check` before the first checkpoint commit. Keep the worktree un-deployed.

**Gate R0:** retrospective source/fixture/QA evidence is present and the focused timeline checks are green; a clean checkpoint commit and deployment are intentionally still open.

### R1 — Finish the universal compatibility schema and migration

1. Add a versioned universal Timeline binding format in `packages/project-schema`. It must explicitly store:
   - Timeline item ID and track ID;
   - element kind;
   - source kind and source ID;
   - start, duration, and source-in timing where applicable;
   - binding to visual/audio/caption/composition state;
   - deterministic within-track order where more than one item representation requires it.
2. Implement one pure `normalizeUniversalTimeline()` adapter. It must read:
   - legacy schema-0 video and composition clips;
   - `joy.clipObjects`;
   - seeded Timeline object IDs;
   - existing caption and audio state;
   - the new versioned binding format.
3. New writes must use explicit element kinds. Display names, filenames, asset IDs, track IDs, and regular expressions must never decide compatibility or capability.
4. Keep the legacy reader for at least one compatibility release. Use copy-on-write migration only after validation; merely opening an old project must not rewrite it.
5. Validate and report, without silently deleting data:
   - duplicate item IDs;
   - duplicate or dangling bindings;
   - missing tracks/sources;
   - invalid timing;
   - ambiguous ordering;
   - unsupported source kinds.
6. Add round-trip fixtures for old and new project documents. Prove that legacy output is byte/pixel equivalent before the first edit and that the first valid edit migrates safely.

**Gate R1:** the normalized representation, validation, legacy fallback, and copy-on-write tests pass; real-document byte/pixel equivalence and first-edit migration evidence remain open.

### R2 — Route every add path through one atomic placement service

1. Add one editor-level service such as `place-timeline-element.ts`. It should accept a typed placement request and return a typed success/failure result.
2. The service must plan and commit, in one `EditorSession.dispatchCompound()` operation:
   - asset/source reference when needed;
   - Timeline item;
   - visual/audio/caption/composition state;
   - versioned binding;
   - selection, playhead, and history metadata.
3. Convert every entry point, including:
   - asset Add to Timeline;
   - drag/drop from asset panels;
   - upload/import completion;
   - sticker/image placement;
   - text, shape, and HTML-scene creation;
   - captions;
   - templates/compositions;
   - agent/Worker-created elements.
4. Remove split sequences that call Timeline dispatch and visual-project replacement separately.
5. Define deterministic track selection:
   - requested unlocked track when valid;
   - otherwise the first unlocked normal track;
   - otherwise create a normal universal track if allowed;
   - otherwise return a user-visible failure with no mutation.
6. Add injected-failure tests at every persistence boundary. Assert zero orphan records, zero partial bindings, unchanged revision on failure, and exactly one Undo/Redo step on success.

**Gate R2:** media Add/import/drop, sticker, and HTML paths use the shared placement planner and compound commits; agent/Worker/template/caption routes and injected-failure rollback are still open.

### R3 — Complete semantic movement, track order, and professional Timeline interaction

1. Introduce semantic commands with inverses:
   - `timeline.moveElement`;
   - `timeline.reorderTrack`;
   - `timeline.renameTrack`.
2. Extract the pointer interaction into a testable drag controller. Preserve the working two-dimensional threshold.
3. During drag, provide:
   - a visible ghost;
   - target-lane highlight;
   - intended time/track preview;
   - invalid/locked/overlap reason;
   - horizontal and vertical edge auto-scroll;
   - Escape cancellation and pointer-capture cleanup.
4. Resolve the destination from actual vertical position, including empty/virtual lanes. Do not infer it from element kind.
5. A cross-track move must update the versioned binding and item location atomically, preserve duration/source timing, and remain one Undo step.
6. Add keyboard/context actions for move up, move down, bring to front, send to back, rename track, and reorder track. Respect locked tracks.
7. Verify mouse, touch, and pen pointer paths, click-vs-drag behavior, scroll offsets, zoom, and compact viewport layouts.

**Gate R3:** pure vertical drag, semantic cross-track movement, track order controls, live drag feedback, edge auto-scroll, Escape cancellation, and focused three-viewport tests pass; touch/pen coverage and authenticated invalid-target evidence remain open.

### R4 — Finish universal Timeline presentation

1. Render a Timeline block for every normalized item kind: video, audio, image, text, shape, caption, HTML scene, composition, camera, and controller.
2. Show kind/icon/capabilities on each block, not as a restriction on the containing track.
3. Keep track role/name as presentation-only metadata. Support inline rename without changing compatibility.
4. Make the top-row/front-layer invariant explicit in UI affordances and accessibility text.
5. Ensure selection, focus, menus, lock state, and drag feedback work at the three supported desktop widths.
6. Add semantic markup and keyboard tests; run the existing accessibility audit against the mixed-element fixture.

**Gate R4:** all ten kinds have normalized capability metadata/classes and generic tracks; authenticated mixed-element browser/accessibility evidence is still required.

### R5 — Make one active render plan authoritative

1. Expand `packages/evaluator/src/active-timeline-render-plan.ts` so the normalized project plus playhead produces all active render/audio/controller items, ordered deterministically.
2. Include:
   - active-interval filtering;
   - track visibility, solo, mute, and lock semantics where relevant;
   - explicit top-track-to-highest-z mapping;
   - within-track order;
   - nested composition resolution and cycle protection;
   - source-local time;
   - caption/burn-in information;
   - audio participation;
   - diagnostics for missing or invalid bindings.
3. Replace the ad hoc active-clip, binding, and z-index projections in `App.tsx` with this plan.
4. Monitor, GPU Worker requests, and Full Export must consume this same ordered plan or the same serialized `RenderFrameIR` derived from it.
5. Define z-order in one place. Remove any remaining kind-based or array-index ordering that can disagree with `Track.order`.
6. Add a pinned red/blue overlap fixture and pixel assertions proving that the top Timeline row renders in front in local Monitor and headless Export.

**Gate R5:** Monitor and Export consume the shared local plan and focused z-order tests pass; Worker serialization and Monitor-vs-Export browser pixel proof remain open.

### R6 — Build the bounded multi-element decoder/compositor path

1. Replace the single `previewVideoFrame` state and one-partner-decoder flow with a keyed active-frame map and bounded decoder pool.
2. Key decoder/frame state by source identity plus relevant timing/transform revision, not by one global selected clip.
3. For each active video/animated source:
   - request the correct source-local frame;
   - coalesce seeks;
   - reject stale results with per-source request tokens;
   - reuse valid decoders/object URLs;
   - release resources when inactive or when the project closes.
4. Define explicit decoder-count, bitmap-count, and byte limits with deterministic eviction.
5. Render image, text, shape, caption, HTML scene, controller, and nested composition items through the same plan; audio-only items must not create fake visual nodes.
6. Show deterministic loading/error placeholders without changing authored content or layer order.
7. Test pause, scrub, playback, rapid seek, reload, source replacement, deletion, and overlapping sources. Include stale-frame and resource-release tests.

**Gate R6:** bounded keyed frame storage, stale-result tests, and bounded primary/partner decoder disposal pass; one live primary decoder remains intentional for the audio clock, and browser resource-release proof remains open.

### R7 — Close the local Preview quality contract

1. Keep Quarter as the default for new and existing users with no stored preference; retain Half and Full.
2. Prove the actual canvas backing dimensions are exactly the selected scale while CSS layout remains unchanged.
3. Invalidate/rebuild only preview caches affected by quality changes. Do not mutate the project, asset descriptors, composition size, history, or export settings.
4. Ensure the renderer status reports the actual renderer and actual dimensions, never the preference alone.
5. Add unit/integration/browser coverage for:
   - default and persistence;
   - Quarter/Half/Full backing dimensions;
   - switching quality during pause/playback;
   - project revision remaining unchanged;
   - Full Export staying Full;
   - visual ordering/parity at all three preview qualities.

**Gate R7:** Quarter/Half/Full helpers, persistence, and local tests pass with Quarter default; browser parity/invariance during playback remains open.

### R8 — Implement the real paired GPU Worker current-frame path

The current capability and DTOs are only a contract skeleton. Complete the path without using the durable job queue for every pointer move.

1. Add a real Worker renderer probe and render host:
   - initialize the selected GPU/WebGL renderer;
   - inspect the actual adapter/renderer;
   - fail closed for SwiftShader, software rasterizers, initialization failure, or missing codecs;
   - advertise `render.preview.gpu` only while the hardware renderer is usable.
2. Reuse the shared render-plan/IR contract. Version requests and responses and reject incompatible schema versions explicitly.
3. Add an authenticated ephemeral preview session transport with:
   - project/user/Worker authorization;
   - opaque expiring asset tokens rather than filesystem paths or permanent URLs;
   - bounded frame size, item count, request rate, and session lifetime;
   - latest-request-wins coalescing and cancellation;
   - response correlation by session, request, playhead, quality, and project revision;
   - private/no-store behavior and prompt token revocation on close/unpair.
4. Build the browser client:
   - Auto selects a healthy paired hardware Worker;
   - GPU Worker preference reports unavailable until capability and session handshake both pass;
   - returned frames replace only the exact still-current request;
   - timeout, disconnect, decode error, revocation, or capability loss visibly falls back to local Pixi without losing edits.
5. Keep local Quarter playback available at all times. Remote GPU preview may initially be limited to paused/current-frame rendering if measured streaming performance does not satisfy the gate.
6. Add integration/security tests for authorization, expiry, replay, revocation, wrong revision, stale response, size/rate limits, software-renderer rejection, and fallback.
7. Measure on the owner's target Windows GPU Worker and supported production browsers. Record median/p95 latency, throughput, failure rate, GPU adapter, resolution, and mixed-element fixture complexity under `docs/qa/wp35/`.

**Gate R8:** a real paired hardware Worker renders the current mixed-element frame and honestly reports GPU status; software rendering never advertises success; Worker loss falls back locally with no stale frame or data loss.

### R9 — Cleanup, full verification, and immutable deployment

1. Remove or quarantine obsolete active paths:
   - kind/name/ID regex inference from active placement and capability decisions;
   - duplicated App render projection;
   - split placement mutations;
   - global single-frame preview state;
   - unused legacy helpers after compatibility readers are isolated.
2. Keep components bounded; extract placement, drag, render-plan, decoder-pool, and Worker-client responsibilities rather than continuing to grow `App.tsx`.
3. Update:
   - `DESIGN.md`;
   - `STATE.md`;
   - project-schema documentation;
   - Worker/API/editor deployment documentation;
   - ADR-0035 status and final compatibility matrix;
   - `docs/qa/wp35/` evidence index and rollback record.
4. Run the complete local gate:

```bash
pnpm check
pnpm build
pnpm audit:prod
pnpm test:e2e:audit
```

5. Run WP-35 E2E at desktop-primary, desktop-compact, and desktop-minimum. Cover Add, drag, reorder, Undo/Redo, reload, Quarter/Half/Full, local fallback, real GPU current-frame render, Worker disconnect, legacy open/migrate, and Monitor-vs-Export pixel order.
6. Commit and push the clean source. Wait for required GitHub CI; do not deploy an unpushed or red commit.
7. Follow `deploy/README.md` and the current immutable release process:
   - record source SHA, active releases/symlinks, health, and Worker capabilities;
   - back up the database and retain rollback releases;
   - deploy additive API/protocol support before enabling the editor client;
   - upgrade/pair and verify the Worker before feature cutover;
   - build releases from the pushed clean SHA;
   - switch only after origin health checks;
   - run authenticated public-browser QA on a disposable project;
   - verify public/live hashes and service restart counts;
   - retain evidence, then remove only disposable QA data.
8. On any failed production gate, restore the prior immutable release and verify health. Do not edit live files directly or bypass drift protection without explicit review.

**Gate R9:** local checks, CI, authenticated production QA, release-hash verification, and rollback readiness are all green; `STATE.md` records the deployed SHA and evidence.

## 6. Recommended remaining commit sequence

The current uncommitted partial work may be split differently after diff review, but the dependency boundaries should remain visible:

1. `chore(wp35): checkpoint audited partial implementation`
2. `test(wp35): add mixed-element compatibility evidence`
3. `feat(schema): normalize universal timeline bindings`
4. `feat(editor): centralize atomic element placement`
5. `feat(timeline): complete semantic movement and track ordering`
6. `feat(render): make active timeline plan authoritative`
7. `feat(preview): add bounded multi-element decoding`
8. `test(preview): close quality and render parity gates`
9. `feat(worker): render authenticated hardware gpu preview frames`
10. `test(wp35): close browser security and performance gates`
11. `docs(wp35): record release evidence and rollback state`

Do not create an artificial “checkpoint” commit if the dirty tree contains unrelated or unreviewed changes. Preserve those changes and isolate only verified WP-35 files.

## 7. Final acceptance checklist

WP-35 is complete only when all of the following are demonstrated:

- [ ] Video, audio, image, text, shape, caption, HTML scene, controller, and nested composition can be placed on any unlocked normal track.
- [ ] At least five overlapping mixed elements appear as separate Timeline blocks.
- [ ] Every active visual element appears in both Monitor and Full Export.
- [ ] Pure vertical drag moves an element to the preceding/following track.
- [ ] Moving or reordering upward places the element visually in front; moving downward reverses it.
- [ ] Add, move, reorder, Undo/Redo, reload, and migration preserve bindings and ordering.
- [ ] One Undo reverses the complete add or move; injected failure leaves no partial state.
- [ ] No ordinary image/text/shape path creates a non-rendering `null` object.
- [ ] Track names/roles never act as compatibility gates.
- [ ] Legacy projects open with unchanged output and migrate only after a valid edit.
- [ ] Monitor defaults to Quarter; Half/Full work; project revision and Full Export are unchanged.
- [ ] Local Monitor and Export consume the same active item ordering and produce matching overlap pixels.
- [ ] A real paired hardware GPU Worker renders the current mixed-element frame.
- [ ] Software rendering cannot advertise the hardware GPU capability.
- [ ] Worker loss, revocation, timeout, or stale response falls back locally without data loss.
- [ ] Decoder, bitmap, asset-token, request, and frame caches have tested bounds and release behavior.
- [ ] `pnpm check`, build, production audit, E2E audit, GitHub CI, and authenticated production gates pass.
- [ ] `STATE.md` records the final deployed SHA, evidence, backups, and rollback release.

## 8. Stop conditions

Luna must stop and report instead of improvising if:

- opening an unedited legacy project changes its persisted bytes or rendered output;
- one user gesture requires multiple Undo operations;
- Monitor, Worker, and Export disagree on active items or z-order;
- any local path, secret, or permanent asset credential reaches browser/API responses;
- Worker detection classifies SwiftShader/software rendering as hardware;
- frame requests accumulate instead of coalescing;
- schema/protocol work requires a destructive database migration;
- the current dirty tree cannot be separated from unrelated user work safely;
- production bytes drift from their immutable source release;
- the GPU Worker misses the current-frame performance gate. In that case, retain local Quarter playback, limit Worker support to the measured paused/current-frame capability, and make no real-time claim.

## 9. Out of scope

- changing Full Export into a remote render-farm workflow;
- arbitrary 3D compositing beyond the existing camera/object model;
- collaborative multi-user conflict resolution for simultaneous drags;
- deleting legacy readers in the same release that introduces the new binding;
- promising real-time GPU Worker playback without measured evidence;
- direct production file edits or drift-protection bypasses.

## 10. Immediate next task

Continue with **R2 completion**, then **R4–R8 integration gates**. The universal schema, deterministic ten-kind fixture, shared local render plan, shared placement planner for the primary UI creation paths, bounded frame/decoder pools, Quarter default, and focused three-viewport timeline behavior are locally verified. Do not start production deployment or claim a real GPU Worker until the remaining legacy placement audit/injected rollback, mixed-element browser/pixel evidence, authenticated Worker host/client, and release gates are complete.
