/* global process */
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function resolveTextFont(): string | undefined {
  const candidates = [
    process.env.JOY_FONT,
    process.platform === 'win32' ? 'C:\\Windows\\Fonts\\arial.ttf' : undefined,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next known path.
    }
  }
  if (process.platform !== 'win32') {
    const match = spawnSync('fc-match', ['-f', '%{file}', 'DejaVu Sans'], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    const path = match.status === 0 ? match.stdout.trim() : '';
    if (path && existsSync(path) && statSync(path).isFile()) return path;
  }
  return undefined;
}

export function escapeDrawtextValue(value: string): string {
  const escaped = new Set(['\\', ':', "'", '%', ',', '[', ']', ';']);
  return [...value]
    .map((character) => (escaped.has(character) ? `\\${character}` : character))
    .join('')
    .replace(/\r?\n/g, '\\n');
}
