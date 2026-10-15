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

/** Kind names models use for the operations Joy has (BUGS.md 9: h3, h5, k2, k3, k6). */
const KIND_SYNONYMS: Readonly<Record<string, string>> = {
  text: 'create-text',
  'add-text': 'create-text',
  caption: 'create-text',
  'add-caption': 'create-text',
  'create-caption': 'create-text',
  title: 'create-text',
  'add-title': 'create-text',
  update: 'update-text',
  'edit-text': 'update-text',
  'modify-text': 'update-text',
  'update-caption': 'update-text',
  'edit-caption': 'update-text',
  look: 'add-effect',
  'apply-look': 'add-effect',
  'set-look': 'add-effect',
  'apply-effect': 'add-effect',
  effect: 'add-effect',
};

function canonicalKind(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const name = value.trim().toLowerCase();
  return KIND_SYNONYMS[name] ?? name;
}

/** `type`, `operation`, `op` and `action` are accepted for an operation's `kind`. */
function withKind(record: Record<string, unknown>, index: number): Record<string, unknown> {
  const { type, operation, op, action, ...rest } = record;
  // On add-effect, `type` names the look (like the CLI's --type flag), so it is kept.
  const typeIsLook =
    canonicalKind(rest.kind ?? operation ?? op ?? action) === 'add-effect' &&
    normalizeLookName(type) !== undefined;
  const entries: AliasEntry[] = [
    ['kind', rest.kind],
    ...(typeIsLook ? [] : ([['type', type]] as AliasEntry[])),
    ['operation', operation],
    ['op', op],
    ['action', action],
  ];
  const kind = pickAlias('operation kind', entries, {
    prefix: `operation ${index + 1}`,
    normalize: canonicalKind,
  });
  if (kind === undefined) return record;
  return { ...rest, ...(typeIsLook ? { type } : {}), kind: canonicalKind(kind) };
}

/** Gives every operation without an `id` a unique `<kind>-N` id. */
function withIds(operations: readonly unknown[]): unknown[] {
  const used = new Set(
    operations.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.id === 'string' ? [candidate.id] : [],
    ),
  );
  const next = (kind: unknown): string => {
    const base = kind === 'create-text' ? 'text' : typeof kind === 'string' ? kind : 'op';
    let n = 1;
    while (used.has(`${base}-${n}`)) n += 1;
    used.add(`${base}-${n}`);
    return `${base}-${n}`;
  };
  return operations.map((candidate) =>
    isRecord(candidate) && candidate.id === undefined
      ? { ...candidate, id: next(candidate.kind) }
      : candidate,
  );
}

export function normalizeTimelineOperationAliases(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return withIds(
    value.map((candidate, index) => (isRecord(candidate) ? withKind(candidate, index) : candidate)),
  );
}

/**
 * Document operation aliases models commonly send: `type`/`operation`/`op` for `kind` and kind
 * synonyms (`text`, `caption`, `look`, …); a missing `id`; for add-effect, `clipId` for
 * `objectId` and `look`/`effect`/`type` for `effectId` (case-insensitive); for create-text,
 * `timelineStartUs`/`start` for `startUs`, `endUs` for `durationUs` and `position`.
 */
export function normalizeDocumentOperationAliases(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const withKinds = withIds(
    value.map((candidate, index) => (isRecord(candidate) ? withKind(candidate, index) : candidate)),
  );
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
    if (candidate.kind === 'create-text') return createTextAliases(candidate);
    if (candidate.kind === 'update-text' && candidate.clipId !== undefined) {
      const { clipId, ...rest } = candidate;
      const objectId = pickAlias(
        'text clip id',
        [
          ['objectId', rest.objectId],
          ['clipId', clipId],
        ],
        { prefix: `update-text ${String(candidate.id)}` },
      );
      return { ...rest, objectId };
    }
    return candidate;
  });
}

/** create-text placements by name; `y` is the CLI's upward offset from the title line. */
const TEXT_POSITIONS: Readonly<Record<string, { readonly x?: number; readonly y?: number }>> = {
  center: { x: 0 },
  centre: { x: 0 },
  bottom: {},
  'bottom-center': { x: 0 },
  middle: { x: 0, y: -0.36 },
  top: { x: 0, y: -0.65 },
  'top-center': { x: 0, y: -0.65 },
};

function createTextAliases(candidate: Record<string, unknown>): Record<string, unknown> {
  const prefix = `create-text ${String(candidate.id)}`;
  const { timelineStartUs, start, endUs, position, ...rest } = candidate;
  const startUs = pickAlias(
    'start',
    [
      ['startUs', rest.startUs],
      ['timelineStartUs', timelineStartUs],
      ['start', start],
    ],
    { prefix },
  );
  let durationUs = rest.durationUs;
  if (endUs !== undefined) {
    const fromEnd =
      typeof endUs === 'number' ? endUs - (typeof startUs === 'number' ? startUs : 0) : endUs;
    durationUs = pickAlias(
      'duration',
      [
        ['durationUs', rest.durationUs],
        ['endUs - startUs', fromEnd],
      ],
      { prefix },
    );
  }
  let placement: { readonly x?: number; readonly y?: number } = {};
  if (position !== undefined) {
    const named =
      typeof position === 'string' ? TEXT_POSITIONS[position.trim().toLowerCase()] : undefined;
    if (named === undefined)
      throw new Error(
        `${prefix}: position must be one of ${Object.keys(TEXT_POSITIONS).join(', ')} (got ${JSON.stringify(position)}); use x/y for other placements.`,
      );
    placement = named;
  }
  return {
    ...rest,
    ...(placement.x !== undefined && rest.x === undefined ? { x: placement.x } : {}),
    ...(placement.y !== undefined && rest.y === undefined ? { y: placement.y } : {}),
    ...(durationUs === undefined ? {} : { durationUs }),
    startUs: startUs ?? 0,
  };
}
