import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const checksumsScript = resolve(import.meta.dirname, 'checksums.ts');
let stagingDir = '';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runChecksums(command: 'verify' | 'write', dir: string) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', checksumsScript, command, '--dir', dir],
    { encoding: 'utf8', windowsHide: true },
  );
  return { status: result.status, output: String(result.stdout) + String(result.stderr) };
}

function writeSums(entries: readonly [string, string][]): void {
  const lines = entries.map(([hash, name]) => hash + '  ' + name);
  writeFileSync(join(stagingDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  stagingDir = mkdtempSync(join(tmpdir(), 'joy-checksums-'));
});

afterEach(() => {
  rmSync(stagingDir, { recursive: true, force: true });
});

describe('checksums.ts verify', () => {
  it('accepts a complete payload whose hashes match', () => {
    writeFileSync(join(stagingDir, 'joy-media.zip'), 'archive bytes', 'utf8');
    writeSums([[sha256('archive bytes'), 'joy-media.zip']]);

    const result = runChecksums('verify', stagingDir);

    expect(result.status).toBe(0);
    expect(result.output).toContain('verified 1 payload file');
  });

  it('reports a payload file missing from SHA256SUMS.txt', () => {
    writeFileSync(join(stagingDir, 'listed.bin'), 'listed', 'utf8');
    writeFileSync(join(stagingDir, 'missing.bin'), 'missing', 'utf8');
    writeSums([[sha256('listed'), 'listed.bin']]);

    const result = runChecksums('verify', stagingDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing entry for missing.bin');
  });

  it('reports a checksum entry for a file absent from the payload', () => {
    writeFileSync(join(stagingDir, 'present.bin'), 'present', 'utf8');
    writeSums([
      [sha256('present'), 'present.bin'],
      [sha256('absent'), 'absent.bin'],
    ]);

    const result = runChecksums('verify', stagingDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('entry does not match payload file absent.bin');
  });

  it('reports a hash that does not match its file', () => {
    writeFileSync(join(stagingDir, 'payload.bin'), 'actual bytes', 'utf8');
    writeSums([['0'.repeat(64), 'payload.bin']]);

    const result = runChecksums('verify', stagingDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('hash mismatch for payload.bin');
  });

  it('rejects a self-listed SHA256SUMS.txt', () => {
    writeSums([['0'.repeat(64), 'SHA256SUMS.txt']]);

    const result = runChecksums('verify', stagingDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('must not list SHA256SUMS.txt');
  });

  it.each([
    ['a hash with the wrong width', 'a'.repeat(63) + '  payload.bin'],
    ['one separator space', 'a'.repeat(64) + ' payload.bin'],
    ['a name containing a path separator', 'a'.repeat(64) + '  folder\\payload.bin'],
  ])('rejects %s', (_description, line) => {
    writeFileSync(join(stagingDir, 'payload.bin'), 'payload', 'utf8');
    writeFileSync(join(stagingDir, 'SHA256SUMS.txt'), line + '\n', 'utf8');

    const result = runChecksums('verify', stagingDir);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('malformed entry');
  });
});

describe('checksums.ts chunked hashing', () => {
  it.each([
    ['3 MiB, larger than the hash chunk', 3 * 1024 * 1024],
    ['2 MiB, an exact multiple of the hash chunk', 2 * 1024 * 1024],
    ['4 MiB, an exact multiple of the hash chunk', 4 * 1024 * 1024],
  ])('hashes a %s payload file to the same digest as a single-buffer hash', (_size, bytes) => {
    const payload = Buffer.alloc(bytes);
    for (let index = 0; index < bytes; index += 1) payload[index] = index % 251;
    writeFileSync(join(stagingDir, 'joy-media.zip'), payload);

    const expectedHash = createHash('sha256').update(payload).digest('hex');

    const writeResult = runChecksums('write', stagingDir);
    expect(writeResult.status).toBe(0);
    expect(writeResult.output).toContain('wrote SHA256SUMS.txt for 1 payload file');
    expect(readFileSync(join(stagingDir, 'SHA256SUMS.txt'), 'utf8')).toBe(
      expectedHash + '  joy-media.zip\n',
    );

    const verifyResult = runChecksums('verify', stagingDir);
    expect(verifyResult.status).toBe(0);
    expect(verifyResult.output).toContain('verified 1 payload file');
  });
});

describe('checksums.ts write', () => {
  it('writes hashes for every payload file except SHA256SUMS.txt itself', () => {
    writeFileSync(join(stagingDir, 'joy-media.zip'), 'archive bytes', 'utf8');
    writeFileSync(join(stagingDir, 'joy-media-release-manifest.json'), '{}\n', 'utf8');

    const result = runChecksums('write', stagingDir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(stagingDir, 'SHA256SUMS.txt'), 'utf8')).toBe(
      sha256('{}\n') +
        '  joy-media-release-manifest.json\n' +
        sha256('archive bytes') +
        '  joy-media.zip\n',
    );
    expect(runChecksums('verify', stagingDir).status).toBe(0);
  });
});
