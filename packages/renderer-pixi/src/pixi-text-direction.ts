import { CanvasTextGenerator, CanvasTextMetrics } from 'pixi.js';
import {
  resolveCanvasTextAlign,
  resolveParagraphDirection,
  type CanvasTextAlignment,
  type CanvasTextDirection,
} from './text-direction.js';

export interface PixiTextDirectionOptions {
  readonly direction: CanvasTextDirection;
  readonly align: CanvasTextAlignment;
  readonly lineDirections: readonly ('ltr' | 'rtl')[];
}

interface CanvasTextContext {
  direction: 'ltr' | 'rtl' | 'inherit';
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  fillText: (text: string, x: number, y: number) => void;
  strokeText: (text: string, x: number, y: number) => void;
}

interface CanvasAndContext {
  readonly context: CanvasTextContext;
}

type CanvasGeneratorAdapter = {
  _renderTextToCanvas: (...args: unknown[]) => void;
  _drawLetterSpacing: (...args: unknown[]) => void;
  _getAlignmentOffset: (...args: unknown[]) => number;
};

type CanvasMetricsAdapter = {
  measureText: (...args: unknown[]) => unknown;
  _measureText: (...args: unknown[]) => number;
  readonly _context: CanvasTextContext;
  readonly experimentalLetterSpacing?: boolean;
};

interface ActiveRender {
  readonly style: object;
  readonly options: PixiTextDirectionOptions;
  alignmentIndex: number;
  drawIndex: number;
}

interface ActiveMeasure {
  readonly options: PixiTextDirectionOptions;
  lineIndex: number;
}

const styleOptions = new WeakMap<object, PixiTextDirectionOptions>();
const generator = CanvasTextGenerator as unknown as CanvasGeneratorAdapter;
const metrics = CanvasTextMetrics as unknown as CanvasMetricsAdapter;
let activeRender: ActiveRender | undefined;
let activeMeasure: ActiveMeasure | undefined;
let installed = false;

function canvasTextAlign(align: CanvasTextAlignment): CanvasTextContext['textAlign'] {
  return align === 'start' || align === 'end' ? align : 'left';
}

export function registerPixiTextDirection(style: object, options: PixiTextDirectionOptions): void {
  styleOptions.set(style, options);
  installCanvasTextDirectionAdapter();
}

function installCanvasTextDirectionAdapter(): void {
  if (installed) return;
  installed = true;

  const renderTextToCanvas = generator._renderTextToCanvas;
  const drawLetterSpacing = generator._drawLetterSpacing;
  const getAlignmentOffset = generator._getAlignmentOffset;
  const measureText = metrics.measureText;
  const measureLine = metrics._measureText;

  metrics.measureText = function (...args: unknown[]): unknown {
    const style = args[1];
    const options =
      typeof style === 'object' && style !== null ? styleOptions.get(style) : undefined;
    if (options === undefined) return Reflect.apply(measureText, this, args);

    const context = metrics._context;
    const previousDirection = context.direction;
    const previousTextAlign = context.textAlign;
    const previousActiveMeasure = activeMeasure;
    context.direction = options.lineDirections[0] ?? 'ltr';
    context.textAlign = canvasTextAlign(options.align);
    activeMeasure = { options, lineIndex: 0 };
    try {
      return Reflect.apply(measureText, this, args);
    } finally {
      context.direction = previousDirection;
      context.textAlign = previousTextAlign;
      activeMeasure = previousActiveMeasure;
    }
  };

  metrics._measureText = function (...args: unknown[]): number {
    const active = activeMeasure;
    if (active === undefined) return Reflect.apply(measureLine, this, args) as number;
    const context = args[2] as CanvasTextContext;
    const previousDirection = context.direction;
    const previousTextAlign = context.textAlign;
    const lineCount = Math.max(1, active.options.lineDirections.length);
    const direction = active.options.lineDirections[active.lineIndex % lineCount] ?? 'ltr';
    active.lineIndex += 1;
    context.direction = direction;
    context.textAlign = canvasTextAlign(active.options.align);
    try {
      return Reflect.apply(measureLine, this, args) as number;
    } finally {
      context.direction = previousDirection;
      context.textAlign = previousTextAlign;
    }
  };

  generator._renderTextToCanvas = function (...args: unknown[]): void {
    const style = args[0];
    if (typeof style !== 'object' || style === null) {
      Reflect.apply(renderTextToCanvas, this, args);
      return;
    }
    const options = styleOptions.get(style);
    if (options === undefined) {
      Reflect.apply(renderTextToCanvas, this, args);
      return;
    }

    const canvasAndContext = args[3] as CanvasAndContext;
    const context = canvasAndContext.context;
    const previousDirection = context.direction;
    const previousTextAlign = context.textAlign;
    const previousActiveRender = activeRender;
    const firstDirection = options.lineDirections[0] ?? 'ltr';
    context.direction = firstDirection;
    context.textAlign = canvasTextAlign(options.align);
    activeRender = { style, options, alignmentIndex: 0, drawIndex: 0 };
    try {
      Reflect.apply(renderTextToCanvas, this, args);
    } finally {
      context.direction = previousDirection;
      context.textAlign = previousTextAlign;
      activeRender = previousActiveRender;
    }
  };

  generator._getAlignmentOffset = function (...args: unknown[]): number {
    const active = activeRender;
    if (active === undefined) {
      return Reflect.apply(getAlignmentOffset, this, args) as number;
    }
    const lineCount = Math.max(1, active.options.lineDirections.length);
    const direction = active.options.lineDirections[active.alignmentIndex % lineCount] ?? 'ltr';
    active.alignmentIndex += 1;
    const lineWidth = Number(args[0]);
    const alignWidth = Number(args[1]);
    const alignment = resolveCanvasTextAlign(active.options.align, direction);
    if (active.options.align === 'start' || active.options.align === 'end') {
      if (alignment === 'right') return alignWidth;
      if (alignment === 'center') return alignWidth / 2;
      return 0;
    }
    if (alignment === 'right') return alignWidth - lineWidth;
    if (alignment === 'center') return (alignWidth - lineWidth) / 2;
    return 0;
  };

  generator._drawLetterSpacing = function (...args: unknown[]): void {
    const active = activeRender;
    const style = args[1];
    if (active === undefined || style !== active.style) {
      Reflect.apply(drawLetterSpacing, this, args);
      return;
    }
    const text = String(args[0] ?? '');
    const canvasAndContext = args[2] as CanvasAndContext;
    const context = canvasAndContext.context;
    const previousDirection = context.direction;
    const previousTextAlign = context.textAlign;
    const lineCount = Math.max(1, active.options.lineDirections.length);
    const textStyle = active.style as {
      readonly _fill?: unknown;
      readonly _stroke?: { readonly width?: number };
      readonly letterSpacing?: number;
    };
    const callsPerLine = Math.max(
      1,
      (Number(textStyle._stroke?.width ?? 0) > 0 ? 1 : 0) + (textStyle._fill === undefined ? 0 : 1),
    );
    const direction =
      active.options.direction === 'auto'
        ? (active.options.lineDirections[Math.floor(active.drawIndex / callsPerLine) % lineCount] ??
          resolveParagraphDirection(text, 'auto'))
        : resolveParagraphDirection(text, active.options.direction);
    const wordSpacing = Number(args[6] ?? 0);
    active.drawIndex += 1;
    context.direction = direction;
    context.textAlign = canvasTextAlign(active.options.align);
    try {
      const hasNativeLetterSpacing =
        metrics.experimentalLetterSpacing === true &&
        ('letterSpacing' in context || 'textLetterSpacing' in context);
      if (
        direction === 'rtl' &&
        (wordSpacing !== 0 ||
          (Number(textStyle.letterSpacing ?? 0) !== 0 && !hasNativeLetterSpacing))
      ) {
        const x = Number(args[3]);
        const y = Number(args[4]);
        if (args[5] === true) context.strokeText(text, x, y);
        else context.fillText(text, x, y);
        return;
      }
      Reflect.apply(drawLetterSpacing, this, args);
    } finally {
      context.direction = previousDirection;
      context.textAlign = previousTextAlign;
    }
  };
}
