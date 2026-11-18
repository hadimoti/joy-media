// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Pixi from 'pixi.js';
import { Text, TextStyle, wordWrap } from 'pixi.js';

vi.mock('pixi.js', async (importOriginal) => {
  Object.defineProperty(globalThis, 'CanvasRenderingContext2D', {
    configurable: true,
    value: class FakeCanvasRenderingContext2D {},
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => {
      const target = {
        font: '',
        measureText: (text: string) => {
          const width = [...text].length * 10;
          return {
            width,
            actualBoundingBoxAscent: 12,
            actualBoundingBoxDescent: 4,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: width,
          };
        },
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      };
      return new Proxy(target, {
        get(object, key) {
          if (key in object) return object[key as keyof typeof object];
          return () => {};
        },
        set(object, key, value) {
          Reflect.set(object, key, value);
          return true;
        },
      });
    },
  });
  return importOriginal<typeof Pixi>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const graphemes = (text: string): string[] =>
  typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
        ({ segment }) => segment,
      )
    : [...text];

const measure = (text: string): number => graphemes(text).length * 10;

function wrap(text: string, width: number): string {
  const style = new TextStyle({
    fontSize: 16,
    wordWrap: true,
    wordWrapWidth: width,
    breakWords: true,
  });
  const canvas = { getContext: () => ({ font: '' }) } as never;
  return wordWrap(
    text,
    style,
    canvas,
    (candidate) => measure(candidate),
    (_token, breakWords) => breakWords,
    () => true,
    graphemes,
  );
}

describe('Pixi text wrapping options', () => {
  it('wraps a long English title at word boundaries within its width', () => {
    const lines = wrap(
      'This is a long English title to test wrapping inside the frame width today',
      180,
    ).split('\n');

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => measure(line) <= 180)).toBe(true);
    expect(lines.every((line) => !line.startsWith(' ') && !line.endsWith(' '))).toBe(true);
  });

  it('keeps text that exactly fits on one line', () => {
    expect(wrap('Clean Title', measure('Clean Title'))).toBe('Clean Title');
  });

  it('breaks an oversized word only between grapheme clusters', () => {
    const word = 'A👩🏽‍💻B';
    const lines = wrap(word, 20).split('\n');

    expect(lines.join('')).toBe(word);
    expect(lines.every((line) => measure(line) <= 20)).toBe(true);
    expect(lines).not.toContain('👩');
  });

  it('preserves explicit newlines', () => {
    expect(wrap('One line\nTwo lines', 200)).toBe('One line\nTwo lines');
  });

  it('measures short text identically with wrapping enabled and wraps a long title', () => {
    const shortText = 'Clean Title';
    const shortPlain = new Text({
      text: shortText,
      style: new TextStyle({ fontSize: 16, fill: 0xffffff }),
    });
    const shortWrapped = new Text({
      text: shortText,
      style: new TextStyle({
        fontSize: 16,
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: 400,
        breakWords: true,
      }),
    });
    const longText = 'This is a long English title to test wrapping inside the frame width today';
    const longPlain = new Text({
      text: longText,
      style: new TextStyle({ fontSize: 16, fill: 0xffffff }),
    });
    const longWrapped = new Text({
      text: longText,
      style: new TextStyle({
        fontSize: 16,
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: 180,
        breakWords: true,
      }),
    });

    try {
      expect({ width: shortWrapped.width, height: shortWrapped.height }).toEqual({
        width: shortPlain.width,
        height: shortPlain.height,
      });
      expect(longWrapped.height).toBeGreaterThan(longPlain.height);
      expect(longWrapped.width).toBeLessThanOrEqual(180);
    } finally {
      shortPlain.destroy();
      shortWrapped.destroy();
      longPlain.destroy();
      longWrapped.destroy();
    }
  });
});
