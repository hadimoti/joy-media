import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remuxBrowserMp4, type ExportProbe } from '@joy-media/export-core';

export interface BrowserRemuxResult {
  readonly bytes: Uint8Array;
  readonly probe: ExportProbe;
}

/**
 * Convert a browser-produced MP4 into the server's verified H.264/AAC
 * interchange format. Temporary files are private to this request and are
 * always removed before the call resolves or rejects.
 */
export function remuxBrowserMp4Bytes(
  bytes: Uint8Array,
  frameRate = 30,
  frameCount?: number,
): BrowserRemuxResult {
  if (bytes.byteLength === 0) throw new Error('browser export is empty');
  if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 120)
    throw new Error('browser export frame rate is invalid');
  if (
    frameCount !== undefined &&
    (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount / frameRate > 86_400)
  )
    throw new Error('browser export frame count is invalid');
  const directory = mkdtempSync(join(tmpdir(), 'joy-media-remux-'));
  const inputPath = join(directory, 'browser-input.mp4');
  const outputPath = join(directory, 'joy-export.mp4');
  try {
    writeFileSync(inputPath, bytes);
    const probe = remuxBrowserMp4(inputPath, outputPath, frameRate, frameCount);
    return { bytes: readFileSync(outputPath), probe };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
