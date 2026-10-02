import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

console.log('=== JOY Media Installer & Package Verification Suite ===');

const desktopDistDir = resolve('apps/desktop/dist');
const standaloneDir = resolve(desktopDistDir, 'joy-media-win32-x64');
const releasesDir = resolve(desktopDistDir, 'releases');

// 1. Verify Distribution Layout
console.log('1. Verifying distribution files in joy-media-win32-x64...');
const requiredFiles = [
  'joy-media.exe',
  'joy.cmd',
  'joy-media.cmd',
  'Setup-JoyMedia.ps1',
  'install.cmd',
  'uninstall.cmd',
  'resources/app/worker/joy-worker.exe',
  'resources/app/cli/joy-media-bundle.mjs',
  'resources/app/renderer/index.html',
  'resources/app/dist/main/electron-entry.js',
];

for (const relPath of requiredFiles) {
  const fullPath = resolve(standaloneDir, relPath);
  assert.ok(existsSync(fullPath), `Required distribution file missing: ${relPath}`);
}
console.log('✔ All required distribution files present.');

// 2. Test Packaged CLI Execution via joy.cmd
console.log('2. Testing packaged CLI execution (joy.cmd doctor)...');
const joyCmdPath = resolve(standaloneDir, 'joy.cmd');
const doctorResult = spawnSync(joyCmdPath, ['doctor'], {
  shell: true,
  encoding: 'utf8',
  timeout: 15000,
});
assert.strictEqual(doctorResult.status, 0, `joy.cmd doctor failed: ${doctorResult.stderr}`);
assert.ok(doctorResult.stdout.includes('JOY MEDIA CLI'), 'Doctor output missing banner');
assert.ok(
  doctorResult.stdout.includes('All core system diagnostics passed'),
  'Doctor diagnostics failed',
);
console.log('✔ Packaged CLI doctor passed cleanly.');

console.log('3. Testing packaged CLI project list...');
const projectResult = spawnSync(joyCmdPath, ['project', 'list'], {
  shell: true,
  encoding: 'utf8',
  timeout: 15000,
});
assert.strictEqual(projectResult.status, 0, `joy.cmd project list failed: ${projectResult.stderr}`);
assert.ok(projectResult.stdout.includes('Local Projects'), 'Project list output unexpected');
console.log('✔ Packaged CLI project list passed cleanly.');

// 4. Test Standalone Uninstall Sandbox Isolation
console.log('4. Testing standalone uninstall.cmd cleanup in an isolated sandbox...');
const uninstallSource = readFileSync(resolve(standaloneDir, 'uninstall.cmd'), 'utf8');
const uninstallLines = uninstallSource.split(/\r?\n/);
const cleanupBanner = 'echo Cleaning application files...';
const cleanupBannerIndexes = uninstallLines.flatMap((line, index) =>
  line.trim() === cleanupBanner ? [index] : [],
);
assert.strictEqual(cleanupBannerIndexes.length, 1, 'Uninstaller cleanup boundary must occur once');
const cleanupBannerIndex = cleanupBannerIndexes[0];
const integrationStartIndex = uninstallLines.findIndex((line) => line.startsWith('del "%APPDATA%'));
assert.ok(
  integrationStartIndex > 0 && integrationStartIndex < cleanupBannerIndex,
  'Uninstaller host-integration block was not found before file cleanup',
);
const safetyPreflightIndex = uninstallLines.findIndex(
  (line) =>
    line.startsWith('powershell.exe') &&
    line.includes('GetPathRoot') &&
    line.includes('joy-media.exe'),
);
assert.ok(
  safetyPreflightIndex > 0 && safetyPreflightIndex < integrationStartIndex,
  'Install-directory safety preflight must run before host integrations',
);
const pathCleanupCommand = uninstallLines.find((line) =>
  line.includes("[Environment]::GetEnvironmentVariable('Path', 'User')"),
);
assert.ok(pathCleanupCommand, 'User PATH cleanup command was not found');
assert.ok(
  pathCleanupCommand.includes('$target = $env:JOY_MEDIA_INSTALL_DIR.TrimEnd') &&
    pathCleanupCommand.includes('-ine $target') &&
    !pathCleanupCommand.includes('%INSTALL_DIR%'),
  'User PATH cleanup must compare the normalized runtime install path without a literal batch variable',
);
const hostIntegrationBlock = uninstallLines
  .slice(integrationStartIndex, cleanupBannerIndex)
  .join('\n');
assert.match(
  hostIntegrationBlock,
  /del "%APPDATA%/i,
  'Start Menu shortcut operation was not found',
);
assert.match(
  hostIntegrationBlock,
  /del "%USERPROFILE%/i,
  'Desktop shortcut operation was not found',
);
assert.match(hostIntegrationBlock, /reg\s+delete/i, 'Registry operation was not found');
assert.match(hostIntegrationBlock, /powershell\.exe/i, 'User PATH operation was not found');

// The test copy preserves the generated file-cleanup logic while removing all
// commands that could modify the host profile, registry, shortcuts, or PATH.
const sandboxUninstaller = [
  ...uninstallLines.slice(0, integrationStartIndex),
  'rem Host integration is intentionally disabled by this isolated test.',
  ...uninstallLines.slice(cleanupBannerIndex),
].join('\r\n');
assert.doesNotMatch(sandboxUninstaller, /\breg(?:\.exe)?\s+(?:delete|add)\b/i);
assert.doesNotMatch(sandboxUninstaller, /Environment\]::(?:Get|Set)EnvironmentVariable/i);
assert.doesNotMatch(sandboxUninstaller, /%APPDATA%|%USERPROFILE%/i);

const uninstallSandboxRoot = mkdtempSync(join(tmpdir(), 'joy-uninstall-sandbox-'));
try {
  const sandboxLocalAppData = join(uninstallSandboxRoot, 'LocalAppData');
  const sandboxAppData = join(uninstallSandboxRoot, 'AppData');
  const sandboxUserProfile = join(uninstallSandboxRoot, 'UserProfile');
  const sandboxInstallDir = join(sandboxLocalAppData, 'Programs', 'JOY Media');
  mkdirSync(sandboxInstallDir, { recursive: true });
  mkdirSync(sandboxAppData, { recursive: true });
  mkdirSync(sandboxUserProfile, { recursive: true });
  writeFileSync(join(sandboxInstallDir, 'uninstall.cmd'), sandboxUninstaller, 'utf8');
  writeFileSync(join(sandboxInstallDir, 'marker.txt'), 'sandbox-only');
  writeFileSync(join(sandboxInstallDir, 'joy-media.exe'), 'sandbox-only');

  const originalPath = process.env.PATH;
  const uninstallResult = spawnSync('cmd.exe', ['/d', '/c', 'uninstall.cmd'], {
    cwd: sandboxInstallDir,
    env: {
      ...process.env,
      LOCALAPPDATA: sandboxLocalAppData,
      APPDATA: sandboxAppData,
      USERPROFILE: sandboxUserProfile,
      TEMP: tmpdir(),
      TMP: tmpdir(),
    },
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  assert.strictEqual(
    uninstallResult.status,
    0,
    `uninstall.cmd failed: ${uninstallResult.stderr || uninstallResult.stdout}`,
  );

  let removed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!existsSync(sandboxInstallDir)) {
      removed = true;
      break;
    }
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 250'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  }
  assert.ok(removed, 'Temporary install directory was not removed by uninstall.cmd');
  assert.strictEqual(process.env.PATH, originalPath, 'The test changed the parent process PATH');
  console.log('✔ Standalone uninstall.cmd isolated cleanup passed.');
} finally {
  rmSync(uninstallSandboxRoot, { recursive: true, force: true });
}

// 5. Test Setup-JoyMedia.ps1 copy logic with an isolated source fixture
console.log('5. Testing Setup-JoyMedia.ps1 file copying with an isolated fixture...');
const setupSandboxRoot = mkdtempSync(join(tmpdir(), 'joy-install-sandbox-'));
try {
  const fixtureSourceDir = join(setupSandboxRoot, 'source');
  const fixtureInstallDir = join(setupSandboxRoot, 'install');
  const setupSource = readFileSync(resolve(standaloneDir, 'Setup-JoyMedia.ps1'), 'utf8');
  const integrationStart = setupSource.indexOf('# Create Shortcuts');
  const integrationEnd = setupSource.indexOf(
    'Write-Host "JOY Media successfully installed!"',
    integrationStart,
  );
  assert.ok(
    integrationStart >= 0 && integrationEnd > integrationStart,
    'Setup integration block boundaries are invalid',
  );
  const setupIntegrationBlock = setupSource.slice(integrationStart, integrationEnd);
  assert.match(
    setupIntegrationBlock,
    /New-Object -ComObject/i,
    'Shortcut integration block was not found',
  );
  assert.match(
    setupIntegrationBlock,
    /SetEnvironmentVariable/i,
    'User PATH integration was not found',
  );
  assert.match(
    setupIntegrationBlock,
    /Set-ItemProperty/i,
    'Registry integration block was not found',
  );
  const isolatedSetup =
    setupSource.slice(0, integrationStart) +
    '# Host shortcut, User PATH, and registry integration is excluded by this test.\r\n' +
    setupSource.slice(integrationEnd);
  assert.doesNotMatch(
    isolatedSetup,
    /WScript\.Shell|SetEnvironmentVariable|GetEnvironmentVariable\("Path"|Set-ItemProperty/i,
  );

  mkdirSync(fixtureSourceDir, { recursive: true });
  const fixtureFiles = [
    'joy-media.exe',
    'joy.cmd',
    'resources/app/cli/joy-media-bundle.mjs',
    'resources/app/worker/joy-worker.exe',
  ];
  for (const relativePath of fixtureFiles) {
    const fixturePath = join(fixtureSourceDir, relativePath);
    mkdirSync(resolve(fixturePath, '..'), { recursive: true });
    writeFileSync(fixturePath, `fixture: ${relativePath}`);
  }
  writeFileSync(join(fixtureSourceDir, 'Setup-JoyMedia.ps1'), isolatedSetup, 'utf8');
  writeFileSync(join(fixtureSourceDir, 'install.cmd'), '@echo off\r\n');
  writeFileSync(join(fixtureSourceDir, 'uninstall.cmd'), '@echo off\r\n');

  const installResult = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(fixtureSourceDir, 'Setup-JoyMedia.ps1'),
      '-InstallPath',
      fixtureInstallDir,
      '-Silent',
    ],
    {
      env: {
        ...process.env,
        LOCALAPPDATA: join(setupSandboxRoot, 'LocalAppData'),
        APPDATA: join(setupSandboxRoot, 'AppData'),
        USERPROFILE: join(setupSandboxRoot, 'UserProfile'),
      },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    },
  );
  assert.strictEqual(
    installResult.status,
    0,
    `Isolated Setup-JoyMedia.ps1 failed: ${installResult.stderr || installResult.stdout}`,
  );
  for (const relativePath of fixtureFiles) {
    assert.ok(
      existsSync(join(fixtureInstallDir, relativePath)),
      `Fixture file was not copied: ${relativePath}`,
    );
  }
  assert.ok(
    !existsSync(join(fixtureInstallDir, 'Setup-JoyMedia.ps1')),
    'Setup script should be excluded from install',
  );
  assert.ok(
    !existsSync(join(fixtureInstallDir, 'install.cmd')),
    'install.cmd should be excluded from install',
  );
  assert.ok(
    !existsSync(join(fixtureInstallDir, 'uninstall.cmd')),
    'uninstall.cmd should be excluded from install',
  );
  console.log('✔ Isolated Setup-JoyMedia.ps1 file copying passed.');
} finally {
  rmSync(setupSandboxRoot, { recursive: true, force: true });
}

// 6. Verify Release Artifacts & Manifest Parity
console.log('6. Verifying release manifest & SHA256 checksums...');
const manifestPath = resolve(releasesDir, 'joy-media-release-manifest.json');
const shaSumsPath = resolve(releasesDir, 'SHA256SUMS.txt');

assert.ok(existsSync(manifestPath), 'Release manifest missing');
assert.ok(existsSync(shaSumsPath), 'SHA256SUMS.txt missing');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.strictEqual(manifest.name, 'joy-media');
assert.strictEqual(manifest.platform, 'windows-x64');
assert.strictEqual(manifest.installer.environment.pathRegistered, true);

const shaSums = readFileSync(shaSumsPath, 'utf8');
for (const artifact of manifest.artifacts) {
  if (artifact.sha256) {
    assert.ok(
      shaSums.includes(artifact.sha256),
      `Artifact ${artifact.fileName} SHA256 ${artifact.sha256} not in SHA256SUMS.txt`,
    );
  }
}
console.log('✔ Release manifest & SHA256 checksums match perfectly.');

// 7. Verify build-installer.ps1 parsing
console.log('7. Verifying build-installer.ps1 parses successfully...');
const buildInstallerPath = resolve('apps/desktop/installer/build-installer.ps1');
const psParseCommand = `
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile('${buildInstallerPath.replace(/'/g, "''")}', [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) {
    Write-Error ($errors | Out-String)
    exit 1
  }
`;
const parseResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', psParseCommand],
  {
    encoding: 'utf8',
    timeout: 15000,
  },
);
assert.strictEqual(
  parseResult.status,
  0,
  `build-installer.ps1 syntax parsing failed:\n${parseResult.stderr || parseResult.stdout}`,
);
console.log('✔ build-installer.ps1 syntax parse check passed.');

console.log('\n=== All Installer & Packaging Checks PASSED! ===');
