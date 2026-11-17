import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageDataWriter } from './image-data-writer.js';

describe('createImageDataWriter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hands the existing RGBA frame buffer to Canvas without allocating a second pixel buffer', () => {
    const imageData: ImageData[] = [];
    const snapshots: number[][] = [];
    class FakeImageData {
      readonly width: number;
      readonly height: number;
      readonly data: Uint8ClampedArray;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    }
    vi.stubGlobal('ImageData', FakeImageData);
    const context = {
      putImageData: vi.fn((image: ImageData) => {
        imageData.push(image);
        // Canvas copies synchronously while the source frame remains owned by its caller.
        snapshots.push([...image.data]);
      }),
    };
    const write = createImageDataWriter();
    const first = new Uint8ClampedArray([1, 2, 3, 255]);
    const second = new Uint8ClampedArray([4, 5, 6, 255]);

    write(context as unknown as CanvasRenderingContext2D, 1, 1, first);
    write(context as unknown as CanvasRenderingContext2D, 1, 1, second);

    expect(imageData).toHaveLength(2);
    expect(imageData[0]?.data).toBe(first);
    expect(imageData[1]?.data).toBe(second);
    expect(snapshots).toEqual([
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ]);
  });

  it('accepts changed dimensions and rejects mismatched pixel buffers', () => {
    class FakeImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal('ImageData', FakeImageData);
    const context = { putImageData: vi.fn() };
    const write = createImageDataWriter();

    write(context as unknown as CanvasRenderingContext2D, 1, 1, new Uint8ClampedArray(4));
    write(context as unknown as CanvasRenderingContext2D, 2, 1, new Uint8ClampedArray(8));

    expect(() =>
      write(context as unknown as CanvasRenderingContext2D, 2, 1, new Uint8ClampedArray(4)),
    ).toThrow('does not match');
  });
});
