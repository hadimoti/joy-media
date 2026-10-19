import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Could not read required Electron installation metadata at ${path}`);
  }
}

function isInstalled(electronRoot, version) {
  const dist = join(electronRoot, 'dist');
  try {
    return (
      readFileSync(join(dist, 'version'), 'utf8').trim().replace(/^v/u, '') === version &&
      readFileSync(join(electronRoot, 'path.txt'), 'utf8') === 'electron.exe' &&
      existsSync(join(dist, 'electron.exe'))
    );
  } catch {
    return false;
  }
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function expandElectronArchiveWithPowerShell(
  archivePath,
  destinationPath,
  { spawnSyncImpl = spawnSync, powershellPath = 'powershell.exe' } = {},
) {
  const command =
    `$ErrorActionPreference = 'Stop'; ` +
    `Expand-Archive -LiteralPath ${quotePowerShell(resolve(archivePath))} ` +
    `-DestinationPath ${quotePowerShell(resolve(destinationPath))} -Force`;
  const result = spawnSyncImpl(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', shell: false, windowsHide: true, stdio: 'inherit' },
  );
  if (result.error)
    throw new Error(`PowerShell could not expand the Electron runtime: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`PowerShell failed to expand the Electron runtime (exit ${result.status}).`);
  }
}

export async function prepareElectronRuntime({
  electronRoot,
  platform = process.platform,
  arch = process.arch,
  downloadArtifact,
  extractArchive = expandElectronArchiveWithPowerShell,
}) {
  if (platform !== 'win32' || arch !== 'x64') {
    throw new Error(`Windows Electron installation requires win32 x64, got ${platform} ${arch}.`);
  }
  if (typeof downloadArtifact !== 'function') {
    throw new Error('Electron artifact downloader was not provided.');
  }

  const root = resolve(electronRoot);
  const electronPackage = readJson(join(root, 'package.json'));
  const version = electronPackage.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('Electron package version is invalid.');
  }
  if (isInstalled(root, version)) return { status: 'already-installed', version };

  const distPath = join(root, 'dist');
  if (existsSync(distPath)) {
    throw new Error(`Electron runtime directory exists but is incomplete: ${distPath}`);
  }

  const archiveName = `electron-v${version}-win32-x64.zip`;
  const checksums = readJson(join(root, 'checksums.json'));
  if (!/^[0-9a-f]{64}$/u.test(checksums[archiveName] ?? '')) {
    throw new Error(`Electron checksum is missing for ${archiveName}`);
  }

  const archivePath = await downloadArtifact({
    version,
    artifactName: 'electron',
    checksums,
    platform: 'win32',
    arch: 'x64',
  });
  if (typeof archivePath !== 'string' || !existsSync(archivePath)) {
    throw new Error('Electron artifact downloader returned a missing archive.');
  }

  mkdirSync(distPath, { recursive: true });
  await extractArchive(archivePath, distPath);
  const observedVersion = readFileSync(join(distPath, 'version'), 'utf8').trim().replace(/^v/u, '');
  if (observedVersion !== version || !existsSync(join(distPath, 'electron.exe'))) {
    throw new Error(
      `Downloaded Electron archive did not contain the expected v${version} runtime.`,
    );
  }
  writeFileSync(join(root, 'path.txt'), 'electron.exe', 'utf8');
  return { status: 'installed', version };
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('This installer helper is only for the Windows x64 release runner.');
  }
  const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const electronRoot = realpathSync(join(desktopRoot, 'node_modules', 'electron'));
  const electronRequire = createRequire(join(electronRoot, 'package.json'));
  const electronGetPath = electronRequire.resolve('@electron/get');
  const { downloadArtifact } = await import(pathToFileURL(electronGetPath).href);
  const result = await prepareElectronRuntime({ electronRoot, downloadArtifact });
  process.stdout.write(`Electron runtime v${result.version} ${result.status}.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `install-electron-windows failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
