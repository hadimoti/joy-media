export interface NumericRange {
  readonly min: number;
  readonly max: number;
  readonly allowZero?: boolean;
  readonly allowNegative?: boolean;
}

export class FlagValidationError extends Error {
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
  if (!range.allowNegative && value < 0) {
    throw new FlagValidationError(flag, `value must be >= ${range.min}`, value);
  }
  if (!range.allowZero && value === 0) {
    throw new FlagValidationError(flag, `value must be > ${range.min}`, value);
  }
  if (value < range.min) {
    throw new FlagValidationError(flag, `value must be >= ${range.min}`, value);
  }
  if (value > range.max) {
    throw new FlagValidationError(flag, `value must be <= ${range.max}`, value);
  }
  return value;
}

export const NUMERIC_RANGES = {
  width: { min: 16, max: 15360 } as NumericRange,
  height: { min: 16, max: 8640 } as NumericRange,
  fps: { min: 1, max: 240 } as NumericRange,
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
