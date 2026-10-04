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

/** Escape a filesystem path through drawtext's option parser and the filtergraph parser. */
export function escapeFilterPath(path: string): string {
  if (
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error('FFmpeg paths cannot contain control characters.');
  const normalized = path.replace(/\\/g, '/');
  const optionEscaped = [...normalized]
    .map((character) =>
      character === "'" || character === ':' || character === '\\' ? `\\${character}` : character,
    )
    .join('');
  return [...optionEscaped]
    .map((character) =>
      character === '\\' ||
      character === "'" ||
      character === '[' ||
      character === ']' ||
      character === ',' ||
      character === ';'
        ? `\\${character}`
        : character,
    )
    .join('');
}
