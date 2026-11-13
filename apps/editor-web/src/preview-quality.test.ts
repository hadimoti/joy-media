import { describe, expect, it } from 'vitest';
import {
  chooseAutoPreviewQuality,
  DEFAULT_PREVIEW_QUALITY,
  previewDimensions,
  previewQualityResolution,
  resolvePreviewQuality,
} from './preview-quality.js';

describe('monitor preview quality', () => {
  it('defaults to Auto and scales authored dimensions for each fixed quality', () => {
    expect(DEFAULT_PREVIEW_QUALITY).toBe('auto');
    expect(previewQualityResolution('quarter')).toBe(0.25);
    expect(previewDimensions(1080, 1920, 'quarter')).toEqual({ width: 270, height: 480 });
    expect(previewDimensions(1080, 1920, 'half')).toEqual({ width: 540, height: 960 });
    expect(previewDimensions(1080, 1920, 'full')).toEqual({ width: 1080, height: 1920 });
  });

  it('keeps full quality lossless and clamps tiny viewports to one pixel', () => {
    expect(previewQualityResolution('full')).toBe(1);
    expect(previewDimensions(1080, 1920, 'full')).toEqual({ width: 1080, height: 1920 });
    expect(previewDimensions(1, 1, 'quarter')).toEqual({ width: 1, height: 1 });
  });

  it('chooses the highest estimated quality that fits the frame budget', () => {
    const frameRate = { num: 30, den: 1 };

    expect(chooseAutoPreviewQuality('full', 40, frameRate)).toBe('half');
    expect(chooseAutoPreviewQuality('half', 40, frameRate)).toBe('quarter');
    expect(chooseAutoPreviewQuality('quarter', 8, frameRate)).toBe('half');
  });

  it('resolves Auto to full while paused and to the measured choice during playback', () => {
    expect(resolvePreviewQuality('auto', 'quarter', false)).toBe('quarter');
    expect(resolvePreviewQuality('auto', 'quarter', true)).toBe('full');
    expect(resolvePreviewQuality('half', 'quarter', true)).toBe('half');
  });
});
