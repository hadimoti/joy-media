/**
 * Universal property-animation schema (WP34-05 foundation + WP34-06 binding
 * normalization and value checks).
 *
 * A property animation is a typed, durable, project-global animation addressed
 * by a *stable* `ownerId`/`propertyId` binding rather than a JSON path, so a
 * target can be renamed or moved without invalidating its animation curves.
 * Each binding carries an explicit `timeDomain` describing which timeline the
 * curve keyframes are measured against.
 *
 * WP34-05 lays the closed enumerations and the discriminated curve/value
 * shapes. WP34-06 adds the canonical binding key, a normalizer that reports
 * diagnostics (with an optional owner resolver for existence checks), and the
 * finite / time / channel / discrete / snapshot value checks that were
 * deferred here.
 */

import type { TimeUs } from './time.js';
import type { ProjectDiagnostic } from './model.js';
import type { AnimationCurveV1, BezierHandlesV1, KeyframeV1 } from './v1.js';

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
 * never a number. Key-array ordering is enforced by the WP34-06 normalizer.
 */
export interface DiscreteKeyV2 {
  readonly timeUs: TimeUs;
  /** A boolean or string hold value; never a number. */
  readonly value: boolean | string;
}

/**
 * A numeric curve snapshot key. Snapshots record the sampled numeric state of
 * a curve (for preview caches or baked exports) without repeating the full
 * keyframe geometry. Ordering and channel sanity are enforced by the WP34-06
 * normalizer.
 */
export interface CurveSnapshotKeyV2 {
  /** Sample time, integer microseconds. */
  readonly timeUs: TimeUs;
  /** Named numeric channels sampled at this time, e.g. `master`. */
  readonly channels: Readonly<Record<string, readonly number[]>>;
  /**
   * Interpolation used between this snapshot and the next. A string is
   * sufficient at this schema stage; a closed enum arrives later.
   */
  readonly interpolation: string;
}

/**
 * Discriminated curve/value payload of a property animation. `scalar`, `angle`,
 * and `hue` reuse the scalar `AnimationCurveV1` shape; `vector`/`color` carry
 * named component-curve string records. `boolean`/`string` are discrete hold
 * channels; `curve-snapshot` samples named channel tables.
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
 * A single universal property animation.
 */
export interface PropertyAnimationV2 {
  readonly binding: PropertyBindingV2;
  readonly value: AnimationValueV2;
}

/**
 * The normalized, validated form of a project's `propertyAnimations` map.
 * Keyed by the canonical binding key; entries whose binding/value failed hard
 * structural checks are dropped and reported via diagnostics instead.
 */
export type NormalizedPropertyAnimationsV2 = Readonly<Record<string, PropertyAnimationV2>>;

/**
 * Optional resolver that confirms whether an owner actually exists in the
 * project. Given the owner kind and id it returns `true` when the owner is
 * present. When omitted, owner-existence diagnostics are skipped (the
 * normalizer works on a standalone slice that has no project context).
 */
export type PropertyOwnerResolverV2 = (ownerKind: PropertyOwnerKindV2, ownerId: string) => boolean;

const SEP = '::';

/**
 * Build the stable, collision-safe canonical key for a binding. Composed from
 * the four address fields (kind, owner, property, time domain) with the
 * separator escaped inside each field so `a::b` never collides with
 * `a` / `b`. Two bindings with the same key address the same animation; any
 * field difference yields a distinct key.
 */
export function canonicalBindingKey(binding: PropertyBindingV2): string {
  return [
    escapeField(binding.ownerKind),
    escapeField(binding.ownerId),
    escapeField(binding.propertyId),
    escapeField(binding.timeDomain),
  ].join(SEP);
}

/** Diagnostic code constants for the WP34-06 normalizer. */
const CODE_BINDING = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_BINDING';
const CODE_VALUE = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_VALUE';
const CODE_VALUE_NUMERIC = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_NUMERIC';
const CODE_VALUE_TIME = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_TIME';
const CODE_VALUE_CHANNEL = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_CHANNEL';
const CODE_VALUE_DISCRETE = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_DISCRETE';
const CODE_VALUE_SNAPSHOT = 'PROJECT_SCHEMA_V1_PROPERTY_ANIMATION_SNAPSHOT';

export interface NormalizePropertyAnimationsResult {
  /** Strictly-validated, deduplicated animations keyed canonically. */
  readonly animations: NormalizedPropertyAnimationsV2;
  /** Diagnostics for every dropped or non-conforming entry/value. */
  readonly diagnostics: ProjectDiagnostic[];
}

/**
 * Normalize and validate a raw `propertyAnimations` value into its canonical,
 * deduplicated form, collecting diagnostics for everything that does not
 * conform.
 *
 * Behavior:
 * - `undefined`/`null`/absent is valid and yields an empty map.
 * - The value must be a plain object; otherwise a single diagnostic is
 *   returned and the result is empty.
 * - Every entry must carry a well-formed `binding` (known `ownerKind` and
 *   `timeDomain`, non-empty `ownerId`/`propertyId`) and a structurally valid,
 *   value-checked `value` (see the finite/time/channel/discrete/snapshot
 *   checks below).
 * - Entries are deduplicated by requiring each map key to equal the canonical
 *   binding key of its own binding. A mismatched map key is reported and the
 *   entry dropped without being aliased or renormalized; the canonical key
 *   always wins, never the input key. Two entries with the same canonical key
 *   therefore collapse to a single map key (the later literal wins), so no
 *   separate duplicate pass is needed.
 * - If an `ownerResolver` is provided, each binding's owner is checked for
 *   existence and a diagnostic is emitted when it is missing.
 * - Per-channel numeric ranges (angle within [0,360], hue wraparound, opacity
 *   within [0,1]) are still a later concern and are NOT enforced here; only
 *   finiteness, integral time, ordering, channel presence, and the discrete /
 *   snapshot shapes are checked.
 */
export function normalizePropertyAnimations(
  value: unknown,
  ownerResolver?: PropertyOwnerResolverV2,
): NormalizePropertyAnimationsResult {
  const diagnostics: ProjectDiagnostic[] = [];
  const animations: Record<string, PropertyAnimationV2> = {};
  if (value === undefined || value === null) {
    return { animations, diagnostics };
  }
  if (!isRecord(value)) {
    diagnostics.push(
      diagnostic(CODE_VALUE, 'propertyAnimations must be an object', 'propertyAnimations'),
    );
    return { animations, diagnostics };
  }
  for (const [id, entry] of Object.entries(value)) {
    const path = `propertyAnimations.${id}`;
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic(CODE_VALUE, 'property animation entry must be an object', path));
      continue;
    }
    const binding = normalizeBinding(entry.binding, `${path}.binding`, diagnostics);
    if (binding === undefined) continue;
    const animationValue = normalizeValue(entry.value, `${path}.value`, diagnostics);
    if (animationValue === undefined) continue;
    if (ownerResolver !== undefined && !ownerResolver(binding.ownerKind, binding.ownerId)) {
      diagnostics.push(
        diagnostic(
          CODE_BINDING,
          `owner "${binding.ownerId}" of kind "${binding.ownerKind}" does not exist`,
          `${path}.binding.ownerId`,
        ),
      );
      continue;
    }
    const key = canonicalBindingKey(binding);
    if (id !== key) {
      diagnostics.push(
        diagnostic(
          CODE_BINDING,
          `map key mismatch: input key "${id}" does not equal canonical binding key "${key}"`,
          `${path}.binding`,
        ),
      );
      continue;
    }
    animations[key] = { binding, value: animationValue };
  }
  return { animations, diagnostics };
}

/** Broad structural validation for the top-level `propertyAnimations` map. */
export function validatePropertyAnimations(value: unknown): ProjectDiagnostic[] {
  return normalizePropertyAnimations(value).diagnostics;
}

function normalizeBinding(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): PropertyBindingV2 | undefined {
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
    return undefined;
  }
  return {
    ownerKind: value.ownerKind as PropertyOwnerKindV2,
    ownerId: value.ownerId as string,
    propertyId: value.propertyId as string,
    timeDomain: value.timeDomain as AnimationTimeDomainV2,
  };
}

function normalizeValue(
  value: unknown,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationValueV2 | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    diagnostics.push(diagnostic(CODE_VALUE, 'value must be a curve or keys record', path));
    return undefined;
  }
  switch (value.kind) {
    case 'scalar':
    case 'angle':
    case 'hue':
      return normalizeScalar(value, path, diagnostics);
    case 'vector':
    case 'color':
      return normalizeChannelRecord(value, path, diagnostics);
    case 'boolean':
    case 'string':
      return normalizeDiscrete(value, path, diagnostics);
    case 'curve-snapshot':
      return normalizeSnapshot(value, path, diagnostics);
    default:
      diagnostics.push(diagnostic(CODE_VALUE, `unknown value kind "${String(value.kind)}"`, path));
      return undefined;
  }
}

function normalizeScalar(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationValueV2 | undefined {
  if (!isRecord(value.curve)) {
    diagnostics.push(diagnostic(CODE_VALUE, `value.${String(value.kind)} requires a curve`, path));
    return undefined;
  }
  const curve = normalizeCurveV1(value.curve, `${path}.curve`, diagnostics);
  if (curve === undefined) return undefined;
  const kind = value.kind as 'scalar' | 'angle' | 'hue';
  return { kind, curve };
}

function normalizeChannelRecord(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationValueV2 | undefined {
  if (!isRecord(value.curve)) {
    diagnostics.push(
      diagnostic(CODE_VALUE, `value.${String(value.kind)} requires a curve record`, path),
    );
    return undefined;
  }
  const names = Object.keys(value.curve);
  if (names.length === 0) {
    diagnostics.push(
      diagnostic(
        CODE_VALUE_CHANNEL,
        `value.${String(value.kind)} requires at least one channel`,
        path,
      ),
    );
    return undefined;
  }
  const curve: Record<string, AnimationCurveV1> = {};
  for (const name of names) {
    const renamed = /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name);
    if (!renamed) {
      diagnostics.push(
        diagnostic(CODE_VALUE_CHANNEL, `invalid channel name "${name}"`, `${path}.curve.${name}`),
      );
      return undefined;
    }
    if (!isRecord(value.curve[name])) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_CHANNEL,
          `channel "${name}" requires a curve`,
          `${path}.curve.${name}`,
        ),
      );
      return undefined;
    }
    const channelCurve = normalizeCurveV1(value.curve[name], `${path}.curve.${name}`, diagnostics);
    if (channelCurve === undefined) return undefined;
    curve[name] = channelCurve;
  }
  const kind = value.kind as 'vector' | 'color';
  return { kind, curve };
}

function normalizeDiscrete(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationValueV2 | undefined {
  if (!Array.isArray(value.keys)) {
    diagnostics.push(
      diagnostic(CODE_VALUE, `value.${String(value.kind)} requires a keys array`, path),
    );
    return undefined;
  }
  const kind = value.kind as 'boolean' | 'string';
  const keys: DiscreteKeyV2[] = [];
  let prevTime = Number.NEGATIVE_INFINITY;
  for (const [i, raw] of value.keys.entries()) {
    const keyPath = `${path}.keys[${i}]`;
    if (!isRecord(raw)) {
      diagnostics.push(diagnostic(CODE_VALUE_DISCRETE, 'discrete key must be an object', keyPath));
      return undefined;
    }
    if (!isTimeUs(raw.timeUs)) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_TIME,
          'discrete key timeUs must be a non-negative integer',
          `${keyPath}.timeUs`,
        ),
      );
      return undefined;
    }
    const timeUs = raw.timeUs as TimeUs;
    if (timeUs <= prevTime) {
      diagnostics.push(
        diagnostic(CODE_VALUE_TIME, 'discrete keys must be strictly increasing in time', keyPath),
      );
      return undefined;
    }
    prevTime = timeUs;
    if (kind === 'boolean') {
      if (typeof raw.value !== 'boolean') {
        diagnostics.push(
          diagnostic(
            CODE_VALUE_DISCRETE,
            'boolean discrete key value must be a boolean',
            `${keyPath}.value`,
          ),
        );
        return undefined;
      }
      keys.push({ timeUs, value: raw.value });
    } else {
      if (typeof raw.value !== 'string') {
        diagnostics.push(
          diagnostic(
            CODE_VALUE_DISCRETE,
            'string discrete key value must be a string (numbers are never discrete holds)',
            `${keyPath}.value`,
          ),
        );
        return undefined;
      }
      keys.push({ timeUs, value: raw.value });
    }
  }
  if (keys.length === 0) {
    diagnostics.push(
      diagnostic(CODE_VALUE_DISCRETE, `value.${kind} requires at least one key`, path),
    );
    return undefined;
  }
  return { kind, keys };
}

function normalizeSnapshot(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationValueV2 | undefined {
  if (!Array.isArray(value.samples)) {
    diagnostics.push(diagnostic(CODE_VALUE, 'value.curve-snapshot requires a samples array', path));
    return undefined;
  }
  if (value.samples.length === 0) {
    diagnostics.push(
      diagnostic(CODE_VALUE_SNAPSHOT, 'value.curve-snapshot requires at least one sample', path),
    );
    return undefined;
  }
  const samples: CurveSnapshotKeyV2[] = [];
  let prevTime = Number.NEGATIVE_INFINITY;
  for (const [i, raw] of value.samples.entries()) {
    const samplePath = `${path}.samples[${i}]`;
    if (!isRecord(raw) || !isRecord(raw.channels) || typeof raw.interpolation !== 'string') {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_SNAPSHOT,
          'curve-snapshot sample requires an object channels and a string interpolation',
          samplePath,
        ),
      );
      return undefined;
    }
    if (!isTimeUs(raw.timeUs)) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_SNAPSHOT,
          'curve-snapshot sample timeUs must be a non-negative integer',
          `${samplePath}.timeUs`,
        ),
      );
      return undefined;
    }
    const timeUs = raw.timeUs as TimeUs;
    if (timeUs <= prevTime) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_SNAPSHOT,
          'curve-snapshot samples must be strictly increasing',
          samplePath,
        ),
      );
      return undefined;
    }
    prevTime = timeUs;
    const channelNames = Object.keys(raw.channels);
    if (channelNames.length === 0) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_SNAPSHOT,
          'curve-snapshot sample requires at least one channel',
          samplePath,
        ),
      );
      return undefined;
    }
    const channels: Record<string, readonly number[]> = {};
    for (const name of channelNames) {
      const channel = raw.channels[name];
      if (!Array.isArray(channel) || channel.length === 0) {
        diagnostics.push(
          diagnostic(
            CODE_VALUE_SNAPSHOT,
            `snapshot channel "${name}" must be a non-empty array`,
            `${samplePath}.channels.${name}`,
          ),
        );
        return undefined;
      }
      if (!channel.every(isFiniteNumber)) {
        diagnostics.push(
          diagnostic(
            CODE_VALUE_NUMERIC,
            `snapshot channel "${name}" contains a non-finite value`,
            `${samplePath}.channels.${name}`,
          ),
        );
        return undefined;
      }
      channels[name] = channel as readonly number[];
    }
    samples.push({ timeUs, channels, interpolation: raw.interpolation });
  }
  return { kind: 'curve-snapshot', samples };
}

/**
 * Structural + finite/time validation of a scalar `AnimationCurveV1`:
 * non-empty keyframes, each key an object with a finite numeric value and an
 * integer non-negative `timeUs`, keys strictly increasing in time.
 */
function normalizeCurveV1(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): AnimationCurveV1 | undefined {
  if (!Array.isArray(value.keyframes) || value.keyframes.length === 0) {
    diagnostics.push(diagnostic(CODE_VALUE, `curve requires a non-empty keyframes array`, path));
    return undefined;
  }
  const keyframes: KeyframeV1[] = [];
  let prevTime = Number.NEGATIVE_INFINITY;
  for (const [i, raw] of value.keyframes.entries()) {
    const keyPath = `${path}.keyframes[${i}]`;
    if (!isRecord(raw)) {
      diagnostics.push(diagnostic(CODE_VALUE, 'keyframe must be an object', keyPath));
      return undefined;
    }
    if (!isTimeUs(raw.timeUs)) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_TIME,
          'keyframe timeUs must be a non-negative integer',
          `${keyPath}.timeUs`,
        ),
      );
      return undefined;
    }
    const timeUs = raw.timeUs as TimeUs;
    if (timeUs <= prevTime) {
      diagnostics.push(
        diagnostic(CODE_VALUE_TIME, 'keyframes must be strictly increasing in time', keyPath),
      );
      return undefined;
    }
    prevTime = timeUs;
    if (!isFiniteNumber(raw.value)) {
      diagnostics.push(
        diagnostic(
          CODE_VALUE_NUMERIC,
          'keyframe value must be a finite number',
          `${keyPath}.value`,
        ),
      );
      return undefined;
    }
    if (typeof raw.interpolation !== 'string') {
      diagnostics.push(
        diagnostic(
          CODE_VALUE,
          'keyframe requires a string interpolation',
          `${keyPath}.interpolation`,
        ),
      );
      return undefined;
    }
    const rawBezier = isRecord(raw.bezier)
      ? normalizeBezier(raw.bezier, `${keyPath}.bezier`, diagnostics)
      : undefined;
    if (isRecord(raw.bezier) && rawBezier === undefined) {
      return undefined;
    }
    const keyframe: KeyframeV1 = rawBezier
      ? {
          timeUs,
          value: raw.value as number,
          interpolation: raw.interpolation as KeyframeV1['interpolation'],
          bezier: rawBezier,
        }
      : {
          timeUs,
          value: raw.value as number,
          interpolation: raw.interpolation as KeyframeV1['interpolation'],
        };
    keyframes.push(keyframe);
  }
  return { keyframes };
}

function normalizeBezier(
  value: Record<string, unknown>,
  path: string,
  diagnostics: ProjectDiagnostic[],
): BezierHandlesV1 | undefined {
  const x1 = value.x1;
  const y1 = value.y1;
  const x2 = value.x2;
  const y2 = value.y2;
  if (!isFiniteNumber(x1) || !isFiniteNumber(y1) || !isFiniteNumber(x2) || !isFiniteNumber(y2)) {
    diagnostics.push(
      diagnostic(CODE_VALUE_NUMERIC, 'bezier handles x1/y1/x2/y2 must all be finite numbers', path),
    );
    return undefined;
  }
  return { x1, y1, x2, y2 };
}

function diagnostic(code: string, message: string, path: string): ProjectDiagnostic {
  return { code, message, path };
}

function escapeField(field: string): string {
  return field.split(SEP).join(SEP + SEP);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimeUs(value: unknown): value is TimeUs {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
