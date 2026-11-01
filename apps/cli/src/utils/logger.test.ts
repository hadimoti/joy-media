import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  c,
  colorEnabled,
  isMachineOutput,
  logError,
  logInfo,
  logLine,
  logStep,
  logSuccess,
  logWarn,
  printBanner,
  printJson,
  printTable,
  setMachineOutput,
  stripAnsi,
} from './logger.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[/;

function setTty(stream: NodeJS.WriteStream, value: boolean | undefined): void {
  Object.defineProperty(stream, 'isTTY', { value, configurable: true, writable: true });
}

describe('utils/logger', () => {
  const saved = {
    stdoutTty: process.stdout.isTTY,
    stderrTty: process.stderr.isTTY,
    env: {
      NO_COLOR: process.env.NO_COLOR,
      FORCE_COLOR: process.env.FORCE_COLOR,
      TERM: process.env.TERM,
    },
  };
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      err.push(args.join(' '));
    });
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    setTty(process.stdout, false);
    setTty(process.stderr, false);
    setMachineOutput(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setMachineOutput(false);
    setTty(process.stdout, saved.stdoutTty);
    setTty(process.stderr, saved.stderrTty);
    for (const [key, value] of Object.entries(saved.env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('machine output mode', () => {
    it('is off by default: human logs on stdout, errors on stderr', () => {
      expect(isMachineOutput()).toBe(false);
      printBanner();
      logInfo('info');
      logSuccess('done');
      logWarn('careful');
      logStep('Label', 'detail');
      logLine('plain');
      printTable(['A'], [['1']]);
      logError('broken');
      expect(out.join('\n')).toMatch(/JOY MEDIA CLI/);
      expect(out.join('\n')).toMatch(
        /info[\s\S]*done[\s\S]*careful[\s\S]*Label: detail[\s\S]*plain/,
      );
      expect(err).toEqual(['✖ broken']);
    });

    it('keeps stdout for JSON only: no banner, every human log goes to stderr', () => {
      setMachineOutput(true);
      printBanner();
      logInfo('info');
      logSuccess('done');
      logWarn('careful');
      logStep('Label', 'detail');
      logLine('plain');
      printTable(['A'], [['1']]);
      logError('broken');
      printJson({ ok: true });
      expect(out).toEqual([JSON.stringify({ ok: true }, null, 2)]);
      expect(err.join('\n')).toMatch(/ℹ info[\s\S]*✔ done[\s\S]*▲ careful[\s\S]*Label: detail/);
      expect(err).toContain('✖ broken');
      expect(err.join('\n')).not.toMatch(/JOY MEDIA CLI/);
    });

    it('never colours anything, even with FORCE_COLOR and TTYs', () => {
      process.env.FORCE_COLOR = '1';
      setTty(process.stdout, true);
      setTty(process.stderr, true);
      setMachineOutput(true);
      logWarn(`pre-coloured ${c('x', 'red')}`);
      logError('broken');
      expect(err.some((line) => ANSI.test(line))).toBe(false);
      expect(c('x', 'red')).toBe('x');
    });
  });

  describe('colour decisions', () => {
    it('only TTYs get colour by default', () => {
      expect(colorEnabled(process.stdout)).toBe(false);
      setTty(process.stdout, true);
      expect(colorEnabled(process.stdout)).toBe(true);
      expect(ANSI.test(c('x', 'red'))).toBe(true);
    });

    it('honours NO_COLOR (non-empty), FORCE_COLOR and TERM=dumb', () => {
      setTty(process.stdout, true);
      process.env.NO_COLOR = '1';
      expect(colorEnabled(process.stdout)).toBe(false);
      process.env.NO_COLOR = '';
      expect(colorEnabled(process.stdout)).toBe(true);
      delete process.env.NO_COLOR;
      process.env.TERM = 'dumb';
      expect(colorEnabled(process.stdout)).toBe(false);
      delete process.env.TERM;

      setTty(process.stdout, false);
      process.env.FORCE_COLOR = '1';
      expect(colorEnabled(process.stdout)).toBe(true);
      process.env.FORCE_COLOR = '';
      expect(colorEnabled(process.stdout)).toBe(true);
      process.env.FORCE_COLOR = '0';
      expect(colorEnabled(process.stdout)).toBe(false);
      process.env.FORCE_COLOR = 'false';
      expect(colorEnabled(process.stdout)).toBe(false);
    });

    it('logError colours from STDERR, not stdout', () => {
      setTty(process.stdout, true);
      setTty(process.stderr, false);
      logError(`see ${c('joy-media help', 'cyan')}`);
      expect(ANSI.test(err[0]!)).toBe(false);
      expect(err[0]).toBe('✖ see joy-media help');

      err.length = 0;
      setTty(process.stdout, false);
      setTty(process.stderr, true);
      logError('broken');
      expect(ANSI.test(err[0]!)).toBe(true);
      expect(stripAnsi(err[0]!)).toBe('✖ broken');
    });

    it('stdout logs carry no ANSI when stdout is piped', () => {
      setTty(process.stderr, true);
      logSuccess('done');
      logStep('Label', 'detail');
      expect(out.some((line) => ANSI.test(line))).toBe(false);
    });
  });
});
