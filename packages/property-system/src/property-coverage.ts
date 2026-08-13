/**
 * WP34-03 — executable property coverage manifest.
 *
 * A pure, immutable registry that declares, exactly once per family, how every
 * property surface exposed by the JOY editor UI is handled by the universal
 * property-animation model (WP34). Each entry is classified as one of:
 *
 * - `creative` — a project property the editor animates via the WP34
 *   `AnimationValueV2` model. Declares exactly one `AnimationValueV2` kind and
 *   a meaningful animation policy, and binds to a `PropertyOwnerKindV2` with a
 *   compatible explicit animation time domain.
 * - `static-with-reason` — a real project property that is intentionally not
 *   exposed to the animation timeline, with a stated reason.
 * - `structural` — durable document/topology/lifecycle surfaces (text, timing,
 *   parenting, chain ownership) that are not themselves animated values.
 * - `ui-only` — pure editor/view state (layout, selection, scopes, export
 *   prefs) that is never serialized into the creative document.
 *
 * The registry is data only — it implements no commands, no animation
 * evaluator, no UI, no migration, and no renderer wiring. `assertPropertyCoverageComplete`
 * is a pure validator over the registry and the closed inventory so any drift
 * between what the UI serves and what the model supports fails loudly at test
 * time.
 */

import type {
  AnimationTimeDomainV2,
  AnimationValueV2,
  PropertyOwnerKindV2,
} from '@joy-media/project-schema';
import { PROPERTY_OWNER_KINDS, PROPERTY_TIME_DOMAINS } from '@joy-media/project-schema';

/**
 * One closed kind from the discriminated `AnimationValueV2` union. A creative
 * entry declares exactly one of these as the representative value shape for
 * its family.
 */
export type AnimationValueKindV2 = AnimationValueV2['kind'];

/** Closed set of manifest classifications. */
export type CoverageClassification = 'creative' | 'static-with-reason' | 'structural' | 'ui-only';

export const COVERAGE_CLASSIFICATIONS: readonly CoverageClassification[] = [
  'creative',
  'static-with-reason',
  'structural',
  'ui-only',
];

/**
 * Animation policy attached to a creative entry. Closed union so validation is
 * total: continuous families carry a value domain (`min`/`max`, wraparound for
 * angles/hue, or unconstrained), discrete/string families hold with a free
 * domain.
 */
export type AnimationPolicy =
  | {
      readonly interpolation: 'smooth';
      readonly domain: { readonly min: number; readonly max: number };
    }
  | { readonly interpolation: 'smooth'; readonly domain: { readonly wrap: true } }
  | { readonly interpolation: 'smooth'; readonly domain: 'free' }
  | { readonly interpolation: 'hold'; readonly domain: 'free' };

/**
 * Canonical binding for a project property. `ownerKind`/`timeDomain` are taken
 * verbatim from the WP34 schema enumerations so a binding can never name an
 * unknown owner or time domain. `domain` is intended to be later projected into
 * an `AnimationTimeDomainV2` (identical string values in most cases).
 */
export interface CoverageBinding {
  readonly ownerKind: PropertyOwnerKindV2;
  readonly timeDomain: AnimationTimeDomainV2;
}

/** Discriminated entry shape. Creative entries require animation data; noncreative entries forbid it. */
export type CoverageEntry =
  | {
      readonly id: string;
      readonly label: string;
      readonly rationale: string;
      readonly classification: 'creative';
      readonly inventoryKey: string;
      readonly animationValueKind: AnimationValueKindV2;
      readonly policy: AnimationPolicy;
      readonly binding: CoverageBinding;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly rationale: string;
      readonly classification: 'static-with-reason' | 'structural' | 'ui-only';
      readonly inventoryKey: string;
      /** Project-bound static/structural surfaces declare a binding; ui-only surfaces never do. */
      readonly binding?: CoverageBinding;
    };

/**
 * Closed inventory of every property family the JOY editor UI serves, from the
 * supplied complete UI inventory. The assertion cross-checks this against the
 * coverage array so each family is classified exactly once and no entry points
 * at an unknown surface.
 */
export const PROPERTY_INVENTORY: readonly string[] = [
  // visual transform
  'visual.transform.position',
  'visual.transform.scale',
  'visual.transform.rotation',
  'visual.transform.opacity',
  'visual.transform.crop',
  // object effects
  'object-effect.params',
  'object-effect.enabled',
  'object-effect.unknown-plugin-params',
  // color v2
  'color-output.adjust',
  'color-clip.adjust',
  'color-output.grade-enabled',
  'color-clip.grade-enabled',
  'color-output.wheels',
  'color-clip.wheels',
  'color-output.curves',
  'color-clip.curves',
  'color-output.hsl',
  'color-clip.hsl',
  'color-output.lut-choice',
  'color-clip.lut-choice',
  'color-output.lut-intensity',
  'color-clip.lut-intensity',
  // clip audio
  'audio-clip.gain',
  'audio-clip.pan',
  'audio-clip.mute',
  // bus audio
  'audio-bus.gain',
  'audio-bus.pan',
  'audio-bus.mute',
  'audio-bus.insert-amount',
  'audio-bus.insert-order',
  'audio-bus.send-amount',
  'audio-bus.send-routing',
  // audio effects
  'audio-effect.params',
  // captions
  'caption.style-values',
  'caption.alignment-template',
  'caption.text',
  'caption.timing',
  // camera
  'camera.view',
  'camera.lifecycle',
  'camera.parenting',
  'camera.active-selection',
  // transitions
  'transition.shader-uniforms',
  'transition.easing',
  'transition.enum-param',
  'transition.bool-param',
  'transition.type',
  'transition.duration',
  'transition.ownership',
  // motion scene
  'motion.scene-layer-variables',
  'motion.scene-topology',
  // workspace / ui-only
  'workspace.layout',
  'workspace.selection',
  'workspace.tabs',
  'editor.scopes',
  'editor.export-preferences',
];

/**
 * Owner-to-time-domain compatibility. A project-bound coverage entry (creative,
 * or static/structural with a binding) must pick a domain from this set, so the
 * assertion rejects an invalid owner/time-domain pairing before it can reach
 * the schema normalizer.
 */
export const OWNER_TIME_DOMAINS: Readonly<
  Record<PropertyOwnerKindV2, readonly AnimationTimeDomainV2[]>
> = {
  'visual-object': ['composition'],
  'object-effect': ['composition'],
  clip: ['clip-local'],
  transition: ['transition-local'],
  'color-output': ['output'],
  'color-clip': ['clip-local'],
  'audio-clip': ['audio-timeline', 'clip-local'],
  'audio-bus': ['audio-timeline'],
  'audio-effect': ['audio-timeline'],
  'caption-clip': ['caption-clip-local'],
  'motion-scene-layer': ['scene-local'],
};

/** Immutable registry. Each family appears exactly once. */
export const PROPERTY_COVERAGE: readonly CoverageEntry[] = [
  // ---------- visual transform (creative; ownerKind visual-object / composition) ----------
  {
    id: 'visual.transform.position',
    label: 'Transform position',
    rationale:
      'x/y are the primary keyframed motion channels of a visual object, addressed in flat composition space.',
    classification: 'creative',
    inventoryKey: 'visual.transform.position',
    animationValueKind: 'vector',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'visual.transform.scale',
    label: 'Transform scale',
    rationale:
      'Non-uniform scaleX/scaleY are continuous motion channels; both legs animate together as a vector.',
    classification: 'creative',
    inventoryKey: 'visual.transform.scale',
    animationValueKind: 'vector',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'visual.transform.rotation',
    label: 'Transform rotation',
    rationale: 'Rotation is a continuous angular channel measured in degrees, wrapping past 360.',
    classification: 'creative',
    inventoryKey: 'visual.transform.rotation',
    animationValueKind: 'angle',
    policy: { interpolation: 'smooth', domain: { wrap: true } },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'visual.transform.opacity',
    label: 'Transform opacity',
    rationale: 'Opacity is a bounded continuous channel in [0, 1], the core cross-dissolve driver.',
    classification: 'creative',
    inventoryKey: 'visual.transform.opacity',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: { min: 0, max: 1 } },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'visual.transform.crop',
    label: 'Transform crop edges',
    rationale:
      'Crop edges inset the visible frame on all four sides; each edge is a continuous channel, so the crop region animates as a vector in flat composition space.',
    classification: 'creative',
    inventoryKey: 'visual.transform.crop',
    animationValueKind: 'vector',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  // ---------- object effects (creative data-driven params + static toggles) ----------
  {
    id: 'object-effect.params',
    label: 'Object-effect parameters',
    rationale:
      'Known effect parameters are a data-driven family: individual fields live in each effect schema, and the manifest addresses the family with a scalar representative rather than inventing plugin fields.',
    classification: 'creative',
    inventoryKey: 'object-effect.params',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'object-effect', timeDomain: 'composition' },
  },
  {
    id: 'object-effect.enabled',
    label: 'Object-effect enabled',
    rationale:
      'The enabled toggle is a discrete boolean hold channel: an effect can be keyed on/off at effect boundaries, and the state holds until the next key.',
    classification: 'creative',
    inventoryKey: 'object-effect.enabled',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'object-effect', timeDomain: 'composition' },
  },
  {
    id: 'object-effect.unknown-plugin-params',
    label: 'Unknown / plugin object-effect parameters',
    rationale:
      'Unknown third-party plugin fields expose arbitrary shapes outside the closed data-driven family; the manifest cannot classify their animation and treats them as opaque until a plugin declares its schema.',
    classification: 'static-with-reason',
    inventoryKey: 'object-effect.unknown-plugin-params',
  },
  // ---------- color v2 (creative; explicit output + clip surface, per target grade) ----------
  {
    id: 'color-output.adjust',
    label: 'Output colour adjustments',
    rationale:
      'The output adjustment block (temperature/tint/exposure/contrast/highlights/shadows/whites/blacks/saturation/vibrance) is continuous and globally graded.',
    classification: 'creative',
    inventoryKey: 'color-output.adjust',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.adjust',
    label: 'Clip colour adjustments',
    rationale:
      'Per-clip adjustments mirror the output block but are measured against the clip timeline.',
    classification: 'creative',
    inventoryKey: 'color-clip.adjust',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.grade-enabled',
    label: 'Output grade enabled / bypass',
    rationale:
      'The output grade exposes an enabled/bypass toggle that can be keyed on/off as a discrete boolean hold channel against the output timeline.',
    classification: 'creative',
    inventoryKey: 'color-output.grade-enabled',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.grade-enabled',
    label: 'Clip grade enabled / bypass',
    rationale:
      'The clip grade exposes an enabled/bypass toggle that can be keyed on/off as a discrete boolean hold channel against the clip timeline.',
    classification: 'creative',
    inventoryKey: 'color-clip.grade-enabled',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.wheels',
    label: 'Output colour wheels',
    rationale:
      'The output grade wheels (lift/gamma/gain/offset) are continuous colour channels animatable per grade against the output timeline.',
    classification: 'creative',
    inventoryKey: 'color-output.wheels',
    animationValueKind: 'color',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.wheels',
    label: 'Clip colour wheels',
    rationale:
      'The clip grade wheels (lift/gamma/gain/offset) are continuous colour channels animatable per grade against the clip timeline.',
    classification: 'creative',
    inventoryKey: 'color-clip.wheels',
    animationValueKind: 'color',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.curves',
    label: 'Output RGB curve snapshots',
    rationale:
      'Output curve adjustments are recorded as sampled curve snapshots for preview caches and baked exports, addressed on the output timeline.',
    classification: 'creative',
    inventoryKey: 'color-output.curves',
    animationValueKind: 'curve-snapshot',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.curves',
    label: 'Clip RGB curve snapshots',
    rationale:
      'Clip curve adjustments are recorded as sampled curve snapshots for preview caches and baked exports, addressed on the clip timeline.',
    classification: 'creative',
    inventoryKey: 'color-clip.curves',
    animationValueKind: 'curve-snapshot',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.hsl',
    label: 'Output eight-band HSL',
    rationale:
      'Output eight-band hue/saturation/luminance/range/softness refine discrete tonal ranges with scalar per-band control on the output timeline.',
    classification: 'creative',
    inventoryKey: 'color-output.hsl',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.hsl',
    label: 'Clip eight-band HSL',
    rationale:
      'Clip eight-band hue/saturation/luminance/range/softness refine discrete tonal ranges with scalar per-band control on the clip timeline.',
    classification: 'creative',
    inventoryKey: 'color-clip.hsl',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.lut-choice',
    label: 'Output LUT built-in choice',
    rationale:
      'The output LUT is addressed by its built-in choice, an explicit discrete string identity held on the output timeline until replaced.',
    classification: 'creative',
    inventoryKey: 'color-output.lut-choice',
    animationValueKind: 'string',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.lut-choice',
    label: 'Clip LUT built-in choice',
    rationale:
      'The clip LUT is addressed by its built-in choice, an explicit discrete string identity held on the clip timeline until replaced.',
    classification: 'creative',
    inventoryKey: 'color-clip.lut-choice',
    animationValueKind: 'string',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  {
    id: 'color-output.lut-intensity',
    label: 'Output LUT intensity',
    rationale:
      'Output LUT intensity mixes the chosen LUT in continuously and is a scalar smooth channel on the output timeline, independent of the held choice.',
    classification: 'creative',
    inventoryKey: 'color-output.lut-intensity',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-output', timeDomain: 'output' },
  },
  {
    id: 'color-clip.lut-intensity',
    label: 'Clip LUT intensity',
    rationale:
      'Clip LUT intensity mixes the chosen LUT in continuously and is a scalar smooth channel on the clip timeline, independent of the held choice.',
    classification: 'creative',
    inventoryKey: 'color-clip.lut-intensity',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'color-clip', timeDomain: 'clip-local' },
  },
  // ---------- clip audio (creative) ----------
  {
    id: 'audio-clip.gain',
    label: 'Clip audio gain',
    rationale: 'Per-clip gain is a continuous loudness channel on the audio timeline.',
    classification: 'creative',
    inventoryKey: 'audio-clip.gain',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'audio-clip', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-clip.pan',
    label: 'Clip audio pan',
    rationale: 'Per-clip stereo pan is a continuous placement channel on the audio timeline.',
    classification: 'creative',
    inventoryKey: 'audio-clip.pan',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: { min: -1, max: 1 } },
    binding: { ownerKind: 'audio-clip', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-clip.mute',
    label: 'Clip audio mute',
    rationale: 'Clip mute is a discrete boolean hold channel.',
    classification: 'creative',
    inventoryKey: 'audio-clip.mute',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'audio-clip', timeDomain: 'audio-timeline' },
  },
  // ---------- bus audio (creative channels + structural chain) ----------
  {
    id: 'audio-bus.gain',
    label: 'Bus audio gain',
    rationale: 'Bus gain is a continuous loudness channel on the audio timeline.',
    classification: 'creative',
    inventoryKey: 'audio-bus.gain',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.pan',
    label: 'Bus audio pan',
    rationale: 'Bus stereo pan is a continuous placement channel on the audio timeline.',
    classification: 'creative',
    inventoryKey: 'audio-bus.pan',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: { min: -1, max: 1 } },
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.mute',
    label: 'Bus audio mute',
    rationale: 'Bus mute is a discrete boolean hold channel.',
    classification: 'creative',
    inventoryKey: 'audio-bus.mute',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.insert-amount',
    label: 'Bus insert effect amount',
    rationale:
      'The wet amount of a bus insert effect is a continuous scalar channel on the audio timeline; the amount animates while the chain stays fixed.',
    classification: 'creative',
    inventoryKey: 'audio-bus.insert-amount',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.insert-order',
    label: 'Bus insert effect order',
    rationale:
      'Which insert effects sit in the chain and in what order is durable bus graph topology, not an animatable value.',
    classification: 'structural',
    inventoryKey: 'audio-bus.insert-order',
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.send-amount',
    label: 'Bus send amount',
    rationale:
      'The amount of a bus send into another bus is a continuous scalar channel on the audio timeline; the send level animates while the route stays fixed.',
    classification: 'creative',
    inventoryKey: 'audio-bus.send-amount',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  {
    id: 'audio-bus.send-routing',
    label: 'Bus send routing topology',
    rationale: 'Which bus a send routes into is durable routing topology, not an animatable value.',
    classification: 'structural',
    inventoryKey: 'audio-bus.send-routing',
    binding: { ownerKind: 'audio-bus', timeDomain: 'audio-timeline' },
  },
  // ---------- audio effects (creative data-driven params) ----------
  {
    id: 'audio-effect.params',
    label: 'Audio-effect parameters',
    rationale:
      'Audio effect parameters are a data-driven family addressed by their schema; declared with a scalar representative.',
    classification: 'creative',
    inventoryKey: 'audio-effect.params',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'audio-effect', timeDomain: 'audio-timeline' },
  },
  // ---------- captions (creative numeric/colour + string hold, structural text/timing) ----------
  {
    id: 'caption.style-values',
    label: 'Caption style numeric / colour values',
    rationale:
      'Caption numeric/colour values (position/scale/opacity/font size/tracking/line height/colours) drive an animatable style block; declared with a scalar representative over the heterogeneous numeric core.',
    classification: 'creative',
    inventoryKey: 'caption.style-values',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'caption-clip', timeDomain: 'caption-clip-local' },
  },
  {
    id: 'caption.alignment-template',
    label: 'Caption alignment / template',
    rationale:
      'Caption alignment and template selection are discrete string identities held on the caption timeline until replaced.',
    classification: 'creative',
    inventoryKey: 'caption.alignment-template',
    animationValueKind: 'string',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'caption-clip', timeDomain: 'caption-clip-local' },
  },
  {
    id: 'caption.text',
    label: 'Caption text content',
    rationale:
      'Caption text is durable document content, not an animatable value; structural editing only.',
    classification: 'structural',
    inventoryKey: 'caption.text',
    binding: { ownerKind: 'caption-clip', timeDomain: 'caption-clip-local' },
  },
  {
    id: 'caption.timing',
    label: 'Caption segment timing',
    rationale:
      'Segment in/out timing is clip-local structure that bounds the style animation, not itself animated.',
    classification: 'structural',
    inventoryKey: 'caption.timing',
    binding: { ownerKind: 'caption-clip', timeDomain: 'caption-clip-local' },
  },
  // ---------- camera (creative view + structural lifecycle/parenting/selection) ----------
  {
    id: 'camera.view',
    label: 'Camera view',
    rationale:
      'Camera x/y/z/roll/FOV are continuous 3D view channels; declared with a vector representative over the numeric/angular core.',
    classification: 'creative',
    inventoryKey: 'camera.view',
    animationValueKind: 'vector',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'camera.lifecycle',
    label: 'Camera lifecycle',
    rationale: 'Camera create/remove is object lifecycle, not an animatable value.',
    classification: 'structural',
    inventoryKey: 'camera.lifecycle',
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'camera.parenting',
    label: 'Camera parenting',
    rationale:
      'Parent linkage orders cameras and attaches them to objects — durable structural topology.',
    classification: 'structural',
    inventoryKey: 'camera.parenting',
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  {
    id: 'camera.active-selection',
    label: 'Active camera selection',
    rationale:
      'Which camera is active per composition is a structural selection, not an animated value.',
    classification: 'structural',
    inventoryKey: 'camera.active-selection',
    binding: { ownerKind: 'visual-object', timeDomain: 'composition' },
  },
  // ---------- transitions (creative shader families + structural type/duration/ownership) ----------
  {
    id: 'transition.shader-uniforms',
    label: 'Transition shader uniforms',
    rationale:
      'Shader uniforms are a data-driven continuous family animated against the transition timeline.',
    classification: 'creative',
    inventoryKey: 'transition.shader-uniforms',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.easing',
    label: 'Transition easing curve',
    rationale:
      'The easing curve is a continuous scalar channel shaping progress over the transition.',
    classification: 'creative',
    inventoryKey: 'transition.easing',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.enum-param',
    label: 'Transition enum parameter',
    rationale: 'Discrete enum selections are string hold channels on the transition timeline.',
    classification: 'creative',
    inventoryKey: 'transition.enum-param',
    animationValueKind: 'string',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.bool-param',
    label: 'Transition boolean parameter',
    rationale: 'Discrete boolean switches are boolean hold channels on the transition timeline.',
    classification: 'creative',
    inventoryKey: 'transition.bool-param',
    animationValueKind: 'boolean',
    policy: { interpolation: 'hold', domain: 'free' },
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.type',
    label: 'Transition type',
    rationale:
      'The transition type picks which shader runs — a static structural choice, not animated.',
    classification: 'structural',
    inventoryKey: 'transition.type',
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.duration',
    label: 'Transition duration',
    rationale:
      'Duration sizes the transition window and bounds its animation timeline — structural metadata.',
    classification: 'structural',
    inventoryKey: 'transition.duration',
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  {
    id: 'transition.ownership',
    label: 'Transition ownership',
    rationale:
      'Which crossings own a transition is durable boundary topology, not an animatable value.',
    classification: 'structural',
    inventoryKey: 'transition.ownership',
    binding: { ownerKind: 'transition', timeDomain: 'transition-local' },
  },
  // ---------- motion scene (creative exposed variables + structural topology) ----------
  {
    id: 'motion.scene-layer-variables',
    label: 'Motion scene exposed variables',
    rationale:
      'Layer-exposed numeric/vector/color/discrete variables are driven by the motion evaluator; declared with a scalar representative over the data-driven variable schema.',
    classification: 'creative',
    inventoryKey: 'motion.scene-layer-variables',
    animationValueKind: 'scalar',
    policy: { interpolation: 'smooth', domain: 'free' },
    binding: { ownerKind: 'motion-scene-layer', timeDomain: 'scene-local' },
  },
  {
    id: 'motion.scene-topology',
    label: 'Motion scene layer topology',
    rationale: 'Layer hierarchy and grouping are durable scene topology, not animatable values.',
    classification: 'structural',
    inventoryKey: 'motion.scene-topology',
    binding: { ownerKind: 'motion-scene-layer', timeDomain: 'scene-local' },
  },
  // ---------- workspace / ui-only ----------
  {
    id: 'workspace.layout',
    label: 'Workspace layout',
    rationale:
      'Panel sizes/arrangement are transient editor view state, never serialized into the creative document.',
    classification: 'ui-only',
    inventoryKey: 'workspace.layout',
  },
  {
    id: 'workspace.selection',
    label: 'Workspace selection',
    rationale: 'Current selection is transient editor state, not a project property.',
    classification: 'ui-only',
    inventoryKey: 'workspace.selection',
  },
  {
    id: 'workspace.tabs',
    label: 'Workspace tabs',
    rationale: 'Open composition tabs are transient editor view state, not project data.',
    classification: 'ui-only',
    inventoryKey: 'workspace.tabs',
  },
  {
    id: 'editor.scopes',
    label: 'Editor scopes / false colour / probe / split / bypass',
    rationale:
      'Monitor scopes, false colour and probe overlays, split view, and effect bypass are all live view-state toggles kept out of the document.',
    classification: 'ui-only',
    inventoryKey: 'editor.scopes',
  },
  {
    id: 'editor.export-preferences',
    label: 'Export preferences',
    rationale:
      'Export preferences are tool-time settings applied at render, not animated project properties.',
    classification: 'ui-only',
    inventoryKey: 'editor.export-preferences',
  },
];

/** Returns the full immutable registry. */
export function listPropertyCoverage(): readonly CoverageEntry[] {
  return PROPERTY_COVERAGE;
}

/** Returns the single entry for a stable semantic id, or `undefined`. */
export function findPropertyCoverage(id: string): CoverageEntry | undefined {
  return PROPERTY_COVERAGE.find((entry) => entry.id === id);
}

export interface PropertyCoverageReportEntry {
  readonly propertyId: string;
  readonly control: string;
  readonly descriptor: string;
  readonly classification: CoverageClassification;
  readonly evaluatorSupported: boolean;
  readonly consumerSupported: boolean;
  readonly omissionReason?: string;
}

export interface PropertyCoverageReport {
  readonly version: 1;
  readonly complete: boolean;
  readonly entries: readonly PropertyCoverageReportEntry[];
  readonly violations: readonly string[];
}

/** Stable JSON-shaped evidence consumed by CI and review tooling. */
export function buildPropertyCoverageReport(
  coverage: readonly CoverageEntry[] = PROPERTY_COVERAGE,
  inventory: readonly string[] = PROPERTY_INVENTORY,
): PropertyCoverageReport {
  let violations: readonly string[] = [];
  try {
    assertPropertyCoverageComplete(coverage, inventory);
  } catch (error) {
    violations = String(error instanceof Error ? error.message : error)
      .split('\n')
      .slice(1)
      .map((line) => line.replace(/^- /, ''));
  }
  const byInventory = new Map(coverage.map((entry) => [entry.inventoryKey, entry]));
  const entries = inventory.flatMap((propertyId) => {
    const entry = byInventory.get(propertyId);
    if (entry === undefined) return [];
    const supported = entry.classification === 'creative';
    return [
      {
        propertyId,
        control: entry.label,
        descriptor: entry.id,
        classification: entry.classification,
        evaluatorSupported: supported,
        consumerSupported: supported,
        ...(supported ? {} : { omissionReason: entry.rationale }),
      },
    ];
  });
  return { version: 1, complete: violations.length === 0, entries, violations };
}

const VALID_VALUE_KINDS: readonly AnimationValueKindV2[] = [
  'scalar',
  'angle',
  'hue',
  'vector',
  'color',
  'boolean',
  'string',
  'curve-snapshot',
];

/**
 * Pure validation of the registry against the closed inventory and the WP34
 * schema enumerations. Throws an `Error` listing every violation found. It
 * rejects duplicate ids, blank label/rationale, bad classification, invalid
 * owner/time-domain pair, creative entries missing/invalid policy or value
 * kind, noncreative entries carrying animation data, inventory keys with no
 * coverage (missing classification), and coverage referring to unknown
 * inventory keys.
 */
export function assertPropertyCoverageComplete(
  coverage: readonly CoverageEntry[] = PROPERTY_COVERAGE,
  inventory: readonly string[] = PROPERTY_INVENTORY,
): void {
  const violations: string[] = [];
  const seen = new Set<string>();
  const classified = new Set<string>();

  for (const entry of coverage) {
    // duplicate id
    if (seen.has(entry.id)) {
      violations.push(`duplicate coverage id "${entry.id}"`);
    }
    seen.add(entry.id);

    // blank label / rationale
    if (entry.label.trim().length === 0) violations.push(`entry "${entry.id}" has a blank label`);
    if (entry.rationale.trim().length === 0)
      violations.push(`entry "${entry.id}" has a blank rationale`);

    // bad classification
    if (!COVERAGE_CLASSIFICATIONS.includes(entry.classification)) {
      violations.push(`entry "${entry.id}" has bad classification "${entry.classification}"`);
    }

    // unknown inventory key
    if (!inventory.includes(entry.inventoryKey)) {
      violations.push(
        `entry "${entry.id}" refers to unknown inventory key "${entry.inventoryKey}"`,
      );
    } else {
      classified.add(entry.inventoryKey);
    }

    if (entry.classification === 'creative') {
      // creative missing/invalid value kind
      if (!VALID_VALUE_KINDS.includes(entry.animationValueKind)) {
        violations.push(
          `creative entry "${entry.id}" has invalid animation value kind "${entry.animationValueKind}"`,
        );
      }
      // creative missing/invalid policy
      if (!('policy' in entry) || !isValidPolicy(entry.policy)) {
        violations.push(`creative entry "${entry.id}" has missing or invalid policy`);
      }
      // invalid owner/time-domain pair
      validateBinding(entry.id, entry.binding, violations);
    } else {
      // noncreative animation data
      if ('animationValueKind' in entry || 'policy' in entry) {
        violations.push(
          `noncreative entry "${entry.id}" of classification "${entry.classification}" carries animation data`,
        );
      }
      // ui-only must not carry a project binding
      if (entry.classification === 'ui-only' && entry.binding !== undefined) {
        violations.push(`ui-only entry "${entry.id}" must not carry a project binding`);
      }
      // project-bound static/structural require a valid binding
      if (entry.binding !== undefined) {
        validateBinding(entry.id, entry.binding, violations);
      }
    }
  }

  // missing inventory classification
  for (const key of inventory) {
    if (!classified.has(key)) {
      violations.push(`inventory key "${key}" has no coverage classification`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`property coverage incomplete:\n- ${violations.join('\n- ')}`);
  }
}

function validateBinding(id: string, binding: CoverageBinding, violations: string[]): void {
  if (!PROPERTY_OWNER_KINDS.includes(binding.ownerKind)) {
    violations.push(`entry "${id}" has unknown owner kind "${binding.ownerKind}"`);
    return;
  }
  if (!PROPERTY_TIME_DOMAINS.includes(binding.timeDomain)) {
    violations.push(`entry "${id}" has unknown time domain "${binding.timeDomain}"`);
    return;
  }
  if (!OWNER_TIME_DOMAINS[binding.ownerKind].includes(binding.timeDomain)) {
    violations.push(
      `entry "${id}" has invalid owner/time-domain pair "${binding.ownerKind}" / "${binding.timeDomain}"`,
    );
  }
}

function isValidPolicy(policy: AnimationPolicy): boolean {
  if (policy.interpolation !== 'smooth' && policy.interpolation !== 'hold') return false;
  if (policy.interpolation === 'hold') return policy.domain === 'free';
  if (policy.domain === 'free') return true;
  if (typeof policy.domain === 'object' && 'wrap' in policy.domain)
    return policy.domain.wrap === true;
  if (
    typeof policy.domain === 'object' &&
    'min' in policy.domain &&
    'max' in policy.domain &&
    typeof policy.domain.min === 'number' &&
    typeof policy.domain.max === 'number' &&
    policy.domain.min <= policy.domain.max
  ) {
    return true;
  }
  return false;
}
