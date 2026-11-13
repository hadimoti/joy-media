import { describe, expect, it } from 'vitest';
import {
  readCanvasReframePreference,
  writeCanvasReframePreference,
} from './canvas-reframe-preference.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('canvas reframe preference', () => {
  it('defaults to Fit and remembers the most recent valid answer', () => {
    const storage = memoryStorage();

    expect(readCanvasReframePreference(storage)).toBe('fit');
    writeCanvasReframePreference(storage, 'fill');
    expect(readCanvasReframePreference(storage)).toBe('fill');
    writeCanvasReframePreference(storage, 'keep');
    expect(readCanvasReframePreference(storage)).toBe('keep');
  });

  it('ignores invalid stored values', () => {
    const storage = memoryStorage();
    storage.setItem('joy-media.canvas-reframe-mode.v1', 'zoom');

    expect(readCanvasReframePreference(storage)).toBe('fit');
  });
});
