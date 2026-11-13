import { describe, expect, it } from 'vitest';
import { shouldAskCanvasReframe } from './canvas-reframe.js';

describe('canvas reframe confirmation', () => {
  it('asks once when an existing timeline has clips and the canvas size changes', () => {
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, true),
    ).toBe(true);
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 3840, height: 2160 }, true),
    ).toBe(true);
  });

  it('skips the dialog when the canvas is unchanged or the timeline is empty', () => {
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, true),
    ).toBe(false);
    expect(
      shouldAskCanvasReframe({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, false),
    ).toBe(false);
  });
});
