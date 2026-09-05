# JOY Agent foundation implementation review — 2026-09-05

Status: reviewed foundation candidate accepted for scoped JOY Media deployment. This document is not a full-editor capability sign-off; production activation/readiness evidence belongs in the subsequent operational receipt.

## Scope

- Base: `dde0a4ab3ce56898ba1a9f6a8a80f4dbebff9783`.
- Reviewed the existing uncommitted agent foundation, its browser Worker proposal path, context packing, motion compilation, presence routing, transaction preparation, readback and replay behavior.
- The owner requested that one Luna agent perform both confirmed bug fixes and the eventual verified JOY Media deployment. The parent owns review and memory closeout.
- Concurrent `joy-vps` work is out of scope. Do not modify its source/runtime, restart its services, reload shared Nginx, or overwrite its memory/brief updates.

## Confirmed findings requiring regression coverage

1. **Context overflow blocks ordinary projects.** A snapshot containing 100 valid Persian titles of 500 characters each exceeds the 60,000-byte envelope and throws before the model request. Pack to a byte budget, prioritize selected entities, and report omissions without leaking secrets.
2. **New title references fail in the Worker.** A title insertion followed by a dependent keyframe compiles canonically, but the Worker rejects its new owner ID against the frozen pre-run object set. Use typed output references resolved from verified dependency outputs; never accept guessed arbitrary owners.
3. **Repeated creation operations collide.** The compound compiler sends each timeline operation as a one-element array, resetting generated-ID indices. Splitting the reference intro at 2 seconds and then at 1 second fails because both derived clips receive the same ID. Multiple asset insertions have the same issue.
4. **Agent split bypasses human lifecycle preparation.** A split of the reference intro produces a new clip without the source `intro-title` binding. Preserve visual bindings, clip-local property curves, audio settings/effects and universal timeline state through the shared preparation helpers and one compound Undo boundary.
5. **Presence points to the wrong surface.** Inspector keyframes route to the Motion preset catalog, and property entity targets have no rendered consumer. Route supported keyframe edits to Inspector/Visual, expose the matching visible property row and retain actual targets through completion.
6. **Replay reports the wrong state.** Retry after a later edit or Undo is a no-op but reads the current revision as though it were the original committed result, and compares an old draft against the changed document. Return the original receipt identity and keep replay messaging distinct from a fresh verified commit.

## Acceptance requirements

- Regression tests for the above paths, including invalid references and dependency order, multilingual size limits, duplicate/no-op replay, immutable preview and one-step Undo.
- Typecheck, focused lint, build and the full unit suite on the final source candidate.
- Browser fixture tests for the real Worker, preview, approval and presence path without using an owner credential or making billable provider calls.
- Exact-commit immutable deployment with verified release identity, dependency readiness and public/direct-origin delivery. Retain the previous release for rollback.
- Read-only Codex browser smoke of production. Do not mutate the owner's project to produce acceptance evidence.

## Final pre-deployment evidence

- All six findings above have fixes and targeted regressions. Review also caught and corrected a pre-seeded creation fixture, omitted-field byte overhead, manual duplicate/freeze regressions during extraction, and invalid fractional universal timeline ordering.
- Parent verification on stable source: `pnpm test -- --testTimeout=30000 --maxWorkers=4 --reporter=dot` — **440 files passed, 1 skipped; 3,502 tests passed, 38 skipped**.
- Root `pnpm typecheck`, changed-source ESLint, editor production build and `git diff --check` passed. Luna additionally verified changed-file Prettier checks.
- Parent executed `agent-live-preview.spec.ts` and `agent-live-presence.spec.ts`, desktop-primary, one worker — **6/6 passed**. These exercise real Worker fixture responses, the approval boundary, title clip creation, Undo removal, revision invalidation and focus-preserving presence.
- The empty-object-context creation case is proven in the Worker unit test. The browser fixture uses the reference workspace, not an entirely empty project. It accepts the dependent keyframe proposal but does not directly assert the committed/evaluated opacity or rendered pixels; do not label it full animation-render acceptance.
- Independent Unicode sweep: **500/500 sizes passed**, with the selected final object retained and maximum serialized context of **59,921 bytes**.
- Worker bundle verifier passed: `engine.worker-BEY0K4x3.js`, 59,872 raw bytes / 17,331 gzip bytes in the reviewed local production build.
- Astra's final read-only review found no remaining concrete P0/P1 blocker in the corrected paths, with 22 focused tests independently passing. This is bounded review evidence, not a guarantee of absence of bugs throughout the application.
- Earlier whole-suite runs exposed one upload-test failure that passed in isolation, and two failures while the timeline patch was still changing. The final stable bounded-concurrency run passed all included tests; no unrelated API fix was applied.
- No owner credential, billable model call, production project edit or `joy-vps` mutation was used for these checks.

## Not established by this release

The broad architecture plan remains open. Sixteen proposal operation kinds and registry metadata do not establish full editor control. Complete domain adapters (effects, audio, scenes, assets/jobs/export), an executable skill runtime, canonical compiler feedback within the model repair loop, fully project-scoped durable run lifecycle, complete entity/preview parity and actual rendered/audio verification still require their own implementation and acceptance gates. No live BYOK model quality or paid-provider journey is claimed by deterministic fixtures.
