import { describe, expect, it } from 'vitest';
import { nodeBoundsFromBox } from '@joy-media/render-ir';
import { collectTextLayoutBounds, type TextLayoutCandidate } from './text-layout-bounds-collect.js';

const COLOR = { r: 255, g: 255, b: 255 };
const REVISION = 'rev-1';

function candidate(id: string, kind: 'title' | 'caption' = 'title'): TextLayoutCandidate {
  return { id, kind, startUs: 0, endUs: 1_000_000, sampleUs: 500_000, revision: REVISION };
}

function frame(ids: readonly string[], revision = REVISION, timeUs = 500_000) {
  return {
    timeUs,
    revision,
    composition: { width: 100, height: 100 },
    nodes: ids.map((id) => ({
      id,
      bounds: nodeBoundsFromBox(
        id,
        { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
        { x: id.includes('outside') ? -10 : 10, y: 10, width: 30, height: 20 },
      ),
      textColor: COLOR,
    })),
  };
}

describe('collectTextLayoutBounds', () => {
  it('keeps renderer rotation and the plate extent in normalized boxes', () => {
    const rotated = nodeBoundsFromBox(
      'rotated',
      {
        translateX: 50,
        translateY: 50,
        scaleX: 1,
        scaleY: 1,
        rotationDeg: 45,
      },
      { x: -10, y: -10, width: 20, height: 20 },
    );
    const plate = nodeBoundsFromBox(
      'plate',
      {
        translateX: 50,
        translateY: 50,
        scaleX: 1,
        scaleY: 1,
      },
      { x: -30, y: -20, width: 60, height: 40 },
    );
    const result = collectTextLayoutBounds(
      [candidate('rotated')],
      [
        {
          ...frame(['rotated']),
          nodes: [
            {
              id: 'rotated',
              bounds: rotated,
              textColor: COLOR,
              plateBounds: plate,
              plateColor: { r: 0, g: 0, b: 0 },
            },
          ],
        },
      ],
    );
    expect(result.boxes[0]?.x).toBeCloseTo(0.2);
    expect(result.boxes[0]?.width).toBeCloseTo(0.6);
    expect(result.boxes[0]?.backgroundColor).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('marks bad boxes, missing ids, zero boxes, and stale frame identity unavailable individually', () => {
    const bad = { id: 'bad', textColor: COLOR };
    const zero = nodeBoundsFromBox(
      'zero',
      { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
      { x: 0, y: 0, width: 0, height: 10 },
    );
    const result = collectTextLayoutBounds(
      [candidate('bad'), candidate('zero'), candidate('missing'), candidate('stale')],
      [
        {
          ...frame(['zero', 'stale'], 'old-revision'),
          nodes: [bad, { id: 'zero', bounds: zero, textColor: COLOR }],
        },
      ],
    );
    expect(result.boxes).toEqual([]);
    expect(result.unavailable).toEqual(['bad', 'zero', 'missing', 'stale']);
    expect(result.notMeasured).toBe(true);
  });

  it('keeps two caption lines and overlapping titles as separate boxes', () => {
    const ids = ['caption:clip:cue:line0', 'caption:clip:cue:line1', 'title:a', 'title:b'];
    const result = collectTextLayoutBounds(
      ids.map((id) => candidate(id, id.startsWith('caption:') ? 'caption' : 'title')),
      [frame(ids)],
    );
    expect(result.boxes).toHaveLength(4);
    expect(result.boxes.map((box) => box.id)).toContain('caption:clip:cue:line1');
  });

  it('caps large cue lists without throwing or treating overflow as a failed check', () => {
    const cues = Array.from({ length: 60 }, (_, index) =>
      candidate(`caption:c:s${index}:line0`, 'caption'),
    );
    const result = collectTextLayoutBounds(cues, [frame(cues.map((item) => item.id))], 36);
    expect(result.boxes).toHaveLength(36);
    expect(result.overflow).toBe(true);
    expect(result.notMeasured).toBe(true);
  });
});
