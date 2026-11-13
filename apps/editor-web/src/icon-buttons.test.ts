import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-D09 — every icon-only button has an accessible name and a tooltip.
 *
 * An icon-only button shows a glyph and no words, so the name has to come
 * from somewhere else: an aria-label, an aria-labelledby, or a title. The
 * check reads the app's own source, because that is where the buttons live.
 */

/** Every source file of the app. */
const sources = (): readonly { file: string; source: string }[] => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const found: { file: string; source: string }[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${folder}/${entry.name}`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.tsx')) {
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

/** The end of an opening tag, skipping quoted strings and braces. */
function endOfTag(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === '>' && depth === 0) return index;
  }
  return -1;
}

/**
 * The words of an element's children. Words live in a text-bearing element,
 * and the words inside it may come from an expression, so a button that only
 * holds an expression is still a button that shows words.
 */
function childrenText(body: string): string {
  let text = body.replace(
    /<(\w+)[^>]*className\s*=\s*(?:"[^"]*sr-only[^"]*"|'[^']*sr-only[^']*')[^>]*>([\s\S]*?)<\/\1>/g,
    ' $2 ',
  );
  let dynamic = false;
  text = text.replace(
    /<(span|small|strong|label|em|b|p|li|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/g,
    (_match, _name, inner: string) => {
      if (/\{[^{}]*\}/.test(inner)) dynamic = true;
      return ` ${inner} `;
    },
  );
  const withoutElements = text.replace(/<[^>]*>/g, ' ');
  const literals = [...withoutElements.matchAll(/'([^']*)'|"([^"]*)"/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .join(' ');
  const plain = withoutElements
    .replace(/\{[^{}]*\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const found = `${plain} ${literals}`.replace(/\s+/g, ' ').trim();
  return dynamic && found === '' ? 'dynamic' : found;
}

interface IconButton {
  readonly file: string;
  readonly line: number;
  readonly name: boolean;
  readonly tooltip: boolean;
  readonly words: boolean;
}

/** Every icon-only button in the app, and what it has to say about itself. */
function iconOnlyButtons(): readonly IconButton[] {
  const found: IconButton[] = [];

  for (const { file, source } of sources()) {
    const tag = /<(button|a)(?=[\s/>])/g;
    let match: RegExpExecArray | null;
    while ((match = tag.exec(source)) !== null) {
      const open = match.index;
      const name = match[1] ?? 'button';
      const close = endOfTag(source, open + 1 + name.length);
      if (close === -1) continue;
      const attributes = source.slice(open, close);
      const line = source.slice(0, open).split('\n').length;

      let body = '';
      if (!attributes.trimEnd().endsWith('/')) {
        const closeTag = new RegExp(`</${name}>`, 'g');
        closeTag.lastIndex = close + 1;
        const end = closeTag.exec(source);
        if (end !== null) body = source.slice(close + 1, end.index);
      }
      const words = childrenText(body);
      const holdsGlyph = /<svg[\s/>]/.test(body) || /<[A-Z]\w*Icon\s*\/?>/.test(body);

      const className = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/.exec(attributes);
      const classes = (className?.[1] ?? className?.[2] ?? className?.[3] ?? '')
        .split(/\s+/)
        .filter((name) => name !== '');
      const wearsIconShape = classes.some(
        (name) =>
          name === 'icon-button' ||
          name === 'icon-tool' ||
          name.startsWith('icon-button-') ||
          name.startsWith('icon-tool-'),
      );
      // A labelled button shows its own name, so it is not icon-only.
      const labelled = classes.includes('icon-button-labeled');

      if (!wearsIconShape && !(holdsGlyph && words === '')) continue;
      if (labelled || words !== '') continue;

      const ariaLabel = /aria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(attributes);
      const title = /title\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/.exec(attributes);
      const hasAria =
        ariaLabel !== null && (ariaLabel[1] ?? ariaLabel[2] ?? ariaLabel[3] ?? '').trim() !== '';
      const hasTitle = title !== null && (title[1] ?? title[2] ?? title[3] ?? '').trim() !== '';
      const labelledBy = /aria-labelledby\s*=/.test(attributes);
      // The app draws its own hover guide from data-guide, so that counts as
      // a tooltip alongside the native title attribute.
      const hasGuide = /data-guide\s*=/.test(attributes);

      found.push({
        file,
        line,
        name: hasAria || hasTitle || labelledBy,
        tooltip: hasTitle || hasGuide,
        words: false,
      });
      tag.lastIndex = close + 1;
    }
  }

  return found;
}

describe('every icon-only button (T-D09)', () => {
  it('gives every icon-only button an accessible name', () => {
    const buttons = iconOnlyButtons();
    expect(
      buttons.length,
      'the scope must find the icon-only buttons it is meant to check',
    ).toBeGreaterThan(100);

    const offenders = buttons
      .filter((button) => !button.name)
      .map((button) => `${button.file}:${button.line}`);
    expect(offenders, 'every icon-only button needs a name').toEqual([]);
  });

  it('gives every icon-only button a tooltip', () => {
    const buttons = iconOnlyButtons();
    const offenders = buttons
      .filter((button) => !button.tooltip)
      .map((button) => `${button.file}:${button.line}`);
    expect(offenders, 'every icon-only button needs a tooltip').toEqual([]);
  });
});
