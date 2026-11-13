import { describe, expect, it } from 'vitest';
import {
  type AutoPreviewQualityDecision,
  chooseAutoPreviewQuality,
  DEFAULT_PREVIEW_QUALITY,
  INITIAL_AUTO_PREVIEW_QUALITY_STATE,
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

  it('steps down immediately when the current quality exceeds the frame budget', () => {
    const frameRate = { num: 30, den: 1 };

    expect(
      chooseAutoPreviewQuality('full', 34, frameRate, INITIAL_AUTO_PREVIEW_QUALITY_STATE).quality,
    ).toBe('half');
    expect(
      chooseAutoPreviewQuality('half', 40, frameRate, INITIAL_AUTO_PREVIEW_QUALITY_STATE).quality,
    ).toBe('quarter');
  });

  it('does not flip between Full and Half around the 30 fps budget', () => {
    const frameRate = { num: 30, den: 1 };
    let decision = chooseAutoPreviewQuality(
      'full',
      34,
      frameRate,
      INITIAL_AUTO_PREVIEW_QUALITY_STATE,
    );

    expect(decision.quality).toBe('half');
    for (let frame = 0; frame < 90; frame += 1) {
      decision = chooseAutoPreviewQuality(decision.quality, 8, frameRate, decision.state);
      expect(decision.quality).toBe('half');
    }
  });

  it('steps up after a sustained fast period below the upgrade threshold', () => {
    const frameRate = { num: 30, den: 1 };
    let decision: AutoPreviewQualityDecision = {
      quality: 'half' as const,
      state: INITIAL_AUTO_PREVIEW_QUALITY_STATE,
    };

    for (let frame = 0; frame < 29; frame += 1) {
      decision = chooseAutoPreviewQuality(decision.quality, 4, frameRate, decision.state);
      expect(decision.quality).toBe('half');
    }
    decision = chooseAutoPreviewQuality(decision.quality, 4, frameRate, decision.state);

    expect(decision.quality).toBe('full');
  });

  it('holds the lower quality for at least one second at each frame rate', () => {
    for (const frameRate of [
      { num: 30, den: 1 },
      { num: 60, den: 1 },
    ]) {
      let decision = chooseAutoPreviewQuality(
        'full',
        34,
        frameRate,
        INITIAL_AUTO_PREVIEW_QUALITY_STATE,
      );
      const holdFrames = (frameRate.num / frameRate.den) * 1;

      for (let frame = 0; frame < holdFrames; frame += 1) {
        decision = chooseAutoPreviewQuality(decision.quality, 1, frameRate, decision.state);
        expect(decision.quality).toBe('half');
      }
      expect(decision.state.holdFramesRemaining).toBe(0);
    }
  });

  it('resolves Auto to full while paused and to the measured choice during playback', () => {
    expect(resolvePreviewQuality('auto', 'quarter', false)).toBe('quarter');
    expect(resolvePreviewQuality('auto', 'quarter', true)).toBe('full');
    expect(resolvePreviewQuality('half', 'quarter', true)).toBe('half');
  });
});
