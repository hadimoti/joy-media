import { describe, expect, it } from 'vitest';
import { hasRenderableExportMedia } from './export-media-readiness.js';

describe('hasRenderableExportMedia', () => {
  it.each([
    ['detached video', { video: {} }],
    ['static image', { stillFrame: {} }],
    ['animated image', { animatedFrameSource: {} }],
    ['video with decoded image fields', { video: {}, animatedFrameSource: {} }],
  ])('accepts %s media', (_label, media) => {
    expect(hasRenderableExportMedia(media)).toBe(true);
  });

  it.each([
    ['audio-only', { audio: {} }],
    ['unprepared', {}],
    ['explicitly empty', { video: undefined, stillFrame: undefined }],
  ])('rejects %s media', (_label, media) => {
    expect(hasRenderableExportMedia(media)).toBe(false);
  });
});
