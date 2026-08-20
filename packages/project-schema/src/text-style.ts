/**
 * Native editable text data shared by the editor, preview renderer, and export.
 *
 * Plain VisualObjectV1.text remains supported for older projects. New text
 * objects may carry this document to preserve independently styled runs such
 * as highlighted words and lower-third name/role blocks.
 */
export type TextDirectionV1 = 'ltr' | 'rtl' | 'auto';
export type TextAlignV1 = 'start' | 'center' | 'end';
export type TextBlendModeV1 =
  'normal' | 'multiply' | 'screen' | 'overlay' | 'soft-light' | 'hard-light' | 'difference';

export interface TextGradientStopV1 {
  readonly offset: number;
  readonly color: string;
}

export type TextFillV1 =
  | { readonly kind: 'solid'; readonly color: string }
  | {
      readonly kind: 'linear-gradient';
      readonly angleDeg: number;
      readonly stops: readonly TextGradientStopV1[];
    };

export interface TextStrokeV1 {
  readonly color: string;
  readonly widthPx: number;
  readonly opacity: number;
}

export interface TextShadowV1 {
  readonly color: string;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blurPx: number;
  readonly opacity: number;
}

export interface TextGlowV1 {
  readonly color: string;
  readonly radiusPx: number;
  readonly strength: number;
}

export interface TextStyleV1 {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly lineHeight: number;
  readonly tracking: number;
  readonly direction: TextDirectionV1;
  readonly align: TextAlignV1;
  readonly fill: TextFillV1;
  readonly stroke?: TextStrokeV1;
  readonly shadow?: TextShadowV1;
  readonly glow?: TextGlowV1;
  readonly blendMode: TextBlendModeV1;
  readonly opacity: number;
}

export type TextRunStyleV1 = Partial<
  Pick<TextStyleV1, 'fontFamily' | 'fontSizePx' | 'fontWeight' | 'italic' | 'fill' | 'stroke'>
> & {
  readonly highlightColor?: string;
};

export interface TextRunV1 {
  readonly text: string;
  readonly style?: TextRunStyleV1;
}

export interface TextBlockV1 {
  readonly id: string;
  readonly runs: readonly TextRunV1[];
  readonly align?: TextAlignV1;
  readonly direction?: TextDirectionV1;
}

export interface TextDocumentV1 {
  readonly version: 1;
  readonly blocks: readonly TextBlockV1[];
}

export const DEFAULT_TEXT_STYLE_V1: TextStyleV1 = {
  fontFamily: 'YekanBakh',
  fontSizePx: 96,
  fontWeight: 700,
  italic: false,
  lineHeight: 1.15,
  tracking: 0,
  direction: 'auto',
  align: 'center',
  fill: { kind: 'solid', color: '#ffffff' },
  blendMode: 'normal',
  opacity: 1,
};

export function textDocumentFromString(text: string, id = 'text-block-1'): TextDocumentV1 {
  return { version: 1, blocks: [{ id, runs: [{ text }] }] };
}

export function textDocumentToString(document: TextDocumentV1): string {
  return document.blocks.map((block) => block.runs.map((run) => run.text).join('')).join('\n');
}
