import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-M12: every Monitor button has a name and a tooltip. The check reads the
 * JSX of each Monitor component and takes every `<button` opening tag with its
 * children; it does not render the panels.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface ButtonTag {
  readonly file: string;
  readonly line: number;
  readonly opening: string;
  readonly children: string;
}

/** The opening tag ends at the `>` that is outside braces and quotes. */
function openingTagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return index;
  }
  return -1;
}

function buttonsIn(file: string): readonly ButtonTag[] {
  const source = readFileSync(join(here, file), 'utf8');
  const found: ButtonTag[] = [];
  let at = source.indexOf('<button');
  while (at >= 0) {
    const end = openingTagEnd(source, at);
    if (end < 0) break;
    const opening = source.slice(at, end + 1);
    const close = source.indexOf('</button>', end);
    const children = close < 0 ? '' : source.slice(end + 1, close);
    const line = source.slice(0, at).split('\n').length;
    if (!opening.endsWith('/>')) found.push({ file, line, opening, children });
    at = source.indexOf('<button', end + 1);
  }
  return found;
}

/** The text a button shows, with JSX expressions counted as text (their value is a label). */
function visibleText(children: string): string {
  return children
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const monitorFiles = readdirSync(here).filter(
  (name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'),
);
const buttons = monitorFiles.flatMap((file) => buttonsIn(file));

describe('Monitor buttons have a name and a tooltip (T-M12)', () => {
  it('finds the Monitor buttons to check', () => {
    expect(buttons.length).toBeGreaterThan(20);
  });

  it('every button has a tooltip (title)', () => {
    const missing = buttons
      .filter((button) => !/\btitle=/.test(button.opening))
      .map((button) => `${button.file}:${button.line}`);
    expect(missing).toEqual([]);
  });

  it('every button has a name: an aria-label or visible text', () => {
    const unnamed = buttons
      .filter(
        (button) =>
          !/\baria-label=/.test(button.opening) &&
          visibleText(button.children).length === 0 &&
          !/\{[^}]*\}/.test(button.children),
      )
      .map((button) => `${button.file}:${button.line}`);
    expect(unnamed).toEqual([]);
  });
});
