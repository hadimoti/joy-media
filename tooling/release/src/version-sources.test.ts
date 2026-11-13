import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const expectedVersion = '1.1.1';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function captureVersion(source: string, marker: RegExp): string {
  const match = source.match(marker);
  expect(match, `Expected version marker ${marker} to remain present`).not.toBeNull();
  return match![1];
}

describe('product version sources', () => {
  it('keeps every product version source, site, and installer scripts aligned', () => {
    const desktopPackage = JSON.parse(readRepositoryFile('apps/desktop/package.json')) as {
      version: string;
    };
    const cliPackageSource = readRepositoryFile('apps/cli/package.json');
    const cliPackageVersion = captureVersion(cliPackageSource, /"version": "([^"]+)"/);

    const sitePackageSource = readRepositoryFile('apps/site/package.json');
    const sitePackageVersion = captureVersion(sitePackageSource, /"version": "([^"]+)"/);

    const cliVersionSource = readRepositoryFile('apps/cli/src/version.ts');
    const cliVersion = captureVersion(cliVersionSource, /export const CLI_VERSION = '([^']+)';/);
    const cliSource = readRepositoryFile('apps/cli/src/cli.ts');
    expect(cliSource).toMatch(/console\.log\(`JOY Media CLI v\$\{CLI_VERSION\}`\);/);
    const loggerSource = readRepositoryFile('apps/cli/src/utils/logger.ts');
    expect(loggerSource).toMatch(/\$\{c\(`v\$\{CLI_VERSION\}`, 'dim'\)\}/);

    const setupSource = readRepositoryFile('apps/desktop/installer/Setup.cs');
    // The installer registers and displays one constant, so the test reads that constant.
    expect(setupSource).toMatch(
      /key\.SetValue\("DisplayVersion", InstallerEngine\.ProductVersion, RegistryValueKind\.String\);/,
    );
    expect(setupSource).toMatch(/Text = "JOY Media v" \+ InstallerEngine\.ProductVersion,/);
    const setupDisplayVersion = captureVersion(
      setupSource,
      /public const string ProductVersion = "([^"]+)";/,
    );
    const setupWindowVersion = setupDisplayVersion;

    const packagerSource = readRepositoryFile('apps/desktop/scripts/package-installer.mjs');
    expect(packagerSource).toMatch(/desktopPackage\s*=\s*JSON\.parse/);
    expect(packagerSource).toMatch(/const version\s*=\s*desktopPackage\.version/);
    expect(packagerSource).toContain(
      'Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value "${version}" -Force',
    );
    expect(packagerSource).toContain(
      'const releaseZipName = `joy-media-windows-x64-v${version}.zip`;',
    );

    const installerBuildSource = readRepositoryFile('apps/desktop/installer/build-installer.ps1');
    // The zip name uses the -Version parameter, whose default is the release version.
    expect(installerBuildSource).toMatch(
      /Join-Path \$distReleases "joy-media-windows-x64-v\$Version\.zip"/,
    );
    const installerZipName = captureVersion(
      installerBuildSource,
      /\[string\]\$Version = "([^"]+)"/,
    );

    const ipcSource = readRepositoryFile('apps/desktop/src/main/ipc-handlers.ts');
    expect(ipcSource).toContain(
      "return { ok: false, error: 'This provider is no longer offered in v1.1.1' };",
    );

    const brokerSource = readRepositoryFile('apps/desktop/src/main/providers/provider-broker.ts');
    expect(brokerSource).toContain(
      "'This profile is a v1.0.x provider that v1.1.1 no longer offers'",
    );

    const versions = [
      desktopPackage.version,
      cliPackageVersion,
      sitePackageVersion,
      cliVersion,
      cliVersion,
      setupDisplayVersion,
      setupWindowVersion,
      installerZipName,
    ];

    expect(versions).toEqual(Array(8).fill(expectedVersion));
    expect(`joy-media-windows-x64-v${desktopPackage.version}.zip`).toBe(
      `joy-media-windows-x64-v${installerZipName}.zip`,
    );
    expect(versions).not.toContain('1.1.0');
    expect(versions).not.toContain('1.0.0');
    expect(versions).not.toContain('0.0.0');
    expect(`JOY Media CLI v${cliVersion}`).toBe('JOY Media CLI v1.1.1');
    expect(`v${cliVersion}`).toBe('v1.1.1');
  });
});
