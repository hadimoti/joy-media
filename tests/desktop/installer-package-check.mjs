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
const desktopManifest = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8'));
const cliManifest = JSON.parse(readFileSync(resolve('apps/cli/package.json'), 'utf8'));
const releaseManifest = JSON.parse(
  readFileSync(resolve(releasesDir, 'joy-media-release-manifest.json'), 'utf8'),
);
const setupSource = readFileSync(resolve('apps/desktop/installer/Setup.cs'), 'utf8');

assert.strictEqual(
  desktopManifest.version,
  cliManifest.version,
  'Desktop and CLI versions differ.',
);
assert.strictEqual(
  releaseManifest.version,
  desktopManifest.version,
  'Packaged release manifest version differs from the desktop package.',
);
assert.ok(
  setupSource.includes(`public const string ProductVersion = "${desktopManifest.version}";`),
  'Installer registry version differs from the desktop package.',
);

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
  'resources/app/node_modules/@joy-media/project-persistence/dist/editor-storage.js',
  'resources/app/renderer/index.html',
  'resources/app/dist/main/electron-entry.js',
];

for (const relPath of requiredFiles) {
  const fullPath = resolve(standaloneDir, relPath);
  assert.ok(existsSync(fullPath), `Required distribution file missing: ${relPath}`);
}
console.log('✔ All required distribution files present.');

// 2. Test Packaged CLI Execution via joy.cmd
console.log('2. Testing packaged CLI execution (joy.cmd doctor) in a disposable profile...');
const joyCmdPath = resolve(standaloneDir, 'joy.cmd');
const cliSandboxRoot = mkdtempSync(join(tmpdir(), 'joy-cli-package-check-'));
const cliHome = join(cliSandboxRoot, 'profile');
const cliTemp = join(cliSandboxRoot, 'temp');
const cliDatabase = join(cliSandboxRoot, 'data', 'joy-media.sqlite3');
mkdirSync(cliHome, { recursive: true });
mkdirSync(cliTemp, { recursive: true });
mkdirSync(join(cliSandboxRoot, 'data'), { recursive: true });
const cliEnv = {
  ...Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [],
    ),
  ),
  HOME: cliHome,
  USERPROFILE: cliHome,
  APPDATA: join(cliHome, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(cliHome, 'AppData', 'Local'),
  TEMP: cliTemp,
  TMP: cliTemp,
  JOY_MEDIA_SQLITE_PATH: cliDatabase,
  JOY_MEDIA_EDGE_URL: 'off',
  NODE_ENV: 'production',
};
mkdirSync(cliEnv.APPDATA, { recursive: true });
mkdirSync(cliEnv.LOCALAPPDATA, { recursive: true });
try {
  const doctorResult = spawnSync(joyCmdPath, ['doctor'], {
    shell: true,
    env: cliEnv,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(doctorResult.status, 0, `joy.cmd doctor failed: ${doctorResult.stderr}`);
  assert.ok(doctorResult.stdout.includes('JOY MEDIA CLI'), 'Doctor output missing banner');
  assert.ok(
    doctorResult.stdout.includes('Core checks passed with'),
    'Doctor output did not report a successful core-check summary',
  );
  assert.ok(
    doctorResult.stdout.includes('Disabled by JOY_MEDIA_EDGE_URL'),
    'Package check must keep the doctor edge probe disabled and offline',
  );
  assert.ok(
    doctorResult.stdout.includes(`v${desktopManifest.version}`),
    'Packaged CLI banner version differs from the desktop package.',
  );
  console.log('✔ Packaged CLI doctor passed cleanly without a production network probe.');

  console.log('3. Testing packaged CLI project create/list...');
  const createResult = spawnSync(
    joyCmdPath,
    ['project', 'create', 'Installer package check', '--sqlite-path', cliDatabase, '--json'],
    { shell: true, env: cliEnv, encoding: 'utf8', timeout: 15000 },
  );
  assert.strictEqual(
    createResult.status,
    0,
    `joy.cmd project create failed: ${createResult.stderr}`,
  );
  const created = JSON.parse(createResult.stdout);
  const projectResult = spawnSync(
    joyCmdPath,
    ['project', 'list', '--sqlite-path', cliDatabase, '--json'],
    { shell: true, env: cliEnv, encoding: 'utf8', timeout: 15000 },
  );
  assert.strictEqual(
    projectResult.status,
    0,
    `joy.cmd project list failed: ${projectResult.stderr}`,
  );
  const projects = JSON.parse(projectResult.stdout);
  assert.ok(
    projects.some((project) => project.id === created.id),
    'Project list omitted created project',
  );
  console.log('✔ Packaged CLI project create/list passed in the disposable profile.');
} finally {
  rmSync(cliSandboxRoot, { recursive: true, force: true });
}

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

console.log('8. Verifying Windows installed-lifecycle hash control and harness syntax...');
const lifecycleHarnessPath = resolve('tests/desktop/windows-lifecycle.ps1');
const lifecycleHarness = readFileSync(lifecycleHarnessPath, 'utf8');
assert.match(
  lifecycleHarness,
  /trap\s*\{[\s\S]*lifecycle diagnostic line/u,
  'Lifecycle failures must report the PowerShell source line before cleanup.',
);
assert.match(
  lifecycleHarness,
  /function Test-UserPathEntry\([\s\S]*?\[string\]::IsNullOrWhiteSpace\(\$UserPath\)/u,
  'Lifecycle User PATH inspection must safely handle an unset value.',
);
assert.doesNotMatch(
  lifecycleHarness,
  /\.Contains\([^\r\n]*,\s*\[StringComparison\]/u,
  'Windows PowerShell 5.1 does not support the two-argument String.Contains overload.',
);
assert.match(
  lifecycleHarness,
  /function Assert-CleanCheckoutStatus\b/u,
  'Lifecycle checkout validation must handle an empty git status result without calling methods on null.',
);
assert.match(
  lifecycleHarness,
  /\$statusLines\s*=\s*@\(& git -C \$repoRoot status --porcelain\)[\s\S]{0,220}Assert-CleanCheckoutStatus -StatusLines \$statusLines/u,
  'Lifecycle checkout validation must capture porcelain output as a collection and validate it safely.',
);
assert.doesNotMatch(
  lifecycleHarness,
  /\(& git -C \$repoRoot status --porcelain\)\.Trim\(\)/u,
  'A clean git status returns no output in Windows PowerShell 5.1, so Trim() would dereference null.',
);
assert.match(
  lifecycleHarness,
  /Invoke-VerifiedSetup \$testTamperedArtifact \$candidateSetup \$candidateVersion/u,
  'Lifecycle hash negative control must exercise the same verified setup entrypoint.',
);
assert.match(
  lifecycleHarness,
  /if \(-not \$negativeControlRejected\).*Installer hash negative control was not rejected/su,
  'Lifecycle harness must require a rejected tampered setup before any install.',
);
const lifecycleParseCommand = `
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile('${lifecycleHarnessPath.replace(/'/g, "''")}', [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) {
    Write-Error ($errors | Out-String)
    exit 1
  }
`;
const lifecycleParseResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', lifecycleParseCommand],
  { encoding: 'utf8', timeout: 15000 },
);
assert.strictEqual(
  lifecycleParseResult.status,
  0,
  `Windows lifecycle harness syntax parsing failed:\n${lifecycleParseResult.stderr || lifecycleParseResult.stdout}`,
);
const lifecyclePathProbeCommand = String.raw`
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile('${lifecycleHarnessPath.replace(/'/g, "''")}', [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 }
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-UserPathEntry' }, $true)
  if ($null -eq $function) { Write-Error 'Test-UserPathEntry function is missing'; exit 1 }
  . ([ScriptBlock]::Create($function.Extent.Text))
  $installPath = 'C:\Users\Disposable\Programs\JOY Media'
  if (Test-UserPathEntry -UserPath $null -InstallPath $installPath) { Write-Error 'Null User PATH was accepted'; exit 1 }
  if (Test-UserPathEntry -UserPath '' -InstallPath $installPath) { Write-Error 'Empty User PATH was accepted'; exit 1 }
  if (-not (Test-UserPathEntry -UserPath 'C:\Other;C:\Users\Disposable\Programs\JOY Media\' -InstallPath $installPath)) { Write-Error 'A normalized installed User PATH entry was not detected'; exit 1 }
  if (Test-UserPathEntry -UserPath 'C:\Users\Other\Programs\JOY Media' -InstallPath $installPath) { Write-Error 'A different User PATH entry was accepted'; exit 1 }
`;
const lifecyclePathProbeResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', lifecyclePathProbeCommand],
  { encoding: 'utf8', timeout: 15000 },
);
assert.strictEqual(
  lifecyclePathProbeResult.status,
  0,
  `Windows lifecycle User PATH null/normalization probe failed:\n${lifecyclePathProbeResult.stderr || lifecyclePathProbeResult.stdout}`,
);
const lifecycleCheckoutProbeCommand = String.raw`
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile('${lifecycleHarnessPath.replace(/'/g, "''")}', [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 }
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-CleanCheckoutStatus' }, $true)
  if ($null -eq $function) { Write-Error 'Assert-CleanCheckoutStatus function is missing'; exit 1 }
  . ([ScriptBlock]::Create($function.Extent.Text))
  Assert-CleanCheckoutStatus -StatusLines @()
  $dirtyRejected = $false
  try { Assert-CleanCheckoutStatus -StatusLines @(' M tracked-file.txt') }
  catch {
    if ($_.Exception.Message -ne 'Windows lifecycle checkout is not clean before generated artifacts.') { throw }
    $dirtyRejected = $true
  }
  if (-not $dirtyRejected) { Write-Error 'A dirty lifecycle checkout was accepted'; exit 1 }
`;
const lifecycleCheckoutProbeResult = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', lifecycleCheckoutProbeCommand],
  { encoding: 'utf8', timeout: 15000 },
);
assert.strictEqual(
  lifecycleCheckoutProbeResult.status,
  0,
  `Windows lifecycle empty/dirty checkout probe failed:\n${lifecycleCheckoutProbeResult.stderr || lifecycleCheckoutProbeResult.stdout}`,
);
console.log('✔ Windows installed-lifecycle harness syntax parse check passed.');

console.log('\n=== All Installer & Packaging Checks PASSED! ===');
