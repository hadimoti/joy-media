/**
 * Universal property-animation schema (WP34-05).
 *
 * A property animation is a typed, durable, project-global animation addressed
 * by a *stable* `ownerId`/`propertyId` binding rather than a JSON path, so a
 * target can be renamed or moved without invalidating its animation curves.
 * Each binding carries an explicit `timeDomain` describing which timeline the
 * curve keyframes are measured against.
 *
 * This lays the closed enumerations and the discriminated curve/value shapes
 * only: owner existence, canonical id formats, per-channel ranges, and
 * keyframe ordering are intentionally deferred to WP34-06.
 */

import type { TimeUs } from './time.js';
import type { ProjectDiagnostic } from './model.js';
import type { AnimationCurveV1 } from './v1.js';

/**
 * Readonly closed owner kinds for a property animation. Each literal names the
 * class of project entity whose property a binding targets.
 */
export type PropertyOwnerKindV2 =
  | 'visual-object'
  | 'object-effect'
  | 'clip'
  | 'transition'
  | 'color-output'
  | 'color-clip'
  | 'audio-clip'
  | 'audio-bus'
  | 'audio-effect'
  | 'caption-clip'
  | 'motion-scene-layer';

export const PROPERTY_OWNER_KINDS: readonly PropertyOwnerKindV2[] = [
  'visual-object',
  'object-effect',
  'clip',
  'transition',
  'color-output',
  'color-clip',
  'audio-clip',
  'audio-bus',
  'audio-effect',
  'caption-clip',
  'motion-scene-layer',
];

/**
 * Readonly closed time domains. `timeUs` keyframes inside a curve are measured
 * against one of these references.
 */
export type AnimationTimeDomainV2 =
  | 'composition'
  | 'clip-local'
  | 'transition-local'
  | 'output'
  | 'caption-clip-local'
  | 'scene-local'
  | 'audio-timeline';

export const PROPERTY_TIME_DOMAINS: readonly AnimationTimeDomainV2[] = [
  'composition',
  'clip-local',
  'transition-local',
  'output',
  'caption-clip-local',
  'scene-local',
  'audio-timeline',
];

/**
 * Typed binding to a target property. `ownerKind`/`ownerId`/`propertyId` are
 * stable identifiers — never JSON paths — so renaming or moving a target keeps
 * its animation intact until the address itself changes. `timeDomain` is
 * explicit and required on every binding.
 */
export interface PropertyBindingV2 {
  readonly ownerKind: PropertyOwnerKindV2;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly timeDomain: AnimationTimeDomainV2;
}

/**
 * A discrete hold key. Discrete channels do not interpolate between samples —
 * the value holds until the next key. The hold value is a boolean or string,
 * never a number. Key-array ordering is unchecked here and enforced in
 * WP34-06.
 */
export interface DiscreteKeyV2 {
  readonly timeUs: TimeUs;
  /** A boolean or string hold value; never a number. */
  readonly value: boolean | string;
}

/**
 * A numeric curve snapshot key. Snapshots record the sampled numeric state of
 * a curve (for preview caches or baked exports) without repeating the full
 * keyframe geometry. Ordering/ranges are WP34-06 concerns.
 */
export interface CurveSnapshotKeyV2 {
  /** Sample time, integer microseconds. */
  readonly timeUs: TimeUs;
  /** Named numeric channels sampled at this time, e.g. `master`. */
  readonly channels: Readonly<Record<string, readonly number[]>>;
  /**
   * Interpolation used between this snapshot and the next. A string is
   * sufficient at this schema stage; a closed enum arrives in WP34-06.
   */
  readonly interpolation: string;
}

/**
 * Discriminated curve/value payload of a property animation. `scalar`, `angle`,
 * and `hue` reuse the scalar `AnimationCurveV1` shape; `vector`/`color` carry
 * and `color` carry named component-curve string records. `boolean`/`string`
 * are discrete hold channels; `curve-snapshot` samples named channel tables.
 */
export type AnimationValueV2 =
  | { readonly kind: 'scalar'; readonly curve: AnimationCurveV1 }
  | { readonly kind: 'angle'; readonly curve: AnimationCurveV1 }
  | { readonly kind: 'hue'; readonly curve: AnimationCurveV1 }
  | { readonly kind: 'vector'; readonly curve: Readonly<Record<string, AnimationCurveV1>> }
  | { readonly kind: 'color'; readonly curve: Readonly<Record<string, AnimationCurveV1>> }
  | { readonly kind: 'boolean'; readonly keys: readonly DiscreteKeyV2[] }
  | { readonly kind: 'string'; readonly keys: readonly DiscreteKeyV2[] }
  | { readonly kind: 'curve-snapshot'; readonly samples: readonly CurveSnapshotKeyV2[] };

/**
 * A single universal property animation (WP34-05).
 */
export interface PropertyAnimationV2 {
  readonly binding: PropertyBindingV2;
  readonly value: AnimationValueV2;
}

/** Broad structural diagnostic codes for the WP34-05 foundation. */
const CODE_MAP = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATIONS';
const CODE_BINDING = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_BINDING';
const CODE_VALUE = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_VALUE';

/**
 * Broad structural validation for the top-level `propertyAnimations` map.
 * Absence is valid. When present it must be a record, and every entry must
 * carry a well-formed `binding` (including a known `timeDomain`) and a
 * structurally valid discriminated `value`.
 *
 * Deferred to WP34-06 (deliberately NOT checked here): canonical owner/property
 * id formats, that an `ownerId`/`propertyId` actually exists in the project,
 * per-channel ranges (e.g. angle [0,360], hue [0,360) wraparound, opacity
 * [0,1]), channel names for vector/color records, and keyframe/snapshot
 * ordering.
 */
export function validatePropertyAnimations(value: unknown): ProjectDiagnostic[] {
  const diagnostics: ProjectDiagnostic[] = [];
  if (value === undefined) return diagnostics;
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(CODE_MAP, 'propertyAnimations must be an object', 'propertyAnimations'),
    );
    return diagnostics;
  }
  for (const [id, entry] of Object.entries(value)) {
    const path = `propertyAnimations.${id}`;
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic(CODE_VALUE, 'property animation entry must be an object', path));
      continue;
    }
    validateBinding(entry.binding, `${path}.binding`, diagnostics);
    validateValue(entry.value, `${path}.value`, diagnostics);
  }
  return diagnostics;
}

function validateBinding(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (
    !isRecord(value) ||
    !(PROPERTY_OWNER_KINDS as readonly string[]).includes(String(value.ownerKind)) ||
    !isNonEmptyString(value.ownerId) ||
    !isNonEmptyString(value.propertyId) ||
    !(PROPERTY_TIME_DOMAINS as readonly string[]).includes(String(value.timeDomain))
  ) {
    diagnostics.push(
      diagnostic(
        CODE_BINDING,
        'binding requires a valid ownerKind, non-empty ownerId/propertyId, and a known timeDomain',
        path,
      ),
    );
  }
}

function validateValue(value: unknown, path: string, diagnostics: ProjectDiagnostic[]): void {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    diagnostics.push(diagnostic(CODE_VALUE, 'value must be a curve or keys record', path));
    return;
  }
  switch (value.kind) {
    case 'scalar':
    case 'angle':
    case 'hue':
      // Shape-only check that the payload carries a `curve` object; keyframe
      // validation is delegated to the existing scalar validator in v1.ts.
      if (!isRecord(value.curve)) {
        diagnostics.push(diagnostic(CODE_VALUE, `value.${value.kind} requires a curve`, path));
      }
      break;
    case 'vector':
    case 'color':
      // Named string record of component curves; channel names/ranges deferred.
      if (!isRecord(value.curve)) {
        diagnostics.push(
          diagnostic(CODE_VALUE, `value.${value.kind} requires a curve record`, path),
        );
      }
      break;
    case 'boolean':
    case 'string':
      if (!Array.isArray(value.keys)) {
        diagnostics.push(diagnostic(CODE_VALUE, `value.${value.kind} requires a keys array`, path));
      }
      break;
    case 'curve-snapshot':
      if (!Array.isArray(value.samples)) {
        diagnostics.push(
          diagnostic(CODE_VALUE, 'value.curve-snapshot requires a samples array', path),
        );
        break;
      }
      // Every sample must carry a non-empty object `channels` table and a
      // string `interpolation`. Counts/ranges/order are WP34-06 concerns.
      for (const [i, sample] of value.samples.entries()) {
        const samplePath = `${path}.samples[${i}]`;
        if (
          !isRecord(sample) ||
          !isRecord(sample.channels) ||
          Object.keys(sample.channels).length === 0 ||
          typeof sample.interpolation !== 'string'
        ) {
          diagnostics.push(
            diagnostic(
              CODE_VALUE,
              'curve-snapshot sample requires a non-empty object channels and a string interpolation',
              samplePath,
            ),
          );
        }
      }
      break;
    default:
      diagnostics.push(diagnostic(CODE_VALUE, `unknown value kind "${String(value.kind)}"`, path));
  }
}

function diagnostic(code: string, message: string, path: string): ProjectDiagnostic {
  return { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
