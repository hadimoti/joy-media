import { describe, expect, it } from 'vitest';
import { exportHasDrawnTextOrShape, exportLacksVisualSource } from './export-missing-media.js';

// A title-only project has no video clip. Its title draws over the background, so the export must not refuse it
// with "No playable visual clips are available" (defect 211). A title is drawn only when a frame of the export is
// painted inside its clip: a clip outside the export length (review P1), or one that no frame falls in (review P2),
// does not count.
const SECOND_US = 1_000_000;
const FIVE_SECONDS = 5 * SECOND_US;
// A 5 s export at 30 fps has 150 frames. Frame i is painted at floor(i * 1e6 / 30) µs, so the last one is at 4 966 666 µs.
const FRAME_RATE = 30;
const FIVE_SECOND_FRAMES = 150;
const grid = { durationUs: FIVE_SECONDS, frameRate: FRAME_RATE, frameCount: FIVE_SECOND_FRAMES };

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
    ...grid,
  };

  it('counts a title bound to a visible clip inside the export length', () => {
    expect(exportHasDrawnTextOrShape({ ...base, clipObjects: { 'clip-title': 'title' } })).toBe(
      true,
    );
  });

  it('counts a shape bound to a visible clip', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...grid,
        visualObjects: { shape },
        compositionSets: [
          { root: timelineWith([{ id: 'clip-shape', startUs: 0, durationUs: FIVE_SECONDS }]) },
        ],
        hiddenClipIds: new Set<string>(),
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
        ...grid,
        visualObjects: { picture, scene },
        clipObjects: undefined,
        compositionSets: [],
        hiddenClipIds: new Set<string>(),
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

  it('counts a title when one of its clip ranges is painted (review P2, round 2)', () => {
    // The title's clip is at 0-2 s in the visual project and at 10-12 s on the timeline. The 0-2 s range is painted.
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([{ id: 'clip-title', startUs: 0, durationUs: 2 * SECOND_US }]),
          },
          {
            root: timelineWith([
              { id: 'clip-title', startUs: 10 * SECOND_US, durationUs: 2 * SECOND_US },
            ]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(true);
  });

  it('does not count a title active only between two frames of the export (review P2)', () => {
    // Active 4.99-5.00 s: the last frame is painted at 4.9667 s, so the export would show no title.
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([{ id: 'clip-title', startUs: 4_990_000, durationUs: 10_000 }]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(false);
  });

  it('counts a title that a frame is painted inside (review P2)', () => {
    // Active 4.96-4.97 s: the frame painted at 4.9667 s falls inside it.
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([{ id: 'clip-title', startUs: 4_960_000, durationUs: 10_000 }]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(true);
  });

  it('counts a title that starts exactly at a frame time (review P2 boundary)', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          { visual: timelineWith([{ id: 'clip-title', startUs: 4_966_666, durationUs: 1 }]) },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(true);
  });

  it('does not count a title that ends exactly at a frame time (review P2 boundary)', () => {
    // The frame at 4.9667 s is the first one at or after the end, so it is not inside the title.
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([{ id: 'clip-title', startUs: 4_933_334, durationUs: 33_332 }]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(false);
  });

  it('does not count a clip that ends exactly at time 0', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([
              { id: 'clip-title', startUs: -2 * SECOND_US, durationUs: 2 * SECOND_US },
            ]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(false);
  });

  it('does not count a clip that starts exactly at the export length', () => {
    expect(
      exportHasDrawnTextOrShape({
        ...base,
        compositionSets: [
          {
            visual: timelineWith([
              { id: 'clip-title', startUs: FIVE_SECONDS, durationUs: 5 * SECOND_US },
            ]),
          },
        ],
        clipObjects: { 'clip-title': 'title' },
      }),
    ).toBe(false);
  });

  it('lets a title-only project past the no-visual-source guard', () => {
    const drawn = exportHasDrawnTextOrShape({ ...base, clipObjects: { 'clip-title': 'title' } });
    expect(exportLacksVisualSource(0, drawn, 0)).toBe(false);
  });

  it('still refuses a project with no visual source at all', () => {
    const drawn = exportHasDrawnTextOrShape({
      ...grid,
      visualObjects: {},
      clipObjects: undefined,
      compositionSets: [],
      hiddenClipIds: new Set<string>(),
    });
    expect(exportLacksVisualSource(0, drawn, 0)).toBe(true);
  });
});
