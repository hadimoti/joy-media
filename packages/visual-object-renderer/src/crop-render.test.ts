import { describe, expect, it } from 'vitest';
import type { RenderFrameIR, Transform2D } from '@joy-media/render-ir';
import { digestRgba } from '@joy-media/golden-render';
import { renderHeadlessFrame } from '@joy-media/renderer-headless';
import { renderPixiPreview } from '@joy-media/renderer-pixi';

const croppedFrame: RenderFrameIR = {
  version: 1,
  compositionId: 'crop-golden',
  timeUs: 0,
  viewport: { width: 12, height: 8, dpr: 1 },
  background: { r: 0, g: 0, b: 0, a: 255 },
  nodes: [
    {
      kind: 'sprite',
      id: 'cropped-element',
      zIndex: 0,
      opacity: 1,
      transform: {
        translateX: 2,
        translateY: 2,
        scaleX: 2,
        scaleY: 1.5,
        rotationDeg: 90,
        crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 },
      } as Transform2D,
      width: 4,
      height: 2,
      color: { r: 255, g: 0, b: 0, a: 255 },
    },
  ],
};

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4;
  return Array.from(pixels.slice(offset, offset + 4));
}

describe('cropped render parity', () => {
  it('cuts the source box before scale and rotation in preview and export', () => {
    const preview = renderPixiPreview(croppedFrame);
    const exported = renderHeadlessFrame(croppedFrame);

    expect(preview.pixels).toEqual(exported.pixels);
    expect(pixelAt(preview.pixels, preview.width, 5, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(preview.pixels, preview.width, 5, 2)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(preview.pixels, preview.width, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(preview.pixels, preview.width, 6, 3)).toEqual([255, 0, 0, 255]);
    expect(digestRgba(preview.pixels)).toBe('8a3fe473bfe818de');
  });
});
