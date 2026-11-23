import { describe, expect, it } from 'vitest';
import { exportHasDrawnTextOrShape, exportLacksVisualSource } from './export-missing-media.js';

// A title-only project has no video clip. Its title draws over the background, so the export must not refuse it
// with "No playable visual clips are available" (defect 211). A title whose clip lies outside the export length is
// not drawn, so it must not count (review P1).
const SECOND_US = 1_000_000;
const FIVE_SECONDS = 5 * SECOND_US;

function timelineWith(
  clips: readonly { readonly id: string; readonly startUs: number; readonly durationUs: number }[],
) {
  return { tracks: [{ clips }] };
}

const title = { id: 'title', kind: 'text' };
const shape = { id: 'shape', kind: 'shape' };
const picture = { id: 'picture', kind: 'image' };
const scene = { id: 'scene', kind: 'html-scene' };

describe('exportHasDrawnTextOrShape (defect 211)', () => {
  const base = {
    visualObjects: { title },
    compositionSets: [
      { root: timelineWith([{ id: 'clip-title', startUs: 0, durationUs: FIVE_SECONDS }]) },
    ],
    hiddenClipIds: new Set<string>(),
    durationUs: FIVE_SECONDS,
  };

  it('counts a title bound to a visible clip inside the export length', () => {
    expect(exportHasDrawnTextOrShape({ ...base, clipObjects: { 'clip-title': 'title' } })).toBe(
      true,
    );
  });

  it('counts a shape bound to a visible clip', () => {
    expect(
      exportHasDrawnTextOrShape({
        visualObjects: { shape },
        compositionSets: [
          { root: timelineWith([{ id: 'clip-shape', startUs: 0, durationUs: FIVE_SECONDS }]) },
        ],
        hiddenClipIds: new Set<string>(),
        durationUs: FIVE_SECONDS,
        clipObjects: { 'clip-shape': 'shape' },
      }),
    ).toBe(true);
  });

  it('does not count a title whose only clip is hidden', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        clipObjects: { 'clip-title': 'title' },
        hiddenClipIds: new Set(['clip-title']),
      }),
    ).toBe(false);
  });

  it('does not count a title whose bound clip no longer exists', () => {
    expect(exportHasDrawnTextOrShape({ ...base, clipObjects: { 'gone-clip': 'title' } })).toBe(
      false,
    );
  });

  it('counts an unbound title, because old projects draw unbound overlays', () => {
    expect(exportHasDrawnTextOrShape({ ...base, clipObjects: undefined })).toBe(true);
  });

  it('does not count pictures or html scenes (they have their own checks)', () => {
    expect(
      exportHasDrawnTextOrShape({
        visualObjects: { picture, scene },
        clipObjects: undefined,
        compositionSets: [],
        hiddenClipIds: new Set<string>(),
        durationUs: FIVE_SECONDS,
      }),
    ).toBe(false);
  });

  it('does not count a title bound to a clip that starts after the export length (review P1)', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([
              { id: 'clip-title', startUs: 10 * SECOND_US, durationUs: 5 * SECOND_US },
            ]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(false);
  });

  it('counts a title whose clip overlaps the end of the export length', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([
              { id: 'clip-title', startUs: 3 * SECOND_US, durationUs: 5 * SECOND_US },
            ]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(true);
  });

  it('lets a title-only project past the no-visual-source guard', () => {
    const drawn = exportHasDrawnTextOrShape({ ...base, clipObjects: { 'clip-title': 'title' } });
    expect(exportLacksVisualSource(0, drawn, 0)).toBe(false);
  });

  it('still refuses a project with no visual source at all', () => {
    const drawn = exportHasDrawnTextOrShape({
      visualObjects: {},
      clipObjects: undefined,
      compositionSets: [],
      hiddenClipIds: new Set<string>(),
      durationUs: FIVE_SECONDS,
    });
    expect(exportLacksVisualSource(0, drawn, 0)).toBe(true);
  });
});
