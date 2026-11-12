import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeFound,
  describeVolumeAnswer,
  firstVolumeLine,
  forgetVolumeAnswers,
  keepVolumeAnswerForTests,
} from './project-volume.js';

/**
 * The words the owner sees for a drive, and the line Windows wrote for it. The Windows query itself is not run here;
 * the claim tests run it on the real temporary folder.
 */

beforeEach(() => {
  forgetVolumeAnswers();
});

describe('describing a volume in words', () => {
  it('says the drive was not checked when no answer was asked', () => {
    expect(describeFound(undefined)).toEqual({ drive: 'drive not checked', fileSystem: 'unknown' });
  });

  it('says there is no local drive when Windows wrote no volume for the path', () => {
    expect(describeFound('')).toEqual({ drive: 'no local drive', fileSystem: 'none' });
  });

  it('names a fixed drive and its file system', () => {
    expect(describeFound('3|FAT32')).toEqual({ drive: 'fixed drive', fileSystem: 'FAT32' });
  });

  it('names a removable drive formatted exFAT', () => {
    expect(describeFound('2|exFAT')).toEqual({ drive: 'removable drive', fileSystem: 'exFAT' });
  });

  it('says a volume with no file system is unformatted', () => {
    expect(describeFound('4|')).toEqual({ drive: 'network drive', fileSystem: 'no file system' });
  });

  it('calls any other kind of drive by a general name', () => {
    expect(describeFound('9|weird')).toEqual({
      drive: 'drive of another kind',
      fileSystem: 'weird',
    });
  });

  it('keeps no description for a volume that was never asked about', () => {
    expect(describeVolumeAnswer(123n)).toBeUndefined();
  });

  it('does not describe a share by the answer kept for a local drive with the same number', () => {
    keepVolumeAnswerForTests(9n, { verified: true, found: '3|NTFS' }, Date.now());
    expect(describeVolumeAnswer(9n, 'C:\\Trip')).toEqual({
      drive: 'fixed drive',
      fileSystem: 'NTFS',
    });
    expect(describeVolumeAnswer(9n, '\\\\localhost\\C$\\Trip')).toBeUndefined();
  });
});

describe('a kept volume answer is shown only while it is fresh', () => {
  it('shows a verified answer for a minute', () => {
    keepVolumeAnswerForTests(7n, { verified: true, found: '3|NTFS' }, Date.now());
    expect(describeVolumeAnswer(7n)).toEqual({ drive: 'fixed drive', fileSystem: 'NTFS' });
  });

  it('shows nothing once a verified answer is more than a minute old', () => {
    keepVolumeAnswerForTests(7n, { verified: true, found: '3|NTFS' }, Date.now() - 61_000);
    expect(describeVolumeAnswer(7n)).toBeUndefined();
  });

  it('shows nothing once a refused answer is more than five seconds old', () => {
    keepVolumeAnswerForTests(8n, { verified: false, found: '2|FAT32' }, Date.now() - 6_000);
    expect(describeVolumeAnswer(8n)).toBeUndefined();
  });
});

describe('reading the volume line from PowerShell', () => {
  it('finds the DriveType|FileSystem line among other output', () => {
    expect(firstVolumeLine('warning: something\r\n3|NTFS\r\n')).toBe('3|NTFS');
  });

  it('returns undefined when no line names a volume', () => {
    expect(firstVolumeLine('no volume here')).toBeUndefined();
    expect(firstVolumeLine('')).toBeUndefined();
  });
});
