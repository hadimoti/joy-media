import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { MediaKind } from '../store/local-database.js';

export interface MediaProbe {
  readonly checksum: string;
  readonly byteSize: number;
}

/** Streaming SHA-256 so probing a large video never holds the whole file in memory. */
export function checksumFile(path: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let byteSize = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      byteSize += bytes.length;
      hash.update(bytes);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ checksum: hash.digest('hex'), byteSize }));
  });
}

const KIND_BY_EXTENSION: Readonly<Record<string, MediaKind>> = {
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  avi: 'video',
  mp3: 'audio',
  wav: 'audio',
  aac: 'audio',
  flac: 'audio',
  ogg: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
};

/** Extension-based classification only — the Worker owns real probing/demuxing (see README).
 * This exists so the media manifest has a usable `kind` before the Worker has probed a file. */
export function classifyMediaKind(path: string): MediaKind {
  const match = /\.([^.\\/]+)$/.exec(path);
  const extension = match?.[1]?.toLowerCase();
  return (extension !== undefined && KIND_BY_EXTENSION[extension]) || 'other';
}

/** Confirms the file this ref points at still exists and matches its last recorded checksum. */
export async function fileExistsWithSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}
