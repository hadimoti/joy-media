/**
 * The allowlisted numeric function set (§20.3). Every function here is a pure
 * function of its numeric arguments — no closures over mutable state, no
 * wall-clock, no `Math.random` (which is a stateful, non-reproducible
 * stream unsuitable for a cacheable expression result).
 */

/** FNV-1a-style string hash, then a mulberry32 mix — same shape as the P00.4 scene spike's PRNG. */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Deterministic, referentially transparent unit random value for a numeric seed. */
export function seededUnitRandom(seed: number): number {
  let state = hash32(String(seed));
  state = (state + 0x6d2b79f5) | 0;
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function requireArgs(name: string, args: readonly number[], count: number): void {
  if (args.length !== count)
    throw new RangeError(`${name}() expects ${count} argument(s), got ${args.length}`);
}

export type ExpressionFunction = (args: readonly number[]) => number;

/** Name -> implementation. `compile.ts`/`interpreter.ts` reject any call not listed here. */
export const ALLOWED_FUNCTIONS: Readonly<Record<string, ExpressionFunction>> = {
  sin: (args) => {
    requireArgs('sin', args, 1);
    return Math.sin(args[0]!);
  },
  cos: (args) => {
    requireArgs('cos', args, 1);
    return Math.cos(args[0]!);
  },
  tan: (args) => {
    requireArgs('tan', args, 1);
    return Math.tan(args[0]!);
  },
  sqrt: (args) => {
    requireArgs('sqrt', args, 1);
    return Math.sqrt(args[0]!);
  },
  abs: (args) => {
    requireArgs('abs', args, 1);
    return Math.abs(args[0]!);
  },
  floor: (args) => {
    requireArgs('floor', args, 1);
    return Math.floor(args[0]!);
  },
  ceil: (args) => {
    requireArgs('ceil', args, 1);
    return Math.ceil(args[0]!);
  },
  round: (args) => {
    requireArgs('round', args, 1);
    return Math.round(args[0]!);
  },
  pow: (args) => {
    requireArgs('pow', args, 2);
    return Math.pow(args[0]!, args[1]!);
  },
  min: (args) => {
    if (args.length === 0) throw new RangeError('min() expects at least 1 argument');
    return Math.min(...args);
  },
  max: (args) => {
    if (args.length === 0) throw new RangeError('max() expects at least 1 argument');
    return Math.max(...args);
  },
  clamp: (args) => {
    requireArgs('clamp', args, 3);
    const [value, lo, hi] = args as [number, number, number];
    return Math.min(hi, Math.max(lo, value));
  },
  lerp: (args) => {
    requireArgs('lerp', args, 3);
    const [a, b, t] = args as [number, number, number];
    return a + (b - a) * t;
  },
  mix: (args) => {
    requireArgs('mix', args, 3);
    const [a, b, t] = args as [number, number, number];
    return a + (b - a) * t;
  },
  random: (args) => {
    requireArgs('random', args, 1);
    return seededUnitRandom(args[0]!);
  },
};
