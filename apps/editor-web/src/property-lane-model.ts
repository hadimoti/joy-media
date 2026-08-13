export type PropertyLaneDomain = 'composition' | 'clip-local' | 'scene-local' | 'output';

export interface PropertyLaneKey<T = number> {
  readonly timeUs: number;
  readonly value: T;
  readonly interpolation?: string;
}

export interface PropertyLaneDescriptor<T = number> {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerLabel: string;
  readonly domain: PropertyLaneDomain;
  readonly propertyId: string;
  readonly label: string;
  readonly keys: readonly PropertyLaneKey<T>[];
  readonly modified: boolean;
}

export interface PropertyLaneGroup<T = number> {
  readonly id: string;
  readonly label: string;
  readonly domain: PropertyLaneDomain;
  readonly lanes: readonly PropertyLaneDescriptor<T>[];
}

export function groupPropertyLanes<T>(
  lanes: readonly PropertyLaneDescriptor<T>[],
): readonly PropertyLaneGroup<T>[] {
  const groups = new Map<string, PropertyLaneGroup<T>>();
  for (const lane of lanes) {
    const id = `${lane.ownerId}::${lane.domain}`;
    const existing = groups.get(id);
    if (existing === undefined)
      groups.set(id, {
        id,
        label: `${lane.ownerLabel} · ${lane.domain}`,
        domain: lane.domain,
        lanes: [lane],
      });
    else groups.set(id, { ...existing, lanes: [...existing.lanes, lane] });
  }
  return [...groups.values()];
}

export function filterPropertyLanes<T>(
  lanes: readonly PropertyLaneDescriptor<T>[],
  filters: { readonly showAnimated?: boolean; readonly showModified?: boolean } = {},
): readonly PropertyLaneDescriptor<T>[] {
  return lanes.filter(
    (lane) =>
      (!filters.showAnimated || lane.keys.length > 0) && (!filters.showModified || lane.modified),
  );
}

export function snapPropertyTime(timeUs: number, frameUs: number, altOverride = false): number {
  if (altOverride || frameUs <= 0) return Math.max(0, Math.round(timeUs));
  return Math.max(0, Math.round(timeUs / frameUs) * frameUs);
}

export interface PropertyKeyClipboard<T = number> {
  readonly propertyId: string;
  readonly anchorUs: number;
  readonly keys: readonly PropertyLaneKey<T>[];
}

export function copyPropertyKeys<T>(
  lane: PropertyLaneDescriptor<T>,
  selectedTimesUs: readonly number[],
): PropertyKeyClipboard<T> {
  const selected = lane.keys.filter((key) => selectedTimesUs.includes(key.timeUs));
  if (selected.length === 0) throw new RangeError('cannot copy an empty key selection');
  const anchorUs = selected[0]!.timeUs;
  return {
    propertyId: lane.propertyId,
    anchorUs,
    keys: selected.map((key) => ({ ...key, timeUs: key.timeUs - anchorUs })),
  };
}

export function pastePropertyKeys<T>(
  lane: PropertyLaneDescriptor<T>,
  clipboard: PropertyKeyClipboard<T>,
  atUs: number,
  frameUs: number,
  altOverride = false,
): readonly PropertyLaneKey<T>[] {
  if (clipboard.propertyId !== lane.propertyId)
    throw new RangeError('clipboard property does not match target lane');
  const anchorUs = snapPropertyTime(atUs, frameUs, altOverride);
  const next = [
    ...lane.keys.filter(
      (key) => !clipboard.keys.some((item) => item.timeUs + anchorUs === key.timeUs),
    ),
  ];
  next.push(...clipboard.keys.map((key) => ({ ...key, timeUs: key.timeUs + anchorUs })));
  return next.sort((left, right) => left.timeUs - right.timeUs);
}

export function setPropertyInterpolation<T>(
  keys: readonly PropertyLaneKey<T>[],
  selectedTimesUs: readonly number[],
  interpolation: string,
): readonly PropertyLaneKey<T>[] {
  const selected = new Set(selectedTimesUs);
  return keys.map((key) => (selected.has(key.timeUs) ? { ...key, interpolation } : key));
}
