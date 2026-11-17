import { describe, expect, it } from 'vitest';
import { CanvasTextGenerator, TextStyle, wordWrap } from 'pixi.js';

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

type GeneratorProbe = {
  _renderTextToCanvas: (
    style: TextStyle,
    padding: number,
    resolution: number,
    canvasAndContext: { canvas: { height: number }; context: Record<string, unknown> },
    measured: {
      lines: readonly string[];
      lineHeight: number;
      lineWidths: readonly number[];
      maxLineWidth: number;
      fontProperties: { fontSize: number; ascent: number; descent: number };
      height: number;
    },
  ) => void;
  _drawLetterSpacing: (...args: unknown[]) => void;
  _setFillAndStrokeStyles: (...args: unknown[]) => void;
};

function drawCalls(style: TextStyle, lines: readonly string[]): readonly unknown[][] {
  const generator = CanvasTextGenerator as unknown as GeneratorProbe;
  const calls: unknown[][] = [];
  const originalDraw = generator._drawLetterSpacing;
  const originalStyles = generator._setFillAndStrokeStyles;
  generator._drawLetterSpacing = (text, _style, _canvas, x, y, stroke, wordSpacing) => {
    calls.push([text, x, y, stroke, wordSpacing]);
  };
  generator._setFillAndStrokeStyles = () => {};
  try {
    generator._renderTextToCanvas(
      style,
      0,
      1,
      {
        canvas: { height: 100 },
        context: { resetTransform() {}, scale() {}, textBaseline: 'alphabetic' },
      },
      {
        lines,
        lineHeight: 20,
        lineWidths: lines.map(measure),
        maxLineWidth: Math.max(...lines.map(measure), 0),
        fontProperties: { fontSize: 16, ascent: 12, descent: 4 },
        height: lines.length * 20,
      },
    );
  } finally {
    generator._drawLetterSpacing = originalDraw;
    generator._setFillAndStrokeStyles = originalStyles;
  }
  return calls;
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

  it('passes the same canvas draw arguments for a short title with wrapping enabled', () => {
    const text = 'Clean Title';
    const originalStyle = new TextStyle({ fontSize: 16, fill: 0xffffff });
    const wrappedStyle = new TextStyle({
      fontSize: 16,
      fill: 0xffffff,
      wordWrap: true,
      wordWrapWidth: 400,
      breakWords: true,
    });

    expect(drawCalls(originalStyle, [text])).toEqual(
      drawCalls(wrappedStyle, wrap(text, 400).split('\n')),
    );
  });
});
