import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const checksumHelper = resolve(repoRoot, 'tests/desktop/windows-release-checksum.ps1');
const windowsLifecycle = resolve(repoRoot, 'tests/desktop/windows-lifecycle.ps1');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('legacy lifecycle hashes files from the actual v1.0.1 archive layout', () => {
  const lifecycle = readFileSync(windowsLifecycle, 'utf8');

  assert.match(
    lifecycle,
    /-FileName 'joy-media\.exe' -ArchivePath \$PreviousArchivePath -ArchiveEntryName 'joy-media-win32-x64\/joy-media\.exe'/,
  );
  assert.match(
    lifecycle,
    /-FileName 'joy-media-bundle\.mjs' -ArchivePath \$PreviousArchivePath -ArchiveEntryName 'joy-media-win32-x64\/resources\/app\/cli\/joy-media-bundle\.mjs'/,
  );
});

test('Windows lifecycle cleanup groups Test-Path calls before applying logical operators', () => {
  const lifecycle = readFileSync(windowsLifecycle, 'utf8');

  assert.match(
    lifecycle,
    /if \(\(Test-Path -LiteralPath \$installRoot\) -and \(Test-Path -LiteralPath \(Join-Path \$installRoot 'joy-media\.exe'\)\)\) \{/,
  );
});

test('Windows lifecycle invokes uninstaller batch files through cmd-compatible raw quoting', () => {
  const lifecycle = readFileSync(windowsLifecycle, 'utf8');
  const rawCmdArguments = /-RawArguments \('\/d \/s \/c ""' \+ \$uninstaller \+ '""'\)/g;

  assert.equal(
    lifecycle.match(rawCmdArguments)?.length ?? 0,
    2,
    'both acceptance and cleanup must invoke cmd.exe with its native quoted batch-file form',
  );
});

test(
  'cmd.exe executes an uninstaller batch file whose path contains spaces',
  { skip: process.platform !== 'win32' },
  () => {
    const root = resolve(mkdtempSync(join(tmpdir(), 'joy-media-cmd-quote-')));
    const tempRoot = resolve(tmpdir()).replace(/[\\/]+$/, '') + sep;
    assert.ok(root.startsWith(tempRoot), 'probe directory must stay under the OS temp root');

    const installDirectory = join(root, 'JOY Media');
    const batchPath = join(installDirectory, 'uninstall.cmd');
    const markerPath = join(installDirectory, 'uninstall-ran.marker');
    const testScript = join(root, 'invoke-batch.ps1');
    mkdirSync(installDirectory, { recursive: true });
    writeFileSync(
      batchPath,
      '@echo off\r\necho ran>"%~dp0uninstall-ran.marker"\r\nexit /b 0\r\n',
      'ascii',
    );
    writeFileSync(
      testScript,
      [
        'param([string]$BatchPath)',
        "$ErrorActionPreference = 'Stop'",
        '$start = [System.Diagnostics.ProcessStartInfo]::new()',
        "$start.FileName = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
        `$start.Arguments = '/d /s /c ""' + $BatchPath + '""'`,
        '$start.WorkingDirectory = Split-Path -LiteralPath $BatchPath',
        '$start.UseShellExecute = $false',
        '$start.CreateNoWindow = $true',
        '$start.RedirectStandardOutput = $true',
        '$start.RedirectStandardError = $true',
        '$process = [System.Diagnostics.Process]::new()',
        '$process.StartInfo = $start',
        "if (-not $process.Start()) { throw 'Could not start cmd.exe.' }",
        '$stdout = $process.StandardOutput.ReadToEndAsync()',
        '$stderr = $process.StandardError.ReadToEndAsync()',
        '$process.WaitForExit()',
        '[void]$process.WaitForExit()',
        '[pscustomobject]@{ exitCode = $process.ExitCode; stdout = $stdout.Result; stderr = $stderr.Result } | ConvertTo-Json -Compress',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          testScript,
          batchPath,
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      assert.equal(result.error, undefined, result.error?.message ?? 'PowerShell did not start.');
      assert.equal(
        result.status,
        0,
        `PowerShell batch invocation failed:\n${result.stdout}\n${result.stderr}`,
      );
      const invocation = JSON.parse(result.stdout.trim());
      assert.equal(invocation.exitCode, 0, `${invocation.stdout}\n${invocation.stderr}`);
      assert.ok(existsSync(markerPath), 'cmd.exe did not execute the uninstaller batch file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'derives legacy installed-file hashes from the verified archive when the sidecar lists only the archive',
  { skip: process.platform !== 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'joy-media-release-checksum-'));
    const archiveInput = join(root, 'archive-input');
    const standaloneDirectory = join(archiveInput, 'joy-media-win32-x64');
    const cliDirectory = join(standaloneDirectory, 'resources', 'app', 'cli');
    const desktopBytes = 'legacy desktop executable bytes';
    const cliBytes = 'legacy cli bundle bytes';
    const archivePath = join(root, 'legacy.zip');
    const testScript = join(root, 'test-release-checksum.ps1');
    mkdirSync(cliDirectory, { recursive: true });
    writeFileSync(join(standaloneDirectory, 'joy-media.exe'), desktopBytes);
    writeFileSync(join(cliDirectory, 'joy-media-bundle.mjs'), cliBytes);
    writeFileSync(
      testScript,
      [
        'param([string]$HelperPath, [string]$InputRoot, [string]$ArchivePath)',
        "$ErrorActionPreference = 'Stop'",
        "if (-not (Test-Path -LiteralPath $HelperPath -PathType Leaf)) { throw 'Get-ChecksummedArchiveEntryHash is not implemented.' }",
        '. $HelperPath',
        "Compress-Archive -Path (Join-Path $InputRoot '*') -DestinationPath $ArchivePath -CompressionLevel Optimal",
        "$archiveOnly = ''.PadLeft(64, '0') + '  joy-media-windows-x64-v1.0.1.zip'",
        "$desktop = Get-ChecksummedArchiveEntryHash -ChecksumsText $archiveOnly -FileName 'joy-media.exe' -ArchivePath $ArchivePath -ArchiveEntryName 'joy-media-win32-x64/joy-media.exe'",
        "$cli = Get-ChecksummedArchiveEntryHash -ChecksumsText $archiveOnly -FileName 'joy-media-bundle.mjs' -ArchivePath $ArchivePath -ArchiveEntryName 'joy-media-win32-x64/resources/app/cli/joy-media-bundle.mjs'",
        "$direct = ''.PadLeft(64, 'f') + '  joy-media.exe'",
        "$directResult = Get-ChecksummedArchiveEntryHash -ChecksumsText $direct -FileName 'joy-media.exe' -ArchivePath $ArchivePath -ArchiveEntryName 'joy-media-win32-x64/joy-media.exe'",
        '[pscustomobject]@{ desktop = $desktop; cli = $cli; direct = $directResult } | ConvertTo-Json -Compress',
      ].join('\n'),
      'utf8',
    );

    try {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          testScript,
          checksumHelper,
          archiveInput,
          archivePath,
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      assert.equal(result.error, undefined, result.error?.message ?? 'PowerShell did not start.');
      assert.equal(
        result.status,
        0,
        `PowerShell release checksum lookup failed:\n${result.stdout}\n${result.stderr}`,
      );
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        desktop: sha256(desktopBytes),
        cli: sha256(cliBytes),
        direct: 'f'.repeat(64),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
