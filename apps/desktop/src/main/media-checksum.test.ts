import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumFile, classifyMediaKind, fileExistsWithSize } from './media-checksum.js';

function tempFile(name: string, content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'joy-media-checksum-'));
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

describe('checksumFile', () => {
  it('matches a synchronous sha256 of the same bytes', async () => {
    const path = tempFile('clip.mp4', 'hello world');
    const expected = createHash('sha256').update('hello world').digest('hex');
    await expect(checksumFile(path)).resolves.toEqual({ checksum: expected, byteSize: 11 });
  });

  it('rejects for a missing file', async () => {
    await expect(checksumFile('C:\\definitely\\missing.mp4')).rejects.toThrow();
  });
});

describe('classifyMediaKind', () => {
  it.each([
    ['C:\\Media\\clip.MP4', 'video'],
    ['C:\\Media\\track.wav', 'audio'],
    ['C:\\Media\\frame.png', 'image'],
    ['C:\\Media\\notes.txt', 'other'],
    ['C:\\Media\\no-extension', 'other'],
  ] as const)('classifies %s as %s', (path, expected) => {
    expect(classifyMediaKind(path)).toBe(expected);
  });
});

describe('fileExistsWithSize', () => {
  it('resolves the byte size for a real file', async () => {
    const path = tempFile('clip.mp4', 'abc');
    await expect(fileExistsWithSize(path)).resolves.toBe(3);
  });

  it('resolves undefined for a missing file', async () => {
    await expect(fileExistsWithSize('C:\\definitely\\missing.mp4')).resolves.toBeUndefined();
  });
});
