# WP-34 — Remaining Implementation and Closeout Plan

> **Final closeout:** WP-34 implementation and release are complete on product
> SHA `630c8ade4c80eea4ca13565204f744c66dd0b67b`. GitHub workflow `31737233944`
> passed `check` and `browser-e2e`; immutable production releases, public
> health/index parity, GBrain, ParsPack backup verification, and VPS cleanup
> are recorded in `STATE.md` and the GBrain page `joy-media-wp34`. The status
> table and packet descriptions below are the historical execution plan that
> preceded the final accepted chain.

**Prepared:** 2026-08-13  
**Implementation branch:** `wp34-integration`  
**Current reviewed head:** `3558556`  
**Canonical main:** `e261252` (clean and an ancestor of the implementation branch)  
**Release state:** local only; not pushed, staged, or deployed

## 1. Objective

Finish WP-34 without rebuilding foundations that already exist. The remaining work must:

1. close known correctness gaps in Effects, Color, and Audio;
2. add independent caption-clip styling and animation;
3. complete camera, transition, appearance/text, time-remap, and scene domains;
4. finish the workspace information architecture and advanced keyframe UX;
5. expose safe agent operations, prove performance/accessibility, and release one immutable SHA.

The working rule remains:

> Register once, edit anywhere appropriate, animate only when meaningful, evaluate once, and render the same result everywhere.

## 2. Truthful status at the current head

| Area                                                                     | Status                                        | Remaining concern                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Universal schema, commands, time domains, ownership lifecycle            | Implemented locally                           | Final coverage/compatibility gate                                                                                                   |
| Shared property rows, interaction sessions, graph bridge, property lanes | Implemented locally                           | Advanced multi-key UX and full conformance audit                                                                                    |
| Transform                                                                | Substantially implemented                     | Final universal-binding/legacy-adapter parity audit                                                                                 |
| Effects                                                                  | Partially complete                            | Effect Studio still has its own recipe animation editing path; prove or finish shared live bindings                                 |
| Color                                                                    | Partially complete                            | Output animation is sampled; clip animation/render ordering and transition-input parity still require explicit implementation/proof |
| Audio                                                                    | Partially complete                            | Clip/bus core works; complete effect descriptors, bus controls, transient gesture semantics, and live de-zippering                  |
| Captions                                                                 | Not implemented                               | Clip-owned model, evaluator, Inspector controls, RTL/karaoke proof                                                                  |
| Camera                                                                   | Not implemented for universal animation       | Inspector migration and FOV sampling                                                                                                |
| Transitions                                                              | Not implemented                               | Descriptor registry, transition-local evaluator, Inspector UI                                                                       |
| Appearance/visual typography                                             | Not implemented as a coherent universal slice | Add only properties already backed by renderer behavior                                                                             |
| Time remap                                                               | Not implemented                               | ADR, monotonic model, evaluator, constrained lane                                                                                   |
| HTML/Motion scenes                                                       | Not universally adapted                       | Manifest policy, deterministic evaluator, shared controls                                                                           |
| Workspace IA                                                             | Partially exists from WP-31/WP-32             | Migrate/clean up; do not rebuild presets or Dockview foundations                                                                    |
| Advanced lanes                                                           | Basic virtualized lanes exist                 | Grouping, filters, marquee, atomic paste, interpolation, 50k-key evidence                                                           |
| Agent API, omission CI, performance, release                             | Not implemented/closed                        | Complete after creative domains stabilize                                                                                           |

The implementation branch is 38 linear commits ahead of `main`. Because `main` is its ancestor, final integration should be a reviewed fast-forward, not a cherry-pick reconstruction.

## 3. Execution rules

- Use one writing executor and one packet at a time.
- Every packet ends in one focused commit with a clean worktree.
- Product state, project schema, evaluator, preview, export, UI, and tests must move together where the property crosses those boundaries.
- Pointer movement is transient. Pointer release, Enter, or blur creates one durable command. Escape/pointer-cancel creates none.
- Never add a control without a descriptor or explicit static/structural/UI-only classification.
- Never keyframe text transcription, cue/word timing, routing, effect order, active-camera assignment, imports, jobs, runtime/backend choices, or workspace preferences.
- Do not push or deploy an intermediate packet.
- A failed focused gate is repaired before dependent work starts. Unrelated independent planning may continue, but no failed packet enters the accepted chain.

## 4. Wave 0 — Correctness closure before adding domains

These packets correct gaps discovered during the current-state audit. They are prerequisites for a truthful Phase D/E/F baseline.

### WP34-24R — Effect Studio shared-binding closeout

**Goal:** Inspector Effects and Effect Studio edit one effect instance and one animation source.

Steps:

1. Map Effect Studio parameter rows to the same stable object/effect/property identity used by Inspector.
2. Replace recipe-local durable keyframe writes with project animation/effect commands or a lossless adapter at the project boundary.
3. Keep recipe drafts transient until Apply; applying must preserve instance IDs, enabled state, order, params, and animation.
4. Make an Inspector edit visible when Effect Studio reopens, and an Effect Studio apply visible immediately in Inspector.
5. Prove scalar, vector/color, boolean/enum hold, enable/bypass, reorder, apply, undo, redo, and reload.

Acceptance:

- no disconnected animation authority;
- one gesture/apply equals one history entry;
- browser preview and export sample the same resolved effect values.

Suggested commit: `fix(effects): unify studio and inspector animation state`

### WP34-26R — Clip color render-order and parity closeout

**Goal:** Animated Clip color is sampled in clip-local time and applied before clip effects/transitions; Output remains post-composite.

Steps:

1. Resolve the active clip’s V2 grade with its `startUs/durationUs` context.
2. Attach the resolved grade to each video/transition input before visual effects.
3. Grade both transition inputs independently, then blend.
4. Keep Output grade on the completed frame only.
5. Use the same dependency-gated LUT resolver in monitor and browser export.
6. Add fixtures where Clip and Output grades intentionally differ, including transition boundaries.

Acceptance:

- no Clip edit leaks to Output or another split clip;
- Clip-before-effects/transition and Output-after-composite tests pass;
- preview/export channel tolerances pass.

Suggested commit: `fix(color): evaluate clip grades before effects and transitions`

### WP34-32R — Audio completeness and interaction closeout

**Goal:** Finish Audio’s descriptor/UI contract rather than treating the current clip-gain slice as the whole phase.

Steps:

1. Register first-party EQ/compressor/limiter/gate parameters with ranges, units, interpolation, and smoothing.
2. Classify fade controls and bus insert/send amounts; keep solo, route, device, backend, source replacement, and chain order static.
3. Add shared rows for bus pan/mute and eligible effect parameters.
4. Convert mixer/Inspector sliders from per-input durable writes to transient preview plus one final command.
5. Schedule live WebAudio gain/pan changes with the declared short ramp instead of assigning abrupt values.
6. Keep Runtime/provider/model controls under a collapsed Advanced/Process section, separate from Mix/Enhance creative controls.
7. Add exact block-boundary, mute-hold, solo-static, undo-count, Escape, reload, and export fixtures.

Acceptance:

- every visible Audio control is classified exactly once;
- no zipper discontinuity at automation block boundaries;
- Inspector and Mixer show the same keys/state;
- compact widths remain usable.

Suggested commits:

- `feat(audio): complete effect and bus automation descriptors`
- `fix(audio): coalesce mixer gestures and smooth live preview`
- `refactor(audio): separate creative controls from runtime process state`

### Wave 0 gate

- focused Effect Studio/Inspector round-trip tests;
- Clip/Output color render-order and transition fixtures;
- audio ramp/undo/compact-width tests;
- `pnpm check`;
- `pnpm build`;
- `git diff --check`.

No caption work starts until this gate is green.

## 5. Wave 1 — Captions and Phase F closeout

### WP34-33A — Caption clip-owned style model

**Goal:** Two timeline caption clips may reuse one transcript document while owning independent appearance.

Steps:

1. Add optional clip-owned V2 style overrides with identity defaults.
2. Include position, scale, opacity, font size, tracking, line height, text color, plate color/opacity, highlight color, and safe alignment/template holds.
3. Add stable caption descriptors and `caption-clip-local` bindings.
4. Keep document text, segments, words, speakers, and timings unchanged.
5. Define split, duplicate, copy/paste, delete, undo, and orphan behavior.
6. Validate finite ranges, colors, hold values, owner existence, and old-project compatibility.

Acceptance:

- old projects serialize/render unchanged;
- two clips sharing a document can diverge without mutating that document;
- lifecycle operations preserve ownership correctly.

Suggested commit: `feat(captions): add clip-owned style animation model`

### WP34-34A — Caption evaluator and Render IR

**Goal:** Resolve caption style at caption-local time before text nodes are emitted.

Steps:

1. Merge template defaults, document style reference, clip overrides, and sampled animation in a deterministic order.
2. Preserve derived karaoke progress from word timing.
3. Apply safe-area, line wrapping, RTL direction/alignment, plate, and highlight after style resolution.
4. Ensure monitor and export call the same evaluator.
5. Add two-clip/shared-document, boundary, RTL, Persian/English, karaoke, and identity golden fixtures.

Acceptance:

- cue text/timing is never sampled as property animation;
- RTL, wrapping, karaoke, and safe areas remain stable while style animates;
- preview/export output matches.

Suggested commit: `feat(captions): evaluate clip-local animated styles`

### WP34-34B — Inspector Caption UI

**Goal:** Inspector edits the selected caption clip; Captions remains transcript/template authoring.

Steps:

1. Add a Caption tab/section when one caption clip is selected.
2. Render universal rows for eligible style values and hold choices.
3. Keep transcript, timing, speaker, transcription, and language controls in Captions.
4. Add reset, previous/next key, diamond state, graph focus, keyboard, and accessible labels.
5. Use transient gesture sessions and one durable command.
6. Cover 320–560 px dock widths.

Acceptance:

- no duplicated style state between Captions and Inspector;
- independent clips show independent values/keys;
- all accessibility and undo semantics pass.

Suggested commit: `feat(captions): add inspector keyframe controls`

### Phase F gate

- Audio and caption focused suites;
- caption LTR/RTL/karaoke/safe-area goldens;
- one-gesture/one-undo and Escape tests;
- narrow-dock accessibility checks;
- full `pnpm check && pnpm build`.

## 6. Wave 2 — Camera, transitions, appearance, time, and scenes

### WP34-35/36 — Camera migration and evaluation

Packets:

1. Register camera X/Y/Z, roll, and FOV; retain create/delete/parent/active assignment as structural.
2. Move selected camera values to Inspector universal rows; Camera remains rig management.
3. Sample FOV and camera transforms through the shared evaluator.
4. Clamp FOV to the valid projection range and add near/far depth preview/export fixtures.

Acceptance: no duplicate value editor, smooth valid projection, static rig topology.

### WP34-37/38 — Transition descriptors, evaluator, and Inspector

Packets:

1. Generate descriptors from declared transition shader uniforms.
2. Classify eligible scalar/vector/color/approved hold parameters; keep type, duration, and clip ownership static.
3. Resolve transition-local time from 0 through duration, including trim/rebase boundaries.
4. Apply values before blend in CPU/GPU/browser paths.
5. Make Transitions catalog/apply-only and Inspector the selected-junction editor.

Acceptance: local-time fixtures, replacement simplicity, one undo per gesture, preview/export parity.

### WP34-39A/B — Renderer-backed appearance and visual text

Packets:

1. Inventory only properties already supported by schema and renderer.
2. Add durable descriptors/evaluation for supported fill, stroke, shadow, crop, corner, and typography values.
3. Add hold Source Text/alignment/font choice only when bundled/preloadable.
4. Add Inspector rows after evaluator/render support exists.

Acceptance: no fake controls; color/vector/text holds and pixel goldens pass.

### WP34-40/41 — Time-remap ADR, model, evaluator, and lane

Packets:

1. Write and accept an ADR for monotonic output-local to source-local mapping.
2. Define trim, split, duplicate, reverse, freeze, loop prohibition, and audio policy.
3. Add schema validation that rejects out-of-range/non-monotonic mappings except explicit reverse segments.
4. Preserve legacy static playback rate until first remap edit.
5. Implement evaluator/export source-time parity.
6. Add a constrained source-time/speed lane with handles that cannot produce invalid mappings.

Acceptance: rate, ramp, freeze, reverse, trim, split, reload, undo, and export fixtures pass.

### WP34-42 — HTML-scene manifest animation

Steps:

1. Extend trusted scene input manifests with explicit value kind, animation policy, default, and constraints.
2. Reject undeclared DOM/CSS paths.
3. Resolve scene-local numeric/vector/color and approved hold inputs.
4. Preserve sandbox, CSP, network, and deterministic capture behavior.

Acceptance: undeclared inputs cannot be addressed and browser/headless parity remains green.

### WP34-43 — Motion Studio adapter

Steps:

1. Reuse universal property rows and transient interaction sessions.
2. Adapt existing scene animation storage without eager document migration.
3. Keep layer identity/order/group/mask topology structural.
4. Remove any second descriptor inventory and preserve My Motions assets for the later Library move.

Acceptance: old scene documents load, one gesture/one undo, preview/export unchanged.

### Phase G gate

- domain-focused schema/evaluator/UI suites;
- CPU/GPU/browser parity where relevant;
- lifecycle and legacy fixtures;
- full `pnpm check && pnpm build`;
- architecture review of time remap and scene security.

## 7. Wave 3 — Information architecture and advanced animation UX

Existing Dockview presets, Custom persistence, TimelinePropertyLanes, basic time-window virtualization, Dual Lens, Templates, and My Motions are inputs—not blank slates.

### WP34-44 — Layout v2 migration

1. Version saved Dockview layouts.
2. Add deterministic aliases for renamed/moved panels and groups.
3. Preserve valid Custom layouts exactly.
4. Test WP-31/WP-32 fixtures and malformed/partial recovery.

### WP34-45 — Library and responsibility cleanup

1. Move Templates and My Motions browsing into Library.
2. Keep Effects/Transitions as browse/apply surfaces.
3. Keep Camera as rig/structure.
4. Keep Inspector as the selected-property editor.
5. Remove System/Runtime panels from creative defaults while retaining View/command-palette reachability.

### WP34-46/47 — Animate, Flow, and workspace presets

1. Rename Motion to Animate with compatibility aliases.
2. Focus Animate on Animated Properties, Dope Sheet, Graph, Paths, and Presets.
3. Absorb Dual Lens into Timeline Flow mode without deleting its durable graph.
4. Finalize Edit, Enhance, Audio & Captions, Automate, and Custom layouts.
5. Verify desktop and compact restoration for every preset.

### WP34-48 — Advanced lanes and virtualization

1. Group lanes by owner/domain with progressive disclosure.
2. Add Show Animated and Show Modified filters.
3. Add multi-key selection, marquee, frame snapping/Alt override, atomic copy/paste, interpolation menu, and bounded drag.
4. Virtualize offscreen owners, lanes, keys, labels, and hit regions.
5. Add a 50,000-key fixture and bounded-work assertions.

### WP34-49 — Accessibility/focus closeout

1. Complete keyboard traversal and focus restoration across panel changes.
2. Announce no-key/between/keyed/mixed states.
3. Verify visible focus, reduced motion, contrast, tooltips, labels, and control/value relationships.
4. Run axe/Playwright at 320, 360, 420, 480, and 560 px dock widths plus desktop presets.

### Phase H gate

- saved-layout migration matrix;
- screenshot and narrow-width matrix;
- 50k-key stress evidence;
- `pnpm test:e2e:audit`;
- `pnpm check`;
- `pnpm build`.

## 8. Wave 4 — Agent API, CI enforcement, performance, and release

### WP34-50 — Agent/change-set operations

Expose typed enable/disable/set/remove/move/interpolation operations through existing permission and validation boundaries. Reject raw JSON paths, unknown descriptors, missing owners, structural properties, and incompatible domains. Prove UI and agent commands normalize to identical project state.

### WP34-51 — Coverage/omission CI gate

Generate a machine-readable report joining:

- visible adjustable controls;
- registered descriptors;
- evaluator support;
- renderer/audio consumer support;
- explicit static/structural/UI-only reasons.

CI must fail with a useful property ID when a new control or descriptor is unclassified.

### WP34-52 — Performance and memory

Measure and optimize:

- descriptor lookup and active-curve indexing;
- color snapshots/LUT preload caches;
- audio block plans;
- caption layout/style resolution;
- transition/scene sampling;
- lane geometry and React rerenders.

Required budgets:

- paused edit-to-preview p95 under 50 ms;
- no interaction task over 50 ms;
- 500 scalar channels under 5 ms p95 on the reference machine;
- no unexplained playback regression over 15%;
- visible-lane/key work scales with viewport, not project total.

### WP34-53 — Candidate integration and immutable staging

1. Require a clean `wp34-integration` head and final diff review.
2. Run frozen install, `pnpm verify:ci`, and `pnpm test:e2e:audit`.
3. Push the candidate branch only after local evidence is green.
4. Require GitHub CI on that exact SHA.
5. Fast-forward canonical `main` from `e261252` to the accepted SHA.
6. Build an immutable JOY Media staging release under the existing `/opt/joy-media` procedure.
7. Record source SHA, artifact hash, release labels, and previous rollback target.

Do not deploy JOY Media through `/opt/joy-wg-bot`; that is a different runtime.

### WP34-54 — Signed-in acceptance

Run on the exact staging SHA:

1. transform key creation, move, graph edit, undo/redo;
2. effect edit from Inspector and Effect Studio;
3. Clip/Output color, curve morph, LUT hold and missing dependency;
4. audio clip/bus/effect automation and export;
5. two caption clips sharing one document;
6. camera Z/FOV;
7. transition-local uniform;
8. time ramp/freeze/reverse;
9. HTML/Motion scene input;
10. Animated/Modified lanes, presets, reload, and Custom layout;
11. browser export parity and diagnostics exclusion.

Evidence must include screenshots/video, console/network health, saved/reloaded project bytes, export hashes, and the staging SHA.

### WP34-55 — Production promotion, rollback, and GBrain

Only after staging acceptance:

1. promote the already-tested immutable artifact—do not rebuild;
2. atomically switch the JOY Media release pointer;
3. verify public health and `https://joyst.ir/?deploy=<short-sha>`;
4. run the signed-in smoke matrix;
5. retain and verify the prior release as rollback;
6. update STATE, WP-34 plan status, QA evidence, and GBrain with the same source/artifact SHA;
7. perform/document the rollback drill without editing an active release.

## 9. Packet gate template

Every implementation packet follows this sequence:

1. inspect current owners/descriptors/evaluator/renderer/UI;
2. state the exact property IDs and time domain;
3. add focused failing tests;
4. implement schema/commands/evaluation/rendering before exposing UI;
5. wire universal rows and transient gesture behavior;
6. run focused tests and package builds;
7. run typecheck, lint, format, and `git diff --check`;
8. review the entire diff;
9. commit once with a narrow message;
10. start the next dependency-safe packet.

At each phase gate:

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
git diff --check
```

Before staging:

```powershell
pnpm verify:ci
pnpm test:e2e:audit
```

## 10. Completion definition

WP-34 is complete only when:

- every logical creative adjustment has a stable descriptor or an explicit static reason;
- all supported domains use the correct owner and time domain;
- Inspector/workspace surfaces edit one shared state;
- preview and browser export evaluate the same result;
- every gesture creates exactly one undo entry and Escape creates none;
- old projects retain prior appearance until edited;
- layout migration, accessibility, and performance gates pass;
- one immutable candidate passes local, GitHub CI, staging, and signed-in acceptance;
- production, rollback evidence, STATE, QA records, and GBrain all identify the same SHA.

## 11. Immediate next sequence

The next work should run in this exact order:

1. WP34-24R — Effect Studio shared-binding closeout;
2. WP34-26R — animated Clip color/render-order closeout;
3. WP34-32R — Audio completeness/gesture closeout;
4. Wave 0 gate;
5. WP34-33A — caption clip-owned model;
6. WP34-34A — caption evaluator/rendering;
7. WP34-34B — Inspector Caption UI;
8. Phase F gate.

Only then proceed to Camera and Transitions.
