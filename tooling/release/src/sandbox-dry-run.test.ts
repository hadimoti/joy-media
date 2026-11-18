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
          '-DryRun',
        ],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      const output = (result.stdout ?? '') + (result.stderr ?? '');

      expect(result.status, output).toBe(0);
      expect(output).toContain('dry-run receipts accepted');
      expect(output).toContain('Windows Sandbox was not started');
      expect(existsSync(lifecycleReceipt)).toBe(false);
    },
  );
});
