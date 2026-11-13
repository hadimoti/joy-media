import { describe, expect, it } from 'vitest';
import {
  EXPORT_PRESETS,
  exportPresetCanvasSize,
  exportPresetForCanvas,
  reconcileExportPresetOnLoad,
  resolveExportSettings,
} from './export-presets.js';

describe('export format presets', () => {
  it('sets the canvas to each requested fixed preset size', () => {
    expect(exportPresetCanvasSize('tiktok-1080', { width: 1920, height: 1080 })).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(exportPresetCanvasSize('instagram-feed-4x5', { width: 1920, height: 1080 })).toEqual({
      width: 1080,
      height: 1350,
    });
    expect(exportPresetCanvasSize('square-1080', { width: 1920, height: 1080 })).toEqual({
      width: 1080,
      height: 1080,
    });
    expect(exportPresetCanvasSize('landscape-4k', { width: 1920, height: 1080 })).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('keeps the current canvas for Custom', () => {
    expect(exportPresetCanvasSize('custom', { width: 1234, height: 987 })).toEqual({
      width: 1234,
      height: 987,
    });
  });

  it('selects an exact preset for a changed canvas and Custom for an unmatched size', () => {
    expect(exportPresetForCanvas(1080, 1920)).toBe('tiktok-1080');
    expect(exportPresetForCanvas(1080, 1350)).toBe('instagram-feed-4x5');
    expect(exportPresetForCanvas(1080, 1080)).toBe('square-1080');
    expect(exportPresetForCanvas(3840, 2160)).toBe('landscape-4k');
    expect(exportPresetForCanvas(1920, 1080)).toBe('youtube-1080');
    expect(exportPresetForCanvas(1234, 987)).toBe('custom');
  });

  it('keeps an existing exact-size legacy preset when the canvas still matches it', () => {
    expect(exportPresetForCanvas(1080, 1920, 'reels-1080')).toBe('reels-1080');
  });

  it('keeps a mismatched legacy project canvas and resolves its preset with a warning', () => {
    const resolution = reconcileExportPresetOnLoad('youtube-1080', {
      width: 1080,
      height: 1920,
    });

    expect(resolution).toEqual({
      presetId: 'tiktok-1080',
      canvas: { width: 1080, height: 1920 },
      mismatch: {
        storedPresetId: 'youtube-1080',
        selectedPresetId: 'tiktok-1080',
        canvas: { width: 1080, height: 1920 },
      },
    });
  });

  it('keeps an old 1920x1080 canvas instead of converting it to portrait on load', () => {
    const resolution = reconcileExportPresetOnLoad('tiktok-1080', {
      width: 1920,
      height: 1080,
    });

    expect(resolution.canvas).toEqual({ width: 1920, height: 1080 });
    expect(resolution.presetId).toBe('youtube-1080');
  });

  it('chooses a matching preset without warning when an old project has no stored preset', () => {
    expect(reconcileExportPresetOnLoad(undefined, { width: 1920, height: 1080 })).toEqual({
      presetId: 'youtube-1080',
      canvas: { width: 1920, height: 1080 },
      mismatch: undefined,
    });
  });

  it('stores each preset as a complete video and audio export record', () => {
    expect(EXPORT_PRESETS['tiktok-1080']).toMatchObject({
      label: 'TikTok 1080p',
      shape: '9:16',
      size: { width: 1080, height: 1920 },
      frameRate: 30,
      videoBitrate: 62_208_000,
      audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitrate: 128_000 },
    });
    expect(EXPORT_PRESETS['instagram-feed-4x5']).toMatchObject({
      shape: '4:5',
      size: { width: 1080, height: 1350 },
      frameRate: 30,
      videoBitrate: 43_740_000,
    });
    expect(EXPORT_PRESETS['square-1080']).toMatchObject({
      shape: '1:1',
      size: { width: 1080, height: 1080 },
      frameRate: 30,
      videoBitrate: 34_992_000,
    });
    expect(EXPORT_PRESETS['landscape-4k']).toMatchObject({
      shape: '16:9',
      size: { width: 3840, height: 2160 },
      frameRate: 30,
      videoBitrate: 248_832_000,
    });
  });

  it('keeps every export manifest at the authored canvas size', () => {
    const canvas = { width: 1234, height: 987 };
    for (const presetId of Object.keys(EXPORT_PRESETS) as (keyof typeof EXPORT_PRESETS)[]) {
      expect(resolveExportSettings(presetId, canvas), presetId).toMatchObject(canvas);
    }
  });

  it('uses the preset frame rate, bitrate rule, and audio settings for export', () => {
    expect(resolveExportSettings('square-1080', { width: 1080, height: 1080 })).toEqual({
      width: 1080,
      height: 1080,
      frameRate: 30,
      videoBitrate: 34_992_000,
      audio: { codec: 'aac', sampleRate: 48_000, channels: 2, bitrate: 128_000 },
    });
    expect(resolveExportSettings('custom', { width: 640, height: 360 }).videoBitrate).toBe(
      6_912_000,
    );
  });
});
