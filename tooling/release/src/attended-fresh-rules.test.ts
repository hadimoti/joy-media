import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRESH_PROCESS_SCENARIO } from './attended-fresh-process.ts';
import { finishedRunArtifacts, parseRunArgs } from '../attended/scenario-rules.mjs';

const CANDIDATE = 'ded976c8b4fe10c0316e5071ece535ba181707e9';
const HASH = 'd1e7e6978ef4ae5a118580bd016461d2169213f88393c4002041dd7bd9cddbc1';
const SCENARIOS = ['desktop.app.restart-save-export', FRESH_PROCESS_SCENARIO];

function freshArgs(extra: string[] = []): string[] {
  return [
    '--scenario',
    FRESH_PROCESS_SCENARIO,
    '--exe',
    'C:\\run\\app\\joy-media.exe',
    '--candidate',
    CANDIDATE,
    '--expected-exe-sha256',
    HASH,
    '--library',
    'C:\\run\\library',
    '--out',
    'C:\\run\\fresh-1',
    ...extra,
  ];
}

describe('the fresh-process command line', () => {
  it('takes no source profile, no project and no profile folder', () => {
    const options = parseRunArgs(freshArgs(), SCENARIOS);
    expect(options.scenario).toBe(FRESH_PROCESS_SCENARIO);
    expect(options.profile).toBeUndefined();
    expect(options.project).toBeUndefined();
    expect(options.launch).toBe(false);
  });

  it('refuses a missing library, and accepts --launch and --media', () => {
    const args = freshArgs();
    const at = args.indexOf('--library');
    const withoutLibrary = [...args.slice(0, at), ...args.slice(at + 2)];
    expect(() => parseRunArgs(withoutLibrary, SCENARIOS)).toThrow('--library is required');
    const launched = parseRunArgs(freshArgs(['--launch', '--media', 'C:\\clip.mp4']), SCENARIOS);
    expect(launched.launch).toBe(true);
    expect(launched.media).toBe('C:\\clip.mp4');
  });

  it('still requires the restart scenario its source profile', () => {
    const args = [
      '--scenario',
      'desktop.app.restart-save-export',
      '--exe',
      'C:\\run\\app\\joy-media.exe',
      '--candidate',
      CANDIDATE,
      '--expected-exe-sha256',
      HASH,
      '--library',
      'C:\\run\\library',
      '--out',
      'C:\\run\\restart-1',
      '--profile',
      'C:\\run\\profile',
    ];
    expect(() => parseRunArgs(args, SCENARIOS)).toThrow('--profile-source is required');
  });
});

describe('the launch folder rule', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'fresh-run-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('allows a folder holding only dry-run files, and refuses one with a finished run in it', () => {
    writeFileSync(join(folder, 'preflight.json'), '{}');
    expect(finishedRunArtifacts(folder)).toEqual([]);
    writeFileSync(join(folder, 'run.json'), '{}');
    mkdirSync(join(folder, 'profile-fresh'));
    expect(finishedRunArtifacts(folder)).toEqual(['run.json', 'profile-fresh']);
  });
});
