import { describe, expect, it } from 'vitest';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import { formatSrt, formatWebVtt, parseSrt, parseWebVtt, segmentDisplayText } from './index.js';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'سلام دنیا',
  '',
  '2',
  '00:00:03,500 --> 00:00:05,000',
  'JOY Media',
  'second line',
  '',
].join('\r\n');

describe('SRT import', () => {
  it('parses cues into tokenized words with linear timing, joining multi-line text', () => {
    const { document, diagnostics } = parseSrt(SRT, { documentId: 'doc', language: 'fa-IR' });
    expect(diagnostics).toEqual([]);
    expect(document.segments).toHaveLength(2);
    const [first, second] = document.segments;
    expect(first).toMatchObject({ startUs: 1_000_000, endUs: 3_500_000 });
    expect(segmentDisplayText(document, first!)).toBe('سلام دنیا');
    expect(segmentDisplayText(document, second!)).toBe('JOY Media second line');
    // Linear word timing across the cue window: 2 words over 2.5 s.
    const words = first!.wordIds.map((id) => document.words[id]!);
    expect(words.map((word) => [word.startUs, word.endUs])).toEqual([
      [1_000_000, 2_250_000],
      [2_250_000, 3_500_000],
    ]);
    expect(words.every((word) => word.confidence === undefined)).toBe(true);
  });

  it('reports malformed blocks as diagnostics and keeps valid cues', () => {
    const { document, diagnostics } = parseSrt(
      ['1', 'not a timing line', 'text', '', '2', '00:00:01,000 --> 00:00:02,000', 'ok', ''].join(
        '\n',
      ),
      { documentId: 'doc' },
    );
    expect(document.segments).toHaveLength(1);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'CAPTION_IMPORT_BAD_TIMING', line: 1 }),
    ]);
  });

  it('produces documents that validate inside a v1 project shell', () => {
    const { document } = parseSrt(SRT, { documentId: 'doc' });
    const diagnostics = validateJoyProjectV1({
      schemaVersion: 1,
      id: 'p',
      title: 'P',
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 16,
          height: 9,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 10_000_000,
          background: '#000000',
          tracks: [],
        },
      },
      assets: {},
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: { doc: document },
      pluginData: {},
    });
    expect(diagnostics).toEqual([]);
  });
});

describe('WebVTT import/export and round-trips', () => {
  it('parses WEBVTT with cue ids, strips inline markup, skips NOTE blocks', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this is a comment',
      '',
      'intro',
      '00:01.000 --> 00:02.000',
      'Hello <b>JOY</b>',
      '',
    ].join('\n');
    const { document, diagnostics } = parseWebVtt(vtt, { documentId: 'doc' });
    expect(diagnostics).toEqual([]);
    expect(document.segments).toHaveLength(1);
    expect(segmentDisplayText(document, document.segments[0]!)).toBe('Hello JOY');
  });

  it('round-trips display text through SRT and WebVTT', () => {
    const { document } = parseSrt(SRT, { documentId: 'doc', language: 'fa-IR' });
    const srtAgain = parseSrt(formatSrt(document), { documentId: 'doc2' });
    expect(srtAgain.document.segments.map((s) => s.startUs)).toEqual(
      document.segments.map((s) => s.startUs),
    );
    expect(srtAgain.document.segments.map((s) => segmentDisplayText(srtAgain.document, s))).toEqual(
      document.segments.map((s) => segmentDisplayText(document, s)),
    );

    const vttText = formatWebVtt(document);
    expect(vttText.startsWith('WEBVTT\n')).toBe(true);
    expect(vttText).toContain('00:00:01.000 --> 00:00:03.500');
    const vttAgain = parseWebVtt(vttText, { documentId: 'doc3' });
    expect(vttAgain.document.segments.map((s) => segmentDisplayText(vttAgain.document, s))).toEqual(
      document.segments.map((s) => segmentDisplayText(document, s)),
    );
  });

  it('exports edited display overrides, not the original tokens', () => {
    const { document } = parseSrt(SRT, { documentId: 'doc' });
    const edited = {
      ...document,
      segments: [
        { ...document.segments[0]!, textOverride: 'سلام JOY!' },
        ...document.segments.slice(1),
      ],
    };
    expect(formatSrt(edited)).toContain('سلام JOY!');
    expect(formatSrt(edited)).not.toContain('سلام دنیا');
  });
});
