import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const expectedVersion = '1.1.0';

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function captureVersion(source: string, marker: RegExp): string {
  const match = source.match(marker);
  expect(match, `Expected version marker ${marker} to remain present`).not.toBeNull();
  return match![1];
}

describe('product version sources', () => {
  it('keeps every product version source and installer zip name aligned', () => {
    const desktopPackage = JSON.parse(readRepositoryFile('apps/desktop/package.json')) as {
      version: string;
    };
    const cliPackageSource = readRepositoryFile('apps/cli/package.json');
    const cliPackageVersion = captureVersion(cliPackageSource, /"version": "([^"]+)"/);

    const cliVersionSource = readRepositoryFile('apps/cli/src/version.ts');
    const cliVersion = captureVersion(cliVersionSource, /export const CLI_VERSION = '([^']+)';/);
    const cliSource = readRepositoryFile('apps/cli/src/cli.ts');
    expect(cliSource).toMatch(/console\.log\(`JOY Media CLI v\$\{CLI_VERSION\}`\);/);
    const loggerSource = readRepositoryFile('apps/cli/src/utils/logger.ts');
    expect(loggerSource).toMatch(/\$\{c\(`v\$\{CLI_VERSION\}`, 'dim'\)\}/);

    const setupSource = readRepositoryFile('apps/desktop/installer/Setup.cs');
    const setupDisplayVersion = captureVersion(
      setupSource,
      /key\.SetValue\("DisplayVersion", "([^"]+)", RegistryValueKind\.String\);/,
    );
    const setupWindowVersion = captureVersion(setupSource, /Text = "JOY Media v([^"]+)"/);

    const packagerSource = readRepositoryFile('apps/desktop/scripts/package-installer.mjs');
    const uninstallerDisplayVersion = captureVersion(
      packagerSource,
      /Set-ItemProperty -Path \$uninstallKey -Name "DisplayVersion" -Value "([^"]+)" -Force/,
    );
    const packagerVersion = captureVersion(packagerSource, /const version = '([^']+)';/);
    expect(packagerSource).toContain(
      'const releaseZipName = `joy-media-windows-x64-v${version}.zip`;',
    );

    const installerBuildSource = readRepositoryFile('apps/desktop/installer/build-installer.ps1');
    const installerZipName = captureVersion(
      installerBuildSource,
      /Join-Path \$distReleases "joy-media-windows-x64-v([^"]+)\.zip"/,
    );

    const versions = [
      desktopPackage.version,
      cliPackageVersion,
      cliVersion,
      cliVersion,
      setupDisplayVersion,
      setupWindowVersion,
      uninstallerDisplayVersion,
      packagerVersion,
      installerZipName,
    ];

    expect(versions).toEqual(Array(9).fill(expectedVersion));
    expect(`joy-media-windows-x64-v${packagerVersion}.zip`).toBe(
      `joy-media-windows-x64-v${installerZipName}.zip`,
    );
    expect(versions).not.toContain('1.0.0');
    expect(versions).not.toContain('0.0.0');
    expect(`JOY Media CLI v${cliVersion}`).toBe('JOY Media CLI v1.1.0');
    expect(`v${cliVersion}`).toBe('v1.1.0');
  });
});
