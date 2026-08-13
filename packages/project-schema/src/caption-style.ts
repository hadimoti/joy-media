import type { PropertyBindingV2 } from './property-animation.js';

/** Clip-owned caption appearance. Text, timing, and transcript data stay on the document. */
export interface CaptionClipStyleV2 {
  readonly version: 2;
  readonly positionX: number;
  readonly positionY: number;
  readonly scale: number;
  readonly opacity: number;
  readonly fontSize: number;
  readonly tracking: number;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly plateColor: string;
  readonly plateOpacity: number;
  readonly highlightColor: string;
  readonly align: 'start' | 'center' | 'end';
  readonly templateId?: string;
}

export const IDENTITY_CAPTION_CLIP_STYLE: CaptionClipStyleV2 = {
  version: 2,
  positionX: 0,
  positionY: 0,
  scale: 1,
  opacity: 1,
  fontSize: 1,
  tracking: 0,
  lineHeight: 1,
  textColor: '#ffffff',
  plateColor: '#000000',
  plateOpacity: 0,
  highlightColor: '#e9b949',
  align: 'center',
};

export type CaptionClipStylePropertyId =
  | 'positionX'
  | 'positionY'
  | 'scale'
  | 'opacity'
  | 'fontSize'
  | 'tracking'
  | 'lineHeight'
  | 'textColor'
  | 'plateColor'
  | 'plateOpacity'
  | 'highlightColor'
  | 'align'
  | 'templateId';

export function captionClipStylePropertyBinding(
  clipId: string,
  propertyId: CaptionClipStylePropertyId,
): PropertyBindingV2 {
  return {
    ownerKind: 'caption-clip',
    ownerId: clipId,
    propertyId,
    timeDomain: 'caption-clip-local',
  };
}

export function isCaptionClipStyleV2(value: unknown): value is CaptionClipStyleV2 {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CaptionClipStyleV2>;
  return (
    candidate.version === 2 &&
    typeof candidate.positionX === 'number' &&
    typeof candidate.positionY === 'number' &&
    typeof candidate.scale === 'number' &&
    typeof candidate.opacity === 'number' &&
    typeof candidate.fontSize === 'number' &&
    typeof candidate.tracking === 'number' &&
    typeof candidate.lineHeight === 'number' &&
    typeof candidate.textColor === 'string' &&
    typeof candidate.plateColor === 'string' &&
    typeof candidate.plateOpacity === 'number' &&
    typeof candidate.highlightColor === 'string' &&
    (candidate.align === 'start' || candidate.align === 'center' || candidate.align === 'end') &&
    (candidate.templateId === undefined || typeof candidate.templateId === 'string')
  );
}

/** Strictly normalizes persisted clip style data; absent style means legacy identity. */
export function normalizeCaptionClipStyle(value: unknown): CaptionClipStyleV2 {
  if (value === undefined) return IDENTITY_CAPTION_CLIP_STYLE;
  if (!isCaptionClipStyleV2(value)) throw new RangeError('invalid caption clip style');
  const numeric = [
    value.positionX,
    value.positionY,
    value.scale,
    value.opacity,
    value.fontSize,
    value.tracking,
    value.lineHeight,
    value.plateOpacity,
  ];
  if (numeric.some((item) => !Number.isFinite(item)))
    throw new RangeError('caption clip style values must be finite');
  if (value.scale <= 0 || value.opacity < 0 || value.opacity > 1 || value.fontSize <= 0)
    throw new RangeError('caption clip style value is outside its safe range');
  if (value.plateOpacity < 0 || value.plateOpacity > 1 || value.lineHeight <= 0)
    throw new RangeError('caption clip style value is outside its safe range');
  return value;
}
