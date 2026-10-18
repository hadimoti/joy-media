import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
