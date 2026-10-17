import { describe, expect, it } from 'vitest';
import { resolveWindowsSystemExecutablePath } from './config.js';

describe('Windows system executable resolution', () => {
  it('uses System32 paths instead of resolving security tools through PATH', () => {
    expect(resolveWindowsSystemExecutablePath('whoami.exe', 'C:\\Windows')).toBe(
      'C:\\Windows\\System32\\whoami.exe',
    );
    expect(resolveWindowsSystemExecutablePath('icacls.exe', 'C:\\Windows')).toBe(
      'C:\\Windows\\System32\\icacls.exe',
    );
  });

  it('rejects a missing or relative Windows system root', () => {
    expect(() => resolveWindowsSystemExecutablePath('whoami.exe', '')).toThrow(
      /absolute Windows system root/,
    );
    expect(() => resolveWindowsSystemExecutablePath('whoami.exe', 'Windows')).toThrow(
      /absolute Windows system root/,
    );
  });
});
