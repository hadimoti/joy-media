import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-D09 — the three text roles.
 *
 * The app has exactly three text roles: primary, secondary and faint. A
 * fourth name once sat next to secondary and carried the same colour, so a
 * reader could not tell the two apart. The check below reads the tokens out
 * of app.css and holds the app to that count, and holds the two roles that
 * carry meaning to a readable contrast on the panel background.
 */

const sourceOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const APP_CSS = './app.css';

/** Every stylesheet the app ships. */
const stylesheets = (): readonly string[] => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return readdirSync(here)
    .filter((name) => name.endsWith('.css'))
    .map((name) => `./${name}`);
};

/** A stylesheet without its comments: a comment names no token. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the `:root` block, read as a token table. */
function rootTokens(css: string): Map<string, string> {
  const clean = withoutComments(css);
  const start = clean.indexOf(':root');
  expect(start, 'app.css must declare a :root block').toBeGreaterThan(-1);
  const open = clean.indexOf('{', start);
  const close = clean.indexOf('}', open);
  const tokens = new Map<string, string>();
  for (const declaration of clean.slice(open + 1, close).split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (name.startsWith('--joy-')) tokens.set(name, value);
  }
  return tokens;
}

/** A `#rgb` or `#rrggbb` colour as its three channels. */
function channelsOf(value: string): [number, number, number] {
  const hex = value.trim().replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : hex;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** The relative luminance of a colour, as WCAG 2.1 defines it. */
function luminanceOf(value: string): number {
  const [r, g, b] = channelsOf(value);
  const linear = (channel: number): number => {
    const share = channel / 255;
    return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The contrast ratio between two colours, as WCAG 2.1 defines it. */
function contrastBetween(foreground: string, background: string): number {
  const lighter = Math.max(luminanceOf(foreground), luminanceOf(background));
  const darker = Math.min(luminanceOf(foreground), luminanceOf(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const tokens = rootTokens(sourceOf(APP_CSS));

describe('the three text roles (T-D09)', () => {
  it('declares primary, secondary and faint, and nothing else', () => {
    const textTokens = [...tokens.keys()].filter((name) => name.startsWith('--joy-text')).sort();

    expect(textTokens).toEqual([
      '--joy-text',
      '--joy-text-disabled',
      '--joy-text-faint',
      '--joy-text-secondary',
    ]);
  });

  it('has no fourth role hiding beside secondary', () => {
    expect(tokens.has('--joy-text-muted')).toBe(false);

    const offenders: string[] = [];
    for (const stylesheet of stylesheets()) {
      const source = sourceOf(stylesheet);
      if (source.includes('--joy-text-muted')) offenders.push(stylesheet);
    }
    expect(offenders, 'no stylesheet may use the retired muted role').toEqual([]);
  });

  it('keeps the three roles apart, so a reader can tell them apart', () => {
    const primary = tokens.get('--joy-text');
    const secondary = tokens.get('--joy-text-secondary');
    const faint = tokens.get('--joy-text-faint');
    expect(primary).toBeTruthy();
    expect(secondary).toBeTruthy();
    expect(faint).toBeTruthy();

    expect(luminanceOf(primary!)).toBeGreaterThan(luminanceOf(secondary!));
    expect(luminanceOf(secondary!)).toBeGreaterThan(luminanceOf(faint!));
  });

  it('names no text role that does not exist', () => {
    // A role that is used but never declared paints nothing at all, so the
    // text falls back to whatever the element inherits. Every --joy-text-*
    // a stylesheet names has to be one of the roles above.
    const declared = new Set([...tokens.keys()].filter((name) => name.startsWith('--joy-text')));
    const offenders: string[] = [];

    for (const stylesheet of stylesheets()) {
      const source = sourceOf(stylesheet);
      for (const match of source.matchAll(/var\(\s*(--joy-text[\w-]*)/g)) {
        const name = match[1] ?? '';
        if (!declared.has(name)) offenders.push(`${stylesheet} names ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('holds the three roles to their measured contrast on the panel background', () => {
    const panel = tokens.get('--joy-bg-panel');
    expect(panel, 'the panel background must be a token').toBeTruthy();

    // The measured ratios, on the panel background. All three clear 4.5:1
    // with room to spare, and they are pinned here so a change to a token
    // cannot quietly change them.
    const measured: readonly { role: string; token: string; ratio: number }[] = [
      { role: 'primary', token: '--joy-text', ratio: 14.22 },
      { role: 'secondary', token: '--joy-text-secondary', ratio: 7.52 },
      { role: 'faint', token: '--joy-text-faint', ratio: 5.21 },
    ];

    for (const { role, token, ratio } of measured) {
      const value = tokens.get(token);
      expect(value, `${token} must be a token`).toBeTruthy();
      const computed = contrastBetween(value as string, panel as string);
      expect(computed, `${role} on the panel background`).toBeGreaterThanOrEqual(4.5);
      expect(computed, `${role} on the panel background`).toBeCloseTo(ratio, 1);
    }
  });
});
