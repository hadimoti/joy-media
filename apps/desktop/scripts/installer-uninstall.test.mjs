import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The uninstaller is generated inline in package-installer.mjs, so the contract is read from that source.
// The Windows lifecycle checks the same result on a real install, in the disposable VM.
const generator = readFileSync(new URL('./package-installer.mjs', import.meta.url), 'utf8');

function uninstallPathCleanupLine() {
  const line = generator
    .split('\n')
    .find(
      (candidate) =>
        candidate.includes("GetEnvironmentVariable('Path', 'User')") &&
        candidate.includes('$target'),
    );
  if (!line) throw new Error('The uninstaller PATH cleanup is missing from package-installer.mjs.');
  return line;
}

describe('uninstaller PATH cleanup (F1)', () => {
  it('removes both the install root and its bin folder from the User PATH', () => {
    const line = uninstallPathCleanupLine();
    expect(line).toContain("$bin = $target + '\\\\bin'");
    expect(line).toContain('-ine $target');
    expect(line).toContain('-ine $bin');
  });

  it('runs only after the install directory has been validated', () => {
    const validation = generator.indexOf(
      'Refusing to remove an invalid JOY Media install directory',
    );
    expect(validation).toBeGreaterThan(-1);
    expect(generator.indexOf(uninstallPathCleanupLine())).toBeGreaterThan(validation);
  });
});

/**
 * The uninstaller's PowerShell command, as cmd.exe will pass it: the JavaScript template escapes are undone, and
 * the two calls that touch the real User PATH are replaced by a fixture and an output line.
 */
function uninstallPathCommand() {
  const generated = uninstallPathCleanupLine().replace(/\\\\/g, '\\');
  const match = /-Command "(.*)" 2>nul/.exec(generated);
  if (!match) throw new Error('The uninstaller PowerShell command could not be read.');
  return match[1]
    .replace("[Environment]::GetEnvironmentVariable('Path', 'User')", '$env:TEST_USER_PATH')
    .replace("[Environment]::SetEnvironmentVariable('Path', $np, 'User')", 'Write-Output $np');
}

describe('uninstaller PATH cleanup behaviour (F1)', () => {
  // The cleanup is PowerShell, so it runs where PowerShell does. The User PATH is a fixture, so the real one is untouched.
  it.skipIf(process.platform !== 'win32')(
    'removes exactly the install root and its bin entries, and keeps every other value',
    () => {
      const install = 'C:\\Users\\example-user\\AppData\\Local\\Programs\\JOY Media';
      const kept = [
        'C:\\Windows\\System32',
        'C:\\Tools\\bin',
        `${install} Tools`,
        `${install}\\bin-old`,
        'D:\\Projects\\JOY Media Notes',
      ];
      const owned = [
        install,
        `${install}\\bin`,
        `${install}\\bin\\`,
        install.toUpperCase(),
        `${install}\\`,
      ];
      const fixture = [
        kept[0],
        owned[0],
        kept[1],
        owned[1],
        kept[2],
        owned[2],
        owned[3],
        kept[3],
        kept[4],
        owned[4],
      ];
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', uninstallPathCommand()],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            JOY_MEDIA_INSTALL_DIR: install,
            TEST_USER_PATH: fixture.join(';'),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(kept.join(';'));
    },
  );
});
