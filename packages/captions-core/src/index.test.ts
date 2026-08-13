import { describe, expect, it } from 'vitest';
import {
  canonicalBindingKey,
  IDENTITY_CAPTION_CLIP_STYLE,
  type CaptionDocumentV1,
  type CompositionV1,
} from '@joy-media/project-schema';
import type { TextNode } from '@joy-media/render-ir';
import {
  activeCaptionSegments,
  activeCaptionWord,
  captionCuesAt,
  layoutCaptionNodes,
  layoutTemplatedCaptionNodes,
  resolveCaptionDirection,
  segmentDisplayText,
  segmentSourceText,
} from './index.js';

/** Persian/mixed-script fixture: RTL tokens, a Latin brand word, and an emoji. */
const persianDocument: CaptionDocumentV1 = {
  id: 'doc-fa',
  language: 'fa-IR',
  direction: 'auto',
  speakers: [{ id: 'narrator', name: 'راوی' }],
  words: {
    w1: { id: 'w1', text: 'سلام', startUs: 0, endUs: 700_000, confidence: 0.94 },
    w2: { id: 'w2', text: 'دنیا', startUs: 700_000, endUs: 1_400_000, confidence: 0.9 },
    w3: { id: 'w3', text: 'JOY', startUs: 1_400_000, endUs: 2_000_000 },
    w4: { id: 'w4', text: '🎬', startUs: 2_000_000, endUs: 2_400_000 },
  },
  segments: [
    {
      id: 'seg-1',
      startUs: 0,
      endUs: 1_400_000,
      wordIds: ['w1', 'w2'],
      speakerId: 'narrator',
    },
    {
      id: 'seg-2',
      startUs: 1_400_000,
      endUs: 2_400_000,
      wordIds: ['w3', 'w4'],
      textOverride: 'JOY! 🎬',
    },
  ],
};

const englishDocument: CaptionDocumentV1 = {
  id: 'doc-en',
  language: 'en-US',
  direction: 'auto',
  speakers: [],
  words: {
    e1: { id: 'e1', text: 'hello', startUs: 0, endUs: 500_000 },
  },
  segments: [{ id: 'seg-en', startUs: 0, endUs: 500_000, wordIds: ['e1'] }],
};

function captionComposition(): CompositionV1 {
  return {
    id: 'root',
    name: 'Root',
    width: 1920,
    height: 1080,
    pixelAspectRatio: { num: 1, den: 1 },
    frameRate: { num: 30, den: 1 },
    durationUs: 10_000_000,
    background: '#000000',
    tracks: [
      {
        id: 'captions-fa',
        kind: 'caption',
        name: 'Persian captions',
        order: 0,
        enabled: true,
        locked: false,
        clips: [
          {
            id: 'clip-fa',
            kind: 'caption',
            startUs: 2_000_000,
            durationUs: 2_400_000,
            captionDocumentId: 'doc-fa',
          },
        ],
      },
      {
        id: 'captions-en',
        kind: 'caption',
        name: 'English captions',
        order: 1,
        enabled: true,
        locked: false,
        clips: [
          {
            id: 'clip-en',
            kind: 'caption',
            startUs: 2_000_000,
            durationUs: 500_000,
            captionDocumentId: 'doc-en',
          },
          {
            id: 'clip-missing',
            kind: 'caption',
            startUs: 2_000_000,
            durationUs: 500_000,
            captionDocumentId: 'doc-gone',
          },
        ],
      },
      {
        id: 'captions-off',
        kind: 'caption',
        name: 'Disabled captions',
        order: 2,
        enabled: false,
        locked: false,
        clips: [
          {
            id: 'clip-off',
            kind: 'caption',
            startUs: 0,
            durationUs: 10_000_000,
            captionDocumentId: 'doc-fa',
          },
        ],
      },
    ],
  };
}

const documents = { 'doc-fa': persianDocument, 'doc-en': englishDocument };

describe('direction resolution (§33.4)', () => {
  it('detects RTL from the first strong Persian character', () => {
    expect(resolveCaptionDirection(persianDocument)).toBe('rtl');
  });
  it('detects LTR for Latin text and defaults to ltr without strong characters', () => {
    expect(resolveCaptionDirection(englishDocument)).toBe('ltr');
    expect(resolveCaptionDirection({ ...englishDocument, words: {}, segments: [] })).toBe('ltr');
  });
  it('respects an explicit direction without re-detection', () => {
    expect(resolveCaptionDirection({ ...persianDocument, direction: 'ltr' })).toBe('ltr');
  });
});

describe('display text preserves source tokens (§20.5)', () => {
  it('joins source tokens in wordIds order', () => {
    expect(segmentSourceText(persianDocument, persianDocument.segments[0]!)).toBe('سلام دنیا');
  });
  it('overrides display text without touching the word table', () => {
    const segment = persianDocument.segments[1]!;
    expect(segmentDisplayText(persianDocument, segment)).toBe('JOY! 🎬');
    expect(segmentSourceText(persianDocument, segment)).toBe('JOY 🎬');
  });
});

describe('active segments and words', () => {
  it('returns segments containing the time, end-exclusive', () => {
    expect(activeCaptionSegments(persianDocument, 0).map((s) => s.id)).toEqual(['seg-1']);
    expect(activeCaptionSegments(persianDocument, 1_400_000).map((s) => s.id)).toEqual(['seg-2']);
    expect(activeCaptionSegments(persianDocument, 2_400_000)).toEqual([]);
  });
  it('finds the active word inside a segment for karaoke timing', () => {
    const segment = persianDocument.segments[0]!;
    expect(activeCaptionWord(persianDocument, segment, 100_000)?.text).toBe('سلام');
    expect(activeCaptionWord(persianDocument, segment, 900_000)?.text).toBe('دنیا');
    expect(activeCaptionWord(persianDocument, segment, 1_400_000)).toBeUndefined();
  });
});

describe('timeline integration (caption clips → cues)', () => {
  it('maps composition time through clip-relative document time', () => {
    const cues = captionCuesAt(captionComposition(), documents, 2_100_000);
    expect(cues.map((cue) => [cue.clipId, cue.segment.id, cue.documentTimeUs])).toEqual([
      ['clip-fa', 'seg-1', 100_000],
      ['clip-en', 'seg-en', 100_000],
    ]);
  });
  it('excludes disabled tracks, inactive clips, and missing documents without failing', () => {
    expect(captionCuesAt(captionComposition(), documents, 1_000_000)).toEqual([]);
    const late = captionCuesAt(captionComposition(), documents, 3_500_000);
    expect(late.map((cue) => cue.clipId)).toEqual(['clip-fa']);
    expect(late[0]!.segment.id).toBe('seg-2');
  });
});

describe('caption layout → Render IR (§20.5 safe areas)', () => {
  const layout = { viewportWidth: 1080, viewportHeight: 1920 } as const;

  it('emits aligned, direction-tagged text nodes inside the safe area', () => {
    const cues = captionCuesAt(captionComposition(), documents, 2_100_000);
    const nodes = layoutCaptionNodes(cues, layout) as readonly TextNode[];
    expect(nodes).toHaveLength(2);
    const [fa, en] = nodes as [TextNode, TextNode];
    expect(fa.id).toBe('caption:clip-fa:seg-1');
    expect(fa.direction).toBe('rtl');
    expect(en.direction).toBe('ltr');
    for (const node of nodes) {
      expect(node.align).toBe('center');
      expect(node.transform.translateX).toBe(1080 / 2);
      expect(node.maxWidth).toBe(1080 * 0.8);
      // Inside vertical safe area: below top inset, above bottom inset.
      expect(node.transform.translateY).toBeGreaterThanOrEqual(1920 * 0.1);
      expect(node.transform.translateY).toBeLessThanOrEqual(1920 - 1920 * 0.1);
    }
    // Stacked upward from the bottom line, later cues nearer the bottom.
    expect(fa.transform.translateY).toBeLessThan(en.transform.translateY);
  });

  it('supports right-aligned RTL templates and skips empty display text', () => {
    const cues = captionCuesAt(captionComposition(), documents, 2_100_000);
    const nodes = layoutCaptionNodes(cues, { ...layout, align: 'right' }) as readonly TextNode[];
    expect(nodes[0]!.align).toBe('right');
    expect(nodes[0]!.transform.translateX).toBe(1080 - 1080 * 0.1);

    const emptyDoc: CaptionDocumentV1 = {
      ...englishDocument,
      id: 'doc-empty',
      words: {},
      segments: [{ id: 'seg-empty', startUs: 0, endUs: 500_000, wordIds: [] }],
    };
    const emptyCue = {
      clipId: 'clip-x',
      documentId: 'doc-empty',
      document: emptyDoc,
      segment: emptyDoc.segments[0]!,
      documentTimeUs: 0,
    };
    expect(layoutCaptionNodes([emptyCue], layout)).toEqual([]);
  });

  it('resolves clip-owned style and caption-local animation before layout', () => {
    const composition = captionComposition();
    const clip = composition.tracks[0]!.clips[0]!;
    if (clip.kind !== 'caption') throw new Error('expected caption clip');
    const style = { ...IDENTITY_CAPTION_CLIP_STYLE, fontSize: 2, positionX: 0.1 };
    const binding = {
      ownerKind: 'caption-clip' as const,
      ownerId: clip.id,
      propertyId: 'opacity',
      timeDomain: 'caption-clip-local' as const,
    };
    const styledComposition = {
      ...composition,
      tracks: composition.tracks.map((track) =>
        track.id === 'captions-fa'
          ? {
              ...track,
              clips: track.clips.map((item) => (item.id === clip.id ? { ...item, style } : item)),
            }
          : track,
      ),
    };
    const cues = captionCuesAt(styledComposition, documents, 2_100_000, {
      [canonicalBindingKey(binding)]: {
        binding,
        value: {
          kind: 'scalar',
          curve: { keyframes: [{ timeUs: 0, value: 0.5, interpolation: 'hold' }] },
        },
      },
    });
    const node = layoutTemplatedCaptionNodes([cues[0]!], layout)[0] as TextNode;
    expect(node.opacity).toBe(0.5);
    expect(node.fontSizePx).toBeGreaterThan(80);
    expect(node.transform.translateX).toBeGreaterThan(1080 / 2);
  });
});
