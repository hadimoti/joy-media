import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasTextGenerator, CanvasTextMetrics } from 'pixi.js';
import { registerPixiTextDirection } from './pixi-text-direction.js';

interface TestCanvasContext {
  direction: 'ltr' | 'rtl' | 'inherit';
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  fillText: (text: string, x: number, y: number) => void;
  strokeText: (text: string, x: number, y: number) => void;
}

interface CanvasGeneratorProbe {
  _renderTextToCanvas: (...args: unknown[]) => void;
  _drawLetterSpacing: (...args: unknown[]) => void;
  _getAlignmentOffset: (...args: unknown[]) => number;
}

interface CanvasMetricsProbe {
  measureText: (...args: unknown[]) => unknown;
  _measureText: (...args: unknown[]) => number;
}

const generator = CanvasTextGenerator as unknown as CanvasGeneratorProbe;
const metrics = CanvasTextMetrics as unknown as CanvasMetricsProbe;
const originalGeneratorMethods = {
  renderTextToCanvas: generator._renderTextToCanvas,
  drawLetterSpacing: generator._drawLetterSpacing,
  getAlignmentOffset: generator._getAlignmentOffset,
};
const originalMetricsMethods = {
  measureText: metrics.measureText,
  measureLine: metrics._measureText,
};

afterEach(() => {
  generator._renderTextToCanvas = originalGeneratorMethods.renderTextToCanvas;
  generator._drawLetterSpacing = originalGeneratorMethods.drawLetterSpacing;
  generator._getAlignmentOffset = originalGeneratorMethods.getAlignmentOffset;
  metrics.measureText = originalMetricsMethods.measureText;
  metrics._measureText = originalMetricsMethods.measureLine;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pixi Canvas text direction adapter', () => {
  it('sets direction per line and resolves logical alignment per paragraph', () => {
    const offsets: number[] = [];
    const measureDirections: string[] = [];
    const measureAlignments: string[] = [];
    const canvasDrawCalls: Array<{
      text: string;
      x: number;
      y: number;
      direction: string;
      textAlign: string;
    }> = [];
    const style = { align: 'right', letterSpacing: 1, _fill: {} };
    const englishTitleStyle = { align: 'center', _fill: {} };
    const context: TestCanvasContext = {
      direction: 'inherit',
      textAlign: 'start',
      fillText: (text, x, y) =>
        canvasDrawCalls.push({
          text,
          x,
          y,
          direction: context.direction,
          textAlign: context.textAlign,
        }),
      strokeText: () => undefined,
    };
    vi.stubGlobal('document', {
      createElement: () => ({ getContext: () => context }),
    });
    metrics.measureText = (): undefined => {
      metrics._measureText('سلام', 0, context);
      metrics._measureText('JOY', 0, context);
      return undefined;
    };
    metrics._measureText = (...args): number => {
      const measureContext = args[2] as TestCanvasContext;
      measureDirections.push(measureContext.direction);
      measureAlignments.push(measureContext.textAlign);
      return 0;
    };
    generator._renderTextToCanvas = (...args): void => {
      const renderStyle = args[0] as object;
      if (renderStyle === englishTitleStyle) {
        generator._drawLetterSpacing('JOY MEDIA', renderStyle, { context }, 50, 24);
        return;
      }
      offsets.push(generator._getAlignmentOffset(20, 100, 'right'));
      offsets.push(generator._getAlignmentOffset(40, 100, 'right'));
      generator._drawLetterSpacing('سلام', renderStyle, { context });
      generator._drawLetterSpacing('JOY', renderStyle, { context });
    };
    generator._drawLetterSpacing = (...args): void => {
      const drawContext = (args[2] as { context: TestCanvasContext }).context;
      drawContext.fillText(String(args[0]), Number(args[3]), Number(args[4]));
    };
    generator._getAlignmentOffset = () => 0;

    // Capture the fixed English title's pre-adapter canvas calls.
    generator._renderTextToCanvas(englishTitleStyle, 0, 1, { context }, { lines: ['JOY MEDIA'] });
    const englishTitleBefore = canvasDrawCalls.map(({ text, x, y }) => ({ text, x, y }));

    registerPixiTextDirection(englishTitleStyle, {
      direction: 'auto',
      align: 'center',
      lineDirections: ['ltr'],
    });
    generator._renderTextToCanvas(englishTitleStyle, 0, 1, { context }, { lines: ['JOY MEDIA'] });
    expect(
      canvasDrawCalls.slice(englishTitleBefore.length).map(({ text, x, y }) => ({ text, x, y })),
    ).toEqual(englishTitleBefore);

    registerPixiTextDirection(style, {
      direction: 'auto',
      align: 'start',
      lineDirections: ['rtl', 'ltr'],
    });

    metrics.measureText('سلام\nJOY', style);
    const textCallsStart = canvasDrawCalls.length;
    generator._renderTextToCanvas(style, 0, 1, { context }, { lines: ['سلام', 'JOY'] });

    expect(offsets).toEqual([100, 0]);
    expect(measureDirections).toEqual(['rtl', 'ltr']);
    expect(measureAlignments).toEqual(['start', 'start']);
    expect(
      canvasDrawCalls.slice(textCallsStart).map(({ text, direction, textAlign }) => ({
        text,
        direction,
        textAlign,
      })),
    ).toEqual([
      { text: 'سلام', direction: 'rtl', textAlign: 'start' },
      { text: 'JOY', direction: 'ltr', textAlign: 'start' },
    ]);
    expect(context).toMatchObject({ direction: 'inherit', textAlign: 'start' });
  });
});
