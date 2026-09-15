import { cp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const workerBinDir = resolve(repoRoot, 'apps', 'worker', 'bin');
const desktopDistDir = resolve(desktopRoot, 'dist');
const unpackedDir = resolve(desktopDistDir, 'joy-media-unpacked');
const standaloneDir = resolve(desktopDistDir, 'joy-media-win32-x64');
const releasesDir = resolve(desktopDistDir, 'releases');

// Find electron prebuilt binaries
const electronDistDir = resolve(desktopRoot, 'node_modules', 'electron', 'dist');
if (!existsSync(electronDistDir)) {
  throw new Error(`Electron prebuilt distribution not found at ${electronDistDir}`);
}

async function computeSha256(filePath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => res(hash.digest('hex')));
    stream.on('error', rej);
  });
}

console.log('=== Building JOY Media Windows Installer & Portable Package ===');

// 1. Stage renderer & assemble unpacked via package-release.mjs --unpacked
console.log('1. Staging unpacked application bundle...');
const unpackResult = spawnSync(
  process.execPath,
  [resolve(desktopRoot, 'scripts', 'package-release.mjs'), '--unpacked'],
  { cwd: desktopRoot, stdio: 'inherit', env: process.env },
);
if (unpackResult.status !== 0) {
  throw new Error(`package-release.mjs --unpacked failed with status ${unpackResult.status}`);
}

// 2. Assemble standalone Electron distribution directory
console.log('2. Assembling standalone distribution in ' + standaloneDir + '...');
await rm(standaloneDir, { recursive: true, force: true });
await mkdir(standaloneDir, { recursive: true });

// Copy electron runtime files
await cp(electronDistDir, standaloneDir, { recursive: true });

// Rename electron.exe -> joy-media.exe
const origExe = resolve(standaloneDir, 'electron.exe');
const targetExe = resolve(standaloneDir, 'joy-media.exe');
if (existsSync(origExe)) {
  const { rename } = await import('node:fs/promises');
  await rename(origExe, targetExe);
}

// Remove default_app.asar to ensure Electron loads resources/app
const defaultAppAsar = resolve(standaloneDir, 'resources', 'default_app.asar');
if (existsSync(defaultAppAsar)) {
  await rm(defaultAppAsar, { force: true });
}

// Copy unpacked app into resources/app
const appResourcesDir = resolve(standaloneDir, 'resources', 'app');
await mkdir(appResourcesDir, { recursive: true });
await cp(unpackedDir, appResourcesDir, { recursive: true });

// Copy standalone worker executable if present
const workerExe = resolve(workerBinDir, 'joy-worker.exe');
if (existsSync(workerExe)) {
  const destWorkerExe = resolve(appResourcesDir, 'worker', 'joy-worker.exe');
  await cp(workerExe, destWorkerExe);
  console.log('Embedded standalone joy-worker.exe into resources/app/worker/');
}

// 3. Generate Windows installer setup script and uninstaller
console.log('3. Generating Windows installer setup script...');
const setupPs1 = `# JOY Media Windows Installer Setup Script
param (
    [switch]$Silent = $false,
    [string]$InstallPath = "$env:LOCALAPPDATA\\Programs\\JOY Media"
)

$ErrorActionPreference = 'Stop'

Write-Host "Installing JOY Media to: $InstallPath" -ForegroundColor Cyan

if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}

$sourceDir = $PSScriptRoot

# Copy files excluding setup scripts
Get-ChildItem -Path $sourceDir -Exclude "Setup-JoyMedia.ps1", "install.cmd", "uninstall.cmd" | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $InstallPath -Recurse -Force
}

$exePath = Join-Path $InstallPath "joy-media.exe"

# Create Shortcuts
$wsh = New-Object -ComObject WScript.Shell

# Desktop Shortcut
$desktopPath = [Environment]::GetFolderPath('Desktop')
$desktopShortcut = Join-Path $desktopPath "JOY Media.lnk"
$shortcut = $wsh.CreateShortcut($desktopShortcut)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $InstallPath
$shortcut.Description = "JOY Media Desktop Application"
$shortcut.Save()

# Start Menu Shortcut
$startMenuDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs"
$startMenuShortcut = Join-Path $startMenuDir "JOY Media.lnk"
$smShortcut = $wsh.CreateShortcut($startMenuShortcut)
$smShortcut.TargetPath = $exePath
$smShortcut.WorkingDirectory = $InstallPath
$smShortcut.Description = "JOY Media Desktop Application"
$smShortcut.Save()

# Register Uninstaller in Windows Registry
$uninstallKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\JoyMedia"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "JOY Media" -Force
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value "1.0.0" -Force
Set-ItemProperty -Path $uninstallKey -Name "Publisher" -Value "JOY Team" -Force
Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon" -Value $exePath -Force
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $InstallPath -Force
$uninstallerCmd = Join-Path $InstallPath "uninstall.cmd"
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value ('"' + $uninstallerCmd + '"') -Force

Write-Host "JOY Media successfully installed!" -ForegroundColor Green
if (-not $Silent) {
    Write-Host "You can now launch JOY Media from your Desktop or Start Menu."
}
`;

const installCmd = `@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-JoyMedia.ps1" %*
`;

const uninstallCmd = `@echo off
echo Uninstalling JOY Media...
set "INSTALL_DIR=%LOCALAPPDATA%\\Programs\\JOY Media"
del "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\JOY Media.lnk" 2>nul
del "%USERPROFILE%\\Desktop\\JOY Media.lnk" 2>nul
reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\JoyMedia" /f 2>nul
echo Cleaning application files...
rmdir /s /q "%INSTALL_DIR%" 2>nul
echo JOY Media has been uninstalled.
`;

await writeFile(resolve(standaloneDir, 'Setup-JoyMedia.ps1'), setupPs1, 'utf8');
await writeFile(resolve(standaloneDir, 'install.cmd'), installCmd, 'utf8');
await writeFile(resolve(standaloneDir, 'uninstall.cmd'), uninstallCmd, 'utf8');

// 4. Create Distributable Releases Directory and Package
console.log('4. Creating distributable zip release...');
await mkdir(releasesDir, { recursive: true });

const version = '1.0.0';
const releaseZipName = `joy-media-windows-x64-v${version}.zip`;
const releaseZipPath = resolve(releasesDir, releaseZipName);

await rm(releaseZipPath, { force: true });

// Use tar or powershell to create zip
const zipResult = spawnSync(
  'tar.exe',
  ['-a', '-c', '-f', releaseZipPath, '-C', desktopDistDir, 'joy-media-win32-x64'],
  {
    stdio: 'inherit',
  },
);

if (zipResult.status !== 0 || !existsSync(releaseZipPath)) {
  console.log('tar.exe exited with error, falling back to PowerShell Compress-Archive...');
  const psZipResult = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${standaloneDir}\\*' -DestinationPath '${releaseZipPath}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  if (psZipResult.status !== 0) {
    throw new Error(`Failed to create release zip archive: status ${psZipResult.status}`);
  }
}

const zipStat = await stat(releaseZipPath);
const zipSha256 = await computeSha256(releaseZipPath);
const exeSha256 = await computeSha256(targetExe);

console.log(
  `Created release archive: ${releaseZipName} (${(zipStat.size / (1024 * 1024)).toFixed(2)} MB)`,
);
console.log(`SHA256: ${zipSha256}`);

// 5. Generate SHA256SUMS.txt and release manifest
const sha256SumsContent = `${zipSha256}  ${releaseZipName}\n${exeSha256}  joy-media.exe\n`;
await writeFile(resolve(releasesDir, 'SHA256SUMS.txt'), sha256SumsContent, 'utf8');

const releaseManifest = {
  name: 'joy-media',
  version,
  platform: 'windows-x64',
  releaseChannel: 'private-release',
  builtAt: new Date().toISOString(),
  targetCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim(),
  artifacts: [
    {
      fileName: releaseZipName,
      type: 'portable-archive',
      byteSize: zipStat.size,
      sha256: zipSha256,
    },
    {
      fileName: 'joy-media.exe',
      type: 'standalone-binary',
      sha256: exeSha256,
    },
  ],
  installer: {
    script: 'Setup-JoyMedia.ps1',
    wrapper: 'install.cmd',
    installDirectory: '%LOCALAPPDATA%\\Programs\\JOY Media',
    shortcuts: ['Desktop', 'StartMenu'],
  },
};

await writeFile(
  resolve(releasesDir, 'joy-media-release-manifest.json'),
  JSON.stringify(releaseManifest, null, 2) + '\n',
  'utf8',
);

console.log('=== Installer & Portable Packaging Complete ===');
console.log(`Artifacts available at: ${releasesDir}`);
