import { parseArgs } from 'node:util';

/**
 * Inclusive numeric range for a flag value. `min`/`max` are the only bounds
 * that apply by default; `allowZero: false` / `allowNegative: false` exclude
 * zero / negative values that would otherwise fall inside `[min, max]`.
 */
export interface NumericRange {
  readonly min: number;
  readonly max: number;
  readonly allowZero?: boolean;
  readonly allowNegative?: boolean;
}

/**
 * The caller invoked the CLI incorrectly (unknown option, missing value,
 * malformed number...). The dispatcher maps it to exit code 2.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class FlagValidationError extends UsageError {
  public readonly flag: string;
  public readonly received: unknown;

  constructor(flag: string, message: string, received: unknown) {
    super(`Invalid value for --${flag}: ${message} (received: ${JSON.stringify(received)})`);
    this.name = 'FlagValidationError';
    this.flag = flag;
    this.received = received;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseIntFlag(flag: string, raw: unknown, range?: NumericRange): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;

  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new FlagValidationError(flag, 'expected an integer', raw);
  }
  // Reject strings that contain non-numeric trailing content.
  if (String(parsed) !== text && !(text.startsWith('-') && String(parsed) === text.slice(1))) {
    // parseInt accepts trailing garbage; flag it as invalid.
    if (!/^-?\d+$/.test(text)) {
      throw new FlagValidationError(flag, 'expected an integer', raw);
    }
  }
  return enforceRange(flag, parsed, range);
}

export function parseFloatFlag(
  flag: string,
  raw: unknown,
  range?: NumericRange,
): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim();
  if (text === '') return undefined;

  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new FlagValidationError(flag, 'expected a number', raw);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) {
    throw new FlagValidationError(flag, 'expected a number', raw);
  }
  return enforceRange(flag, parsed, range);
}

function enforceRange(flag: string, value: number, range?: NumericRange): number {
  if (!range) return value;
  if (!isFiniteNumber(value)) {
    throw new FlagValidationError(flag, 'value is not a finite number', value);
  }
  // Report against the effective lower bound so the message is always true:
  // with `allowNegative: false` and a negative `min`, the floor is 0.
  const floor = range.allowNegative === false ? Math.max(range.min, 0) : range.min;
  if (value < floor) {
    const zeroExcluded = range.allowZero === false && floor === 0;
    throw new FlagValidationError(
      flag,
      `value must be ${zeroExcluded ? '>' : '>='} ${floor}`,
      value,
    );
  }
  if (value > range.max) {
    throw new FlagValidationError(flag, `value must be <= ${range.max}`, value);
  }
  if (range.allowZero === false && value === 0) {
    throw new FlagValidationError(
      flag,
      floor === 0 ? 'value must be > 0' : 'value must not be 0',
      value,
    );
  }
  return value;
}

export const NUMERIC_RANGES = {
  width: { min: 16, max: 15360 } as NumericRange,
  height: { min: 16, max: 8640 } as NumericRange,
  fps: { min: 1, max: 240 } as NumericRange,
  // Timeline positions: 0 (the very start of the timeline) is valid.
  start: { min: 0, max: 86400 } as NumericRange,
  duration: { min: 0.001, max: 86400 } as NumericRange,
  end: { min: 0, max: 86400 } as NumericRange,
  at: { min: 0, max: 86400 } as NumericRange,
  scale: { min: 1, max: 16 } as NumericRange,
};

export function assertFiniteNumber(flag: string, value: unknown): asserts value is number {
  if (!isFiniteNumber(value)) {
    throw new FlagValidationError(flag, 'expected a finite number', value);
  }
}

// ---------------------------------------------------------------------------
// Command-line parsing (strict, with helpful usage errors)
// ---------------------------------------------------------------------------

export interface CliOptionSpec {
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  /** The value is numeric: an empty value is a usage error, a leading `-` is a negative number. */
  readonly numeric?: boolean;
}

export interface ParsedCommandLine {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: string[];
  /** `--help` / `-h` appeared before any `--` terminator. */
  readonly help: boolean;
  /** `--version` / `-v` appeared before any `--` terminator. */
  readonly version: boolean;
  /** The first usage problem found, if any. Help/version still win over it. */
  readonly error: UsageError | undefined;
}

const NEGATIVE_NUMBER_RE = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Does `value` (taken from the NEXT argv entry) look like another option rather than a value? */
function looksLikeOption(value: string): boolean {
  return value.length > 1 && value.startsWith('-') && !NEGATIVE_NUMBER_RE.test(value);
}

/**
 * Parse argv against a declared option table.
 *
 * Unlike `parseArgs({ strict: true })` this accepts negative numbers as option
 * values (`--start -3` reaches the numeric validator), and unlike
 * `strict: false` it never silently drops anything: unknown options, missing
 * values and values on switches are reported as a {@link UsageError}.
 */
export function parseCommandLine(
  argv: readonly string[],
  options: Readonly<Record<string, CliOptionSpec>>,
): ParsedCommandLine {
  const { tokens, positionals } = parseArgs({
    args: [...argv],
    options: Object.fromEntries(
      Object.entries(options).map(([name, spec]) => [
        name,
        spec.short ? { type: spec.type, short: spec.short } : { type: spec.type },
      ]),
    ),
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const values: Record<string, string | boolean | undefined> = {};
  let help = false;
  let version = false;
  let error: UsageError | undefined;
  const fail = (message: string): void => {
    error ??= new UsageError(message);
  };

  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    // `-project` / `-json`: a long option written with one dash would otherwise be
    // read as a cluster of short options (`-p roject`) and silently do the wrong thing.
    const raw = argv[token.index] ?? '';
    const singleDashLong = /^-([a-z][a-z-]+)(?:=.*)?$/i.exec(raw)?.[1];
    if (singleDashLong && suggest(singleDashLong, Object.keys(options), 0)) {
      fail(
        `Unknown option ${raw.split('=')[0]}. Did you mean --${suggest(singleDashLong, Object.keys(options), 0)}?`,
      );
      continue;
    }
    const spec = Object.hasOwn(options, token.name) ? options[token.name] : undefined;
    if (!spec) {
      fail(unknownOptionMessage(token.rawName, options));
      continue;
    }
    if (token.name === 'help') help = true;
    if (token.name === 'version') version = true;

    if (spec.type === 'boolean') {
      if (token.value !== undefined) {
        fail(
          `Option ${token.rawName} is a switch and does not take a value (got "${token.value}"). ` +
            `Use ${token.rawName} on its own.`,
        );
        continue;
      }
      values[token.name] = true;
      continue;
    }

    // String option.
    const value = token.value;
    if (value === undefined) {
      fail(`Option ${token.rawName} requires a value: ${token.rawName} <value>.`);
      continue;
    }
    if (!token.inlineValue && looksLikeOption(value)) {
      if (value === '--help' || value === '-h') help = true;
      if (value === '--version' || value === '-v') version = true;
      fail(
        `Option ${token.rawName} requires a value but got the option "${value}". ` +
          `If the value really starts with "-", write ${token.rawName}=${value}.`,
      );
      continue;
    }
    if (spec.numeric && value.trim() === '') {
      fail(`Option ${token.rawName} requires a numeric value, got an empty string.`);
      continue;
    }
    values[token.name] = value;
  }

  return { values, positionals, help, version, error };
}

function unknownOptionMessage(
  rawName: string,
  options: Readonly<Record<string, CliOptionSpec>>,
): string {
  const isLong = rawName.startsWith('--');
  const bare = rawName.replace(/^-+/, '');
  let message = `Unknown option ${rawName}.`;
  if (isLong) {
    const guess = suggest(bare, Object.keys(options));
    if (guess) message += ` Did you mean --${guess}?`;
  } else if (/^\d/.test(bare)) {
    message += ' To pass a negative number or a value starting with "-", put it after "--".';
  }
  return message;
}

/** Levenshtein edit distance (small inputs only). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length]!;
}

/**
 * Closest candidate to `input` (case-insensitive), or undefined when nothing is
 * plausibly what the user meant. `maxDistance` defaults to a third of the input
 * length (at least 1); pass 0 to accept only case-insensitive exact matches.
 */
export function suggest(
  input: string,
  candidates: readonly string[],
  maxDistance?: number,
): string | undefined {
  const needle = input.toLowerCase();
  if (needle === '') return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const hay = candidate.toLowerCase();
    if (hay === needle) return candidate;
    const distance = editDistance(needle, hay);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const tolerance = maxDistance ?? Math.max(1, Math.floor(needle.length / 3));
  if (best !== undefined && bestDistance <= tolerance) return best;
  if (maxDistance === 0) return undefined;
  // A prefix is a good hint too (`--proj` -> `--project`).
  return candidates.find((candidate) => needle.length >= 3 && candidate.startsWith(needle));
}
