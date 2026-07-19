# P04 — Motion System and HTML Scenes

**Status:** in-progress · **Gate to enter:** P02 exit criteria (parallel-safe with P03) · **Master plan:** §36 Phase 4, §39 items 62–70, §20.3, §20.4, §2.3
**Goal:** JOY's strongest visual differentiator — universal keyframe motion plus deterministic, sandboxed HTML scenes as first-class timeline objects.

**Decisions needed:** Q11 (scene authoring mode).

## Work packages

- [x] **WP-04.1 — Keyframe engine** _(done 2026-07-20)_. `motion-core` interpolation (hold/linear/eased/bezier temporal + a 2D spatial-path sampler with tangents), `sampleCurve`/`setKeyframe`/`removeKeyframe`, value scaling, and time-relative copy/paste on the new durable §20.3 `AnimationCurveV1` schema; the evaluator resolves animated transforms; keyframe edits ride the shared v1 history via the undoable `object.replaceAnimation` command; Inspector gains per-channel keyframe toggles that add/remove/auto-key at the playhead. _(§39-62,63)_
- [x] **WP-04.2 — Motion UI** _(done 2026-07-20)_. Motion panel with per-channel keyframe lanes (click-to-seek) and a graph-editor baseline; durable parenting (`parentId`) and null/controller objects (`kind: 'null'`) with pure world-transform composition, cycle-safe validation, and an undoable `object.setParent` command; four original JOY motion presets applied as atomic multi-channel curves; pure text animation scopes (character/word/line stagger) and basic motion blur (shutter sample offsets). _(§39-64,65, §20.3)_
- [x] **WP-04.3 — Scene package + runtime** _(done 2026-07-20)_. Versioned manifests validate deterministic permissions and package-relative paths; typed variables resolve defaults and report invalid overrides; asset/font resolvers fail explicitly; strict CSP is generated from declared network origins; compiler diagnostics replace crashes and emit deterministic reference-frame hashes; `joy-scene` validates real package directories; a React starter package compiles end to end. _(§39-66,69, §20.4)_
- [ ] **WP-04.4 — Scene preview + export.** Sandboxed iframe preview with message validation and resource suspension; deterministic headless capture with alpha; frame/region caching; compile/runtime diagnostics as placeholders. _(§39-67,68)_
- [ ] **WP-04.5 — First-party scenes + goldens.** Title, product card, lower third, data-driven list scenes; golden tests; nested-composition variable overrides. _(§39-70, §36-P4)_

## Exit criteria (§36 Phase 4)

- [ ] A reel combining footage, animated captions, keyframed objects, and two HTML scenes builds and exports.
- [ ] Preview and final render stay within defined visual tolerance.
- [ ] A scene with forbidden network/wall-clock behavior fails validation.
- [ ] Scene variables work in manual edit, template instance, and headless render.
- [ ] Missing scene/plugin shows a graceful placeholder, never a broken project.
