import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTextFont } from './text-font.js';

describe('text font selection', () => {
  it('prefers JOY_FONT_ARABIC for Arabic text and validates explicit paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-text-font-'));
    const arabic = join(dir, 'arabic.ttf');
    const general = join(dir, 'general.ttf');
    const oldValues = {
      JOY_FONT: process.env.JOY_FONT,
      JOY_FONT_ARABIC: process.env.JOY_FONT_ARABIC,
    };
    try {
      writeFileSync(arabic, 'font');
      writeFileSync(general, 'font');
      process.env.JOY_FONT = general;
      process.env.JOY_FONT_ARABIC = arabic;
      expect(resolveTextFont('سلام')).toBe(arabic);
      expect(resolveTextFont('Joy Media')).toBe(general);
      expect(() => resolveTextFont('', join(dir, 'missing.ttf'))).toThrow(
        'Font file does not exist',
      );
    } finally {
      if (oldValues.JOY_FONT === undefined) delete process.env.JOY_FONT;
      else process.env.JOY_FONT = oldValues.JOY_FONT;
      if (oldValues.JOY_FONT_ARABIC === undefined) delete process.env.JOY_FONT_ARABIC;
      else process.env.JOY_FONT_ARABIC = oldValues.JOY_FONT_ARABIC;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
