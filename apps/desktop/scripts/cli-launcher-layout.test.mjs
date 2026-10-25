import { describe, expect, it } from 'vitest';
import {
  CLI_LAUNCHER_DIRECTORY,
  CLI_LAUNCHER_NAMES,
  cliLauncherContent,
  cliLauncherPathEntry,
} from './cli-launcher-layout.mjs';

describe('CLI launcher contract', () => {
  it('keeps both launchers in one folder, and that folder is the only PATH entry', () => {
    expect(CLI_LAUNCHER_DIRECTORY).toBe('bin');
    expect(CLI_LAUNCHER_NAMES).toEqual(['joy.cmd', 'joy-media.cmd']);
    expect(cliLauncherPathEntry('C:\\Programs\\JOY Media')).toBe('C:\\Programs\\JOY Media\\bin');
  });

  it('runs the bundle from the install root, one level above bin, on Electron as Node', () => {
    const content = cliLauncherContent();
    expect(content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(content).toContain('"%~dp0..\\joy-media.exe"');
    expect(content).toContain('"%~dp0..\\resources\\app\\cli\\joy-media-bundle.mjs" %*');
    expect(content).not.toContain('"%~dp0joy-media.exe"');
  });
});
