import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Why a caption probe reports the canonical face unusable. */
export const CAPTION_FACE_UNUSABLE_REASON =
  'FFmpeg libass did not draw the canonical Noto Sans Arabic Arabic 400 TrueType face; captions require it and will fail closed.';

const PROBE_WIDTH = 320;
const PROBE_HEIGHT = 180;
const FRAME_BYTES = PROBE_WIDTH * PROBE_HEIGHT * 3;
/**
 * Fewer differing pixels than this is not a drawn glyph. A face that libass cannot load draws the
 * same frame as a family that does not exist, so the two frames then differ by nothing.
 */
const MINIMUM_DIFFERING_PIXELS = 64;
const MISSING_FAMILY = 'Joy Media Missing Caption Family';
const PERSIAN_LINE = 'مرحبا';

export interface CaptionFaceCommands {
  /** FFmpeg arguments that draw the line with the canonical family. Run with the probe folder as cwd. */
  readonly canonical: readonly string[];
  /** FFmpeg arguments that draw the same line with a family that does not exist. */
  readonly missing: readonly string[];
}

export interface CaptionFacePixelProbe {
  readonly usable: boolean;
  readonly log: string;
  readonly differingPixels: number;
}

function captionDocument(family: string): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${PROBE_WIDTH}`,
    `PlayResY: ${PROBE_HEIGHT}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${family},28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,0,2,10,10,20,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    `Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,${PERSIAN_LINE}`,
    '',
  ].join('\n');
}

function drawArguments(name: string, assFile: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'debug',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${PROBE_WIDTH}x${PROBE_HEIGHT}:d=1`,
    '-vf',
    `ass=filename=${assFile}:fontsdir=fonts`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-y',
    `${name}.rgb`,
  ];
}

/**
 * Writes the font and the two caption documents into `directory` and returns the FFmpeg commands
 * that draw them. The caller runs both commands with `directory` as the working folder, then calls
 * judgeCaptionProbe.
 */
export function prepareCaptionProbe(
  directory: string,
  fontFile: string,
  fontBytes: Uint8Array,
): CaptionFaceCommands {
  const fontsDirectory = join(directory, 'fonts');
  mkdirSync(fontsDirectory, { recursive: true });
  writeFileSync(join(fontsDirectory, fontFile), fontBytes);
  writeFileSync(join(directory, 'canonical.ass'), captionDocument('Noto Sans Arabic'), 'utf8');
  writeFileSync(join(directory, 'missing.ass'), captionDocument(MISSING_FAMILY), 'utf8');
  return {
    canonical: drawArguments('canonical', 'canonical.ass'),
    missing: drawArguments('missing', 'missing.ass'),
  };
}

function readFrame(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return Buffer.alloc(0);
  }
}

function differingPixels(first: Buffer, second: Buffer): number {
  if (first.length !== FRAME_BYTES || second.length !== FRAME_BYTES) return 0;
  let count = 0;
  for (let offset = 0; offset < FRAME_BYTES; offset += 3) {
    if (
      first[offset] !== second[offset] ||
      first[offset + 1] !== second[offset + 1] ||
      first[offset + 2] !== second[offset + 2]
    )
      count += 1;
  }
  return count;
}

/**
 * Compares the two drawn frames. Log lines are not evidence: a Windows libass build selects fonts
 * through DirectWrite and logs nothing, so only the drawn pixels decide.
 */
export function judgeCaptionProbe(options: {
  readonly directory: string;
  readonly fontFile: string;
  readonly canonical: { readonly status: number | null; readonly log: string };
  readonly missing: { readonly status: number | null };
}): CaptionFacePixelProbe {
  const drawn = differingPixels(
    readFrame(join(options.directory, 'canonical.rgb')),
    readFrame(join(options.directory, 'missing.rgb')),
  );
  const openedError = options.canonical.log
    .split(/\r?\n/)
    .some((line) => /Error opening/i.test(line) && line.includes(options.fontFile));
  return {
    usable:
      options.canonical.status === 0 &&
      options.missing.status === 0 &&
      !openedError &&
      drawn >= MINIMUM_DIFFERING_PIXELS,
    log: options.canonical.log,
    differingPixels: drawn,
  };
}
