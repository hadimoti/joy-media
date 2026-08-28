import { describe, expect, it } from 'vitest';
import type { CaptionDocumentV1, JoyProjectV1 } from '@joy-media/project-schema';
import { validateJoyProjectV1 } from '@joy-media/project-schema';
import {
  applyCaptionProjectCommand,
  CaptionCommandError,
  captionSlots,
  searchCaptionSegments,
  segmentDisplayText,
  segmentMinConfidence,
  segmentSourceText,
  segmentTimelineRange,
} from './index.js';

const document: CaptionDocumentV1 = {
  id: 'doc',
  language: 'fa-IR',
  direction: 'auto',
  speakers: [],
  words: {
    w1: { id: 'w1', text: 'سلام', startUs: 0, endUs: 700_000, confidence: 0.95 },
    w2: { id: 'w2', text: 'دنیا', startUs: 700_000, endUs: 1_400_000, confidence: 0.6 },
  },
  segments: [{ id: 'seg-1', startUs: 0, endUs: 1_400_000, wordIds: ['w1', 'w2'] }],
};

function project(): JoyProjectV1 {
  return {
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
        width: 1920,
        height: 1080,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 10_000_000,
        background: '#000000',
        tracks: [
          {
            id: 'captions',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-1',
                kind: 'caption',
                startUs: 1_000_000,
                durationUs: 1_000_000,
                captionDocumentId: 'doc',
              },
            ],
          },
        ],
      },
    },
    assets: {},
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: { doc: document },
    pluginData: {},
  };
}

describe('caption commands', () => {
  it('sets a display override, keeps source tokens, and inverts to the previous state', () => {
    const base = project();
    const edited = applyCaptionProjectCommand(base, {
      type: 'caption.setSegmentText',
      payload: { documentId: 'doc', segmentId: 'seg-1', textOverride: 'سلام JOY' },
    });
    const editedDoc = edited.project.captionDocuments.doc!;
    expect(segmentDisplayText(editedDoc, editedDoc.segments[0]!)).toBe('سلام JOY');
    expect(segmentSourceText(editedDoc, editedDoc.segments[0]!)).toBe('سلام دنیا');
    expect(editedDoc.words).toEqual(document.words);
    expect(validateJoyProjectV1(edited.project)).toEqual([]);

    const reverted = applyCaptionProjectCommand(edited.project, edited.inverse);
    expect(reverted.project.captionDocuments.doc).toEqual(document);
  });

  it('retimes segments and words with range validation and exact inverses', () => {
    const base = project();
    const retimed = applyCaptionProjectCommand(base, {
      type: 'caption.setSegmentTiming',
      payload: { documentId: 'doc', segmentId: 'seg-1', startUs: 100_000, endUs: 1_500_000 },
    });
    expect(retimed.project.captionDocuments.doc!.segments[0]).toMatchObject({
      startUs: 100_000,
      endUs: 1_500_000,
    });
    expect(
      applyCaptionProjectCommand(retimed.project, retimed.inverse).project.captionDocuments.doc,
    ).toEqual(document);

    const wordRetimed = applyCaptionProjectCommand(base, {
      type: 'caption.setWordTiming',
      payload: { documentId: 'doc', wordId: 'w2', startUs: 700_000, endUs: 1_500_000 },
    });
    expect(wordRetimed.project.captionDocuments.doc!.words.w2!.endUs).toBe(1_500_000);
    expect(() =>
      applyCaptionProjectCommand(base, {
        type: 'caption.setSegmentTiming',
        payload: { documentId: 'doc', segmentId: 'seg-1', startUs: 500_000, endUs: 500_000 },
      }),
    ).toThrowError(CaptionCommandError);
  });

  it('adds and removes segments as exact inverses, keeping start order', () => {
    const base = project();
    const added = applyCaptionProjectCommand(base, {
      type: 'caption.addSegment',
      payload: {
        documentId: 'doc',
        segment: {
          id: 'seg-0',
          startUs: 1_400_000,
          endUs: 2_000_000,
          wordIds: [],
          textOverride: 'دستی',
        },
      },
    });
    expect(added.project.captionDocuments.doc!.segments.map((s) => s.id)).toEqual([
      'seg-1',
      'seg-0',
    ]);
    const removed = applyCaptionProjectCommand(added.project, added.inverse);
    expect(removed.project.captionDocuments.doc).toEqual(document);
    expect(() =>
      applyCaptionProjectCommand(base, {
        type: 'caption.removeSegment',
        payload: { documentId: 'doc', segmentId: 'ghost' },
      }),
    ).toThrowError(CaptionCommandError);
  });
});

describe('style and document replacement commands', () => {
  it('applies a template styleRef with an inverse restoring the previous choice', () => {
    const base = project();
    const styled = applyCaptionProjectCommand(base, {
      type: 'caption.setStyle',
      payload: { documentId: 'doc', styleRef: 'joy-karaoke-pop' },
    });
    expect(styled.project.captionDocuments.doc!.styleRef).toBe('joy-karaoke-pop');
    const reverted = applyCaptionProjectCommand(styled.project, styled.inverse);
    expect(reverted.project.captionDocuments.doc).toEqual(document);
  });

  it('replaces a whole document atomically (import path) and inverts to the original', () => {
    const base = project();
    const replacement = {
      ...document,
      words: { n1: { id: 'n1', text: 'imported', startUs: 0, endUs: 900_000 } },
      segments: [{ id: 'new-seg', startUs: 0, endUs: 900_000, wordIds: ['n1'] }],
    };
    const replaced = applyCaptionProjectCommand(base, {
      type: 'caption.replaceDocument',
      payload: { documentId: 'doc', document: replacement },
    });
    expect(replaced.project.captionDocuments.doc!.segments[0]!.id).toBe('new-seg');
    expect(
      applyCaptionProjectCommand(replaced.project, replaced.inverse).project.captionDocuments.doc,
    ).toEqual(document);
    expect(() =>
      applyCaptionProjectCommand(base, {
        type: 'caption.replaceDocument',
        payload: { documentId: 'doc', document: { ...replacement, id: 'other' } },
      }),
    ).toThrowError(CaptionCommandError);
  });

  it('retimes a specific caption clip and restores its placement exactly', () => {
    const base = project();
    const placed = applyCaptionProjectCommand(base, {
      type: 'caption.setClipTiming',
      payload: {
        documentId: 'doc',
        clipId: 'clip-1',
        startUs: 4_000_000,
        durationUs: 3_000_000,
      },
    });
    expect(placed.project.compositions.root!.tracks[0]!.clips[0]).toMatchObject({
      startUs: 4_000_000,
      durationUs: 3_000_000,
    });
    expect(applyCaptionProjectCommand(placed.project, placed.inverse).project).toEqual(base);
  });
});

describe('editing surface helpers', () => {
  it('finds segments by display and source text, case-insensitively', () => {
    expect(searchCaptionSegments(document, 'دنیا').map((m) => m.segment.id)).toEqual(['seg-1']);
    expect(searchCaptionSegments(document, '  ')).toEqual([]);
    const overridden: CaptionDocumentV1 = {
      ...document,
      segments: [{ ...document.segments[0]!, textOverride: 'Hello JOY' }],
    };
    expect(searchCaptionSegments(overridden, 'joy')).toHaveLength(1);
    // Source tokens stay searchable underneath an override.
    expect(searchCaptionSegments(overridden, 'سلام')).toHaveLength(1);
  });

  it('reports the lowest word confidence and none for manual segments', () => {
    expect(segmentMinConfidence(document, document.segments[0]!)).toBe(0.6);
    expect(
      segmentMinConfidence(document, { id: 'x', startUs: 0, endUs: 1, wordIds: [] }),
    ).toBeUndefined();
  });

  it('maps segments to composition time through their clip, clamped to the clip', () => {
    const [slot] = captionSlots(project().compositions.root!, { doc: document });
    expect(slot).toBeDefined();
    const range = segmentTimelineRange(slot!.clip, document.segments[0]!);
    // Clip starts at 1s and lasts 1s; the 1.4s segment is clamped to the clip end.
    expect(range).toEqual({ startUs: 1_000_000, durationUs: 1_000_000 });
    expect(
      segmentTimelineRange(slot!.clip, {
        id: 'off',
        startUs: 5_000_000,
        endUs: 6_000_000,
        wordIds: [],
      }),
    ).toBeUndefined();
  });
});
