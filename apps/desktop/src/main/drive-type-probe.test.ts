import type { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { driveTypeOfRoot } from './drive-type-probe.js';

const mockedExecFile = vi.fn<typeof execFile>();
const injectedExecFile = mockedExecFile as unknown as typeof execFile;

type ExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;

function respond(error: Error | null, stdout = ''): void {
  mockedExecFile.mockImplementation((_file, _args, _options, callback) => {
    (callback as unknown as ExecCallback)(error, stdout, '');
    return undefined as never;
  });
}

beforeEach(() => {
  mockedExecFile.mockReset();
});

describe('driveTypeOfRoot production probe', () => {
  it('queries Windows with a validated drive-letter literal', async () => {
    respond(null, '2\r\n');

    await expect(
      driveTypeOfRoot('Q:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('removable');

    expect(mockedExecFile).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='Q:'").DriveType`,
      ],
      { timeout: 5000, windowsHide: true },
      expect.any(Function),
    );
  });

  it('caches a successful drive-type result', async () => {
    respond(null, '3');

    await expect(
      driveTypeOfRoot('R:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('fixed');
    await expect(
      driveTypeOfRoot('R:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('fixed');

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight Windows query between concurrent callers', async () => {
    let reply: ExecCallback | undefined;
    mockedExecFile.mockImplementation((_file, _args, _options, callback) => {
      reply = callback as unknown as ExecCallback;
      return undefined as never;
    });

    const first = driveTypeOfRoot('V:\\', { platform: 'win32', execFile: injectedExecFile });
    const second = driveTypeOfRoot('V:\\', { platform: 'win32', execFile: injectedExecFile });
    expect(mockedExecFile).toHaveBeenCalledTimes(1);

    reply!(null, '4', '');
    await expect(Promise.all([first, second])).resolves.toEqual(['network', 'network']);
  });

  it('returns unknown when the Windows probe times out', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    respond(timeout);

    await expect(
      driveTypeOfRoot('S:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('unknown');

    expect(mockedExecFile.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000 });
  });

  it('retries after a timed-out unknown result instead of caching it permanently', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    respond(timeout);
    await expect(
      driveTypeOfRoot('W:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('unknown');

    respond(null, '3');
    await expect(
      driveTypeOfRoot('W:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('fixed');
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it('returns unknown when the Windows probe fails', async () => {
    respond(new Error('powershell unavailable'));

    await expect(
      driveTypeOfRoot('T:\\', { platform: 'win32', execFile: injectedExecFile }),
    ).resolves.toBe('unknown');
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
  });

  it.each(['C:\\Media', '12:', 'AB:', "C:'; Write-Output 'injected'"])(
    'rejects an unchecked root without invoking PowerShell (%s)',
    async (root) => {
      respond(null, '3');
      await expect(
        driveTypeOfRoot(root, { platform: 'win32', execFile: injectedExecFile }),
      ).resolves.toBe('unknown');
      expect(mockedExecFile).not.toHaveBeenCalled();
    },
  );

  it('returns unknown on non-Windows systems without invoking PowerShell', async () => {
    await expect(
      driveTypeOfRoot('U:\\', { platform: 'linux', execFile: injectedExecFile }),
    ).resolves.toBe('unknown');
    expect(mockedExecFile).not.toHaveBeenCalled();
  });
});
