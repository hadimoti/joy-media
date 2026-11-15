import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertManifestListsFiles,
  assertReleasePlanUnsigned,
  assertZipEntryNames,
  fileSha256,
  listedSha256,
  zipEntryNames,
  zipEntryNamesFromBuffer,
} from './installer-package-assertions.mjs';

/** A zip with only a central directory (no file data): enough for the name reader. */
function fakeZip(names: string[]): Buffer {
  const entries = names.map((name) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(nameBytes.length, 28);
    return Buffer.concat([header, nameBytes]);
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([directory, end]);
}

describe('zip entry names', () => {
  it('reads the names from the central directory', () => {
    const names = ['joy-media-win32-x64/', 'joy-media-win32-x64/joy-media.exe'];
    expect(zipEntryNamesFromBuffer(fakeZip(names))).toEqual(names);
  });

  it('reads a zip file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-zip-names-'));
    try {
      const path = join(dir, 'a.zip');
      writeFileSync(path, fakeZip(['x/y.txt']));
      expect(zipEntryNames(path)).toEqual(['x/y.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects bytes that are not a zip', () => {
    expect(() => zipEntryNamesFromBuffer(Buffer.from('not a zip'))).toThrow(
      /end-of-central-directory/,
    );
  });
});

describe('assertZipEntryNames', () => {
  const required = ['joy-media-win32-x64/joy-media.exe'];

  it('passes for forward-slash entries that include the required file', () => {
    const entries = zipEntryNamesFromBuffer(
      fakeZip(['joy-media-win32-x64/', 'joy-media-win32-x64/joy-media.exe']),
    );
    expect(() => assertZipEntryNames(entries, required)).not.toThrow();
  });

  it('fails when an entry name has a backslash', () => {
    const entries = zipEntryNamesFromBuffer(
      fakeZip(['joy-media-win32-x64/joy-media.exe', 'joy-media-win32-x64\\resources\\app.asar']),
    );
    expect(() => assertZipEntryNames(entries, required)).toThrow(/forward slashes/);
  });

  it('fails when every entry uses backslashes (the Compress-Archive layout)', () => {
    const entries = zipEntryNamesFromBuffer(fakeZip(['joy-media-win32-x64\\joy-media.exe']));
    expect(() => assertZipEntryNames(entries, required)).toThrow(/forward slashes/);
  });

  it('fails for an empty archive', () => {
    expect(() => assertZipEntryNames([], required)).toThrow(/no entries/);
  });

  it('fails when a required entry is missing', () => {
    expect(() => assertZipEntryNames(['joy-media-win32-x64/other.txt'], required)).toThrow(
      /does not contain joy-media-win32-x64\/joy-media\.exe/,
    );
  });
});

describe('listedSha256 and fileSha256', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  it('reads a digest and lower-cases it', () => {
    expect(listedSha256(`${'A'.repeat(64)}  m.json\n`, 'm.json')).toBe(a);
  });

  it('does not match a missing, duplicated or look-alike name', () => {
    expect(listedSha256(`${a}  other.zip\n`, 'm.json')).toBeUndefined();
    expect(listedSha256(`${a}  m.json.bak\n`, 'm.json')).toBeUndefined();
    expect(listedSha256(`${a}  m.json\n${b}  m.json\n`, 'm.json')).toBeUndefined();
  });

  it('hashes file bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-sha-'));
    try {
      const path = join(dir, 'f.bin');
      writeFileSync(path, 'abc');
      expect(fileSha256(path)).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertManifestListsFiles', () => {
  const manifest = {
    artifacts: [
      { fileName: 'joy-media-setup.exe', sha256: 'a'.repeat(64) },
      { fileName: 'joy-worker.exe', sha256: 'b'.repeat(64) },
      { fileName: 'joy.cmd' },
    ],
  };

  it('passes when the setup exe and the worker exe are listed with digests', () => {
    expect(() =>
      assertManifestListsFiles(manifest, ['joy-media-setup.exe', 'joy-worker.exe']),
    ).not.toThrow();
  });

  it('fails when the setup exe is not listed', () => {
    const withoutSetup = { artifacts: manifest.artifacts.slice(1) };
    expect(() => assertManifestListsFiles(withoutSetup, ['joy-media-setup.exe'])).toThrow(
      /does not list joy-media-setup\.exe/,
    );
  });

  it('fails when a listed file has no digest', () => {
    expect(() => assertManifestListsFiles(manifest, ['joy.cmd'])).toThrow(/does not list joy.cmd/);
  });
});

describe('assertReleasePlanUnsigned', () => {
  it('passes for a source that writes unsigned-release', () => {
    expect(() =>
      assertReleasePlanUnsigned("const plan = { status: 'unsigned-release' };"),
    ).not.toThrow();
  });

  it('fails for a source that still says blocked', () => {
    expect(() => assertReleasePlanUnsigned("const plan = { status: 'blocked' };")).toThrow(
      /unsigned-release/,
    );
    expect(() =>
      assertReleasePlanUnsigned("{ status: 'unsigned-release' } ; { status: 'blocked' }"),
    ).toThrow(/must not say blocked/);
  });
});
