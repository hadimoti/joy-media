import { describe, expect, it } from 'vitest';
import {
  IDENTITY_CAPTION_CLIP_STYLE,
  captionClipStylePropertyBinding,
  isCaptionClipStyleV2,
  normalizeCaptionClipStyle,
} from './caption-style.js';

describe('caption clip-owned style model', () => {
  it('keeps identity defaults independent from transcript documents', () => {
    expect(IDENTITY_CAPTION_CLIP_STYLE).toMatchObject({ version: 2, scale: 1, opacity: 1 });
    expect(captionClipStylePropertyBinding('caption-a', 'fontSize')).toEqual({
      ownerKind: 'caption-clip',
      ownerId: 'caption-a',
      propertyId: 'fontSize',
      timeDomain: 'caption-clip-local',
    });
  });

  it('accepts a complete style and rejects malformed ranges at the type boundary', () => {
    expect(isCaptionClipStyleV2(IDENTITY_CAPTION_CLIP_STYLE)).toBe(true);
    expect(isCaptionClipStyleV2({ ...IDENTITY_CAPTION_CLIP_STYLE, version: 1 })).toBe(false);
    expect(isCaptionClipStyleV2({ ...IDENTITY_CAPTION_CLIP_STYLE, opacity: '1' })).toBe(false);
    expect(() => normalizeCaptionClipStyle({ ...IDENTITY_CAPTION_CLIP_STYLE, scale: 0 })).toThrow(
      'safe range',
    );
  });
});
