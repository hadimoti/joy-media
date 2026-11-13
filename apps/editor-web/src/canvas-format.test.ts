import { describe, expect, it } from 'vitest';
import {
  CANVAS_SHAPES,
  canvasFormatPresetId,
  canvasFormatReadout,
  canvasShapeForSize,
  canvasShapeLabel,
} from './canvas-format.js';

describe('canvas format shapes', () => {
  it('lists the nine shapes that exist today, with Fit left out', () => {
    expect(CANVAS_SHAPES.map((shape) => shape.label)).toEqual([
      '16:9',
      '4:3',
      '3:2',
      '21:9',
      '1:1',
      '9:16',
      '4:5',
      '3:4',
      '2:3',
    ]);
  });

  it('gives each shape the canvas size it has always had', () => {
    expect(CANVAS_SHAPES.map((shape) => [shape.label, shape.width, shape.height])).toEqual([
      ['16:9', 1920, 1080],
      ['4:3', 1440, 1080],
      ['3:2', 1620, 1080],
      ['21:9', 2520, 1080],
      ['1:1', 1080, 1080],
      ['9:16', 1080, 1920],
      ['4:5', 1080, 1350],
      ['3:4', 1080, 1440],
      ['2:3', 1080, 1620],
    ]);
  });
});

describe('canvasShapeLabel (the read-out of the shape)', () => {
  it.each(CANVAS_SHAPES.map((shape) => [shape.label, shape.width, shape.height] as const))(
    'reads %s for a %i×%i canvas',
    (label, width, height) => {
      expect(canvasShapeLabel(width, height)).toBe(label);
      expect(canvasShapeForSize(width, height)?.label).toBe(label);
    },
  );

  it('reads Custom for a canvas that matches no shape', () => {
    expect(canvasShapeLabel(1234, 987)).toBe('Custom');
    expect(canvasShapeForSize(1234, 987)).toBeUndefined();
  });
});

describe('canvasFormatReadout', () => {
  it('shows shape, size and export preset in one line', () => {
    expect(canvasFormatReadout({ width: 1920, height: 1080 }, 'youtube-1080')).toBe(
      '16:9 · 1920×1080 · YouTube · 1080p',
    );
  });

  it.each(CANVAS_SHAPES.map((shape) => [shape.label, shape.width, shape.height] as const))(
    'starts the read-out with the %s shape for its canvas',
    (label, width, height) => {
      expect(canvasFormatReadout({ width, height }, 'custom')).toBe(
        `${label} · ${width}×${height} · Custom`,
      );
    },
  );

  it('keeps a custom canvas readable instead of naming a shape it is not', () => {
    expect(canvasFormatReadout({ width: 1234, height: 987 }, 'custom')).toBe(
      'Custom · 1234×987 · Custom',
    );
  });
});

describe('canvasFormatPresetId', () => {
  it('keeps a stored preset whose size matches the canvas', () => {
    expect(canvasFormatPresetId('youtube-1080', { width: 1920, height: 1080 })).toBe(
      'youtube-1080',
    );
  });

  it('falls back to the preset that matches a canvas the stored preset does not fit', () => {
    expect(canvasFormatPresetId('tiktok-1080', { width: 1920, height: 1080 })).toBe('youtube-1080');
  });

  it('derives a preset when none is stored', () => {
    expect(canvasFormatPresetId(undefined, { width: 1080, height: 1080 })).toBe('square-1080');
  });
});
