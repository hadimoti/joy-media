import { describe, expect, it } from 'vitest';
import { CanvasTextGenerator, CanvasTextMetrics, TextStyle } from 'pixi.js';
import { pixiTextAlignmentOffset, registerPixiTextDirection } from './pixi-text-direction.js';

type TextDirection = 'ltr' | 'rtl';
type TextAlignment = 'left' | 'center' | 'right' | 'start' | 'end';

interface DrawCall {
  readonly text: string;
  readonly x: number;
  readonly left: number;
  readonly right: number;
  readonly direction: TextDirection | 'inherit';
  readonly textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  readonly letterSpacing: string;
}

class RecordingCanvasContext {
  direction: TextDirection | 'inherit' = 'ltr';
  textAlign: DrawCall['textAlign'] = 'start';
  textBaseline = 'alphabetic';
  font = '';
  fillStyle: unknown;
  strokeStyle: unknown;
  shadowColor = 'transparent';
  lineWidth = 1;
  miterLimit = 10;
  lineJoin = 'miter';
  lineCap = 'butt';
  readonly drawCalls: DrawCall[] = [];
  readonly measuredDirections: Array<{ text: string; direction: string }> = [];
  readonly measuredSamples: string[] = [];
  private currentLetterSpacing = 'normal';

  get letterSpacing(): string {
    return this.currentLetterSpacing;
  }

  set letterSpacing(value: string) {
    this.currentLetterSpacing = value;
  }

  get textLetterSpacing(): string {
    return this.currentLetterSpacing;
  }

  set textLetterSpacing(value: string) {
    this.currentLetterSpacing = value;
  }

  resetTransform(): void {}
  scale(_x: number, _y: number): void {}

  measureText(text: string): {
    width: number;
    actualBoundingBoxLeft: number;
    actualBoundingBoxRight: number;
    actualBoundingBoxAscent: number;
    actualBoundingBoxDescent: number;
  } {
    this.measuredSamples.push(text);
    this.measuredDirections.push({ text, direction: this.direction });
    const graphemes = [...text];
    const rawWidth = graphemes.reduce(
      (width, grapheme) => width + (/\s/u.test(grapheme) ? 5 : this.direction === 'rtl' ? 12 : 10),
      0,
    );
    const nativeSpacing =
      this.currentLetterSpacing === 'normal' ? 0 : Number.parseFloat(this.currentLetterSpacing);
    const width = rawWidth + Math.max(0, graphemes.length - 1) * (nativeSpacing || 0);
    return {
      width,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      actualBoundingBoxAscent: 15,
      actualBoundingBoxDescent: text.includes('\u064a') ? 46 : 21,
    };
  }

  fillText(text: string, x: number, _y: number): void {
    this.recordDraw(text, x);
  }

  strokeText(text: string, x: number, _y: number): void {
    this.recordDraw(text, x);
  }

  private recordDraw(text: string, x: number): void {
    const width = this.measureText(text).width;
    const left =
      this.textAlign === 'center'
        ? x - width / 2
        : this.textAlign === 'right' ||
            (this.textAlign === 'start' && this.direction === 'rtl') ||
            (this.textAlign === 'end' && this.direction === 'ltr')
          ? x - width
          : x;
    this.drawCalls.push({
      text,
      x,
      left,
      right: left + width,
      direction: this.direction,
      textAlign: this.textAlign,
      letterSpacing: this.letterSpacing,
    });
  }
}

interface PixiGeneratorProbe {
  _renderTextToCanvas: (...args: unknown[]) => void;
}

interface PixiMetricsProbe {
  __context?: RecordingCanvasContext;
  _experimentalLetterSpacingSupported?: boolean;
  experimentalLetterSpacing: boolean;
}

const generator = CanvasTextGenerator as unknown as PixiGeneratorProbe;
const metrics = CanvasTextMetrics as unknown as PixiMetricsProbe;

function installRecordingContext(): RecordingCanvasContext {
  const context = new RecordingCanvasContext();
  Object.defineProperty(CanvasTextMetrics, '__context', {
    configurable: true,
    writable: true,
    value: context,
  });
  Object.defineProperty(CanvasTextMetrics, '_experimentalLetterSpacingSupported', {
    configurable: true,
    writable: true,
    value: true,
  });
  metrics.experimentalLetterSpacing = false;
  CanvasTextMetrics.clearMetrics();
  return context;
}

function makeStyle(align: TextAlignment, direction: TextDirection, letterSpacing = 0): TextStyle {
  const physicalAlign: 'left' | 'center' | 'right' =
    align === 'start'
      ? direction === 'rtl'
        ? 'right'
        : 'left'
      : align === 'end'
        ? direction === 'rtl'
          ? 'left'
          : 'right'
        : align;
  const style = new TextStyle({
    fontFamily: 'Arial',
    fontSize: 20,
    letterSpacing,
    align: physicalAlign,
    wordWrap: false,
  });
  (style as unknown as { _fill: unknown })._fill = false;
  (style as unknown as { _stroke: unknown })._stroke = undefined;
  return style;
}

function measureText(text: string, style: TextStyle, context: RecordingCanvasContext) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return CanvasTextMetrics.measureText(text, style, canvas);
}

function expectedLeft(
  align: TextAlignment,
  direction: TextDirection,
  lineWidth: number,
  boxWidth: number,
): number {
  if (align === 'right' || (align === 'start' && direction === 'rtl')) {
    return boxWidth - lineWidth;
  }
  if (align === 'center') return (boxWidth - lineWidth) / 2;
  if (align === 'end' && direction === 'ltr') return boxWidth - lineWidth;
  return 0;
}

function expectedPixiOffset(
  align: TextAlignment,
  direction: TextDirection,
  lineWidth: number,
  boxWidth: number,
): number {
  if (align === 'start') return direction === 'rtl' ? boxWidth : 0;
  if (align === 'end') return direction === 'rtl' ? 0 : boxWidth;
  return expectedLeft(align, direction, lineWidth, boxWidth);
}

describe('Pixi RTL canvas text integration', () => {
  it('extends descent only for Arabic yeh, leaving Latin and Persian font metrics unchanged', () => {
    const context = installRecordingContext();
    const style = makeStyle('right', 'rtl');
    const arabic = '\u0639\u0644\u064a \u0643\u0631\u0633\u064a';
    const persian = '\u0639\u0644\u06cc \u06a9\u0631\u0633\u06cc';

    registerPixiTextDirection(style, {
      direction: 'rtl',
      align: 'right',
      lineDirections: ['rtl'],
    });
    const arabicMeasurement = measureText(arabic, style, context);
    const latinMeasurement = measureText('JOY MEDIA', makeStyle('left', 'ltr'), context);
    const persianStyle = makeStyle('right', 'rtl');
    registerPixiTextDirection(persianStyle, {
      direction: 'rtl',
      align: 'right',
      lineDirections: ['rtl'],
    });
    const persianMeasurement = measureText(persian, persianStyle, context);

    expect(CanvasTextMetrics.METRICS_STRING).not.toContain('\u064a');
    expect(metrics.__context!.measuredSamples).toContain(
      `${CanvasTextMetrics.METRICS_STRING}\u064a${CanvasTextMetrics.BASELINE_SYMBOL}`,
    );
    expect(arabicMeasurement.fontProperties.descent).toBeGreaterThanOrEqual(46);
    expect(latinMeasurement.fontProperties.descent).toBe(21);
    expect(persianMeasurement.fontProperties.descent).toBe(21);
    expect(arabic).toContain('\u064a');
    expect(persian).toContain('\u06cc');
    expect(persian).not.toContain('\u064a');
  });

  it.each([
    ['ltr', 'left'],
    ['ltr', 'center'],
    ['ltr', 'right'],
    ['ltr', 'start'],
    ['ltr', 'end'],
    ['rtl', 'left'],
    ['rtl', 'center'],
    ['rtl', 'right'],
    ['rtl', 'start'],
    ['rtl', 'end'],
  ] as const)(
    'draws real Pixi lines at %s %s positions for one and two lines',
    (direction, align) => {
      const context = installRecordingContext();
      const style = makeStyle(align, direction);
      const lines = direction === 'rtl' ? ['سلام', 'دنیا'] : ['JOY MEDIA', 'title'];
      registerPixiTextDirection(style, {
        direction,
        align,
        lineDirections: lines.map(() => direction),
      });

      const measured = measureText(lines.join('\n'), style, context);
      const canvasAndContext = { canvas: { height: 100 }, context };
      generator._renderTextToCanvas(style, 0, 1, canvasAndContext, measured);

      expect(context.drawCalls).toHaveLength(lines.length);
      for (const [index, line] of lines.entries()) {
        const width = measured.lineWidths[index]!;
        const expected = expectedLeft(align, direction, width, measured.maxLineWidth);
        expect(context.drawCalls[index]).toMatchObject({
          text: line,
          left: expected,
          right: expected + width,
          direction,
        });
      }
      expect(pixiTextAlignmentOffset(20, 100, align, direction)).toBe(
        expectedPixiOffset(align, direction, 20, 100),
      );
    },
  );

  it('does not reuse a text measurement across distinct styles with different directions', () => {
    const context = installRecordingContext();
    const ltrStyle = makeStyle('left', 'ltr');
    const rtlStyle = makeStyle('right', 'rtl');
    registerPixiTextDirection(ltrStyle, {
      direction: 'ltr',
      align: 'left',
      lineDirections: ['ltr'],
    });
    registerPixiTextDirection(rtlStyle, {
      direction: 'rtl',
      align: 'right',
      lineDirections: ['rtl'],
    });

    const ltrMeasurement = measureText('سلام', ltrStyle, context);
    const rtlMeasurement = measureText('سلام', rtlStyle, context);

    expect(ltrStyle.styleKey).not.toBe(rtlStyle.styleKey);
    expect(ltrMeasurement.width).toBe(40);
    expect(rtlMeasurement.width).toBe(48);
    expect(context.measuredDirections).toContainEqual({ text: 'سلام', direction: 'ltr' });
    expect(context.measuredDirections).toContainEqual({ text: 'سلام', direction: 'rtl' });
  });

  it('keeps Arabic joined and excludes tracking from its measured width', () => {
    const context = installRecordingContext();
    const style = makeStyle('right', 'rtl', 2);
    registerPixiTextDirection(style, {
      direction: 'rtl',
      align: 'right',
      lineDirections: ['rtl'],
    });

    const measured = measureText('سلام', style, context);
    generator._renderTextToCanvas(style, 0, 1, { canvas: { height: 100 }, context }, measured);

    expect(measured.lineWidths).toEqual([48]);
    expect(context.drawCalls).toHaveLength(1);
    expect(context.drawCalls[0]).toMatchObject({
      text: 'سلام',
      direction: 'rtl',
      letterSpacing: '0px',
    });
  });

  it('keeps tracking for a non-joining RTL script', () => {
    const context = installRecordingContext();
    const style = makeStyle('right', 'rtl', 2);
    registerPixiTextDirection(style, {
      direction: 'rtl',
      align: 'right',
      lineDirections: ['rtl'],
    });

    const measured = measureText('שלום', style, context);
    generator._renderTextToCanvas(style, 0, 1, { canvas: { height: 100 }, context }, measured);

    expect(measured.lineWidths).toEqual([54]);
    expect(context.drawCalls.map(({ text }) => text)).toEqual(['ש', 'ל', 'ו', 'ם']);
    expect(context.drawCalls.map(({ x }) => x)).toEqual([0, 14, 28, 42]);
  });
});
