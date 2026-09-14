import { describe, expect, it } from 'vitest';
import { buildManifest, sha256Hex, verifyManifest } from './manifest.js';
import type { ArchiveEntry } from './manifest.js';

function entry(name: string, text: string): ArchiveEntry {
  return { name, bytes: Buffer.from(text, 'utf8') };
}

describe('buildManifest', () => {
  it('records a sha256, byte length, and total for every entry', () => {
    const manifest = buildManifest([entry('a.txt', 'hello'), entry('b.txt', 'world!')], () => 'T0');
    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: 'T0',
      entryCount: 2,
      totalByteLength: 5 + 6,
    });
    expect(manifest.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt']);
    expect(manifest.entries[0]!.sha256).toBe(sha256Hex(Buffer.from('hello', 'utf8')));
  });

  it('sorts entries by name regardless of input order', () => {
    const manifest = buildManifest([entry('z.txt', '1'), entry('a.txt', '2')]);
    expect(manifest.entries.map((e) => e.name)).toEqual(['a.txt', 'z.txt']);
  });

  it('produces an empty-but-valid manifest for zero entries', () => {
    const manifest = buildManifest([], () => 'T0');
    expect(manifest).toMatchObject({ entryCount: 0, totalByteLength: 0, entries: [] });
  });

  it('produces the same manifestChecksum for the same content regardless of input order', () => {
    const a = buildManifest([entry('a.txt', '1'), entry('b.txt', '2')], () => 'T0');
    const b = buildManifest([entry('b.txt', '2'), entry('a.txt', '1')], () => 'T0');
    expect(a.manifestChecksum).toBe(b.manifestChecksum);
  });

  it('changes the manifestChecksum if any single byte changes', () => {
    const a = buildManifest([entry('a.txt', 'hello')], () => 'T0');
    const b = buildManifest([entry('a.txt', 'hellp')], () => 'T0');
    expect(a.manifestChecksum).not.toBe(b.manifestChecksum);
  });
});

describe('verifyManifest', () => {
  it('accepts an unmodified archive against its own manifest', () => {
    const entries = [entry('a.txt', 'hello'), entry('b.txt', 'world!')];
    const manifest = buildManifest(entries, () => 'T0');
    expect(verifyManifest(entries, manifest)).toEqual({ ok: true });
  });

  it('rejects a single entry with tampered bytes', () => {
    const entries = [entry('a.txt', 'hello')];
    const manifest = buildManifest(entries, () => 'T0');
    const tampered = [entry('a.txt', 'HELLO')];
    const result = verifyManifest(tampered, manifest);
    expect(result.ok).toBe(false);
  });

  it('rejects a missing entry', () => {
    const entries = [entry('a.txt', '1'), entry('b.txt', '2')];
    const manifest = buildManifest(entries, () => 'T0');
    const result = verifyManifest([entry('a.txt', '1')], manifest);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/count/);
  });

  it('rejects an extra, unlisted entry', () => {
    const entries = [entry('a.txt', '1')];
    const manifest = buildManifest(entries, () => 'T0');
    const result = verifyManifest([entry('a.txt', '1'), entry('b.txt', '2')], manifest);
    expect(result.ok).toBe(false);
  });

  it('rejects a manifest claiming an unsupported format version', () => {
    const entries = [entry('a.txt', '1')];
    const manifest = { ...buildManifest(entries), formatVersion: 2 as unknown as 1 };
    expect(verifyManifest(entries, manifest).ok).toBe(false);
  });

  it('rejects a manifest whose own checksum was tampered with, even if every entry still matches', () => {
    const entries = [entry('a.txt', '1')];
    const manifest = buildManifest(entries, () => 'T0');
    const tampered = { ...manifest, manifestChecksum: 'f'.repeat(64) };
    expect(verifyManifest(entries, tampered).ok).toBe(false);
  });
});
