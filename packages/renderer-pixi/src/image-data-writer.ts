/** Wraps each decoded RGBA buffer directly, avoiding a second full-frame pixel allocation. */
export function createImageDataWriter(): (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  pixels: Uint8ClampedArray<ArrayBufferLike>,
) => void {
  return (context, width, height, pixels) => {
    if (pixels.byteLength !== width * height * 4) {
      throw new RangeError(
        `RGBA buffer length ${pixels.byteLength} does not match ${width}x${height}`,
      );
    }
    const imagePixels =
      pixels.buffer instanceof ArrayBuffer
        ? (pixels as unknown as Uint8ClampedArray<ArrayBuffer>)
        : new Uint8ClampedArray(pixels);
    const image = new ImageData(imagePixels, width, height);
    // ImageData wraps the source array; putImageData copies it synchronously into the canvas.
    context.putImageData(image, 0, 0);
  };
}
