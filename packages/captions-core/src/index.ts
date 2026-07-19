import type { TextNode } from '@joy-media/render-ir';
export interface CaptionWord {
  readonly id: string;
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
}
export interface CaptionSegment {
  readonly id: string;
  readonly speakerId?: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly words: readonly CaptionWord[];
}
export interface CaptionSpeaker {
  readonly id: string;
  readonly name: string;
}
export interface CaptionDocument {
  readonly id: string;
  readonly locale: string;
  readonly speakers: readonly CaptionSpeaker[];
  readonly segments: readonly CaptionSegment[];
}
export function activeCaptionText(document: CaptionDocument, timeUs: number): string {
  return document.segments
    .filter((segment) => segment.startUs <= timeUs && timeUs < segment.endUs)
    .flatMap((segment) =>
      segment.words
        .filter((word) => word.startUs <= timeUs && timeUs < word.endUs)
        .map((word) => word.text),
    )
    .join(' ');
}
export function captionTextNode(
  document: CaptionDocument,
  timeUs: number,
  width: number,
  height: number,
): TextNode | undefined {
  const text = activeCaptionText(document, timeUs);
  return text.length === 0
    ? undefined
    : {
        kind: 'text',
        id: `caption:${document.id}`,
        zIndex: 10_000,
        opacity: 1,
        transform: { translateX: width * 0.1, translateY: height * 0.82, scaleX: 1, scaleY: 1 },
        text,
        color: { r: 255, g: 255, b: 255, a: 255 },
      };
}
