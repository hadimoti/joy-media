import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareElectronRuntime } from './install-electron-windows.mjs';

describe('prepareElectronRuntime', () => {
  let temporaryRoot;

  afterEach(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function createElectronPackage() {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'joy-electron-runtime-'));
    const electronRoot = join(temporaryRoot, 'electron');
    mkdirSync(electronRoot, { recursive: true });
    writeFileSync(join(electronRoot, 'package.json'), JSON.stringify({ version: '44.3.0' }));
    const archiveName = 'electron-v44.3.0-win32-x64.zip';
    writeFileSync(
      join(electronRoot, 'checksums.json'),
      JSON.stringify({ [archiveName]: 'a'.repeat(64) }),
    );
    return { electronRoot, archiveName };
  }

  it('downloads the locked Windows artifact and extracts it with the verified checksum', async () => {
    const { electronRoot, archiveName } = createElectronPackage();
    const archivePath = join(temporaryRoot, archiveName);
    writeFileSync(archivePath, 'checksum-validated fixture');
    const downloadArtifact = vi.fn(async () => archivePath);
    const extractArchive = vi.fn(async (_archive, destination) => {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'electron.exe'), 'electron-fixture');
      writeFileSync(join(destination, 'version'), '44.3.0');
    });

    const result = await prepareElectronRuntime({
      electronRoot,
      platform: 'win32',
      arch: 'x64',
      downloadArtifact,
      extractArchive,
    });

    expect(downloadArtifact).toHaveBeenCalledWith({
      version: '44.3.0',
      artifactName: 'electron',
      checksums: { [archiveName]: 'a'.repeat(64) },
      platform: 'win32',
      arch: 'x64',
    });
    expect(extractArchive).toHaveBeenCalledWith(archivePath, join(electronRoot, 'dist'));
    expect(result).toMatchObject({ status: 'installed', version: '44.3.0' });
    expect(readFileSync(join(electronRoot, 'path.txt'), 'utf8')).toBe('electron.exe');
  });

  it('reuses a valid runtime without downloading again', async () => {
    const { electronRoot } = createElectronPackage();
    const dist = join(electronRoot, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'electron.exe'), 'electron-fixture');
    writeFileSync(join(dist, 'version'), '44.3.0');
    writeFileSync(join(electronRoot, 'path.txt'), 'electron.exe');
    const downloadArtifact = vi.fn();
    const extractArchive = vi.fn();

    const result = await prepareElectronRuntime({
      electronRoot,
      platform: 'win32',
      arch: 'x64',
      downloadArtifact,
      extractArchive,
    });

    expect(result).toMatchObject({ status: 'already-installed', version: '44.3.0' });
    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it('rejects a missing checksum before downloading or extracting', async () => {
    const { electronRoot, archiveName } = createElectronPackage();
    writeFileSync(join(electronRoot, 'checksums.json'), JSON.stringify({}));
    const downloadArtifact = vi.fn();
    const extractArchive = vi.fn();

    await expect(
      prepareElectronRuntime({
        electronRoot,
        platform: 'win32',
        arch: 'x64',
        downloadArtifact,
        extractArchive,
      }),
    ).rejects.toThrow(`Electron checksum is missing for ${archiveName}`);
    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it('uses PowerShell Expand-Archive without shell interpolation', async () => {
    const { electronRoot } = createElectronPackage();
    const calls = [];
    const spawnSync = vi.fn((executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, error: undefined };
    });
    const { expandElectronArchiveWithPowerShell } = await import('./install-electron-windows.mjs');

    await expandElectronArchiveWithPowerShell("C:\\runner\\agent's\\electron.zip", electronRoot, {
      spawnSyncImpl: spawnSync,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('-Command');
    expect(calls[0].args.join(' ')).toContain("agent''s");
    expect(calls[0].args.join(' ')).toContain('Expand-Archive -LiteralPath');
    expect(calls[0].options.shell).toBe(false);
  });
});
