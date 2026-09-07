/**
 * Living Look definitions (R2 / L2) — the typed, declarative shape a pack
 * author writes and the compiler reads.
 *
 * A definition is code, versioned and pinned. It declares:
 *  - `slots`: the semantic roles an operator fills with real project entities
 *    (a headline, a product region, a caption track…);
 *  - `bindingTargets`: the exact property/text/caption addresses the compiler
 *    is allowed to write, each with a stable `bindingId`;
 *  - `controls`: the few sliders/toggles an operator actually turns, each
 *    declaring which binding targets it drives and the bounded range it maps
 *    onto — never a free-form property path;
 *  - portrait and landscape `constraints` with explicit values;
 *  - `license`/`provenance` and `verification` predicates.
 *
 * Nothing here is executable. There are no URLs, no code strings, no
 * model-generated paths. `@joy-media/motion-core` depends only on
 * `@joy-media/project-schema`, so the canonical-operation vocabulary is
 * mirrored locally as `LookOperation` and translated 1:1 to a JoyCode plan by
 * the editor host adapter.
 */

import type { AnimationTimeDomainV2, PropertyOwnerKindV2 } from '@joy-media/project-schema';

export const LOOK_DEFINITION_SCHEMA_VERSION = 1 as const;

/** The canonical operation kinds a Look compiler is allowed to emit. */
export const LOOK_OPERATION_KINDS = [
  'motion.setKeyframe',
  'motion.removeKeyframe',
  'text.setContent',
  'text.setTemplate',
  'text.insertTemplate',
  'caption.setSegmentText',
  'caption.setTemplate',
  'transition.addAtJunction',
] as const;

export type LookOperationKind = (typeof LOOK_OPERATION_KINDS)[number];

/** A control the operator turns. Exactly the JSON scalars, nothing nested. */
export type LookControlKind = 'scalar' | 'enum' | 'color' | 'font' | 'boolean';

/**
 * What surface a binding target writes:
 *  - `keyframe`   — a `motion.setKeyframe` on `propertyId`, which must be a
 *    real animatable property (`ANIMATABLE_PROPERTIES`);
 *  - `text-template` / `caption-template` — a `*.setTemplate` swap; `propertyId`
 *    is a marker, not an animatable property.
 */
export type LookBindingChannel = 'keyframe' | 'text-template' | 'caption-template';

/**
 * A property address the compiler may write. `bindingId` is stable identity —
 * it is what a `LookInstance.overriddenBindingIds` entry and a control's
 * `drives` list refer to. `ownerSlotId` says which slot's resolved entity owns
 * the property; the compiler fills `ownerId` from the instance's
 * `entityBindings[ownerSlotId]`.
 */
export interface LookBindingTarget {
  readonly bindingId: string;
  readonly channel: LookBindingChannel;
  readonly ownerSlotId: string;
  readonly ownerKind: PropertyOwnerKindV2;
  readonly propertyId: string;
  readonly timeDomain: AnimationTimeDomainV2;
}

/**
 * One binding a scalar control drives. The operator's `[0,1]` value scales an
 * *excursion* from `min` towards `max`; the `profile` (one weight in `[0,1]`
 * per `atFractions` entry) shapes that excursion over time, so a drive is a
 * real trajectory — e.g. `atFractions: [0, 0.2, 1]` with `profile: [0, 1, 1]`
 * rises from the resting `min` to the full mapped value and holds. The
 * keyframe at fraction `i` is `min + operatorValue * profile[i] * (max - min)`.
 * `profile` defaults to all-ones (a flat hold at the mapped value).
 */
export interface LookScalarDrive {
  readonly bindingId: string;
  readonly min: number;
  readonly max: number;
  readonly atFractions: readonly number[];
  readonly profile?: readonly number[];
  readonly interpolation: 'hold' | 'linear' | 'eased';
}

/** A scalar control: `[0,1]` operator value maps onto `[min,max]` per driven binding. */
export interface LookScalarControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'scalar';
  /** Default operator value in `[0,1]`. */
  readonly default: number;
  readonly drives: readonly LookScalarDrive[];
}

/**
 * A template-swap drive: the selected option chooses a text/caption template
 * id, so a colour / font / variant choice compiles to a real `*.setTemplate`
 * operation rather than a free-form style string.
 */
export interface LookTemplateDrive {
  readonly bindingId: string;
  readonly target: 'text' | 'caption';
  readonly templateByOption: Readonly<Record<string, string>>;
}

/**
 * An enum control: one of a closed set of string options. It may drive
 * keyframes (`drives`, per-option numeric values), template swaps
 * (`templateDrives`, per-option template ids), or both. It must drive at
 * least one — an enum that compiles to nothing is a fake picker.
 */
export interface LookEnumControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'enum';
  readonly options: readonly string[];
  readonly default: string;
  /**
   * Per-option keyframe drives. `byOption[opt]` is the value at profile weight
   * 0 (the start); `settled` is the value at weight 1 (the end the motion
   * approaches). `profile` (one weight per `atFractions` entry, default
   * all-ones) shapes the approach. With `settled` omitted the curve is flat at
   * `byOption[opt]`.
   */
  readonly drives: readonly {
    readonly bindingId: string;
    readonly byOption: Readonly<Record<string, number>>;
    readonly settled?: number;
    readonly atFractions: readonly number[];
    readonly profile?: readonly number[];
    readonly interpolation: 'hold' | 'linear' | 'eased';
  }[];
  /** Per-option template ids applied to the driven template bindings. */
  readonly templateDrives?: readonly LookTemplateDrive[];
}

/**
 * A validated palette-pair control — never an arbitrary unmeasured colour. Its
 * `drives` are required and non-empty: a `color` control that compiles to
 * nothing is a fake slider (validation rejects it). Each palette-pair id must
 * map to a real template id in every drive.
 */
export interface LookColorControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'color';
  /** Each option is a `{ foreground, background }` pair that passed contrast review at authoring time. */
  readonly palettePairs: readonly {
    readonly id: string;
    readonly foreground: string;
    readonly background: string;
  }[];
  readonly default: string;
  /** Template swaps keyed by palette-pair id. Required and non-empty. */
  readonly drives: readonly LookTemplateDrive[];
}

/**
 * A font control constrained to the bundled free catalogue. Its `drives` are
 * required and non-empty for the same reason `LookColorControl.drives` is.
 */
export interface LookFontControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'font';
  readonly families: readonly string[];
  readonly default: string;
  /** Template swaps keyed by font family. Required and non-empty. */
  readonly drives: readonly LookTemplateDrive[];
}

/**
 * A boolean control that toggles a declared, bounded accent. Its `drives` are
 * required and non-empty — a boolean with nothing to drive is a fake toggle.
 * Each drive writes `whenTrue` at its fractions when the operator's value is
 * true and `whenFalse` (or nothing, when `whenFalse` is `'omit'`) when false.
 */
export interface LookBooleanDrive {
  readonly bindingId: string;
  readonly whenTrue: number;
  readonly whenFalse: number | 'omit';
  readonly atFractions: readonly number[];
  readonly profile?: readonly number[];
  readonly interpolation: 'hold' | 'linear' | 'eased';
}

export interface LookBooleanControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'boolean';
  readonly default: boolean;
  readonly drives: readonly LookBooleanDrive[];
}

export type LookControl =
  LookScalarControl | LookEnumControl | LookColorControl | LookFontControl | LookBooleanControl;

export interface LookSlot {
  readonly id: string;
  readonly label: string;
  /** The entity class this slot resolves to. */
  readonly ownerKind: PropertyOwnerKindV2;
  readonly required: boolean;
}

/** Explicit per-format constraint values — no format inherits the other's numbers. */
export interface LookFormatConstraints {
  readonly safeMarginPx: number;
  readonly maxHeadlineChars: number;
  readonly minHoldUs: number;
}

export interface LookConstraints {
  readonly portrait: LookFormatConstraints;
  readonly landscape: LookFormatConstraints;
}

export interface LookProvenance {
  readonly author: string;
  readonly license: string;
  readonly notes?: string;
}

/**
 * A deterministic post-apply check the verifier can run. `method` reuses the
 * R1 director-verifier vocabulary; `structural` checks are the ones a Look can
 * assert without a rendered frame.
 */
export interface LookVerificationPredicate {
  readonly id: string;
  readonly method: 'structural' | 'rendered' | 'audio-measured';
  readonly summary: string;
}

export interface LookDefinition {
  readonly schemaVersion: typeof LOOK_DEFINITION_SCHEMA_VERSION;
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly slots: readonly LookSlot[];
  readonly bindingTargets: readonly LookBindingTarget[];
  readonly controls: readonly LookControl[];
  readonly constraints: LookConstraints;
  readonly provenance: LookProvenance;
  /** Operation kinds the compiler needs; a strict subset of `LOOK_OPERATION_KINDS`. */
  readonly requiredOperationKinds: readonly LookOperationKind[];
  /** Bundled free-font families the pack needs resolved before it can compile. */
  readonly requiredFonts: readonly string[];
  readonly verification: readonly LookVerificationPredicate[];
}

/* ─── Compiler I/O ─── */

/** Composition-fraction motion keyframe, resolved to microseconds by the compiler. */
export interface LookSetKeyframeOperation {
  readonly kind: 'motion.setKeyframe';
  readonly bindingId: string;
  readonly ownerKind: PropertyOwnerKindV2;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly timeDomain: AnimationTimeDomainV2;
  readonly timeUs: number;
  readonly value: number;
  readonly interpolation: 'hold' | 'linear' | 'eased';
}

export interface LookSetTextContentOperation {
  readonly kind: 'text.setContent';
  readonly bindingId: string;
  readonly objectId: string;
  readonly content: string;
}

export interface LookSetTextTemplateOperation {
  readonly kind: 'text.setTemplate';
  readonly bindingId: string;
  readonly objectId: string;
  readonly templateId: string;
}

export interface LookSetCaptionTemplateOperation {
  readonly kind: 'caption.setTemplate';
  readonly bindingId: string;
  readonly captionClipId: string;
  readonly templateId: string;
}

export interface LookAddTransitionOperation {
  readonly kind: 'transition.addAtJunction';
  readonly bindingId: string;
  readonly outgoingClipId: string;
  readonly incomingClipId: string;
  readonly transitionId: string;
  readonly durationUs: number;
}

export type LookOperation =
  | LookSetKeyframeOperation
  | LookSetTextContentOperation
  | LookSetTextTemplateOperation
  | LookSetCaptionTemplateOperation
  | LookAddTransitionOperation;

export interface LookCompilerDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly bindingId?: string;
}

/**
 * A pre-baked keyframe track for one `keyframe`-channel binding, produced
 * outside the compiler (the L4 audio bridge bakes a `motion.setKeyframe`
 * trajectory from beat evidence). When a bake is supplied for a binding, the
 * compiler emits those keyframes verbatim and skips every control drive that
 * targets the same binding — the bake is the source of truth for it, exactly
 * as a hand-edit override would be.
 */
export interface LookAudioBakeInput {
  readonly bindingId: string;
  readonly keys: readonly { readonly timeUs: number; readonly value: number }[];
  /** Interpolation for the baked keyframes; defaults to `linear`. */
  readonly interpolation?: 'hold' | 'linear' | 'eased';
}

/**
 * What the operator's action supplies. Either an existing `LookInstance`'s
 * `controlValues`/`entityBindings`/`overriddenBindingIds` (reapply / update),
 * or a fresh slot assignment for a first apply.
 */
export interface LookCompileInput {
  readonly definition: LookDefinition;
  readonly definitionVersion: number;
  readonly compositionId: string;
  readonly compositionDurationUs: number;
  readonly format: 'portrait' | 'landscape';
  /** slotId -> resolved entity id. */
  readonly entityBindings: Readonly<Record<string, string>>;
  /** controlId -> operator value (number in [0,1] for scalar, option string, boolean, palette id, font family). */
  readonly controlValues: Readonly<Record<string, number | string | boolean>>;
  /** bindingIds the operator hand-edited; the compiler skips them unless reset. */
  readonly overriddenBindingIds: readonly string[];
  /** bindingIds an explicit reset re-opened; compiled even if still listed as overridden. */
  readonly resetBindingIds?: readonly string[];
  /** Font family -> resolved (bundled) family. A missing entry is a dependency failure. */
  readonly resolvedFonts: Readonly<Record<string, string>>;
  /** Pre-baked keyframe tracks (L4 audio-reactive) that supersede control drives on their bindings. */
  readonly audioBakes?: readonly LookAudioBakeInput[];
}

export interface LookCompileResult {
  readonly ok: boolean;
  readonly operations: readonly LookOperation[];
  /** Deterministic digest of `operations` — identical inputs give the identical digest. */
  readonly operationDigest: string;
  /** bindingIds this compilation wrote (excludes protected overrides). */
  readonly changedBindingIds: readonly string[];
  /** Font families / operation kinds the caller must have available. */
  readonly dependencies: {
    readonly operationKinds: readonly LookOperationKind[];
    readonly fonts: readonly string[];
  };
  readonly diagnostics: readonly LookCompilerDiagnostic[];
}
