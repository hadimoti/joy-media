/**
 * Field aliases shared by the CLI flags and the agent's operation schema, so a look or a
 * clip id is accepted under the same names (and with the same conflict rules) everywhere.
 */

export const JOY_LOOK_PRESETS = ['crt', 'bw', 'warm', 'cool'] as const;
export type JoyLookPreset = (typeof JOY_LOOK_PRESETS)[number];

/** A named alias value, e.g. `['--clipId', 'clip-1']` or `['look', 'CRT']`. */
export type AliasEntry = readonly [name: string, value: unknown];

/** Case-insensitive look name (`" CRT "` → `"crt"`); undefined when not a supported look. */
export function normalizeLookName(value: unknown): JoyLookPreset | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return (JOY_LOOK_PRESETS as readonly string[]).includes(name)
    ? (name as JoyLookPreset)
    : undefined;
}

function conflict(label: string, given: readonly AliasEntry[], prefix?: string): Error {
  const detail = given.map(([name, value]) => `${name} ${String(value)}`).join(', ');
  return new Error(
    prefix
      ? `${prefix}: conflicting ${label} values: ${detail}`
      : `Conflicting ${label} values: ${detail}`,
  );
}

/**
 * The one value given under any of the aliased names. Values that compare equal after
 * `normalize` are not a conflict; different values are an error, never a silent pick.
 */
export function pickAlias(
  label: string,
  entries: readonly AliasEntry[],
  options: { readonly prefix?: string; readonly normalize?: (value: unknown) => unknown } = {},
): unknown {
  const given = entries.filter(([, value]) => value !== undefined);
  if (given.length === 0) return undefined;
  const normalize = options.normalize ?? ((value: unknown) => value);
  const first = normalize(given[0]![1]);
  if (given.some(([, value]) => normalize(value) !== first))
    throw conflict(label, given, options.prefix);
  return given[0]![1];
}

/** One supported look from aliased fields (case-insensitive), or undefined if none was given. */
export function resolveLookAliases(
  entries: readonly AliasEntry[],
  prefix?: string,
): JoyLookPreset | undefined {
  const raw = pickAlias('look', entries, {
    ...(prefix === undefined ? {} : { prefix }),
    normalize: (value) => normalizeLookName(value) ?? value,
  });
  if (raw === undefined) return undefined;
  const look = normalizeLookName(raw);
  if (look === undefined) {
    const rule = `must be one of: ${JOY_LOOK_PRESETS.join(', ')} (got "${String(raw)}").`;
    throw new Error(prefix ? `${prefix}: look ${rule}` : `Look ${rule}`);
  }
  return look;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `type` is accepted for an operation's `kind` (timeline and document operations). */
function withKind(record: Record<string, unknown>, index: number): Record<string, unknown> {
  const { type, ...rest } = record;
  if (type === undefined) return record;
  if (rest.kind === undefined) return { ...rest, kind: type };
  if (rest.kind === type) return rest;
  // On add-effect, `type` names the look (like the CLI's --type flag).
  if (rest.kind === 'add-effect' && normalizeLookName(type) !== undefined) return record;
  throw conflict(
    'operation kind',
    [
      ['kind', rest.kind],
      ['type', type],
    ],
    `operation ${index + 1}`,
  );
}

export function normalizeTimelineOperationAliases(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((candidate, index) =>
    isRecord(candidate) ? withKind(candidate, index) : candidate,
  );
}

/**
 * Document operation aliases models commonly send: `type` for `kind`; for add-effect,
 * `clipId` for `objectId` and `look`/`effect`/`type` for `effectId` (case-insensitive);
 * for create-text, a missing `id` (`text-N`) and `startUs` (0).
 */
export function normalizeDocumentOperationAliases(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const withKinds = value.map((candidate, index) =>
    isRecord(candidate) ? withKind(candidate, index) : candidate,
  );
  const usedIds = new Set(
    withKinds.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.id === 'string' ? [candidate.id] : [],
    ),
  );
  const nextTextId = (): string => {
    let n = 1;
    while (usedIds.has(`text-${n}`)) n += 1;
    usedIds.add(`text-${n}`);
    return `text-${n}`;
  };
  return withKinds.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    if (candidate.kind === 'add-effect') {
      const prefix = `add-effect ${typeof candidate.id === 'string' ? candidate.id : '(no id)'}`;
      const { clipId, look, effect, type, ...rest } = candidate;
      const objectId = pickAlias(
        'clip id',
        [
          ['objectId', rest.objectId],
          ['clipId', clipId],
        ],
        { prefix },
      );
      const effectId = resolveLookAliases(
        [
          ['effectId', rest.effectId],
          ['look', look],
          ['effect', effect],
          ['type', type],
        ],
        prefix,
      );
      return {
        ...rest,
        ...(objectId === undefined ? {} : { objectId }),
        ...(effectId === undefined ? {} : { effectId }),
      };
    }
    if (candidate.kind === 'create-text') {
      return {
        ...candidate,
        ...(candidate.id === undefined ? { id: nextTextId() } : {}),
        ...(candidate.startUs === undefined ? { startUs: 0 } : {}),
      };
    }
    return candidate;
  });
}
