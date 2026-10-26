/**
 * Pre-emptive encoder selection for a known-bad GPU driver range (L2, plan §3.2). It is a pure decision and is not wired
 * into the app. It stays inert until the owner's diagnosis proves the cause is outside our code and an entry is added
 * to KNOWN_BAD_ENCODER_RANGES. The table is empty today, so every adapter keeps the hardware path, and the fallback
 * relaunch remains the last resort.
 */
export interface GpuAdapterFacts {
  readonly vendorId: number;
  readonly deviceId: number;
  /** Dotted numeric driver version, for example "617.42". */
  readonly driverVersion: string;
}

export interface KnownBadEncoderRange {
  /** The redacted diagnosis that justified the entry. */
  readonly id: string;
  readonly vendorId: number;
  readonly deviceIds: readonly number[];
  /** Inclusive upper bound. A newer driver moves the adapter out of the range, and the entry stops applying. */
  readonly lastBadDriver: string;
  readonly electronMajor: number;
  /** ISO time after which the entry no longer applies, so a stale entry cannot pin a device forever. */
  readonly expires: string;
}

export type EncoderPolicy =
  { readonly mode: 'hardware' } | { readonly mode: 'software-mf-off'; readonly reason: string };

/** Empty until a diagnosis proves a branch H1, H3 or H6 outside our code (plan §3.2). */
export const KNOWN_BAD_ENCODER_RANGES: readonly KnownBadEncoderRange[] = [];

export function decideEncoderPolicy(options: {
  readonly adapter: GpuAdapterFacts;
  readonly electronMajor: number;
  readonly now: string;
  readonly ranges?: readonly KnownBadEncoderRange[];
}): EncoderPolicy {
  const ranges = options.ranges ?? KNOWN_BAD_ENCODER_RANGES;
  const match = ranges.find(
    (range) =>
      range.vendorId === options.adapter.vendorId &&
      range.deviceIds.includes(options.adapter.deviceId) &&
      range.electronMajor === options.electronMajor &&
      Date.parse(options.now) < Date.parse(range.expires) &&
      isDriverVersion(options.adapter.driverVersion) &&
      isDriverVersion(range.lastBadDriver) &&
      compareDriverVersions(options.adapter.driverVersion, range.lastBadDriver) <= 0,
  );
  return match === undefined ? { mode: 'hardware' } : { mode: 'software-mf-off', reason: match.id };
}

/** Negative when `a` is older than `b`. Each dotted part compares as a number; missing parts count as zero. */
export function compareDriverVersions(a: string, b: string): number {
  if (!isDriverVersion(a) || !isDriverVersion(b)) {
    throw new RangeError('driver versions must be dotted numbers');
  }
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

/** A driver version the policy can order: dotted numbers only. Anything else, such as "617.42-beta", never matches. */
function isDriverVersion(value: string): boolean {
  return /^\d+(\.\d+)*$/u.test(value);
}
