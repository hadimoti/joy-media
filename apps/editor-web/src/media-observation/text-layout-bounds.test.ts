import { describe, expect, it } from 'vitest';
import { projectTextLayoutBounds, type TextLayoutBoundsRecord } from './text-layout-bounds.js';

const WHITE = { r: 255, g: 255, b: 255 };

function record(overrides: Partial<TextLayoutBoundsRecord> = {}): TextLayoutBoundsRecord {
  return {
    id: 'title:one',
    kind: 'title',
    startUs: 0,
    endUs: 2_000_000,
    composition: { width: 1920, height: 1080 },
    corners: [
      { x: 192, y: 108 },
      { x: 960, y: 108 },
      { x: 960, y: 324 },
      { x: 192, y: 324 },
    ],
    textColor: WHITE,
    ...overrides,
  };
}

describe('projectTextLayoutBounds', () => {
  it('scales a drawn box to the composition size', () => {
    const { boxes, unavailable } = projectTextLayoutBounds([record()]);
    expect(unavailable).toEqual([]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      id: 'title:one',
      kind: 'title',
      startUs: 0,
      endUs: 2_000_000,
    });
    expect(boxes[0]?.x).toBeCloseTo(0.1);
    expect(boxes[0]?.y).toBeCloseTo(0.1);
    expect(boxes[0]?.width).toBeCloseTo(0.4);
    expect(boxes[0]?.height).toBeCloseTo(0.2);
  });

  it('uses the rectangle around a rotated box', () => {
    // A 100 x 100 square turned 45 degrees about (500, 500): its corners are on the axes.
    const half = 100 / Math.SQRT2;
    const { boxes } = projectTextLayoutBounds([
      record({
        composition: { width: 1000, height: 1000 },
        corners: [
          { x: 500, y: 500 - half },
          { x: 500 + half, y: 500 },
          { x: 500, y: 500 + half },
          { x: 500 - half, y: 500 },
        ],
      }),
    ]);
    expect(boxes[0]?.x).toBeCloseTo(0.5 - half / 1000);
    expect(boxes[0]?.width).toBeCloseTo((2 * half) / 1000);
    expect(boxes[0]?.height).toBeCloseTo((2 * half) / 1000);
  });

  it('covers the plate behind the text and keeps its colour', () => {
    const { boxes } = projectTextLayoutBounds([
      record({
        id: 'caption:a',
        kind: 'caption',
        plateCorners: [
          { x: 160, y: 80 },
          { x: 1000, y: 80 },
          { x: 1000, y: 360 },
          { x: 160, y: 360 },
        ],
        plateColor: { r: 0, g: 0, b: 0, a: 200 },
      }),
    ]);
    expect(boxes[0]?.x).toBeCloseTo(160 / 1920);
    expect(boxes[0]?.width).toBeCloseTo(840 / 1920);
    expect(boxes[0]?.backgroundColor).toEqual({ r: 0, g: 0, b: 0, a: 200 });
  });

  it('does not clamp a box that reaches outside the frame', () => {
    const { boxes } = projectTextLayoutBounds([
      record({
        corners: [
          { x: -96, y: 1000 },
          { x: 960, y: 1000 },
          { x: 960, y: 1180 },
          { x: -96, y: 1180 },
        ],
      }),
    ]);
    expect(boxes[0]?.x).toBeLessThan(0);
    expect((boxes[0]?.y ?? 0) + (boxes[0]?.height ?? 0)).toBeGreaterThan(1);
  });

  it('reports a text node it cannot trust as unavailable and gives it no box', () => {
    const { boxes, unavailable } = projectTextLayoutBounds([
      record({
        id: 'a',
        corners: [
          { x: 0, y: 0 },
          { x: NaN, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      }),
      record({ id: 'b', startUs: 5, endUs: 5 }),
      record({ id: 'c', composition: { width: 0, height: 1080 } }),
      record({
        id: 'd',
        corners: [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
      }),
      record({ id: 'ok' }),
      record({ id: 'ok' }),
    ]);
    expect(boxes.map((box) => box.id)).toEqual(['ok']);
    expect(unavailable).toEqual([
      { id: 'a', reason: 'invalid-corners' },
      { id: 'b', reason: 'invalid-interval' },
      { id: 'c', reason: 'invalid-composition' },
      { id: 'd', reason: 'invalid-corners' },
      { id: 'ok', reason: 'invalid-record' },
    ]);
  });

  it('orders boxes by start time, then id', () => {
    const { boxes } = projectTextLayoutBounds([
      record({ id: 'z', startUs: 0 }),
      record({ id: 'b', startUs: 1_000_000, endUs: 2_000_000 }),
      record({ id: 'a', startUs: 1_000_000, endUs: 2_000_000 }),
    ]);
    expect(boxes.map((box) => box.id)).toEqual(['z', 'a', 'b']);
  });
});
