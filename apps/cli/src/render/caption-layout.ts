import { layoutTemplatedCaptionNodes, type CaptionCue } from '@joy-media/captions-core';
import type {
  CaptionClipStyleV2,
  CaptionDocumentV1,
  CaptionSegmentV1,
} from '@joy-media/project-schema';

type TextNode = Extract<ReturnType<typeof layoutTemplatedCaptionNodes>[number], { kind: 'text' }>;

export interface FfmpegCaptionLayoutInput {
  readonly clipId: string;
  readonly document: CaptionDocumentV1;
  readonly segment: CaptionSegmentV1;
  readonly style: CaptionClipStyleV2 | undefined;
  readonly width: number;
  readonly height: number;
}

/** Returns every renderer-neutral text node produced by captions-core/editor layout. */
export function layoutFfmpegCaption(input: FfmpegCaptionLayoutInput): readonly TextNode[] {
  const cue: CaptionCue = {
    clipId: input.clipId,
    documentId: input.document.id,
    document: input.document,
    segment: input.segment,
    documentTimeUs: input.segment.startUs,
    ...(input.style === undefined ? {} : { style: input.style }),
  };
  return layoutTemplatedCaptionNodes([cue], {
    viewportWidth: input.width,
    viewportHeight: input.height,
  }).filter((candidate): candidate is TextNode => candidate.kind === 'text');
}

export function ffmpegCaptionX(node: TextNode): string {
  const x = finite(node.transform.translateX, 'caption x');
  finite(node.transform.scaleX, 'caption x scale');
  if (node.align === 'center') return `${x}-text_w/2`;
  if (node.align === 'right') return `${x}-text_w`;
  return String(x);
}

export function ffmpegCaptionY(node: TextNode, frameHeight?: number): number {
  const y = finite(node.transform.translateY, 'caption y');
  if (frameHeight === undefined) return y;
  const height = finite(frameHeight, 'frame height');
  const maxY = Math.max(0, height - ffmpegCaptionFontSize(node));
  return Math.min(maxY, Math.max(0, y));
}

export function ffmpegCaptionFontSize(node: TextNode): number {
  const size = finite(node.fontSizePx ?? 16, 'caption font size');
  const scale = finite(node.transform.scaleY, 'caption y scale');
  if (size <= 0 || scale <= 0)
    throw new RangeError('Caption font size and scale must be positive.');
  const result = Math.max(1, Math.round(size * scale));
  if (!Number.isSafeInteger(result)) throw new RangeError('Caption font size is invalid.');
  return result;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number.`);
  return value;
}
