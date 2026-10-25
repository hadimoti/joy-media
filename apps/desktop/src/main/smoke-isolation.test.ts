import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSmokeProfile,
  isSmokeRun,
  planSmokeProfile,
  removeSmokeProfile,
  sameLocation,
  smokeEnvironment,
  smokePathOverrides,
  type SmokeProfile,
} from './smoke-isolation.js';

const NONCE = 'a'.repeat(32);
const OTHER_NONCE = 'b'.repeat(32);

/** A real folder this test owns, standing in for the OS temp folder. */
let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'joy-smoke-test-'));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function planFor(overrides: { tempRoot?: string; nonce?: string; protectedPaths?: string[] } = {}) {
  return planSmokeProfile({
    tempRoot,
    nonce: NONCE,
    protectedPaths: [],
    ...overrides,
  });
}

function everyPathIsInside(profile: SmokeProfile, paths: readonly string[]): boolean {
  return paths.every((candidate) => candidate.startsWith(`${profile.root}${path.sep}`));
}

describe('isSmokeRun', () => {
  it('selects a run only for the exact flag', () => {
    expect(isSmokeRun(['electron', '.', '--smoke'])).toBe(true);
    expect(isSmokeRun(['joy-media.exe', '--smoke', '--user-data-dir=C:\\x'])).toBe(true);
    expect(isSmokeRun(['joy-media.exe', '--smoke-test'])).toBe(false);
    expect(isSmokeRun(['joy-media.exe', '--user-data-dir=--smoke'])).toBe(false);
    expect(isSmokeRun([])).toBe(false);
  });
});

describe('planSmokeProfile', () => {
  it('plans a new run folder directly under the temp root, with every path inside it', () => {
    const profile = planFor();
    expect(path.dirname(profile.root)).toBe(path.resolve(tempRoot));
    expect(path.basename(profile.root)).toBe(`joy-media-smoke-${NONCE}`);
    expect(profile.tempRoot).toBe(path.resolve(tempRoot));
    expect(
      everyPathIsInside(profile, [
        profile.marker,
        profile.userData,
        profile.sessionData,
        profile.logs,
        profile.crashDumps,
        profile.downloads,
        profile.appData,
        profile.home,
        profile.localAppData,
        profile.temp,
        profile.assetLibrary,
      ]),
    ).toBe(true);
  });

  it('never plans the default asset library in the real home folder', () => {
    const profile = planFor();
    expect(profile.assetLibrary).toBe(path.join(profile.home, 'joy-media-assets'));
    expect(everyPathIsInside(profile, [profile.assetLibrary])).toBe(true);
  });

  it('refuses a relative temp root', () => {
    expect(() => planFor({ tempRoot: 'relative-temp' })).toThrow(/absolute path/);
  });

  it.each([
    ['upper-case hex', 'A'.repeat(32)],
    ['too short', 'a'.repeat(31)],
    ['path traversal', `..${'a'.repeat(30)}`],
    ['separator', `${'a'.repeat(16)}/${'a'.repeat(15)}`],
  ])('refuses a nonce that is %s', (_label, nonce) => {
    expect(() => planFor({ nonce })).toThrow(/32 lowercase hex/);
  });

  it('refuses a temp root that sits inside protected data', () => {
    const protectedData = path.join(tempRoot, 'roaming', '@joy-media');
    const insideProtected = path.join(protectedData, 'tmp');
    expect(() => planFor({ tempRoot: insideProtected, protectedPaths: [protectedData] })).toThrow(
      /would overlap/,
    );
    expect(() => planFor({ tempRoot, protectedPaths: [tempRoot] })).toThrow(/would overlap/);
  });

  it('refuses a protected folder that sits inside the run folder', () => {
    const runFolder = path.join(tempRoot, `joy-media-smoke-${NONCE}`);
    expect(() => planFor({ protectedPaths: [path.join(runFolder, 'user-data')] })).toThrow(
      /would overlap/,
    );
  });

  it('allows an install folder that sits inside the temp root, because the run only reads it', () => {
    const installFolder = path.join(tempRoot, 'installed', 'JOY Media');
    expect(() => planFor({ protectedPaths: [installFolder] })).not.toThrow();
  });

  it('allows protected data that is unrelated to the temp root', () => {
    const elsewhere = path.join(tempRoot, '..', 'joy-media-unrelated-data');
    expect(() => planFor({ protectedPaths: [elsewhere] })).not.toThrow();
  });
});

describe('smokeEnvironment and smokePathOverrides', () => {
  it('redirects every profile and temp variable into the run folder', () => {
    const profile = planFor();
    const environment = smokeEnvironment(profile);
    expect(Object.keys(environment).sort()).toEqual(
      ['APPDATA', 'HOME', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE'].sort(),
    );
    expect(everyPathIsInside(profile, Object.values(environment))).toBe(true);
  });

  it('overrides exactly the Electron folders that the run may write to', () => {
    const profile = planFor();
    const overrides = smokePathOverrides(profile);
    expect(overrides.map(([name]) => name)).toEqual([
      'userData',
      'sessionData',
      'logs',
      'crashDumps',
      'downloads',
      'temp',
      'appData',
    ]);
    expect(
      everyPathIsInside(
        profile,
        overrides.map(([, folder]) => folder),
      ),
    ).toBe(true);
  });
});

describe('createSmokeProfile and removeSmokeProfile', () => {
  it('creates the run folder, its folders and a marker, then deletes exactly that folder', () => {
    const profile = planFor();
    createSmokeProfile(profile);
    expect(existsSync(profile.userData)).toBe(true);
    expect(existsSync(profile.temp)).toBe(true);
    expect(JSON.parse(readFileSync(profile.marker, 'utf8'))).toEqual({ nonce: NONCE });

    expect(removeSmokeProfile(profile)).toEqual({ removed: true });
    expect(existsSync(profile.root)).toBe(false);
    expect(existsSync(tempRoot)).toBe(true);
  });

  it('refuses to reuse a run folder that already exists, and leaves its contents alone', () => {
    const profile = planFor();
    mkdirSync(profile.root);
    writeFileSync(path.join(profile.root, 'keep.txt'), 'not ours');
    expect(() => createSmokeProfile(profile)).toThrow();
    expect(readFileSync(path.join(profile.root, 'keep.txt'), 'utf8')).toBe('not ours');
  });

  it('keeps the folder when its marker is missing', () => {
    const profile = planFor();
    createSmokeProfile(profile);
    rmSync(profile.marker);
    expect(removeSmokeProfile(profile).removed).toBe(false);
    expect(existsSync(profile.root)).toBe(true);
  });

  it('keeps the folder when its marker belongs to another run', () => {
    const profile = planFor();
    createSmokeProfile(profile);
    writeFileSync(profile.marker, JSON.stringify({ nonce: OTHER_NONCE }));
    const result = removeSmokeProfile(profile);
    expect(result).toMatchObject({ removed: false });
    expect(existsSync(profile.root)).toBe(true);
  });

  it('keeps a folder that is not a direct child of the recorded temp root', () => {
    const nested = path.join(tempRoot, 'nested');
    mkdirSync(nested);
    const forgedRoot = path.join(nested, `joy-media-smoke-${NONCE}`);
    const forged: SmokeProfile = {
      ...planFor(),
      root: forgedRoot,
      marker: path.join(forgedRoot, 'smoke-profile.json'),
    };
    mkdirSync(forged.root);
    writeFileSync(forged.marker, JSON.stringify({ nonce: NONCE }));
    expect(removeSmokeProfile(forged)).toMatchObject({ removed: false });
    expect(existsSync(forged.root)).toBe(true);
  });

  it('keeps a folder whose name does not carry its nonce', () => {
    const profile = planFor();
    const forged: SmokeProfile = { ...profile, root: path.join(tempRoot, 'Documents') };
    mkdirSync(forged.root);
    expect(removeSmokeProfile(forged)).toMatchObject({ removed: false });
    expect(existsSync(forged.root)).toBe(true);
  });
});

describe('sameLocation', () => {
  it('treats the same folder, written two ways, as the same location', () => {
    const folder = path.join(tempRoot, 'same');
    expect(sameLocation(folder, path.join(folder, '..', 'same'))).toBe(true);
    expect(sameLocation(folder, path.join(tempRoot, 'other'))).toBe(false);
  });
});

describe('the protocol registration guard in electron-entry.ts', () => {
  const entrySource = readFileSync(new URL('./electron-entry.ts', import.meta.url), 'utf8');
  const guarded = /if \(!isSmokeMode\)\s+app\.setAsDefaultProtocolClient\('joy'\);/;

  it('registers the joy protocol only outside smoke runs', () => {
    expect(entrySource.match(/app\.setAsDefaultProtocolClient\(/g)).toHaveLength(1);
    expect(entrySource).toMatch(guarded);
  });

  it('would fail if the guard were removed (negative control)', () => {
    const unguarded = entrySource.replace(/if \(!isSmokeMode\)\s+/, '');
    expect(unguarded.match(/app\.setAsDefaultProtocolClient\(/g)).toHaveLength(1);
    expect(unguarded).not.toMatch(guarded);
  });
});
