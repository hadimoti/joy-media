import { describe, expect, it } from 'vitest';
import {
  type CliOptionSpec,
  FlagValidationError,
  NUMERIC_RANGES,
  UsageError,
  editDistance,
  parseCommandLine,
  parseFloatFlag,
  parseIntFlag,
  suggest,
} from './flags.js';

describe('utils/flags (numeric flag validation)', () => {
  describe('parseIntFlag', () => {
    it('returns undefined for empty inputs', () => {
      expect(parseIntFlag('width', undefined)).toBeUndefined();
      expect(parseIntFlag('width', null)).toBeUndefined();
      expect(parseIntFlag('width', '')).toBeUndefined();
      expect(parseIntFlag('width', '   ')).toBeUndefined();
    });

    it('parses valid integers', () => {
      expect(parseIntFlag('width', '1920')).toBe(1920);
      expect(parseIntFlag('width', '0')).toBe(0);
      expect(parseIntFlag('width', 1080)).toBe(1080);
    });

    it('throws FlagValidationError on NaN / non-numeric strings', () => {
      expect(() => parseIntFlag('width', 'abc')).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', '12abc')).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', Number.NaN)).toThrow(FlagValidationError);
      expect(() => parseIntFlag('width', Number.POSITIVE_INFINITY)).toThrow(FlagValidationError);
    });

    it('enforces min/max ranges', () => {
      // 1 is allowed, so the message must not claim "> 1" (it used to).
      expect(() => parseIntFlag('fps', '0', { min: 1, max: 240 })).toThrow(/must be >= 1 \(/);
      expect(parseIntFlag('fps', '1', { min: 1, max: 240 })).toBe(1);
      expect(() => parseIntFlag('fps', '300', { min: 1, max: 240 })).toThrow(/must be <= 240/);
      expect(parseIntFlag('fps', '60', { min: 1, max: 240 })).toBe(60);
    });
  });

  describe('parseFloatFlag', () => {
    it('returns undefined for empty inputs', () => {
      expect(parseFloatFlag('start', undefined)).toBeUndefined();
      expect(parseFloatFlag('start', '')).toBeUndefined();
    });

    it('parses valid floats', () => {
      expect(parseFloatFlag('start', '1.5')).toBe(1.5);
      expect(parseFloatFlag('start', '-2.25')).toBe(-2.25);
    });

    it('throws on non-numeric strings', () => {
      expect(() => parseFloatFlag('start', 'foo')).toThrow(FlagValidationError);
      expect(() => parseFloatFlag('start', '1.2.3')).toThrow(FlagValidationError);
    });

    it('enforces ranges', () => {
      expect(() => parseFloatFlag('start', '-1', { min: 0, max: 100 })).toThrow(/must be >= 0/);
      // The floor is 0.001, so "> 0" would be inaccurate for 0.0005.
      expect(() => parseFloatFlag('duration', '0', { min: 0.001, max: 100 })).toThrow(
        /must be >= 0\.001/,
      );
      expect(() => parseFloatFlag('duration', '0.0005', { min: 0.001, max: 100 })).toThrow(
        /must be >= 0\.001/,
      );
      expect(parseFloatFlag('duration', '5', { min: 0.001, max: 100 })).toBe(5);
    });
  });

  describe('range semantics', () => {
    it('timeline positions accept 0 (a clip may start at 0:00)', () => {
      for (const flag of ['start', 'end', 'at'] as const) {
        expect(parseFloatFlag(flag, '0', NUMERIC_RANGES[flag])).toBe(0);
        expect(parseFloatFlag(flag, '0.0', NUMERIC_RANGES[flag])).toBe(0);
        expect(() => parseFloatFlag(flag, '-3', NUMERIC_RANGES[flag])).toThrow(
          new RegExp(`--${flag}: value must be >= 0 \\(received: -3\\)`),
        );
      }
    });

    it('bounds are inclusive and messages are always true statements', () => {
      expect(parseIntFlag('scale', '1', NUMERIC_RANGES.scale)).toBe(1);
      expect(parseIntFlag('scale', '16', NUMERIC_RANGES.scale)).toBe(16);
      expect(() => parseIntFlag('scale', '0', NUMERIC_RANGES.scale)).toThrow(/must be >= 1 \(/);
      expect(() => parseIntFlag('scale', '17', NUMERIC_RANGES.scale)).toThrow(/must be <= 16/);
      expect(() => parseIntFlag('width', '15', NUMERIC_RANGES.width)).toThrow(/must be >= 16/);
    });

    it('allowZero: false excludes 0 with a ">" message when 0 is the floor', () => {
      const range = { min: 0, max: 10, allowZero: false };
      expect(() => parseFloatFlag('gain', '0', range)).toThrow(/must be > 0/);
      expect(() => parseFloatFlag('gain', '-1', range)).toThrow(/must be > 0/);
      expect(parseFloatFlag('gain', '0.5', range)).toBe(0.5);
      expect(() => parseFloatFlag('pan', '0', { min: -1, max: 1, allowZero: false })).toThrow(
        /must not be 0/,
      );
      expect(parseFloatFlag('pan', '-1', { min: -1, max: 1, allowZero: false })).toBe(-1);
    });

    it('allowNegative: false raises a negative floor to 0', () => {
      expect(() => parseIntFlag('n', '-1', { min: -5, max: 5, allowNegative: false })).toThrow(
        /must be >= 0/,
      );
      expect(parseIntFlag('n', '0', { min: -5, max: 5, allowNegative: false })).toBe(0);
    });

    it('FlagValidationError is a UsageError (exit 2)', () => {
      expect(() => parseIntFlag('fps', 'x')).toThrow(UsageError);
    });
  });

  describe('parseCommandLine', () => {
    const options = {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      project: { type: 'string', short: 'p' },
      name: { type: 'string', short: 'n' },
      start: { type: 'string', numeric: true },
    } as const satisfies Record<string, CliOptionSpec>;

    it('accepts known options in every syntax, before or after positionals', () => {
      const parsed = parseCommandLine(
        ['--json', 'project', 'create', '-p', 'a', '--name=x', '-nY', '--start', '-3'],
        options,
      );
      expect(parsed.error).toBeUndefined();
      expect(parsed.positionals).toEqual(['project', 'create']);
      expect(parsed.values).toEqual({ json: true, project: 'a', name: 'Y', start: '-3' });
    });

    it('negative numbers are values, not options', () => {
      for (const value of ['-3', '-0.5', '-.5', '-1e3']) {
        const parsed = parseCommandLine(['--start', value], options);
        expect(parsed.error, value).toBeUndefined();
        expect(parsed.values.start).toBe(value);
      }
    });

    it('reports unknown options with a suggestion', () => {
      expect(parseCommandLine(['--projct', 'x'], options).error?.message).toBe(
        'Unknown option --projct. Did you mean --project?',
      );
      expect(parseCommandLine(['--zzzzzz'], options).error?.message).toBe(
        'Unknown option --zzzzzz.',
      );
      expect(parseCommandLine(['-project', 'x'], options).error?.message).toBe(
        'Unknown option -project. Did you mean --project?',
      );
      expect(parseCommandLine(['-5'], options).error?.message).toMatch(/after "--"/);
    });

    it('reports a missing value instead of turning it into `true`', () => {
      expect(parseCommandLine(['--name'], options).error?.message).toMatch(
        /--name requires a value/,
      );
      expect(parseCommandLine(['--project', '--json'], options).error?.message).toMatch(
        /--project requires a value but got the option "--json"/,
      );
      expect(parseCommandLine(['--start', ''], options).error?.message).toMatch(
        /--start requires a numeric value/,
      );
      // An explicit `=` means the user really wants the dash value.
      expect(parseCommandLine(['--project=--json'], options).values.project).toBe('--json');
      // A lone "-" (stdin convention) is a value.
      expect(parseCommandLine(['--name', '-'], options).values.name).toBe('-');
    });

    it('rejects values on switches', () => {
      expect(parseCommandLine(['--json=false'], options).error?.message).toMatch(
        /--json is a switch/,
      );
    });

    it('detects help/version even when another option swallowed them', () => {
      expect(parseCommandLine(['--name', '--help'], options).help).toBe(true);
      expect(parseCommandLine(['-hv'], options)).toMatchObject({ help: true, version: true });
      expect(parseCommandLine(['--', '--help'], options)).toMatchObject({
        help: false,
        positionals: ['--help'],
      });
    });

    it('last occurrence wins for repeated options', () => {
      expect(parseCommandLine(['-p', 'a', '--project', 'b'], options).values.project).toBe('b');
    });
  });

  describe('suggest', () => {
    it('finds close, case-insensitive and prefix matches only', () => {
      const commands = ['agent', 'project', 'timeline', 'worker', 'render', 'doctor'];
      expect(suggest('projct', commands)).toBe('project');
      expect(suggest('PROJECT', commands)).toBe('project');
      expect(suggest('time', commands)).toBe('timeline');
      expect(suggest('xyzzy', commands)).toBeUndefined();
      expect(suggest('', commands)).toBeUndefined();
      expect(editDistance('kitten', 'sitting')).toBe(3);
    });
  });

  it('FlagValidationError carries flag name and received value', () => {
    try {
      parseIntFlag('width', 'not-a-number');
      throw new Error('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FlagValidationError);
      const e = err as FlagValidationError;
      expect(e.flag).toBe('width');
      expect(e.received).toBe('not-a-number');
      expect(e.message).toMatch(/--width/);
    }
  });
});
