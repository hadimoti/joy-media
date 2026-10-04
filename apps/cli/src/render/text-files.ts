import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FfmpegTextFile {
  readonly path: string;
  readonly content: string;
}

export function createFfmpegTextWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'joy-media-text-'));
}

export function writeFfmpegTextFiles(files: readonly FfmpegTextFile[]): void {
  for (const file of files) {
    writeFileSync(file.path, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
}

export function removeFfmpegTextWorkspace(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
