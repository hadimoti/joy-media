/** Deterministic ASS contract shared by export rendering and pixel inspection. */
export type CaptionAssStyleRef = string;
export interface CaptionAssSegment {
  readonly startUs: number;
  readonly endUs: number;
  readonly text: string;
}
export interface CaptionAssDocumentPayload {
  readonly styleRef: CaptionAssStyleRef;
  readonly segments: readonly CaptionAssSegment[];
}
export interface CaptionAssDocumentOptions {
  readonly width: number;
  readonly height: number;
}
export function captionAssDocument(
  payload: CaptionAssDocumentPayload,
  options: CaptionAssDocumentOptions,
): string {
  const { width, height } = options;
  const size = Math.max(16, Math.round(height * captionFontScale(payload.styleRef)));
  const alignment = payload.styleRef === 'joy-rtl-classic' ? 3 : 2;
  const primary = payload.styleRef === 'joy-rtl-classic' ? '&H00DCDCDC' : '&H00FFFFFF';
  const outline = payload.styleRef === 'joy-karaoke-pop' ? 2 : 3;
  const events = payload.segments.map(
    (segment) =>
      `Dialogue: 0,${captionAssTime(segment.startUs)},${captionAssTime(segment.endUs)},Default,,0,0,0,,${captionAssText(segment.text)}`,
  );
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Falsafeh Light,${size},${primary},&H00FFFFFF,&H00101010,&H90101010,0,0,0,0,100,100,0,0,3,${outline},1,${alignment},${Math.round(width * 0.1)},${Math.round(width * 0.1)},${Math.round(height * 0.1)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
function captionFontScale(styleRef: CaptionAssStyleRef): number {
  return styleRef === 'joy-karaoke-pop' ? 0.055 : styleRef === 'joy-rtl-classic' ? 0.042 : 0.045;
}
function captionAssTime(us: number): string {
  const centiseconds = Math.max(0, Math.round(us / 10_000));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor((centiseconds % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((centiseconds % 6000) / 100)).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}
function captionAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\N')
    .replace(/[{}]/g, (value) => `\\${value}`);
}
