import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW_QUALITY,
  previewDimensions,
  previewQualityResolution,
} from './preview-quality.js';

describe('monitor preview quality', () => {
  it('defaults to quarter resolution and scales authored dimensions', () => {
    expect(DEFAULT_PREVIEW_QUALITY).toBe('quarter');
    expect(previewQualityResolution('quarter')).toBe(0.25);
    expect(previewDimensions(1080, 1920, 'quarter')).toEqual({ width: 270, height: 480 });
    expect(previewDimensions(1080, 1920, 'half')).toEqual({ width: 540, height: 960 });
  });

  it('keeps full quality lossless and clamps tiny viewports to one pixel', () => {
    expect(previewQualityResolution('full')).toBe(1);
    expect(previewDimensions(1080, 1920, 'full')).toEqual({ width: 1080, height: 1920 });
    expect(previewDimensions(1, 1, 'quarter')).toEqual({ width: 1, height: 1 });
  });
});
