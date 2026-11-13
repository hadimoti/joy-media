import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-D09 — the type floor.
 *
 * The app's type scale starts at 11 px, and 11 px is only for an uppercase
 * label. Everything a reader has to read is 12 px or more. The check reads
 * every stylesheet the app ships and holds that floor.
 */

const sourceOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/** Every stylesheet the app ships, by folder. */
const stylesheets = (): readonly { file: string; source: string }[] => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const found: { file: string; source: string }[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${folder}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.css')) {
        found.push({
          file: `${prefix}${entry.name}`,
          source: readFileSync(`${folder}/${entry.name}`, 'utf8'),
        });
      }
    }
  };
  walk(here, '');
  return found;
};

const REM = 16;
const TYPE_TOKENS: Readonly<Record<string, number>> = {
  '--joy-type-2xs': 11,
  '--joy-type-xs': 12,
  '--joy-type-sm': 13,
  '--joy-type-md': 14,
};

/** The size of a font-size value in pixels, or null when it is not a plain size. */
function pixelsOf(value: string): number | null {
  const clean = value
    .trim()
    .replace(/!important$/i, '')
    .trim();
  const token = /^var\(\s*(--joy-type-[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(clean);
  if (token !== null) {
    const known = TYPE_TOKENS[token[1] ?? ''];
    if (known !== undefined) return known;
    return token[2] === undefined ? null : pixelsOf(token[2]);
  }
  if (clean.endsWith('rem')) return parseFloat(clean) * REM;
  if (clean.endsWith('px')) return parseFloat(clean);
  if (clean.endsWith('pt')) return (parseFloat(clean) * 96) / 72;
  return null;
}

/** A stylesheet without its comments: a comment names no size. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule {
  readonly selector: string;
  readonly body: string;
}

/** The rules of a stylesheet, including the ones inside a media query. */
function rulesOf(source: string): Rule[] {
  const text = withoutComments(source);
  const found: Rule[] = [];
  const stack: number[] = [];
  let lastClose = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') stack.push(index);
    else if (text[index] === '}' && stack.length > 0) {
      const open = stack.pop() as number;
      const inner = text.slice(open + 1, index);
      if (!inner.includes('{')) {
        found.push({
          selector: text.slice(lastClose, open).trim().replace(/\s+/g, ' '),
          body: inner,
        });
      }
      lastClose = index + 1;
    }
  }
  return found;
}

/** The selectors that turn their text uppercase, so their children inherit it. */
const uppercaseSelectors = new Set(
  stylesheets()
    .flatMap((sheet) => rulesOf(sheet.source))
    .filter((rule) => /text-transform:\s*uppercase/i.test(rule.body))
    .flatMap((rule) => rule.selector.split(',').map((part) => part.trim()))
    .filter((part) => part !== ''),
);

/** Does this rule sit under a selector that turns its text uppercase? */
function isUppercase(rule: Rule): boolean {
  if (/text-transform:\s*uppercase/i.test(rule.body)) return true;
  const parts = rule.selector.split(',')[0]?.trim().split(/\s+/) ?? [];
  for (let take = 1; take <= parts.length; take += 1) {
    if (uppercaseSelectors.has(parts.slice(0, take).join(' '))) return true;
  }
  return false;
}

describe('the type floor (T-D09)', () => {
  it('keeps every readable size at 12 px, and 11 px only for uppercase labels', () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const sheet of stylesheets()) {
      for (const rule of rulesOf(sheet.source)) {
        for (const match of rule.body.matchAll(/font-size:\s*([^;]+);/g)) {
          const raw = (match[1] ?? '').trim();
          const pixels = pixelsOf(raw);
          // A size the reader never sees (a hidden label, an icon box) and a
          // size the reader does see are two different things.
          if (pixels === null || pixels === 0) continue;
          checked += 1;
          if (pixels >= 12) continue;
          if (pixels === 11 && isUppercase(rule)) continue;
          offenders.push(`${sheet.file}: ${rule.selector} { font-size: ${raw} } is ${pixels}px`);
        }
      }
    }

    expect(checked, 'the app must have font sizes to check').toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  it('keeps the two steps on the scale the app declares', () => {
    const appCss = sourceOf('./app.css');
    expect(appCss).toContain('--joy-type-2xs: 0.6875rem');
    expect(appCss).toContain('--joy-type-xs: 0.75rem');
  });
});
