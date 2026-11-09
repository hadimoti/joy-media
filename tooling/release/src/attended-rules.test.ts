import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInside, parseRunArgs, realPathOf, samePath } from '../attended/scenario-rules.mjs';

const SCENARIO = 'desktop.app.restart-save-export';
const SCENARIOS = [SCENARIO];
const VALID = [
  '--scenario',
  SCENARIO,
  '--exe',
  'C:\\x\\joy-media.exe',
  '--candidate',
  'a'.repeat(40),
  '--expected-exe-sha256',
  'b'.repeat(64),
  '--profile-source',
  'C:\\p',
  '--profile',
  'C:\\q',
  '--library',
  'C:\\l',
  '--out',
  'C:\\o',
  '--project',
  'project-1',
];

const tmp = mkdtempSync(join(tmpdir(), 'attended-rules-'));

beforeAll(() => {
  mkdirSync(join(tmp, 'a', 'b'), { recursive: true });
  mkdirSync(join(tmp, 'ab'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('path rules', () => {
  it('treats a folder as inside itself and inside its parent, but not a sibling with the same start', () => {
    expect(isInside(join(tmp, 'a'), join(tmp, 'a'))).toBe(true);
    expect(isInside(join(tmp, 'a', 'b'), join(tmp, 'a'))).toBe(true);
    expect(isInside(join(tmp, 'ab'), join(tmp, 'a'))).toBe(false);
  });

  it('compares a missing path through its nearest existing parent', () => {
    const missing = join(tmp, 'a', 'not-yet', 'deeper');
    expect(realPathOf(missing)).toBe(join(realPathOf(join(tmp, 'a')), 'not-yet', 'deeper'));
    expect(isInside(missing, join(tmp, 'a'))).toBe(true);
  });

  it('ignores a trailing separator when comparing', () => {
    expect(samePath(join(tmp, 'a') + sep, join(tmp, 'a'))).toBe(true);
    expect(samePath(join(tmp, 'a'), join(tmp, 'ab'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('sees through a junction to the real folder', () => {
    // A junction needs no administrator rights, so the test can make one inside its scratch folder.
    const real = join(tmp, 'real');
    const link = join(tmp, 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, 'junction');
    expect(isInside(join(link, 'file.txt'), real)).toBe(true);
    expect(samePath(link, real)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('ignores case on Windows', () => {
    expect(samePath(join(tmp, 'A', 'B'), join(tmp, 'a', 'b'))).toBe(true);
    expect(isInside(join(tmp, 'A', 'B'), join(tmp, 'a'))).toBe(true);
  });
});

describe('run arguments', () => {
  it('reads every option and defaults to no launch', () => {
    const options = parseRunArgs(VALID, SCENARIOS);
    expect(options).toMatchObject({ scenario: SCENARIO, project: 'project-1', launch: false });
  });

  it('turns the app on only with --launch', () => {
    expect(parseRunArgs([...VALID, '--launch'], SCENARIOS).launch).toBe(true);
  });

  it('names the first missing option', () => {
    expect(() => parseRunArgs(VALID.slice(0, -2), SCENARIOS)).toThrow('--project is required');
  });

  it('refuses an unknown scenario, a malformed commit or hash, and stray arguments', () => {
    expect(() =>
      parseRunArgs(
        VALID.map((value) => (value === SCENARIO ? 'desktop.other' : value)),
        SCENARIOS,
      ),
    ).toThrow('unknown scenario');
    expect(() =>
      parseRunArgs(
        VALID.map((value) => (value === 'a'.repeat(40) ? 'ABC' : value)),
        SCENARIOS,
      ),
    ).toThrow('full 40-character');
    expect(() =>
      parseRunArgs(
        VALID.map((value) => (value === 'b'.repeat(64) ? 'B'.repeat(64) : value)),
        SCENARIOS,
      ),
    ).toThrow('64-character');
    expect(() => parseRunArgs([...VALID, 'stray'], SCENARIOS)).toThrow('unexpected argument');
    expect(() => parseRunArgs([...VALID, '--launch', '--port'], SCENARIOS)).toThrow(
      '--port needs a value',
    );
  });
});
