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
