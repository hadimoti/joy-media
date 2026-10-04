/* global process */
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { containsArabicScript } from './text-scripts.js';

export function resolveTextFont(text = '', explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) {
    if (!isFontFile(explicitPath)) throw new Error(`Font file does not exist: ${explicitPath}`);
    return explicitPath;
  }
  const configured = [
    ...(containsArabicScript(text) ? [process.env.JOY_FONT_ARABIC] : []),
    process.env.JOY_FONT,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of configured) {
    if (!isFontFile(candidate)) throw new Error(`Font file does not exist: ${candidate}`);
    return candidate;
  }
  const candidates = [
    process.platform === 'win32' ? 'C:\\Windows\\Fonts\\arial.ttf' : undefined,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (isFontFile(candidate)) return candidate;
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
    if (path && isFontFile(path)) return path;
  }
  return undefined;
}

function isFontFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
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
