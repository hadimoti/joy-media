import { describe, expect, it, vi } from 'vitest';
import { createColorEyedropperStore, pixelAt, pixelNeighbourhood } from './color-eyedropper.js';
import {
  createColorGradeBypassStore,
  withoutColorGrades,
  withoutVideoNodeGrade,
} from './color-grade-bypass.js';
import type { ScopePixels } from './color-scopes.js';
import { createIdentityColorGrade, type JoyProjectV1 } from '@joy-media/project-schema';
import type { VideoFrameNode } from '@joy-media/render-ir';

/** A 4 × 2 read-back: left half pure green, right half pure red. */
function patches(): ScopePixels {
  const width = 4;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = x < 2 ? 0 : 255;
      data[offset + 1] = x < 2 ? 255 : 0;
      data[offset + 2] = 0;
      data[offset + 3] = 255;
    }
  return { width, height, data };
}

describe('pixel read from a smaller read-back', () => {
  const frame = { width: 400, height: 200 };

  it('maps a canvas point onto the read-back', () => {
    expect(pixelAt(patches(), frame, { x: 10, y: 10 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(pixelAt(patches(), frame, { x: 390, y: 190 })).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('gives nothing outside the frame', () => {
    expect(pixelAt(patches(), frame, { x: -1, y: 10 })).toBeUndefined();
    expect(pixelAt(patches(), frame, { x: 400, y: 10 })).toBeUndefined();
    expect(pixelAt(patches(), frame, { x: 10, y: 200 })).toBeUndefined();
  });

  it('collects the magnifier square around a point', () => {
    const cells = pixelNeighbourhood(patches(), frame, { x: 150, y: 50 }, 1);
    expect(cells).toHaveLength(9);
    // The row above the frame is outside.
    expect(cells.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(cells[4]).toEqual({ r: 0, g: 255, b: 0 });
    expect(cells[5]).toEqual({ r: 255, g: 0, b: 0 });
  });
});

describe('the eyedropper session', () => {
  it('hands a pick to whoever started it, once', () => {
    const store = createColorEyedropperStore();
    const onPick = vi.fn();
    store.start(onPick);
    expect(store.get()).toBeDefined();
    store.pick({ r: 1, g: 2, b: 3 });
    expect(onPick).toHaveBeenCalledWith({ r: 1, g: 2, b: 3 });
    expect(store.get()).toBeUndefined();
    store.pick({ r: 4, g: 5, b: 6 });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('cancels without a pick', () => {
    const store = createColorEyedropperStore();
    const onPick = vi.fn();
    const listener = vi.fn();
    store.subscribe(listener);
    store.start(onPick);
    store.cancel();
    expect(store.get()).toBeUndefined();
    expect(onPick).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('hold to compare', () => {
  it('switches on and off and tells its listeners once per change', () => {
    const store = createColorGradeBypassStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(true);
    store.set(true);
    store.set(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get()).toBe(false);
  });

  it('takes every grade off the project and off a decoded video node', () => {
    const grade = createIdentityColorGrade();
    const project = {
      colorGrade: grade,
      clipColorGrades: { clip: grade },
      name: 'p',
    } as unknown as JoyProjectV1;
    const bare = withoutColorGrades(project);
    expect('colorGrade' in bare).toBe(false);
    expect('clipColorGrades' in bare).toBe(false);
    expect((bare as unknown as { name: string }).name).toBe('p');
    expect(project.colorGrade).toBe(grade);

    const node = { id: 'clip', colorGrade: { saturation: 0 } } as unknown as VideoFrameNode;
    expect('colorGrade' in withoutVideoNodeGrade(node)).toBe(false);
    const plain = { id: 'clip' } as unknown as VideoFrameNode;
    expect(withoutVideoNodeGrade(plain)).toBe(plain);
  });
});
