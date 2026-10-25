import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The setup is C# compiled by csc in build-installer.ps1, and the Windows lifecycle runs the built binary. These
// checks keep the source contract that the lifecycle relies on: a verified staging install, a kept previous version,
// a rollback mode, and no silently swallowed failure in the install path (F2).
const setupSource = readFileSync(new URL('../installer/Setup.cs', import.meta.url), 'utf8');
const buildScript = readFileSync(
  new URL('../installer/build-installer.ps1', import.meta.url),
  'utf8',
);
const packager = readFileSync(new URL('./package-installer.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('installer source contract (F2 and L1)', () => {
  it('declares the product version the packaged app reports', () => {
    const declarations =
      setupSource.match(/public const string ProductVersion = "([^"]+)";/gu) ?? [];
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toContain(`"${packageJson.version}"`);
  });

  it('has no empty catch block, so no failure in the install path is swallowed', () => {
    expect(setupSource).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/u);
  });

  it('verifies the extracted payload against the embedded manifest before replacing anything', () => {
    expect(setupSource).toContain('"payload-manifest.txt"');
    expect(setupSource).toContain('VerifyStaging(stagingPath, manifest)');
    expect(setupSource.indexOf('VerifyStaging(stagingPath, manifest)')).toBeLessThan(
      setupSource.indexOf('SwapIn(installPath, stagingPath, !repairing)'),
    );
    expect(setupSource).toContain('SHA256.Create()');
  });

  it('keeps the version it replaces, and offers a rollback mode', () => {
    expect(setupSource).toContain('.previous');
    expect(setupSource).toContain('"/rollback"');
    expect(setupSource).toContain('"/restore-data"');
    expect(setupSource).toContain('"PreviousVersion"');
    expect(setupSource).toContain('RollbackSync(restoreData)');
  });

  it('refuses to replace an install whose files are held, and says the installed version was kept', () => {
    expect(setupSource).toContain('The installed version was not changed.');
  });

  it('makes shortcut failures fatal instead of warnings', () => {
    expect(setupSource).not.toMatch(/Warnings/u);
    expect(setupSource).toContain('CreateShortcuts(installPath);');
  });

  it('embeds the payload manifest in the setup build, and refuses to build without it', () => {
    expect(buildScript).toContain('"/resource:$manifestPath,payload-manifest.txt"');
    expect(buildScript).toContain('payload-manifest.txt not found');
  });

  it('writes the manifest beside the release archive, and the archive is unchanged', () => {
    expect(packager).toContain('buildPayloadManifest(standaloneDir)');
    expect(packager).toContain('PAYLOAD_MANIFEST_NAME');
    expect(packager).toContain("'-C', desktopDistDir, 'joy-media-win32-x64'");
  });

  it('removes the kept previous folder and leftover staging folders at uninstall', () => {
    expect(packager).toContain("'.previous'");
    expect(packager).toContain("'.staging-*'");
    expect(packager).toContain("'.rollback-tmp'");
  });
});
