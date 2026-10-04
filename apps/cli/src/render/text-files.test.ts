import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFfmpegTextWorkspace,
  removeFfmpegTextWorkspace,
  writeFfmpegTextFiles,
} from './text-files.js';

describe('ffmpeg text file workspace', () => {
  it('writes literal UTF-8 text with private permissions and removes the workspace', () => {
    const directory = createFfmpegTextWorkspace();
    const path = join(directory, 'caption.txt');
    try {
      writeFfmpegTextFiles([{ path, content: "it's 50%: a,b;[c]" }]);
      expect(readFileSync(path, 'utf8')).toBe("it's 50%: a,b;[c]");
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      removeFfmpegTextWorkspace(directory);
    }
    expect(existsSync(directory)).toBe(false);
  });
});
