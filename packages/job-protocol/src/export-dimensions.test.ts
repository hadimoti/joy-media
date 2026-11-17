import { describe, expect, it } from 'vitest';
import { validateH264ExportDimensions } from './export-dimensions.js';

describe('H.264 export dimensions', () => {
  it('rejects odd dimensions before the I420 VideoFrame path is reached', () => {
    expect(validateH264ExportDimensions(1921, 1080)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('even width and height'),
    });
    expect(validateH264ExportDimensions(1920, 1081).ok).toBe(false);
    expect(validateH264ExportDimensions(1920, 1080)).toEqual({ ok: true });
  });
});
