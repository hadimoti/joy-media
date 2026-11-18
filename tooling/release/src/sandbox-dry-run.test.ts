import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const powershell = process.platform === 'win32' ? 'powershell.exe' : undefined;
const runner = resolve(import.meta.dirname, '../sandbox/run-sandbox.ps1');

describe('Windows Sandbox runner dry run', () => {
  it.skipIf(powershell === undefined)(
    'writes and validates fake lifecycle and offline-smoke receipts without starting Sandbox',
    () => {
      const scratch = join(tmpdir(), 'joy-media-sandbox-dry-run-test-' + process.pid);
      const lifecycleReceipt = join(scratch, 'sandbox-lifecycle.json');
      const result = spawnSync(
        powershell!,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          runner,
          '-Kind',
          'lifecycle',
          '-SetupExe',
          join(scratch, 'fake-setup.exe'),
          '-OutDir',
          join(scratch, 'out'),
          '-Receipt',
          lifecycleReceipt,
          '-OfflineSmoke',
          '-DryRun',
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(result.status, output).toBe(0);
      expect(output).toContain('dry-run receipts accepted');
      expect(output).toContain('Windows Sandbox was not started');
      expect(output).toContain('DRY RUN WSB BEGIN');
      expect(output).toContain('<Networking>Disable</Networking>');
      expect(existsSync(lifecycleReceipt)).toBe(false);

      const wsbStart = output.indexOf('DRY RUN WSB BEGIN');
      const wsbEnd = output.indexOf('DRY RUN WSB END');
      expect(wsbStart).toBeGreaterThanOrEqual(0);
      expect(wsbEnd).toBeGreaterThan(wsbStart);
      const wsbXml = output.slice(wsbStart + 'DRY RUN WSB BEGIN'.length, wsbEnd).trim();
      const parsedXml = spawnSync(
        powershell!,
        [
          '-NoProfile',
          '-Command',
          "try { [xml]$document = $env:JOY_MEDIA_WSB_XML; if ($document.Configuration.Networking -ne 'Disable' -or $document.Configuration.LogonCommand.Command -notmatch '-RunOfflineSmoke') { exit 1 } } catch { exit 1 }",
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          windowsHide: true,
          env: { ...process.env, JOY_MEDIA_WSB_XML: wsbXml },
        },
      );
      expect(parsedXml.status, (parsedXml.stdout ?? '') + (parsedXml.stderr ?? '')).toBe(0);

      const optionalResult = spawnSync(
        powershell!,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          runner,
          '-Kind',
          'lifecycle',
          '-SetupExe',
          join(scratch, 'fake-setup.exe'),
          '-OutDir',
          join(scratch, 'out'),
          '-Receipt',
          lifecycleReceipt,
          '-DryRun',
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      const optionalOutput = (optionalResult.stdout ?? '') + (optionalResult.stderr ?? '');
      expect(optionalResult.status, optionalOutput).toBe(0);
      expect(optionalOutput).toContain('optional offline smoke step not requested');
      expect(optionalOutput).not.toContain('-RunOfflineSmoke');
    },
  );
});
