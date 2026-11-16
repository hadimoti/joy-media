import { describe, expect, it } from 'vitest';
import { bitmapWithData } from './preview-frame-helpers.js';

/** Shaped like a browser ImageData: the size lives on the prototype, not on the object. */
class ImageDataShaped {
  readonly #width: number;
  readonly #height: number;
  readonly data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.#width = width;
    this.#height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  get width(): number {
    return this.#width;
  }
  get height(): number {
    return this.#height;
  }
}

describe('bitmapWithData', () => {
  it('keeps the size of an ImageData whose width and height are prototype accessors', () => {
    const source = new ImageDataShaped(4, 2);
    // The old spread lost both numbers: this is the case it got wrong.
    expect({ ...source, data: source.data }).not.toHaveProperty('width');

    const graded = new Uint8ClampedArray(4 * 2 * 4).fill(9);
    const copy = bitmapWithData(source, graded);
    expect(copy.width).toBe(4);
    expect(copy.height).toBe(2);
    expect(copy.data).toBe(graded);
  });
});
