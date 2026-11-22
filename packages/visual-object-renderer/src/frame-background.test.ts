import { describe, expect, it } from 'vitest';
import { validateRenderFrameIR } from '@joy-media/render-ir';
import { buildRenderFrameIR } from './index.js';

describe('frame background', () => {
  it('keeps the solid dark frame colour by default, which export and quality captures rely on', () => {
    const frame = buildRenderFrameIR('root', 0, 1920, 1080, []);
    expect(frame.background).toEqual({ r: 12, g: 16, b: 28, a: 255 });
  });

  it('draws a transparent frame when the caller asks for one (the Monitor)', () => {
    const frame = buildRenderFrameIR('root', 0, 1920, 1080, [], {
      background: { r: 0, g: 0, b: 0, a: 0 },
    });
    expect(frame.background).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(() => validateRenderFrameIR(frame)).not.toThrow();
  });
});
