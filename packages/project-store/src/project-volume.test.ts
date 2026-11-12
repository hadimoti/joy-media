import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeAnswer,
  isNtfsAnswer,
  isVerifiedNtfsVolume,
  forgetVolumeAnswers,
  volumeListPath,
  warmVolumeAnswer,
} from './project-volume.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync as typeof execFileSync),
    execFile: vi.fn(actual.execFile as typeof execFile),
  };
});

const asked = vi.mocked(execFileSync);
const askedAsync = vi.mocked(execFile);

type AsyncCallback = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;

/** The next question asked without blocking gets this text back after `delayMs`, or fails when `text` is an Error. */
function answerAsyncWith(text: string | Error, delayMs = 0): void {
  askedAsync.mockImplementationOnce(((...args: unknown[]) => {
    const callback = args[args.length - 1] as AsyncCallback;
    setTimeout(() => {
      if (text instanceof Error) callback(text, Buffer.alloc(0), Buffer.alloc(0));
      else callback(null, Buffer.from(text), Buffer.alloc(0));
    }, delayMs);
    return {} as ChildProcess;
  }) as unknown as typeof execFile);
}

/** The next question to Windows gets this text back, as its bytes. */
function answerWith(text: string): void {
  asked.mockImplementationOnce((() => Buffer.from(text)) as unknown as typeof execFileSync);
}

beforeEach(() => {
  asked.mockClear();
  askedAsync.mockClear();
  forgetVolumeAnswers();
});

describe('the path PowerShell is asked about', () => {
  it('loses the extended prefix of a drive path, and ends with a backslash so a mount folder names itself', () => {
    expect(volumeListPath('C:\\Mount')).toBe('C:\\Mount\\');
    expect(volumeListPath('\\\\?\\C:\\Trip')).toBe('C:\\Trip\\');
    expect(volumeListPath('\\\\?\\UNC\\server\\share\\Trip')).toBe('\\\\server\\share\\Trip\\');
    expect(volumeListPath('\\\\?\\Volume{abc}\\Trip\\')).toBe('\\\\?\\Volume{abc}\\Trip\\');
  });
});

describe('reading the answer', () => {
  it('reads single-byte and UTF-16 text, and drops a byte order mark', () => {
    expect(decodeAnswer(Buffer.from('3|NTFS\r\n', 'utf8'))).toBe('3|NTFS\r\n');
    expect(decodeAnswer(Buffer.from('\uFEFF3|NTFS\r\n', 'utf16le'))).toBe('3|NTFS\r\n');
  });

  it('accepts NTFS on a fixed or removable local volume, and nothing else', () => {
    expect(isNtfsAnswer('3|NTFS\r\n')).toBe(true);
    expect(isNtfsAnswer('2|NTFS\r\n')).toBe(true);
    expect(isNtfsAnswer('3|exFAT\r\n')).toBe(false);
    expect(isNtfsAnswer('4|NTFS\r\n')).toBe(false);
    expect(isNtfsAnswer('')).toBe(false);
  });
});

describe('asking Windows', () => {
  it.skipIf(process.platform !== 'win32')(
    'the drive that holds the temporary folder is verified as NTFS',
    () => {
      const place = tmpdir();
      expect(isVerifiedNtfsVolume(place, statSync(place, { bigint: true }).dev)).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'a real folder, named by the native real path, is verified as NTFS',
    () => {
      const folder = mkdtempSync(join(tmpdir(), 'volume-real-'));
      try {
        const real = realpathSync.native(folder);
        expect(isVerifiedNtfsVolume(real, statSync(real, { bigint: true }).dev)).toBe(true);
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'a network share is not verified, because no local volume holds it',
    () => {
      expect(isVerifiedNtfsVolume('\\\\server\\share\\Trip.proj', 9001n)).toBe(false);
    },
  );

  it.skipIf(process.platform !== 'win32')('another file system is refused', () => {
    answerWith('3|exFAT\r\n');
    expect(isVerifiedNtfsVolume('E:\\Trip.proj', 9002n)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('a missing or failing PowerShell is refused', () => {
    asked.mockImplementationOnce(() => {
      throw new Error('spawn powershell.exe ENOENT');
    });
    expect(isVerifiedNtfsVolume('E:\\Trip.proj', 9003n)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'the path travels in the environment, not in the script',
    () => {
      answerWith('3|NTFS\r\n');
      const place = 'C:\\Path Check\\Trip.proj';
      expect(isVerifiedNtfsVolume(place, 9004n)).toBe(true);
      const [file, args, options] = asked.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(file).toBe('powershell.exe');
      expect(args.join(' ')).not.toContain('Path Check');
      expect(options.env.PROJECT_PATH).toBe(volumeListPath(place));
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'a verified volume is asked once, so a second file on it is not asked again',
    () => {
      answerWith('3|NTFS\r\n');
      expect(isVerifiedNtfsVolume('C:\\Cache Check\\One.proj', 9005n)).toBe(true);
      expect(isVerifiedNtfsVolume('C:\\Cache Check\\Two.proj', 9005n)).toBe(true);
      expect(asked).toHaveBeenCalledTimes(1);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'a verified answer is asked again after a minute, and a refused one after five seconds',
    () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
        answerWith('3|NTFS\r\n');
        expect(isVerifiedNtfsVolume('C:\\Expiry Check\\One.proj', 9010n)).toBe(true);
        vi.setSystemTime(new Date('2026-11-11T10:00:59Z'));
        expect(isVerifiedNtfsVolume('C:\\Expiry Check\\One.proj', 9010n)).toBe(true);
        expect(asked).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date('2026-11-11T10:01:01Z'));
        answerWith('3|exFAT\r\n');
        expect(isVerifiedNtfsVolume('C:\\Expiry Check\\One.proj', 9010n)).toBe(false);
        expect(asked).toHaveBeenCalledTimes(2);
        vi.setSystemTime(new Date('2026-11-11T10:01:03Z'));
        expect(isVerifiedNtfsVolume('C:\\Expiry Check\\One.proj', 9010n)).toBe(false);
        expect(asked).toHaveBeenCalledTimes(2);

        vi.setSystemTime(new Date('2026-11-11T10:01:07Z'));
        answerWith('3|NTFS\r\n');
        expect(isVerifiedNtfsVolume('C:\\Expiry Check\\One.proj', 9010n)).toBe(true);
        expect(asked).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('asking Windows without blocking (condition (q))', () => {
  it.skipIf(process.platform !== 'win32')(
    'a warmed volume is answered from the kept answer, so the check asks nothing inline',
    async () => {
      answerAsyncWith('3|NTFS\r\n');
      await warmVolumeAnswer('C:\\Warm Check\\One.proj', 9101n);
      expect(isVerifiedNtfsVolume('C:\\Warm Check\\Two.proj', 9101n)).toBe(true);
      expect(askedAsync).toHaveBeenCalledTimes(1);
      expect(asked).not.toHaveBeenCalled();
      const [file, args, options] = askedAsync.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string>; timeout: number },
      ];
      expect(file).toBe('powershell.exe');
      expect(args.join(' ')).not.toContain('Warm Check');
      expect(options.env.PROJECT_PATH).toBe(volumeListPath('C:\\Warm Check\\One.proj'));
      expect(options.timeout).toBe(10_000);
    },
  );

  it.skipIf(process.platform !== 'win32')('two warms of one volume ask Windows once', async () => {
    answerAsyncWith('3|NTFS\r\n', 20);
    await Promise.all([
      warmVolumeAnswer('C:\\Twice\\One.proj', 9102n),
      warmVolumeAnswer('C:\\Twice\\Two.proj', 9102n),
    ]);
    await warmVolumeAnswer('C:\\Twice\\Three.proj', 9102n);
    expect(askedAsync).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform !== 'win32')(
    'the thread keeps running while Windows is asked',
    async () => {
      answerAsyncWith('3|NTFS\r\n', 300);
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      try {
        await warmVolumeAnswer('C:\\Busy\\One.proj', 9103n);
      } finally {
        clearInterval(timer);
      }
      // A blocking question would have let no timer run until it returned.
      expect(ticks).toBeGreaterThanOrEqual(10);
      expect(isVerifiedNtfsVolume('C:\\Busy\\One.proj', 9103n)).toBe(true);
      expect(asked).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'a failed question is kept as refused and never throws, and another file system is refused',
    async () => {
      answerAsyncWith(new Error('spawn powershell.exe ENOENT'));
      await expect(warmVolumeAnswer('E:\\Fail\\One.proj', 9104n)).resolves.toBeUndefined();
      expect(isVerifiedNtfsVolume('E:\\Fail\\One.proj', 9104n)).toBe(false);
      answerAsyncWith('3|exFAT\r\n');
      await warmVolumeAnswer('F:\\Stick\\One.proj', 9105n);
      expect(isVerifiedNtfsVolume('F:\\Stick\\One.proj', 9105n)).toBe(false);
      expect(asked).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'the real drive that holds the temporary folder is verified as NTFS without blocking',
    async () => {
      const place = realpathSync.native(tmpdir());
      const device = statSync(place, { bigint: true }).dev;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 5);
      try {
        await warmVolumeAnswer(place, device);
      } finally {
        clearInterval(timer);
      }
      expect(ticks).toBeGreaterThan(0);
      expect(isVerifiedNtfsVolume(place, device)).toBe(true);
      expect(asked).not.toHaveBeenCalled();
    },
  );

  it('asks nothing on other platforms, where every volume counts as verified', async () => {
    if (process.platform === 'win32') return;
    await warmVolumeAnswer('/tmp/One.proj', 9106n);
    expect(askedAsync).not.toHaveBeenCalled();
  });
});
