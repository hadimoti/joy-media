import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8');

// These are the shell section roots whose colors must come from the shared
// token surface. Experimental/themed islands intentionally remain opt-in:
// their internal palettes are not evidence that the editor shell is tokenized.
const shellSections = [
  ':root',
  '.app-header',
  '.workspace',
  '.joy-panel-root',
  '.timeline-panel',
  '.monitor-panel',
  '.shortcuts-overlay',
  '.shortcuts-panel',
] as const;

const themedIsland = /(?:^|[.#])(?:dual-|three-d-studio-|es-)/;
const rawColor = /(?:#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\([^)]*\)|\b(?:white|black)\b)/i;

function declarationsFor(
  selector: string,
): Array<{ readonly body: string; readonly line: number }> {
  // :root is the intentional token declaration surface; raw values are
  // allowed there and are what the shell contract requires consumers to use.
  if (selector === ':root') return [];
  const declarations: Array<{ readonly body: string; readonly line: number }> = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const selectors =
      match[1]
        ?.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    if (selectors.includes(selector) && !selectors.some((value) => themedIsland.test(value))) {
      declarations.push({
        body: match[2] ?? '',
        line: css.slice(0, match.index ?? 0).split('\n').length,
      });
    }
  }
  return declarations;
}

describe('editor shell CSS color contract', () => {
  it('keeps shell section colors on variables, with root token declarations as the sole raw-color source', () => {
    const violations = shellSections.flatMap((selector) =>
      declarationsFor(selector)
        .flatMap(({ body }) => body.split(';'))
        .filter((declaration) => !declaration.trim().startsWith('--') && rawColor.test(declaration))
        .map((declaration) => `${selector}: ${declaration.trim()}`),
    );
    expect(violations).toEqual([]);
    for (const selector of shellSections.slice(1)) {
      const ranges = declarationsFor(selector);
      expect(ranges, `missing targeted shell section ${selector}`).not.toEqual([]);
      expect(ranges.every(({ line }) => line > 0)).toBe(true);
    }
    expect(css).toMatch(/:root\s*\{[\s\S]*--joy-bg-app:/);
  });

  it('documents the bounded themed-island exception instead of claiming a file-wide ban', () => {
    expect(css).toMatch(/\.dual-/);
    expect(css).toMatch(/\.three-d-studio-/);
    expect(css).toMatch(/\.es-/);
  });
});
