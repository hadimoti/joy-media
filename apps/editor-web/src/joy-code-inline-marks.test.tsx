import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  JoyCodeInlineText,
  parseJoyCodeInlineMarks,
  type JoyCodeInlineNode,
} from './joy-code-inline-marks.js';

function html(text: string): string {
  return renderToStaticMarkup(<JoyCodeInlineText text={text} />);
}

describe('parseJoyCodeInlineMarks', () => {
  it('turns **bold** into a strong node', () => {
    expect(parseJoyCodeInlineMarks('Made by **JOY** today')).toEqual([
      { kind: 'text', text: 'Made by ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'JOY' }] },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('turns *italic* and _italic_ into em nodes', () => {
    expect(parseJoyCodeInlineMarks('a *b* and _c_')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'em', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'em', children: [{ kind: 'text', text: 'c' }] },
    ]);
  });

  it('turns inline `code` into a code node, and marks inside it stay literal', () => {
    expect(parseJoyCodeInlineMarks('run `**x**` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: '**x**' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('nests italic inside bold and bold inside italic', () => {
    expect(parseJoyCodeInlineMarks('**bold *inner* end**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', text: 'bold ' },
          { kind: 'em', children: [{ kind: 'text', text: 'inner' }] },
          { kind: 'text', text: ' end' },
        ],
      },
    ]);
    expect(parseJoyCodeInlineMarks('*outer **inner** end*')).toEqual([
      {
        kind: 'em',
        children: [
          { kind: 'text', text: 'outer ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'inner' }] },
          { kind: 'text', text: ' end' },
        ],
      },
    ]);
  });

  it('keeps unbalanced marks as plain text', () => {
    for (const text of ['**open only', 'a * b * c', 'snake_case_name', '**a and *b', '****']) {
      expect(parseJoyCodeInlineMarks(text)).toEqual([{ kind: 'text', text }]);
    }
  });

  it('keeps a link or an image as plain text', () => {
    const text = 'See [the site](https://example.com) and ![pic](a.png)';
    expect(parseJoyCodeInlineMarks(text)).toEqual([{ kind: 'text', text }]);
  });

  it('keeps HTML as plain text', () => {
    expect(parseJoyCodeInlineMarks('<script>alert(1)</script>')).toEqual([
      { kind: 'text', text: '<script>alert(1)</script>' },
    ]);
  });
});

describe('JoyCodeInlineText', () => {
  it('renders bold, italic and code elements', () => {
    expect(html('**JOY** *edit* `clip`')).toBe(
      '<strong>JOY</strong> <em>edit</em> <code>clip</code>',
    );
  });

  it('renders <script> as escaped text, never as an element', () => {
    const markup = html('**hi** <script>alert(1)</script>');
    expect(markup).toBe('<strong>hi</strong> &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<script');
  });

  it('keeps unbalanced marks visible as written', () => {
    expect(html('**open *x')).toBe('**open *x');
  });

  it('does not produce a node for an empty mark', () => {
    const nodes: JoyCodeInlineNode[] = parseJoyCodeInlineMarks('** ** and __');
    expect(nodes.every((node) => node.kind === 'text')).toBe(true);
  });
});
