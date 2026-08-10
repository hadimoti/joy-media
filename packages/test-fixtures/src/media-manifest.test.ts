import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type ManifestEntry = {
  readonly name: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly durationUs?: number;
};

const mediaRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'media');

describe('WP-29 browser media fixtures', () => {
  it('matches every committed fixture to its manifest digest and size', () => {
    const manifest = JSON.parse(readFileSync(join(mediaRoot, 'manifest.json'), 'utf8')) as {
      readonly version: number;
      readonly files: Record<string, ManifestEntry>;
    };
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.files).sort()).toEqual([
      'audio.mp3',
      'audio.wav',
      'captions-en.srt',
      'captions-fa.vtt',
      'corrupt.mp4',
      'empty.bin',
      'image.jpg',
      'image.png',
      'invalid.txt',
      'joycode-attachment.md',
      'video.mp4',
    ]);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(mediaRoot, name));
      expect(bytes.byteLength, name).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(entry.sha256);
      expect(entry.name, name).toBe(name);
      expect(entry.mimeType.length, name).toBeGreaterThan(0);
      expect(entry.kind.length, name).toBeGreaterThan(0);
    }
    expect(manifest.files['video.mp4']?.durationUs).toBe(3_000_000);
    expect(manifest.files['audio.wav']?.durationUs).toBe(3_000_000);
    expect(manifest.files['audio.mp3']?.durationUs).toBe(3_000_000);
    expect(manifest.files['empty.bin']?.bytes).toBe(0);
  });
});
