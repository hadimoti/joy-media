import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getJoyMediaHome } from './joy-media-home.js';

let originalJoyMediaHome: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let temporaryRoot = '';

beforeEach(() => {
  originalJoyMediaHome = process.env.JOY_MEDIA_HOME;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-media-home-test-'));
  process.env.HOME = temporaryRoot;
  process.env.USERPROFILE = temporaryRoot;
});

afterEach(() => {
  if (originalJoyMediaHome === undefined) delete process.env.JOY_MEDIA_HOME;
  else process.env.JOY_MEDIA_HOME = originalJoyMediaHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('getJoyMediaHome', () => {
  it('uses JOY_MEDIA_HOME when it is set', () => {
    const configuredHome = join(temporaryRoot, 'configured-home');
    process.env.JOY_MEDIA_HOME = configuredHome;

    expect(getJoyMediaHome()).toBe(configuredHome);
  });

  it('defaults to the existing per-user directory when unset or blank', () => {
    delete process.env.JOY_MEDIA_HOME;
    expect(getJoyMediaHome()).toBe(join(homedir(), '.joy-media'));

    process.env.JOY_MEDIA_HOME = '   ';
    expect(getJoyMediaHome()).toBe(join(homedir(), '.joy-media'));
  });
});
