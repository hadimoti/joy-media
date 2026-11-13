import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

const CLIP_TYPE_COLOURS = [
  { kind: 'video', colour: '#5b8def' },
  { kind: 'audio', colour: '#3cc8b4' },
  { kind: 'text', colour: '#c4b5fd' },
  { kind: 'effect', colour: '#fb7185' },
] as const;

/** Declarations of the rule whose selector is exactly `selector`. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = appCss.match(new RegExp(`(?:^|\\n)${escaped} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1]?.trim() ?? '';
}

/** Declarations of the shared fill rule that lists all four typed clip classes. */
function sharedFillDeclarations(): string {
  const match = appCss.match(
    /\.timeline-clip--video,\n\.timeline-clip--audio,\n\.timeline-clip--text,\n\.timeline-clip--effect \{([\s\S]*?)\n\}/,
  );
  return match?.[1]?.trim() ?? '';
}

describe('Clip colour by type (T-D11)', () => {
  it.each(CLIP_TYPE_COLOURS)('$kind clips carry the $colour type colour', ({ kind, colour }) => {
    expect(declarationsOf(`.timeline-clip--${kind}`)).toBe(`--clip-type: ${colour};`);
  });

  it.each(CLIP_TYPE_COLOURS)('$kind clip rule snapshot', ({ kind }) => {
    expect({
      typeRule: declarationsOf(`.timeline-clip--${kind}`),
      sharedFill: sharedFillDeclarations(),
    }).toMatchSnapshot();
  });

  it('fills every typed clip with a 28 percent tint of its colour', () => {
    expect(sharedFillDeclarations()).toContain(
      '--clip-tint: color-mix(in srgb, var(--clip-type) 28%, var(--joy-bg-raised));',
    );
  });

  it('draws the typed clip rail in full colour, not the track label colour', () => {
    expect(sharedFillDeclarations()).toContain('--clip-rail-fill: var(--clip-type);');
    expect(declarationsOf('.timeline-clip::before')).toContain('--clip-rail-fill,');
  });

  it('paints the video filmstrip cells, text and effect surfaces with the tint', () => {
    expect(declarationsOf('.timeline-clip--video .timeline-clip-cell')).toContain(
      'var(--clip-tint)',
    );
    expect(declarationsOf('.timeline-clip--text .timeline-clip-kind-surface')).toContain(
      'var(--clip-tint)',
    );
    expect(declarationsOf('.timeline-clip--effect .timeline-clip-kind-surface')).toContain(
      'var(--clip-tint)',
    );
  });

  it('keeps the tint on hover', () => {
    const hover = appCss.match(
      /\.timeline-clip--video:hover,\n\.timeline-clip--audio:hover,\n\.timeline-clip--text:hover,\n\.timeline-clip--effect:hover \{([\s\S]*?)\n\}/,
    );
    expect(hover?.[1]).toContain('var(--clip-tint)');
  });

  it('keeps the selection outline gold', () => {
    expect(declarationsOf(".timeline-clip[aria-pressed='true']")).toContain(
      'outline: 2px solid var(--joy-accent);',
    );
  });
});
