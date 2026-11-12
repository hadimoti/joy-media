import { describe, expect, it } from 'vitest';
import { nodeBoundsFromBox, type Transform2D } from '@joy-media/render-ir';
import {
  boxContainsPoint,
  hitTestElements,
  marqueeRect,
  marqueeSelect,
  rectOverlapsBox,
  type HitTestElement,
} from './monitor-hit-test.js';

function element(
  id: string,
  transform: Partial<Transform2D>,
  size = { width: 100, height: 100 },
  flags: { locked?: boolean; hidden?: boolean } = {},
): HitTestElement {
  const full: Transform2D = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, ...transform };
  return {
    id,
    bounds: nodeBoundsFromBox(id, full, { x: 0, y: 0, ...size }),
    ...flags,
  };
}

describe('hitTestElements', () => {
  it('finds a plain box and misses outside it', () => {
    const box = element('a', { translateX: 100, translateY: 50 });
    expect(hitTestElements({ x: 150, y: 100 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 100, y: 50 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 99, y: 100 }, [box])).toEqual([]);
    expect(hitTestElements({ x: 150, y: 151 }, [box])).toEqual([]);
  });

  it('uses the scaled box', () => {
    const box = element('a', { translateX: 10, translateY: 10, scaleX: 2, scaleY: 0.5 });
    expect(hitTestElements({ x: 205, y: 55 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 215, y: 55 }, [box])).toEqual([]);
    expect(hitTestElements({ x: 100, y: 65 }, [box])).toEqual([]);
  });

  it('a mirrored (negative scale) box is still hit', () => {
    const box = element('a', { translateX: 200, translateY: 0, scaleX: -1 });
    expect(hitTestElements({ x: 150, y: 50 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 250, y: 50 }, [box])).toEqual([]);
  });

  it('uses the rotated box, not its axis-aligned rectangle', () => {
    // A 100x100 square turned 45 degrees about its centre (50, 50).
    const box = element('a', { rotationDeg: 45 });
    expect(hitTestElements({ x: 50, y: 50 }, [box])).toEqual(['a']);
    // A corner of the unrotated square is outside the diamond.
    expect(hitTestElements({ x: 2, y: 2 }, [box])).toEqual([]);
    // The diamond reaches past the old square on the left: 50 - 70.7.
    expect(hitTestElements({ x: -15, y: 50 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: -25, y: 50 }, [box])).toEqual([]);
  });

  it('a rotated and scaled box', () => {
    // 200x50 after scale, turned 90 degrees about its centre (100, 25).
    const box = element('a', { scaleX: 2, scaleY: 0.5, rotationDeg: 90 });
    expect(hitTestElements({ x: 100, y: 110 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 100, y: -60 }, [box])).toEqual(['a']);
    expect(hitTestElements({ x: 180, y: 25 }, [box])).toEqual([]);
  });

  it('returns overlapping boxes topmost first, in the order given', () => {
    const top = element('top', { translateX: 50, translateY: 50 });
    const middle = element('middle', { translateX: 0, translateY: 0 });
    const bottom = element('bottom', { scaleX: 3, scaleY: 3 });
    const list = [top, middle, bottom];
    expect(hitTestElements({ x: 75, y: 75 }, list)).toEqual(['top', 'middle', 'bottom']);
    expect(hitTestElements({ x: 25, y: 25 }, list)).toEqual(['middle', 'bottom']);
    expect(hitTestElements({ x: 250, y: 250 }, list)).toEqual(['bottom']);
  });

  it('skips locked and hidden tracks, and the one below is found instead', () => {
    const locked = element('locked', {}, undefined, { locked: true });
    const hidden = element('hidden', {}, undefined, { hidden: true });
    const below = element('below', { scaleX: 2, scaleY: 2 });
    expect(hitTestElements({ x: 50, y: 50 }, [locked, hidden, below])).toEqual(['below']);
  });

  it('a box with no size is never hit', () => {
    const flat = element('flat', {}, { width: 0, height: 100 });
    expect(hitTestElements({ x: 0, y: 50 }, [flat])).toEqual([]);
  });

  it('a picture counts as its whole box (transparent areas included)', () => {
    // Only the box is tested; there is no pixel read at all.
    const picture = element(
      'picture',
      { translateX: 0, translateY: 0 },
      { width: 400, height: 300 },
    );
    expect(hitTestElements({ x: 399, y: 1 }, [picture])).toEqual(['picture']);
  });
});

describe('boxContainsPoint', () => {
  it('works for either corner order', () => {
    const clockwise = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(boxContainsPoint(clockwise, { x: 5, y: 5 })).toBe(true);
    expect(boxContainsPoint([...clockwise].reverse(), { x: 5, y: 5 })).toBe(true);
    expect(boxContainsPoint([...clockwise].reverse(), { x: 11, y: 5 })).toBe(false);
  });
});

describe('marqueeSelect', () => {
  const a = element('a', { translateX: 0, translateY: 0 });
  const b = element('b', { translateX: 300, translateY: 0 });
  const c = element('c', { translateX: 0, translateY: 300 });

  it('selects every box the marquee touches, partial overlap included', () => {
    expect(marqueeSelect({ x: 90, y: 90 }, { x: 310, y: 120 }, [a, b, c])).toEqual(['a', 'b']);
    expect(marqueeSelect({ x: 120, y: 120 }, { x: 250, y: 250 }, [a, b, c])).toEqual([]);
  });

  it('works when dragged in any direction', () => {
    expect(marqueeSelect({ x: 310, y: 120 }, { x: 90, y: 90 }, [a, b, c])).toEqual(['a', 'b']);
    expect(marqueeRect({ x: 10, y: 40 }, { x: 0, y: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 40,
    });
  });

  it('keeps the order given (topmost first)', () => {
    expect(marqueeSelect({ x: -10, y: -10 }, { x: 500, y: 500 }, [c, b, a])).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('skips locked and hidden tracks', () => {
    const locked = element('locked', {}, undefined, { locked: true });
    const hidden = element('hidden', {}, undefined, { hidden: true });
    expect(marqueeSelect({ x: 0, y: 0 }, { x: 50, y: 50 }, [locked, hidden, a])).toEqual(['a']);
  });

  it('uses the rotated box: a marquee in the empty corner misses the diamond', () => {
    const diamond = element('d', { rotationDeg: 45 });
    expect(marqueeSelect({ x: -5, y: -5 }, { x: 10, y: 10 }, [diamond])).toEqual([]);
    expect(marqueeSelect({ x: -5, y: -5 }, { x: 30, y: 30 }, [diamond])).toEqual(['d']);
    expect(rectOverlapsBox({ x: 120, y: 45, width: 10, height: 10 }, diamond.bounds.corners)).toBe(
      true,
    );
  });
});
