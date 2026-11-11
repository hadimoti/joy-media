import { execFileSync } from 'node:child_process';
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
} from './project-volume.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync as typeof execFileSync) };
});

const asked = vi.mocked(execFileSync);

/** The next question to Windows gets this text back, as its bytes. */
function answerWith(text: string): void {
  asked.mockImplementationOnce((() => Buffer.from(text)) as unknown as typeof execFileSync);
}

beforeEach(() => {
  asked.mockClear();
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
