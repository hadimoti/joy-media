import { describe, expect, it } from 'vitest';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import type { TextNode } from '@joy-media/render-ir';
import { validateRenderFrameIR } from '@joy-media/render-ir';
import {
  breakCaptionLines,
  DEFAULT_CAPTION_TEMPLATE_ID,
  JOY_CAPTION_TEMPLATES,
  layoutTemplatedCaptionNodes,
  resolveCaptionTemplate,
} from './index.js';
import type { CaptionCue } from './index.js';

const words = {
  w1: { id: 'w1', text: 'JOY', startUs: 0, endUs: 500_000 },
  w2: { id: 'w2', text: 'makes', startUs: 500_000, endUs: 1_000_000 },
  w3: { id: 'w3', text: 'captions', startUs: 1_000_000, endUs: 1_500_000 },
  w4: { id: 'w4', text: 'sing', startUs: 1_500_000, endUs: 2_000_000 },
} as const;

function cue(overrides: Partial<CaptionDocumentV1> = {}, documentTimeUs = 700_000): CaptionCue {
  const document: CaptionDocumentV1 = {
    id: 'doc',
    language: 'en-US',
    direction: 'auto',
    speakers: [],
    words,
    segments: [{ id: 'seg', startUs: 0, endUs: 2_000_000, wordIds: ['w1', 'w2', 'w3', 'w4'] }],
    ...overrides,
  };
  return {
    clipId: 'clip',
    documentId: document.id,
    document,
    segment: document.segments[0]!,
    documentTimeUs,
  };
}

const viewport = { viewportWidth: 1080, viewportHeight: 1920 };

describe('template registry', () => {
  it('ships at least three original templates with unique ids', () => {
    expect(JOY_CAPTION_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(JOY_CAPTION_TEMPLATES.map((t) => t.id)).size).toBe(JOY_CAPTION_TEMPLATES.length);
  });
  it('falls back to the default template for unknown or missing styleRefs', () => {
    expect(resolveCaptionTemplate(undefined).id).toBe(DEFAULT_CAPTION_TEMPLATE_ID);
    expect(resolveCaptionTemplate('nope').id).toBe(DEFAULT_CAPTION_TEMPLATE_ID);
    expect(resolveCaptionTemplate('joy-rtl-classic').id).toBe('joy-rtl-classic');
  });
});

describe('line breaking', () => {
  it('wraps greedily by character budget without dropping words', () => {
    const lines = breakCaptionLines(['aaaa', 'bbbb', 'cccc', 'dd'], 9);
    expect(lines.map((line) => line.text)).toEqual(['aaaa bbbb', 'cccc dd']);
    expect(lines.flatMap((line) => line.wordIndices)).toEqual([0, 1, 2, 3]);
  });
});

describe('templated layout', () => {
  it('emits safe-area-bounded, plated, sized lines that validate as Render IR', () => {
    const nodes = layoutTemplatedCaptionNodes([cue()], viewport) as readonly TextNode[];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.fontSizePx).toBeCloseTo(0.045 * 1920);
      expect(node.background).toBeDefined();
      expect(node.transform.translateY).toBeGreaterThanOrEqual(1920 * 0.1);
      expect(node.transform.translateY).toBeLessThanOrEqual(1920 * 0.9);
    }
    validateRenderFrameIR({
      version: 1,
      compositionId: 'root',
      timeUs: 0,
      viewport: { width: 1080, height: 1920, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes,
    });
  });

  it('shrinks the font instead of dropping text when lines exceed the template budget', () => {
    const longWords = Object.fromEntries(
      Array.from({ length: 24 }, (_, i) => [
        `w${i}`,
        { id: `w${i}`, text: 'wordy', startUs: i * 1_000, endUs: (i + 1) * 1_000 },
      ]),
    );
    const longCue = cue({
      words: longWords,
      segments: [
        {
          id: 'seg',
          startUs: 0,
          endUs: 24_000,
          wordIds: Object.keys(longWords),
        },
      ],
    });
    const nodes = layoutTemplatedCaptionNodes([longCue], viewport) as readonly TextNode[];
    const joined = nodes.map((node) => node.text).join(' ');
    expect(joined.split(/\s+/)).toHaveLength(24); // nothing dropped
    expect(nodes[0]!.fontSizePx).toBeLessThan(0.045 * 1920); // responsive shrink
  });

  it('marks the active word with karaoke spans that concatenate exactly', () => {
    const karaokeCue = cue({ styleRef: 'joy-karaoke-pop' }, 700_000); // w2 active
    const nodes = layoutTemplatedCaptionNodes([karaokeCue], viewport) as readonly TextNode[];
    const withSpans = nodes.find((node) => node.spans !== undefined);
    expect(withSpans).toBeDefined();
    expect(withSpans!.spans!.map((span) => span.text).join('')).toBe(withSpans!.text);
    const active = withSpans!.spans!.find((span) => span.emphasis === true);
    expect(active?.text).toBe('makes');
    expect(active?.color).toEqual({ r: 233, g: 185, b: 73, a: 255 });
  });

  it('disables karaoke under a display override because word mapping is broken', () => {
    const overridden = cue({
      styleRef: 'joy-karaoke-pop',
      segments: [
        {
          id: 'seg',
          startUs: 0,
          endUs: 2_000_000,
          wordIds: ['w1', 'w2', 'w3', 'w4'],
          textOverride: 'JOY sings captions',
        },
      ],
    });
    const nodes = layoutTemplatedCaptionNodes([overridden], viewport) as readonly TextNode[];
    expect(nodes.every((node) => node.spans === undefined)).toBe(true);
    expect(nodes.map((n) => n.text).join(' ')).toBe('JOY sings captions');
  });

  it('resolves logical start alignment against the document direction (§33.4)', () => {
    const rtl = cue({
      styleRef: 'joy-rtl-classic',
      language: 'fa-IR',
      words: { p1: { id: 'p1', text: 'سلام', startUs: 0, endUs: 2_000_000 } },
      segments: [{ id: 'seg', startUs: 0, endUs: 2_000_000, wordIds: ['p1'] }],
    });
    const nodes = layoutTemplatedCaptionNodes([rtl], viewport) as readonly TextNode[];
    expect(nodes[0]!.direction).toBe('rtl');
    expect(nodes[0]!.align).toBe('right');

    const ltr = cue({ styleRef: 'joy-rtl-classic' });
    const ltrNodes = layoutTemplatedCaptionNodes([ltr], viewport) as readonly TextNode[];
    // Logical 'start' resolves to the left edge for LTR documents.
    expect(ltrNodes[0]!.align).toBe('left');
  });
});
