import type {
  CaptionClipStyleV2,
  CaptionDocumentV1,
  CaptionClipV1,
} from '@joy-media/project-schema';

export interface CreateTextClipInput {
  readonly id: string;
  readonly text: string;
  readonly startUs: number;
  readonly durationUs: number;
  /** Caption editor frame-fraction offset (normally between -0.4 and 0.4). */
  readonly x?: number;
  /** Caption editor frame-fraction offset (normally between -0.4 and 0.4). */
  readonly y?: number;
  /** Multiplier applied to the selected caption template's font size. */
  readonly size?: number;
  readonly color?: string;
  readonly direction?: 'rtl' | 'ltr' | 'auto';
}

export function detectTextDirection(text: string): 'rtl' | 'ltr' {
  for (const character of text) {
    if (
      /\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Adlam}/u.test(
        character,
      )
    )
      return 'rtl';
    if (/\p{L}/u.test(character)) return 'ltr';
  }
  return 'ltr';
}

export function createTextClip(input: CreateTextClipInput): {
  readonly document: CaptionDocumentV1;
  readonly clip: CaptionClipV1;
} {
  if (!input.text.trim() || input.text.length > 4096)
    throw new RangeError('Text is empty or too long.');
  if (!Number.isSafeInteger(input.startUs) || input.startUs < 0)
    throw new RangeError('Text start is invalid.');
  if (!Number.isSafeInteger(input.durationUs) || input.durationUs <= 0)
    throw new RangeError('Text duration is invalid.');
  const size = input.size ?? 1;
  if (!Number.isFinite(size) || size < 0.1 || size > 8)
    throw new RangeError('Text size multiplier must be from 0.1 through 8.');
  for (const coordinate of [input.x, input.y]) {
    if (coordinate !== undefined && (!Number.isFinite(coordinate) || Math.abs(coordinate) > 0.4))
      throw new RangeError('Text position must be a frame fraction from -0.4 through 0.4.');
  }
  const color = input.color ?? '#ffffff';
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new RangeError('Text color must be #RRGGBB.');
  const wordId = `${input.id}-word`;
  const segmentId = `${input.id}-segment`;
  const direction =
    input.direction === undefined || input.direction === 'auto'
      ? detectTextDirection(input.text)
      : input.direction;
  const document: CaptionDocumentV1 = {
    id: input.id,
    language: 'en',
    direction,
    speakers: [],
    words: { [wordId]: { id: wordId, text: input.text, startUs: 0, endUs: input.durationUs } },
    segments: [{ id: segmentId, startUs: 0, endUs: input.durationUs, wordIds: [wordId] }],
  };
  const style: CaptionClipStyleV2 = {
    version: 2,
    positionX: input.x ?? 0,
    // captions-core stores positive Y as an upward offset; the CLI uses the intuitive +down convention.
    positionY: input.y === undefined || input.y === 0 ? 0 : -input.y,
    scale: 1,
    opacity: 1,
    fontSize: size,
    tracking: 0,
    lineHeight: 1,
    textColor: color,
    plateColor: '#000000',
    plateOpacity: 0,
    highlightColor: color,
    align: direction === 'rtl' ? 'end' : 'center',
  };
  const clip: CaptionClipV1 = {
    id: `text-${input.id}`,
    kind: 'caption',
    captionDocumentId: input.id,
    startUs: input.startUs,
    durationUs: input.durationUs,
    style,
  };
  return { document, clip };
}
