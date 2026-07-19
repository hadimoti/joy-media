# P04 — Motion System and HTML Scenes

**Status:** not-started · **Gate to enter:** P02 exit criteria (parallel-safe with P03) · **Master plan:** §36 Phase 4, §39 items 62–70, §20.3, §20.4, §2.3
**Goal:** JOY's strongest visual differentiator — universal keyframe motion plus deterministic, sandboxed HTML scenes as first-class timeline objects.

**Decisions needed:** Q11 (scene authoring mode).

## Work packages

- [ ] **WP-04.1 — Keyframe engine.** `motion-core` keyframe schema + interpolation (hold/linear/Bezier/eased, spatial+temporal); Inspector keyframe controls; keyframe copy/paste and value scaling. _(§39-62,63)_
- [ ] **WP-04.2 — Motion UI.** Timeline keyframe lanes, graph editor baseline, parenting/null evaluation, motion presets, text animation scopes, basic motion blur. _(§39-64,65, §20.3)_
- [ ] **WP-04.3 — Scene package + runtime.** `html-scene-runtime`: manifest/compiler/SDK, deterministic clock, typed variables, asset/font resolver, permissions → generated CSP; scene package CLI; React starter template. _(§39-66,69, §20.4)_
- [ ] **WP-04.4 — Scene preview + export.** Sandboxed iframe preview with message validation and resource suspension; deterministic headless capture with alpha; frame/region caching; compile/runtime diagnostics as placeholders. _(§39-67,68)_
- [ ] **WP-04.5 — First-party scenes + goldens.** Title, product card, lower third, data-driven list scenes; golden tests; nested-composition variable overrides. _(§39-70, §36-P4)_

## Exit criteria (§36 Phase 4)

- [ ] A reel combining footage, animated captions, keyframed objects, and two HTML scenes builds and exports.
- [ ] Preview and final render stay within defined visual tolerance.
- [ ] A scene with forbidden network/wall-clock behavior fails validation.
- [ ] Scene variables work in manual edit, template instance, and headless render.
- [ ] Missing scene/plugin shows a graceful placeholder, never a broken project.
