# JOY Living Looks and Linked Versions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` / installed `executing-plans` task-by-task. A Claude implementer agent executes; an independent Claude Opus agent reviews the exact release candidate before deployment. Read the master plan and R1 contracts first.

**Goal:** Turn JOY's verified editing/observation foundation into distinctive editable art direction and coherent campaign deliverables that preserve human choices.

**Architecture:** Declarative Look recipes compile into existing JOY entities, properties and keyframes through R1's operation definitions. Linked versions are project-owned derivative compositions with typed dependency mappings and three-way updates, not a new external database or rendering engine.

**Tech Stack:** Existing project-schema, motion/property/audio systems, command transactions, React panels and RenderFrameIR, Vitest/Playwright. Reuse R1 evidence, consent, receipts and verifier.

---

## R2 prerequisites and file boundaries

R1's shared operations, prepared changes, durable controller, actual render observation and field-level binding validation must pass before these features are advertised. Code can be prepared behind development flags, but a flag does not satisfy acceptance. Preserve existing motion descriptors and project migrations.

- Look schema/data: `packages/project-schema/src/living-look.ts`, exported through `index.ts`.
- Pure compiler/pack definitions: `packages/motion-core/src/looks/`.
- Local persisted application instances: project document, not private provider session state.
- Host adapter and UI: `apps/editor-web/src/joy-agent/look-operations.ts`, `LivingLooksPanel.tsx`, shared Inspector property controls.
- Do not place executable scripts or remote-fetch instructions inside Look files.

## L1 — Versioned Look definition and durable instances

**Files**

- Create: `packages/project-schema/src/living-look.ts`, `living-look.test.ts`, `packages/motion-core/src/looks/validate.ts`, `validate.test.ts`.
- Modify: `packages/project-schema/src/v1.ts`, `migration.ts`, `index.ts`, schema validators; `apps/editor-web/src/project-package.ts`, `project-document-hydration.ts` and tests.

Introduce a typed semantic style value using existing property-system scalar/color/font/enum types, not arbitrary CSS strings. A definition has ID/version, title, slots, typed controls, validated binding targets, supported composition constraints, license/provenance, dependency declarations and verification predicates. Persist instances separately from definitions so applying a new pack version is an explicit action.

```ts
export interface LookInstance {
  id: string;
  definitionId: string;
  definitionVersion: number;
  compositionId: string;
  entityBindings: Readonly<Record<string, string>>;
  controlValues: Readonly<Record<string, number | string | boolean>>;
  overriddenBindingIds: readonly string[];
  createdEntityIds: readonly string[];
}
export function isLookBindingWritable(
  bindingId: string,
  instance: LookInstance,
  resetOverrides: boolean,
): boolean {
  return resetOverrides || !instance.overriddenBindingIds.includes(bindingId);
}
```

Runtime schemas reject unsupported control types, cross-project bindings, external URLs and executable payloads. Use a stable binding ID from the property descriptors; translated display labels are not binding identity.

- [ ] Red tests: old schema-5 project with no Looks round-trips unchanged; instance applies only to its composition; definition update cannot mutate an existing pinned instance; one manual override survives control reapplication; explicit reset changes only selected overrides.
- [ ] Test unknown newer schema opens read-only/actionable where supported, never strips data. Project import/export validates missing dependencies, malicious pack fields and collisions.
- [ ] Run `pnpm exec vitest run packages/project-schema/src/living-look.test.ts packages/motion-core/src/looks/validate.test.ts apps/editor-web/src/project-package.test.ts` red.
- [ ] Implement additive versioned storage/migration using the next schema version at the execution baseline, not a hardcoded version that may conflict with other work. Include instances in session revision, atomic journal, Undo and package portability; exclude credentials/evidence bytes.
- [ ] Run green plus all existing schema/migration/hydration tests; commit `feat(looks): persist versioned editable style instances`.

## L2 — Pure Look compiler and shared manual/agent control

**Files**

- Create: `packages/motion-core/src/looks/compile.ts`, `compile.test.ts`, `apps/editor-web/src/joy-agent/look-operations.ts`, `look-operations.test.ts`, `LivingLooksPanel.tsx`, `LivingLooksPanel.test.tsx`.
- Modify: operation registry, `packages/motion-core/src/descriptor.ts` only for compatible references, existing Inspector property bindings and composer skill selection.
- Test: `tests/e2e/agent-living-looks.spec.ts`.

Compiler inputs: pinned definition, instance or new-slot assignment, composition dimensions/duration, resolved free-font/assets, typed controls and frozen revision. Outputs: ordinary canonical operations, created entity output refs, diagnostics, changed bindings and dependency requirements. No second rendering representation.

Macros are deterministic bounded mappings, not model-generated property paths. Example scalar map (use only for declared legal scalar bindings):

```ts
export function mapLookControl(value: number, minimum: number, maximum: number): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1 ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum > maximum
  )
    throw new RangeError('Invalid Look control range');
  return minimum + value * (maximum - minimum);
}
```

- [ ] Red tests: map `[0, 0.5, 1]` over `[10, 30]` to `[10, 20, 30]`; invalid/nonfinite/range inputs reject; same definition/inputs yield same operation digest; manually overridden property is unchanged; invalid target yields no partial operation commit.
- [ ] Run `pnpm exec vitest run packages/motion-core/src/looks/compile.test.ts apps/editor-web/src/joy-agent/look-operations.test.ts`.
- [ ] Implement `looks.catalog`, `looks.describe`, `looks.prepareApply`, `looks.prepareUpdate`, `looks.detach` and `looks.resetOverrides` through the R1 operation registry. Read operations are read-only; changes use normal prepare/approval/Undo. Detach preserves authored entities as ordinary editable content; removal lists only entities the instance owns and needs explicit removal intent.
- [ ] Build a compact Looks panel using shared controls: select slots, show macros/individual properties, preview, apply, reset selected override or detach. Agent and manual interactions compile the same inputs to identical complete state. User edits on linked bindings mark overrides through the canonical operation path, including edits made by user-directed agent commands.
- [ ] Run `pnpm exec playwright test tests/e2e/agent-living-looks.spec.ts --project=desktop-primary`; prove title/effect/keyframe editability, preview pixels, exact Undo/Redo/reload and project export/import. Commit `feat(looks): compile styles through shared editor operations`.

## L3 — Six art-directed packs with inspectable fixtures

**Files — create**

- `packages/motion-core/src/looks/packs/editorial-clean.ts`
- `packages/motion-core/src/looks/packs/product-precision.ts`
- `packages/motion-core/src/looks/packs/kinetic-type.ts`
- `packages/motion-core/src/looks/packs/quiet-documentary.ts`
- `packages/motion-core/src/looks/packs/music-pulse.ts`
- `packages/motion-core/src/looks/packs/persian-editorial.ts`
- `packages/motion-core/src/looks/packs/index.ts`, `packs.test.ts`
- `tooling/fixtures/living-looks.json`, `tests/e2e/living-looks-render.spec.ts`

| Pack              | Deliberate identity                                                   | Editable slots / checks                                                                                     |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Editorial Clean   | Restrained hierarchy and alignment, clean title/subtitle rhythm       | Headline/deck/caption/accent; readable contrast and safe margins                                            |
| Product Precision | Controlled product framing, callouts and timed emphasis               | Product region/callout/benefit/CTA; do not cover the observed subject, align callout at actual event        |
| Kinetic Type      | Phrase-led typography with distinct entrance/hold/exit                | Word groups, rhythm and scale/offset curves; no unreadably short holds or clipping                          |
| Quiet Documentary | Minimal lower thirds, gentle fades, listening space                   | Speaker/title/captions, audio continuity; no invented speaker identity or forced beat animation             |
| Music Pulse       | Audio-linked motion with bounded amplitude and restrained accent cuts | Envelope source, response scale, event grid and accent; silent audio yields stable output                   |
| Persian Editorial | Native RTL hierarchy and mixed-script typography                      | Persian/Latin/numerals/captions; shaping, line wrap, free-font readiness and correct bidirectional behavior |

Each pack defines portrait and landscape constraint values explicitly. Energy changes declared duration/amplitude/easing bindings; density changes a declared set of optional accents/spacing constraints; contrast changes validated palette pairs, not arbitrary unmeasured color choices. If a macro has no meaningful effect for a pack, omit it rather than ship a fake slider.

- [ ] Write red schema tests for each pack's real operation/property dependencies, free-font resolution, finite ranges, semantic slot uniqueness, valid timing and no executable content.
- [ ] Run `pnpm exec vitest run packages/motion-core/src/looks/packs.test.ts`.
- [ ] Author each pack as typed declarative data and compile it on portrait, landscape, short/long title, missing optional media and RTL fixtures. Use installed/free fonts only; include license notices and fallback diagnostics without resurrecting Fontiran.
- [ ] Render before/after/keyframe boundary frames and full short motion previews using actual JOY rendering. Establish golden expectations for stable geometry/timing/pixels with pinned fixture fonts; account explicitly for platform rasterization tolerance, not broad screenshot masks.
- [ ] Run `pnpm exec playwright test tests/e2e/living-looks-render.spec.ts --project=desktop-primary`. Review actual motion and legibility visually; save sanitized samples for independent-reviewer/creator evaluation. A passing schema test is not art-direction approval.
- [ ] Commit each independently finished pack, then pack integration. Run the master's creator scorecard and record weaknesses; improve the pack data/constraints rather than multiplying presets to hide low quality.

## L4 — Audio-reactive motion that remains editable and deterministic

**Files**

- Create: `packages/motion-core/src/looks/audio-reactive.ts`, `audio-reactive.test.ts`.
- Reuse/extend: R1 `packages/audio-core/src/beat-envelope.ts`, motion keyframe operations and property sampling.
- Test: `tests/e2e/living-looks-audio-motion.spec.ts`.

Inputs are an explicit audio evidence version, source/composition time mapping, selected legal property, amplitude range, smoothing and keyframe density. Output is ordinary keyframes with analysis provenance. Do not run a live microphone or mutable wall-clock callback in render/export.

- [ ] Red tests: known impulse creates bounded response at the expected composition time; smoothing never overshoots declared property limits; silence yields a constant/no-op curve; changed speed/remap invalidates derived timing; low-confidence beat detection is reported without invented downbeats.
- [ ] Run `pnpm exec vitest run packages/motion-core/src/looks/audio-reactive.test.ts`.
- [ ] Implement envelope-to-keyframe sampling with bounded simplification error and explicit maximum key count; expose approximation error if decimating. Human editing of a generated key marks the corresponding curve override. Reanalysis produces a proposed diff, not an automatic overwrite.
- [ ] Compare preview/export evaluation at exact impulse/key times, then decode the export to verify A/V alignment. Run `pnpm exec playwright test tests/e2e/living-looks-audio-motion.spec.ts --project=desktop-primary`.
- [ ] Commit `feat(looks): bake audio-reactive motion into editable keyframes`. R2 review bundle includes six packs, source audio evidence, editable project packages, actual rendered samples and pilot feedback. Apply the master independent-Opus review gate before release.

## R3 scope and model decision

Initial linked versions live inside one project as derivative compositions. Do not introduce automatic cross-project/cloud collaboration to implement this. Manual ordinary compositions continue to work without links. Existing paid/generated assets are reused by reference; missing asset/permission is a preflight failure, not permission to regenerate.

## C1 — Linked composition schema and ownership

**Files**

- Create: `packages/project-schema/src/linked-version.ts`, `linked-version.test.ts`, `packages/commands/src/linked-version.ts`, `linked-version.test.ts`.
- Modify: project schema/index/migration, session revision/journal, project-package/hydration and validation.

```ts
export interface LinkedVersion {
  id: string;
  masterCompositionId: string;
  derivativeCompositionId: string;
  appliedMasterRevision: string;
  baseSnapshotId: string;
  entityMap: Readonly<Record<string, string>>;
  overrideBindingIds: readonly string[];
  lockedEntityIds: readonly string[];
  format: 'portrait' | 'landscape' | 'poster' | 'localized';
  language?: string;
  lastVerifiedExportReceiptId?: string;
}
```

Persist a compact versioned base snapshot/digest of linked fields sufficient for three-way comparison, not just a label. Field keys use canonical typed bindings; missing vs explicitly null/deleted values are distinct. A master cannot depend on its derivative; validate cycles and entity ownership.

- [ ] Red tests: schema migration without links, derivative clone with stable map, no shared mutable object aliasing, unresolved IDs, nested cycle, deleting a master with dependents, detach retaining derivative content and local overrides.
- [ ] Run `pnpm exec vitest run packages/project-schema/src/linked-version.test.ts packages/commands/src/linked-version.test.ts`.
- [ ] Implement typed create/read/detach/delete-link operations through the canonical session. Master deletion requires an explicit choice to detach or remove dependents; default rejection preserves data. Link removal is not asset deletion.
- [ ] Include schema recovery/package import/export and exact one-Undo behavior. Run green plus schema/session tests; commit `feat(versions): persist linked compositions and overrides`.

## C2 — Three-way selective propagation and conflict preview

**Files**

- Create: `packages/commands/src/version-propagation.ts`, `version-propagation.test.ts`, `apps/editor-web/src/joy-agent/version-operations.ts`, `version-operations.test.ts`.
- Create: `apps/editor-web/src/VersionChangesPanel.tsx`, `VersionChangesPanel.test.tsx`.
- Test: `tests/e2e/linked-version-propagation.spec.ts`.

Pure per-field merge rule, applied only after typed entity/dependency validation:

```ts
export type MergeChoice = 'unchanged' | 'apply-master' | 'preserve-variant' | 'conflict';
export function chooseLinkedFieldUpdate(input: {
  masterChanged: boolean;
  variantChanged: boolean;
  equalCurrentValues: boolean;
  locked: boolean;
  overridden: boolean;
}): MergeChoice {
  if (!input.masterChanged || input.equalCurrentValues) return 'unchanged';
  if (input.locked || input.overridden) return 'preserve-variant';
  return input.variantChanged ? 'conflict' : 'apply-master';
}
```

Deletion/relationship changes need a typed conflict resolution: deleting an entity with locked descendant fields, changing source duration beyond trims, missing fonts/media, or destroying override bindings cannot be solved by a scalar merge alone. Keep the old base until approved application succeeds.

- [ ] Red tests: master title change propagates to untouched derivative; manual crop/text override survives; both sides change an unmarked field → conflict; new master entity creates a new mapping; master deletion of a locked entity is a visible conflict; equal values produce no-op.
- [ ] Run `pnpm exec vitest run packages/commands/src/version-propagation.test.ts apps/editor-web/src/joy-agent/version-operations.test.ts`.
- [ ] Implement `versions.describe`, `versions.prepareCreate`, `versions.prepareUpdate`, `versions.lock`, `versions.override`, `versions.detach` using R1 prepare/commit/receipts. Compare previous base/new master/current derivative, not only timestamps. Map source/output refs deterministically and respect nested time domains.
- [ ] UI previews affected variants and fields, preserved overrides, actual frame differences and conflicts. User chooses explicit resolution; unresolved conflicts block commit. Group a local multi-composition update in one transaction/Undo; if an external export job follows, show separate job/checkpoint receipts.
- [ ] Test source revision drift after preview, one failed variant preparation, writer race, reload and retry. Run `pnpm exec playwright test tests/e2e/linked-version-propagation.spec.ts --project=desktop-primary` green. Commit `feat(versions): preview selective updates without overwriting users`.

## C3 — Four useful derivative formats with evidence-based framing

**Files**

- Create: `apps/editor-web/src/versions/variant-planner.ts`, `safe-area-verifier.ts`, `variant-planner.test.ts`, `safe-area-verifier.test.ts`, `VariantsPanel.tsx`.
- Reuse: R1 media evidence/render verifier/skills, project output settings, text/caption operations and Look constraints.
- Test: `tests/e2e/linked-version-formats.spec.ts`.

Deliver portrait, landscape, still poster and localized title/caption variants. Target formats are editable presets, not claims about permanent platform specifications. User can change dimensions, duration, frame rate and safe margins. Poster has a selected composition time plus separately editable layout; it is not a hidden video export with a renamed extension.

- [ ] Red fixtures: moving subject crosses an edge; crop must follow observed trajectory only in covered intervals; unknown intervals create a review warning. Portrait title wraps within margins; poster picks an actual observed frame; Persian localization shapes correctly; missing translated copy prompts/blocks rather than invents an approved translation.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/versions/variant-planner.test.ts apps/editor-web/src/versions/safe-area-verifier.test.ts`.
- [ ] Build a variant preparation skill using explicit source/Look/entity mappings and evidence IDs. Convert reframing trajectories into editable camera/crop keyframes; keep user locks. Avoid identifying people; use user-selected subject regions or visual object tracking evidence. No face/voice identity inference is needed.
- [ ] Allow supplied translated text; machine translation is a separately consented provider operation with source/output review. Changing language or duration must show affected captions/titles/audio fit, not silently retime everything.
- [ ] Render all formats before approval and verify deterministic safe-area/overflow/dependency constraints. Run `pnpm exec playwright test tests/e2e/linked-version-formats.spec.ts --project=desktop-primary`; visually inspect real samples and commit `feat(versions): create four editable deliverable formats`.

## C4 — Delivery queue, reuse, recovery and campaign acceptance

**Files**

- Create: `apps/editor-web/src/versions/delivery-queue.ts`, `delivery-queue.test.ts`, `delivery-receipts.ts`, `delivery-receipts.test.ts`.
- Reuse: existing export/import services, job clients, provenance, R1 single-submit reconciliation and encoded-output verifier.
- Test: `tests/e2e/linked-version-delivery.spec.ts`.

- [ ] Red tests: title-only master update starts zero generation jobs; identical approved generated assets reused; invalid/missing media blocks only affected jobs explicitly; export cancellation/reload reconciles without duplicate billing/download; schema rollback compatibility is assessed before live promotion.
- [ ] Run `pnpm exec vitest run apps/editor-web/src/versions/delivery-queue.test.ts apps/editor-web/src/versions/delivery-receipts.test.ts`.
- [ ] Implement preflight per derivative revision/dependency set, a bounded local/export-job queue and artifact receipts. Each receipt identifies input composition revision, dimensions, format, actual encoded output digest and verification result. A queued or uploaded file is not automatically “delivered”; external destinations require explicit configured authority and a verified response.
- [ ] Invalidate verified-export badges when dependent fields/assets change. Re-export uses explicit user action or an approved delivery envelope; no surprise background jobs. Unknown or ambiguous external status remains visible until reconciled.
- [ ] Run `pnpm exec playwright test tests/e2e/linked-version-delivery.spec.ts --project=desktop-primary`. End-to-end campaign scenario: generate four variants, manually lock crop and localized title, change master logo/title/music, preview selective updates, preserve overrides, apply once, reload, export and decode all artifacts. One Undo restores the local update but does not claim refunded external costs.
- [ ] Commit `feat(versions): verify and recover campaign delivery`. Run the master checks, creator study and exact-candidate independent Opus review gate. Complete Gbrain/Desktop-brief closeout only for the validated release scope.

## Combined completion checklist

- [ ] R1 all supported editor domain paths and perception skills work through the real Worker/controller; no unfinished adapter disguised as a skill.
- [ ] Six Looks are meaningfully distinct, editable, portable, free-font compatible and preview/export tested.
- [ ] Audio-reactive motion has measured timing and editable ordinary keyframes.
- [ ] Four derivative types are real working outputs, not empty UI categories.
- [ ] Master propagation preserves human changes and rejects unresolved structural conflicts.
- [ ] Media/provider generation reuse prevents unnecessary paid regeneration.
- [ ] Project package migration, Undo/reload, privacy, resource limits and UI accessibility pass across milestones.
- [ ] Actual output/creative evaluation accompanies the complete diff. The independent Opus reviewer approves the unchanged candidate before any deploy; unknown/blocked checks remain explicit.
