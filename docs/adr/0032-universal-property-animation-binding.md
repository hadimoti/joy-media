# ADR-0032: Universal property animation binding

Status: Accepted
Date: 2026-08-13

## Context

WP-34 (§4.1–§4.4, §6–§8) mandates a single, unified property animation system that replaces the current mix of object/effect-only curves, ad hoc JSON paths, and implicit domain rules with an explicit, typed, and extensible binding contract. Earlier ADRs establish the foundation: integer microsecond time base (ADR-0002), semantic command/undo model (ADR-0003), Render IR as the preview/export boundary (ADR-0004), restricted expressions scope (ADR-0015), and timeline-domain/change-set mechanics (ADR-0030). Without a formal property binding and animation ownership decision, WP-34 cannot start implementation: there is no agreed address for an animation, no canonical evaluation order, no migration path from legacy curves, and no command boundary that preview and agents can share.

## Decision

1. **Typed binding addresses only.** Animation targets are `PropertyBindingV2` objects composed of a registered owner kind, a stable owner identifier, a descriptor `propertyId`, and an explicit `timeDomain`. Arbitrary JSON path strings are rejected at validation time. The canonical binding key is computed deterministically from the binding and used to index the project-level animation map.

2. **Explicit time domains.** The supported `AnimationTimeDomainV2` values are `composition`, `clip-local`, `transition-local`, `output`, `caption-clip-local`, `scene-local`, and `audio-timeline`. Every domain resolves project time to an owner-local offset using the domain's mapping rule; all durations and offsets are integer microseconds as defined in ADR-0002.

3. **Value representation and interpolation.**
   - Scalar numeric properties reuse the existing `AnimationCurveV1` on a `value` channel.
   - Vector/color properties decompose into named channels (`x`, `y`, `z`, `r`, `g`, `b`, `a`).
   - Boolean, enum, and string properties use sorted `holdKeys` with discrete values.
   - Color curve morphing uses bounded snapshot tables (256 samples/channel) with explicit interpolation metadata.
   - Time-remap is a separate monotonic source-time mapping with dedicated constraints; it is never represented as a scalar curve.

4. **Lazy, optional V2 storage.** Projects may include an optional `propertyAnimations` record keyed by canonical binding keys. This collection is created lazily; legacy `VisualObjectV1.animations` and `EffectInstanceV1.animations` remain valid and are read unchanged until the first V2 edit of that exact property, at which point only that property migrates.

5. **Evaluation order.** At a requested project time `tUs`:
   1. Resolve the owner and map `tUs` into the binding's explicit time domain.
   2. Read the static/base value from the owner.
   3. If a V2 animation exists for the binding, sample and reconstruct its value.
   4. Otherwise, if a compatible legacy curve exists, sample it.
   5. Evaluate an expression/binding last; on failure, safely fall back to the animated/static value.
   6. Normalize/clamp the result through the property descriptor.
   7. Write the final value into a frame-local evaluated snapshot consumed by Render IR.
      Render IR never persists curves; it contains only evaluated, domain-resolved values.

6. **Single reversible command family.** All normalized property animation edits flow through one command family (`animation.replace`, `animation.setStatic`). UI interactions preview transiently during gesture/drag and produce exactly one durable, reversible command on commit (pointerup/Enter/blur); pressing Escape discards the transient preview and emits no command.

7. **Ownership lifecycle.**
   - Split: copy clip-owned animations to both resulting clips, rebasing times into each new clip-local domain.
   - Duplicate/copy-paste: deep-copy eligible bindings to the new stable owner IDs.
   - Delete: remove orphaned animation entries atomically in the same transaction; undo restores both owner and entries.
   - Effect duplicate: allocate a new effect instance ID and copy its animations.
   - Reorder does not change binding identity.
     A project validator reports orphaned bindings; removal is a separate, explicit repair action.

8. **Non-animatable categories.** Workspace layouts/preferences, UI state, selection, diagnostics, active tabs, asset ownership/imports, routing/topology, runtime/process state, export settings, caption cue/word timing, transition type/duration, and camera creation/assignment are never keyframe-eligible and have no binding descriptors.

9. **Shared descriptor registry.** The registry lives in `@joy-media/property-system` and is consumed by UI, command validation, evaluator, renderer adapters, and agent tools. Each descriptor declares: `id`, `label`, `group`, allowed owner kinds, `valueKind`, `defaultValue`, constraints, animation policy (`continuous`, `angle`, `hue`, `color`, `vector`, `hold`, `curve-snapshot`, `time-remap`, or `static` with reason), expression capability, multi-edit policy, and render-impact category.

10. **Single evaluator boundary.** Browser preview, browser export, and CPU reference rendering all consume the same evaluator entry point that produces frame-local evaluated snapshots. Audio automation is delivered at sample/block boundaries through a dedicated adapter that uses the same evaluator core.

## Alternatives considered

- **Arbitrary JSON paths as animation addresses.** Rejected: path strings drift with refactors, cannot be validated at schema time, and hide ownership/domain semantics.
- **Single global time domain.** Rejected: clip-local, transition-local, and audio-timeline require owner-local remapping; a single global domain cannot express clip trim offset or transition progress correctly.
- **Eager full-project migration to V2 on open.** Rejected: would force a write on every legacy project open and risk data loss if the migration had a bug; lazy per-property migration limits blast radius.
- **Separate command types per panel or per value kind.** Rejected: breaks the single command family contract, multiplies undo code paths, and prevents agents from reasoning uniformly about animation.
- **Store curves in Render IR.** Rejected by ADR-0004; Render IR is ephemeral and renderer-facing; persisting curves there duplicates durable state and breaks the preview/export parity guarantee.
- **Two-phase evaluation with separate preview and final evaluators.** Rejected: the single evaluator boundary is required to keep preview, export, and CPU reference in lockstep; a separate preview evaluator would drift.
- **Allow ad hoc JSON path concatenation at call sites.** Rejected: breaks the typed binding contract and prevents static validation of animation addresses.
- **Immediate expression evaluation before animation.** Rejected: the decision places expressions last so that they can reference animated values and override them, matching After Effects semantics.

## Consequences

- The `PropertyBindingV2` shape plus descriptor registry become the single source of truth for "what can be animated." Any new animatable capability must register a descriptor; failing to do so blocks keyframe UI and agent access by design.
- Legacy projects open unchanged and render identically; the first edit to a specific property on a specific owner triggers a per-property migration to V2 and removes only that legacy duplicate.
- The evaluator must implement domain mapping, sampling, expression evaluation, and descriptor normalization in a single pass to guarantee deterministic results across preview and export.
- UI property rows, Animate panel lanes, and agent tools all operate on the same binding and descriptor abstractions, eliminating duplicate property metadata and ensuring consistent validation messages.
- Time-remap's monotonic constraint must be enforced by the command applier and the evaluator; non-monotonic edits are rejected at apply time.
- The command family enforces atomicity at the property binding level; multi-selection emits one transaction with one command per affected binding, preserving exact undo semantics.
- Non-animatable categories are explicitly enumerated; future proposals to animate a currently static category must update the eligibility matrix in WP-34 and go through a new ADR if they affect core invariants.

## Migration and compatibility

- Schema: `JoyProjectV1` gains an optional `propertyAnimations` field. Existing projects without it are valid and continue to use legacy curves.
- Legacy curves: `VisualObjectV1.animations` and `EffectInstanceV1.animations` remain readable. V2 takes precedence for a given binding when present; otherwise the legacy curve is sampled if compatible.
- First V2 edit: when a user edits a legacy-animated property, the command applier migrates only that property to V2, removes the legacy entry for that property only, and retains the same evaluated result at the edit time.
- Export and render: projects with no V2 animations render exactly as before; golden tests compare both paths at key frame boundaries and midpoints.
- Descriptor registry: additive; new descriptors can be introduced without breaking existing bindings. A CI check asserts no duplicate descriptor IDs across packages.

## Validation and rollback

- Schema validation rejects unknown owner kinds, invalid time domains, duplicate key times, NaN/Infinity in curve values, unknown channel names for a given value kind, and mismatched binding keys.
- Evaluator tests prove frame-local evaluation parity between V2 and legacy curves for the same property and time, within floating-point epsilon for numeric channels.
- Command tests prove that a V2 animation edit followed by undo restores the exact legacy or V2 state that preceded the edit.
- Render IR parity tests prove that preview and export produce identical evaluated snapshots for the same frame.
- Rollback path: if a critical defect is found, the V2 extension can be disabled by not populating `propertyAnimations`; legacy curves continue to work. No destructive schema migration is required; the optional field can be removed or ignored.

## Related contracts/tests

- ADR-0002 (integer microsecond time base and rational frame mapping)
- ADR-0003 (command, transaction, and undo semantics)
- ADR-0004 (Render IR as the preview/export boundary)
- ADR-0015 (P10 scope: bounded 2.5D camera and restricted expressions)
- ADR-0030 (timeline-domain proposals and bounded snapshots)
- `packages/project-schema/src/v1.ts` (schema extensions)
- `packages/property-system/src/index.ts` (descriptor registry)
- `packages/evaluator/src/properties.ts` (evaluation order and domain mapping)
- `packages/commands/src/commands.ts` (normalized animation command family)
- `plan/WP-34-universal-animation-and-editor-information-architecture.md` §4, §6, §7, §8
