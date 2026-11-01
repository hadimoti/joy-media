import { describe, expect, it } from 'vitest';
import { powershellOptions, WINDOWS_POWERSHELL } from './windows-powershell.js';

const PINNED_MODULES = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules';

describe('powershellOptions', () => {
  it('keeps one pinned PSModulePath whatever spelling the source uses', () => {
    const { env } = powershellOptions({
      PSModulePath: '\\\\server\\modules',
      PSMODULEPATH: '\\\\server\\other',
      psmodulepath: '\\\\server\\third',
      PATH: 'C:\\tools',
    });

    const spellings = Object.keys(env).filter((name) => name.toUpperCase() === 'PSMODULEPATH');
    expect(spellings).toEqual(['PSModulePath']);
    expect(env.PSModulePath).toBe(PINNED_MODULES);
    expect(env.PATH).toBe('C:\\tools');
  });

  it('starts the Windows PowerShell program by its absolute path only', () => {
    expect(powershellOptions({}).file).toBe(WINDOWS_POWERSHELL);
    expect(WINDOWS_POWERSHELL).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });
});
