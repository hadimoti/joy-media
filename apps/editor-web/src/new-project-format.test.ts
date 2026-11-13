import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEW_PROJECT_FORMAT_ID,
  NEW_PROJECT_FORMATS,
  newProjectFormatChoice,
  newProjectPresetLabel,
  newProjectSpecFor,
  parseCustomCanvas,
} from './new-project-format.js';

describe('New project format choices', () => {
  it('offers YouTube 16:9, Reels and Shorts 9:16, Square 1:1, Feed 4:5, then Custom', () => {
    expect(NEW_PROJECT_FORMATS.map((choice) => choice.label)).toEqual([
      'YouTube 16:9',
      'Reels and Shorts 9:16',
      'Square 1:1',
      'Feed 4:5',
      'Custom',
    ]);
  });

  it('gives each fixed tile its canvas and the preset that matches it', () => {
    expect(NEW_PROJECT_FORMATS.map((c) => [c.id, c.size, c.presetId])).toEqual([
      ['youtube-16-9', { width: 1920, height: 1080 }, 'youtube-1080'],
      ['reels-9-16', { width: 1080, height: 1920 }, 'reels-1080'],
      ['square-1-1', { width: 1080, height: 1080 }, 'square-1080'],
      ['feed-4-5', { width: 1080, height: 1350 }, 'instagram-feed-4x5'],
      ['custom', undefined, 'custom'],
    ]);
  });

  it('selects YouTube 16:9 at 1080p by default', () => {
    expect(DEFAULT_NEW_PROJECT_FORMAT_ID).toBe('youtube-16-9');
    expect(newProjectPresetLabel(newProjectFormatChoice('youtube-16-9'))).toBe('YouTube · 1080p');
  });

  it('refuses an unknown format id', () => {
    expect(() => newProjectFormatChoice('portrait-3-4' as never)).toThrow('unknown new-project');
  });
});

describe('newProjectSpecFor', () => {
  it('gives a fixed tile its size and preset, ignoring the Custom fields', () => {
    expect(newProjectSpecFor('reels-9-16', 'abc', '')).toEqual({
      canvas: { width: 1080, height: 1920 },
      presetId: 'reels-1080',
    });
  });

  it('gives Custom the width and height typed in', () => {
    expect(newProjectSpecFor('custom', ' 1600 ', '900')).toEqual({
      canvas: { width: 1600, height: 900 },
      presetId: 'custom',
    });
  });

  it('returns an error for Custom sizes that are not usable', () => {
    expect(newProjectSpecFor('custom', '', '1080')).toHaveProperty('error');
  });
});

describe('parseCustomCanvas', () => {
  it('accepts whole numbers from 16 to 7680 on each side', () => {
    expect(parseCustomCanvas('16', '7680')).toEqual({ canvas: { width: 16, height: 7680 } });
  });

  it.each([
    ['below the minimum', '15', '1080'],
    ['above the maximum', '1920', '7681'],
    ['a decimal', '1920.5', '1080'],
    ['a negative number', '-1920', '1080'],
    ['not a number', 'wide', '1080'],
    ['empty', '', '1080'],
  ])('refuses a side that is %s', (_label, width, height) => {
    const result = parseCustomCanvas(width, height);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('16 to 7680');
  });
});
