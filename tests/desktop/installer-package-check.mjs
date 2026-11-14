import { createHash } from 'node:crypto';
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

/**
 * The entry names of a zip archive, read from its central directory. Nothing is extracted, so the names are
 * exactly what the archive stores.
 */
function zipEntryNames(zipPath) {
  const data = readFileSync(zipPath);
  const endRecord = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endRecord >= 0, `${zipPath} has no end-of-central-directory record`);
  const entryCount = data.readUInt16LE(endRecord + 10);
  let offset = data.readUInt32LE(endRecord + 16);
  const names = [];
  for (let index = 0; index < entryCount; index++) {
    assert.strictEqual(data.readUInt32LE(offset), 0x02014b50, 'Bad central directory entry');
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** The lowercase SHA-256 of a file's bytes, as SHA256SUMS.txt lists it. */
function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * The digest that a SHA256SUMS.txt text lists for one file name, or undefined when it lists that name zero or
 * more than one time. Lines follow "<64 hex>  <name>"; a name that only ends the same way does not match.
 */
function listedSha256(sumsText, fileName) {
  const digests = sumsText.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line);
    return match && match[2] === fileName ? [match[1].toLowerCase()] : [];
  });
  return digests.length === 1 ? digests[0] : undefined;
}

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
  // The packaged Worker script and the third-party package it imports at start. Without the package
  // the Worker exits at start, and exports wait forever for it.
  'resources/app/worker/index.js',
  'resources/app/node_modules/playwright-core/package.json',
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
assert.ok(doctorResult.stdout.includes('All diagnostics passed'), 'Doctor diagnostics failed');
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

// 3b. The release zip uses forward slashes, and the packaged exe names JOY Media at this app version.
const packageVersion = JSON.parse(
  readFileSync(resolve('apps/desktop/package.json'), 'utf8'),
).version;
const releaseZipPath = resolve(releasesDir, `joy-media-windows-x64-v${packageVersion}.zip`);
console.log('3b. Testing the release zip entry names and the packaged exe version resource...');
const zipEntries = zipEntryNames(releaseZipPath);
assert.ok(zipEntries.length > 0, 'The release zip has no entries');
assert.deepStrictEqual(
  zipEntries.filter((name) => name.includes('\\')),
  [],
  'The release zip must use forward slashes in every entry name',
);
assert.ok(
  zipEntries.includes('joy-media-win32-x64/joy-media.exe'),
  'The release zip does not contain joy-media-win32-x64/joy-media.exe',
);
console.log(`✔ Release zip has ${zipEntries.length} entries, none with a backslash.`);

const versionInfoRun = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$v = (Get-Item -LiteralPath '${resolve(standaloneDir, 'joy-media.exe')}').VersionInfo; ` +
      '[pscustomobject]@{ ProductName = $v.ProductName; FileDescription = $v.FileDescription; ' +
      'ProductVersion = $v.ProductVersion; FileVersion = $v.FileVersion } | ConvertTo-Json -Compress',
  ],
  { encoding: 'utf8', timeout: 30000, windowsHide: true },
);
assert.strictEqual(
  versionInfoRun.status,
  0,
  `Reading joy-media.exe details failed: ${versionInfoRun.stderr}`,
);
const exeDetails = JSON.parse(versionInfoRun.stdout);
assert.strictEqual(
  exeDetails.ProductName,
  'JOY Media',
  'joy-media.exe ProductName is not JOY Media',
);
assert.strictEqual(
  exeDetails.FileDescription,
  'JOY Media',
  'joy-media.exe FileDescription is not JOY Media',
);
assert.strictEqual(
  exeDetails.ProductVersion,
  packageVersion,
  'joy-media.exe ProductVersion is not the app version',
);
assert.strictEqual(
  exeDetails.FileVersion,
  `${packageVersion}.0`,
  'joy-media.exe FileVersion is not the app version',
);
console.log('✔ joy-media.exe names JOY Media at the app version.');

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
assert.match(
  hostIntegrationBlock,
  /Software\\+Classes\\+joy[\s\S]*JOY_MEDIA_INSTALL_DIR[\s\S]*Remove-Item/i,
  'The joy:// handler cleanup (only when it names this install) was not found',
);

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
  // Full path: cmd does not search the current folder when NoDefaultCurrentDirectoryInExePath is set.
  const uninstallResult = spawnSync(
    'cmd.exe',
    ['/d', '/c', join(sandboxInstallDir, 'uninstall.cmd')],
    {
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
    },
  );
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

// 5b. The user PATH merge. A v1.0.x script joined a one-entry PATH and the install folder into one
// entry with no separator ("...\WindowsAppsC:\...\JOY Media"). These cases run the merge on plain strings
// and never touch the registry or the process PATH.
console.log('5b. Testing the user PATH merge in Setup-JoyMedia.ps1 and in the setup exe source...');
{
  const installDir = 'C:\\Users\\T\\AppData\\Local\\Programs\\JOY Media';
  const apps = 'C:\\Users\\T\\AppData\\Local\\Microsoft\\WindowsApps';
  const setupSource = readFileSync(resolve(standaloneDir, 'Setup-JoyMedia.ps1'), 'utf8');
  const fnStart = setupSource.indexOf('function Get-PathWithInstallDir');
  const fnEnd = setupSource.indexOf('$userPath = [Environment]::GetEnvironmentVariable', fnStart);
  assert.ok(
    fnStart >= 0 && fnEnd > fnStart,
    'Get-PathWithInstallDir was not found in the setup script',
  );
  const psCases = [
    ['', installDir],
    [apps, `${apps};${installDir}`],
    [`${apps};C:\\B`, `${apps};C:\\B;${installDir}`],
    [`${apps};${installDir}`, '<unchanged>'],
    [`${apps};${installDir.toLowerCase()}\\`, '<unchanged>'],
  ];
  const psScript =
    setupSource.slice(fnStart, fnEnd) +
    `\n$i = '${installDir}'\n` +
    psCases
      .map(
        ([input]) =>
          `$r = Get-PathWithInstallDir '${input}' $i; if ($null -eq $r) { '<unchanged>' } else { $r }`,
      )
      .join('\n');
  const psRun = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    },
  );
  assert.strictEqual(psRun.status, 0, `PATH merge script failed: ${psRun.stderr}`);
  assert.deepStrictEqual(
    psRun.stdout.split(/\r?\n/).filter((line) => line.length > 0),
    psCases.map(([, expected]) => expected),
    'Setup-JoyMedia.ps1 PATH merge gave the wrong result',
  );

  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!existsSync(csc)) {
    console.log('  (csc.exe not found: the setup exe PATH merge check was skipped)');
  } else {
    const csRoot = mkdtempSync(join(tmpdir(), 'joy-userpath-'));
    try {
      const esc = (text) => text.replace(/\\/g, '\\\\');
      const csCases = [
        ['', installDir],
        ['C:\\A', `C:\\A;${installDir}`],
        [`${apps}${installDir}`, `${apps};${installDir}`],
        [`C:\\X;${apps}${installDir};C:\\Y`, `C:\\X;${apps};${installDir};C:\\Y`],
        [`${apps};${installDir.toUpperCase()}\\`, '<unchanged>'],
        [`${installDir};${installDir}`, installDir],
        ['%LOCALAPPDATA%\\Programs\\JOY Media', '<unchanged>'],
        ['C:\\Programs\\JOY Media Tools', `C:\\Programs\\JOY Media Tools;${installDir}`],
      ];
      const harness = `using System;
using JoyMedia.Setup;
static class T {
  static void Main() {
    Environment.SetEnvironmentVariable("LOCALAPPDATA", @"C:\\Users\\T\\AppData\\Local");
    string i = "${esc(installDir)}";
${csCases
  .map(
    ([input]) =>
      `    { string r = UserPathEditor.WithInstallDir("${esc(input)}", i); Console.WriteLine(r == null ? "<unchanged>" : r); }`,
  )
  .join('\n')}
  }
}
`;
      writeFileSync(join(csRoot, 'T.cs'), harness);
      const exe = join(csRoot, 'T.exe');
      const compile = spawnSync(
        csc,
        [
          '/nologo',
          `/out:${exe}`,
          join(csRoot, 'T.cs'),
          resolve('apps/desktop/installer/UserPath.cs'),
        ],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
      assert.strictEqual(compile.status, 0, `UserPath.cs did not compile: ${compile.stdout}`);
      const csRun = spawnSync(exe, [], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.strictEqual(csRun.status, 0, `PATH merge harness failed: ${csRun.stderr}`);
      assert.deepStrictEqual(
        csRun.stdout.split(/\r?\n/).filter((line) => line.length > 0),
        csCases.map(([, expected]) => expected),
        'Setup.cs PATH merge gave the wrong result',
      );
    } finally {
      rmSync(csRoot, { recursive: true, force: true });
    }
  }
  console.log('✔ User PATH merge passed.');
}

// 5c. The setup exe is built after the packager writes SHA256SUMS.txt, so build-installer.ps1 adds its
// line. This runs that block on a temp folder with a stand-in file, then lets checksums.ts verify the result.
console.log(
  '5c. Testing that build-installer.ps1 records joy-media-setup.exe in SHA256SUMS.txt...',
);
{
  const script = readFileSync(resolve('apps/desktop/installer/build-installer.ps1'), 'utf8');
  const begin = script.indexOf('(SUMS-BLOCK-BEGIN)');
  const end = script.indexOf('(SUMS-BLOCK-END)');
  assert.ok(begin >= 0 && end > begin, 'The SHA256SUMS block was not found in build-installer.ps1');
  const block = script.slice(script.indexOf('\n', begin), end);
  const sumsRoot = mkdtempSync(join(tmpdir(), 'joy-sums-'));
  try {
    const checksumsTs = resolve('tooling/release/src/checksums.ts');
    const verify = () =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', checksumsTs, 'verify', '--dir', sumsRoot],
        { encoding: 'utf8', timeout: 60000 },
      );
    const runBlock = () =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; $distReleases = '${sumsRoot}'; $outExe = '${join(sumsRoot, 'joy-media-setup.exe')}'\n${block}`,
        ],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
    const sumsPath = join(sumsRoot, 'SHA256SUMS.txt');

    // No SHA256SUMS.txt yet: the block must stop, not invent one.
    writeFileSync(join(sumsRoot, 'joy-media-setup.exe'), 'setup build 1');
    assert.notStrictEqual(
      runBlock().status,
      0,
      'The block must fail when SHA256SUMS.txt is missing',
    );

    // The packager's file, written before the setup exists.
    rmSync(join(sumsRoot, 'joy-media-setup.exe'));
    writeFileSync(join(sumsRoot, 'a.zip'), 'zip');
    writeFileSync(join(sumsRoot, 'b.mjs'), 'bundle');
    const packagerWrite = spawnSync(
      process.execPath,
      ['--experimental-strip-types', checksumsTs, 'write', '--dir', sumsRoot],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.strictEqual(packagerWrite.status, 0, `checksums write failed: ${packagerWrite.stderr}`);
    writeFileSync(join(sumsRoot, 'joy-media-setup.exe'), 'setup build 1');
    assert.notStrictEqual(verify().status, 0, 'Verify must fail while the setup has no line');

    const first = runBlock();
    assert.strictEqual(first.status, 0, `Recording the setup failed: ${first.stderr}`);
    assert.strictEqual(
      verify().status,
      0,
      `Verify failed after recording the setup: ${verify().stderr}`,
    );

    // A rebuilt setup has a new digest: its line is replaced, not duplicated.
    writeFileSync(join(sumsRoot, 'joy-media-setup.exe'), 'setup build 2');
    const second = runBlock();
    assert.strictEqual(second.status, 0, `Re-recording the setup failed: ${second.stderr}`);
    assert.strictEqual(verify().status, 0, `Verify failed after a rebuild: ${verify().stderr}`);
    const setupLines = readFileSync(sumsPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /\sjoy-media-setup\.exe$/.test(line));
    assert.strictEqual(setupLines.length, 1, 'SHA256SUMS.txt must list the setup exactly once');
  } finally {
    rmSync(sumsRoot, { recursive: true, force: true });
  }
  console.log('✔ build-installer.ps1 records joy-media-setup.exe in SHA256SUMS.txt.');
}

// 5d. build-installer.ps1 also lists the setup exe in the release manifest, with its digest. The block runs on a
// temp folder with a stand-in manifest; a rebuilt setup replaces its entry instead of adding a second one.
console.log(
  '5d. Testing that build-installer.ps1 lists joy-media-setup.exe in the release manifest...',
);
{
  const script = readFileSync(resolve('apps/desktop/installer/build-installer.ps1'), 'utf8');
  const begin = script.indexOf('(MANIFEST-BLOCK-BEGIN)');
  const end = script.indexOf('(MANIFEST-BLOCK-END)');
  assert.ok(begin >= 0 && end > begin, 'The manifest block was not found in build-installer.ps1');
  const block = script.slice(script.indexOf('\n', begin), end);
  const manifestRoot = mkdtempSync(join(tmpdir(), 'joy-manifest-'));
  try {
    const manifestPath = join(manifestRoot, 'joy-media-release-manifest.json');
    const runBlock = () =>
      spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; $distReleases = '${manifestRoot}'; $outExe = '${join(manifestRoot, 'joy-media-setup.exe')}'\n${block}`,
        ],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
      );
    const stand = {
      name: 'joy-media',
      version: '1.1.1',
      installer: { script: 'Setup-JoyMedia.ps1', environment: { pathRegistered: true } },
      artifacts: [{ fileName: 'joy-media.exe', type: 'standalone-binary', sha256: 'a'.repeat(64) }],
    };
    // The packager's SHA256SUMS.txt lists the manifest with the digest from before this block rewrote it.
    const sumsPath = join(manifestRoot, 'SHA256SUMS.txt');
    const otherLine = `${'c'.repeat(64)}  joy-media.exe\n`;
    const staleLine = `${'b'.repeat(64)}  joy-media-release-manifest.json\n`;
    writeFileSync(manifestPath, JSON.stringify(stand, null, 2) + '\n', 'utf8');

    // No manifest yet: the block must stop, not invent one.
    rmSync(manifestPath);
    assert.notStrictEqual(runBlock().status, 0, 'The block must fail when the manifest is missing');

    writeFileSync(manifestPath, JSON.stringify(stand, null, 2) + '\n', 'utf8');
    writeFileSync(join(manifestRoot, 'joy-media-setup.exe'), 'setup build 1');
    // No SHA256SUMS.txt: the block must stop too, not invent one.
    assert.notStrictEqual(
      runBlock().status,
      0,
      'The block must fail when SHA256SUMS.txt is missing',
    );
    writeFileSync(sumsPath, otherLine + staleLine, 'utf8');
    const first = runBlock();
    assert.strictEqual(
      first.status,
      0,
      `Recording the setup in the manifest failed: ${first.stderr}`,
    );
    const afterFirst = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const setupEntries = afterFirst.artifacts.filter((a) => a.fileName === 'joy-media-setup.exe');
    assert.strictEqual(setupEntries.length, 1, 'The manifest must list the setup exe once');
    assert.strictEqual(setupEntries[0].type, 'installer');
    assert.strictEqual(setupEntries[0].byteSize, 'setup build 1'.length);
    assert.match(setupEntries[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(
      afterFirst.artifacts.some((a) => a.fileName === 'joy-media.exe'),
      'The existing manifest artifacts must be kept',
    );
    assert.strictEqual(
      afterFirst.installer.environment.pathRegistered,
      true,
      'Other manifest fields must be kept',
    );

    // The manifest's line in SHA256SUMS.txt is replaced with the manifest's new digest, and the other line stays.
    const sumsAfterFirst = readFileSync(sumsPath, 'utf8');
    assert.strictEqual(
      listedSha256(sumsAfterFirst, 'joy-media-release-manifest.json'),
      fileSha256(manifestPath),
      'SHA256SUMS.txt must list the manifest with the digest of the manifest on disk',
    );
    assert.ok(sumsAfterFirst.includes(otherLine), 'Other SHA256SUMS.txt lines must be kept');
    assert.strictEqual(
      sumsAfterFirst.split('\n').filter((line) => line !== '').length,
      2,
      'SHA256SUMS.txt must keep its line count',
    );

    writeFileSync(join(manifestRoot, 'joy-media-setup.exe'), 'setup build 2');
    const second = runBlock();
    assert.strictEqual(second.status, 0, `Re-recording the setup failed: ${second.stderr}`);
    assert.strictEqual(
      listedSha256(readFileSync(sumsPath, 'utf8'), 'joy-media-release-manifest.json'),
      fileSha256(manifestPath),
      'A rebuilt setup must update the manifest line in SHA256SUMS.txt',
    );
    const afterSecond = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const rebuilt = afterSecond.artifacts.filter((a) => a.fileName === 'joy-media-setup.exe');
    assert.strictEqual(rebuilt.length, 1, 'A rebuilt setup must replace its manifest entry');
    assert.notStrictEqual(
      rebuilt[0].sha256,
      setupEntries[0].sha256,
      'The rebuilt setup must have a new digest',
    );
  } finally {
    rmSync(manifestRoot, { recursive: true, force: true });
  }
  // The digest parser, on text: a listed digest is read back, and a missing, duplicated or look-alike name is not.
  assert.strictEqual(
    listedSha256(`${'A'.repeat(64)}  m.json\n`, 'm.json'),
    'a'.repeat(64),
    'listedSha256 must read a digest and lower-case it',
  );
  assert.strictEqual(listedSha256(`${'a'.repeat(64)}  other.zip\n`, 'm.json'), undefined);
  assert.strictEqual(listedSha256(`${'a'.repeat(64)}  m.json.bak\n`, 'm.json'), undefined);
  assert.strictEqual(
    listedSha256(`${'a'.repeat(64)}  m.json\n${'b'.repeat(64)}  m.json\n`, 'm.json'),
    undefined,
  );
  console.log('✔ build-installer.ps1 lists joy-media-setup.exe in the release manifest.');
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
// The payload is the setup exe, the zip, the app exe, the worker exe, the CLI bundle and this manifest
// (apps/site/src/release.mjs payloadNames). The manifest lists the setup and the worker.
for (const fileName of ['joy-media-setup.exe', 'joy-worker.exe']) {
  assert.ok(
    existsSync(resolve(releasesDir, fileName)),
    `${fileName} is missing from the release folder`,
  );
  assert.ok(
    manifest.artifacts.some((artifact) => artifact.fileName === fileName && artifact.sha256),
    `The release manifest does not list ${fileName}`,
  );
}

const shaSums = readFileSync(shaSumsPath, 'utf8');
for (const artifact of manifest.artifacts) {
  if (artifact.sha256) {
    assert.ok(
      shaSums.includes(artifact.sha256),
      `Artifact ${artifact.fileName} SHA256 ${artifact.sha256} not in SHA256SUMS.txt`,
    );
  }
}
// The manifest is rewritten by build-installer.ps1 after the packager's checksums step, so its own line in
// SHA256SUMS.txt must be the digest of the manifest as it is on disk now.
const manifestLineHash = listedSha256(shaSums, 'joy-media-release-manifest.json');
assert.ok(manifestLineHash, 'SHA256SUMS.txt has no single line for the release manifest');
assert.strictEqual(
  manifestLineHash,
  fileSha256(manifestPath),
  'SHA256SUMS.txt hash for joy-media-release-manifest.json does not match the manifest on disk',
);
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

// 8. The release plan for a non-staging build says "unsigned-release", not "blocked". (package-release.mjs runs
// its work when imported, so the check reads its source.)
console.log('8. Verifying the release plan status in package-release.mjs...');
const releaseScript = readFileSync(resolve('apps/desktop/scripts/package-release.mjs'), 'utf8');
assert.match(
  releaseScript,
  /status: 'unsigned-release'/,
  'The release plan must say unsigned-release',
);
assert.doesNotMatch(releaseScript, /status: 'blocked'/, 'The release plan must not say blocked');
console.log('✔ Release plan status is unsigned-release.');

console.log('\n=== All Installer & Packaging Checks PASSED! ===');
