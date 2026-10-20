import { CommandFailure } from '../utils/project-loader.js';

export interface AssCaptionCue {
  readonly text: string;
  readonly lines?: readonly string[];
  readonly measuredWidthsPx?: readonly number[];
  readonly maxWidthPx?: number;
  readonly startUs: number;
  readonly endUs: number;
  readonly karaoke?: boolean;
  readonly style?: unknown;
  readonly animation?: unknown;
  readonly direction?: 'ltr' | 'rtl' | 'auto';
}

export interface AssCaptionOptions {
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  readonly cues: readonly AssCaptionCue[];
  readonly frameRate?: { readonly num: number; readonly den: number };
  readonly fontSizePx?: number;
  readonly marginBottomPx?: number;
}

function unsupported(message: string): never {
  throw new CommandFailure('CAPTION_UNSUPPORTED', message);
}

function assTime(us: number, frameRate?: { readonly num: number; readonly den: number }): string {
  if (!Number.isFinite(us) || us < 0)
    return unsupported('Caption times must be non-negative finite values.');
  const centiseconds = Math.round(us / 10_000);
  if (frameRate) {
    if (
      !Number.isSafeInteger(frameRate.num) ||
      !Number.isSafeInteger(frameRate.den) ||
      frameRate.num <= 0 ||
      frameRate.den <= 0
    )
      return unsupported('Caption frame rate is invalid.');
    const target = ceilDiv(
      BigInt(Math.round(us)) * BigInt(frameRate.num),
      1_000_000n * BigInt(frameRate.den),
    );
    const projected = ceilDiv(
      BigInt(centiseconds) * BigInt(frameRate.num),
      100n * BigInt(frameRate.den),
    );
    if (target !== projected)
      throw new CommandFailure(
        'CAPTION_TIMING_UNREPRESENTABLE',
        'Caption boundary cannot be represented at centisecond precision without changing a visible frame.',
      );
  }
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(2, '0')}`;
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function escapeAssText(text: string): string {
  return text.replace(/[{}\\]/g, (character) => `\\${character}`).replace(/\r\n|\r|\n/g, '\\N');
}

/** Compile basic caption cues to ASS; libass performs bidirectional shaping. */
export function compileCaptionAss(options: AssCaptionOptions): string {
  const { width, height, fontFamily } = options;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
    return unsupported('Caption composition dimensions must be positive integers.');
  if (!fontFamily.trim() || /[\r\n,]/.test(fontFamily))
    return unsupported('Caption font family is invalid.');

  const dialogues = options.cues.map((cue) => {
    if (cue.karaoke || cue.style !== undefined || cue.animation !== undefined)
      return unsupported(
        'CAPTION_UNSUPPORTED: karaoke, per-cue styles, and animation tags are unsupported.',
      );
    const start = assTime(cue.startUs, options.frameRate);
    const end = assTime(cue.endUs, options.frameRate);
    const startCs = Math.round(cue.startUs / 10_000);
    const endCs = Math.round(cue.endUs / 10_000);
    if (
      cue.maxWidthPx !== undefined &&
      cue.measuredWidthsPx?.some((width) => width > cue.maxWidthPx!)
    )
      throw new CommandFailure(
        'CAPTION_LAYOUT_OVERFLOW',
        'Measured caption wrap exceeds the available line width.',
      );
    if (endCs <= startCs)
      return unsupported('Caption end must be after start at centisecond precision.');
    const hardBreaks = cue.lines?.join('\n') ?? cue.text;
    return `Dialogue: 0,${start},${end},Caption,,0,0,0,,${escapeAssText(hardBreaks)}`;
  });

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontFamily},${options.fontSizePx ?? Math.round(height / 18)},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,${options.marginBottomPx ?? Math.round(height * 0.15)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogues,
    '',
  ].join('\n');
}
