import { describe, expect, it } from 'vitest';
import { layoutTemplatedCaptionNodes, type CaptionCue } from '@joy-media/captions-core';
import { createTextClip } from './text-clip.js';
import {
  ffmpegCaptionFontSize,
  ffmpegCaptionX,
  ffmpegCaptionY,
  layoutFfmpegCaption,
} from './caption-layout.js';

describe('FFmpeg caption layout', () => {
  it.each([
    { width: 1920, height: 1080, x: 0, y: 0, size: 1 },
    { width: 1280, height: 720, x: -0.25, y: 0.2, size: 1.5 },
    { width: 640, height: 360, x: 0.4, y: -0.4, size: 0.75 },
  ])('matches captions-core pixel placement and font sizing for $width×$height', (example) => {
    const text = createTextClip({
      id: 'parity',
      text: 'Joy title',
      startUs: 0,
      durationUs: 1_000_000,
      x: example.x,
      y: example.y,
      size: example.size,
    });
    const cue: CaptionCue = {
      clipId: text.clip.id,
      documentId: text.document.id,
      document: text.document,
      segment: text.document.segments[0]!,
      documentTimeUs: 0,
      ...(text.clip.style === undefined ? {} : { style: text.clip.style }),
    };
    const editorNodes = layoutTemplatedCaptionNodes([cue], {
      viewportWidth: example.width,
      viewportHeight: example.height,
    });
    const rendererNodes = layoutFfmpegCaption({
      clipId: cue.clipId,
      document: cue.document,
      segment: cue.segment,
      style: cue.style,
      width: example.width,
      height: example.height,
    })!;

    expect(rendererNodes).toEqual(editorNodes);
    for (const rendererNode of rendererNodes) {
      expect(rendererNode.kind).toBe('text');
      expect(ffmpegCaptionFontSize(rendererNode)).toBe(
        Math.max(1, Math.round(rendererNode.fontSizePx! * rendererNode.transform.scaleY)),
      );
      expect(ffmpegCaptionY(rendererNode)).toBe(rendererNode.transform.translateY);
      expect(ffmpegCaptionX(rendererNode)).toContain(String(rendererNode.transform.translateX));
    }
  });

  it('creates a centered caption clip by default using editor units', () => {
    const text = createTextClip({
      id: 'centered',
      text: 'Centered',
      startUs: 0,
      durationUs: 1_000_000,
    });
    expect(text.clip.style).toMatchObject({
      positionX: 0,
      positionY: 0,
      fontSize: 1,
      align: 'center',
    });
  });

  it('keeps every wrapped line from the editor layout', () => {
    const text = createTextClip({
      id: 'wrapped',
      text: 'This is a long caption that needs multiple lines in the editor layout',
      startUs: 0,
      durationUs: 1_000_000,
    });
    const segment = {
      ...text.document.segments[0]!,
      textOverride: 'This is a long caption that needs multiple lines in the editor layout',
    };
    const layout = layoutFfmpegCaption({
      clipId: text.clip.id,
      document: text.document,
      segment,
      style: text.clip.style,
      width: 640,
      height: 360,
    });
    expect(layout.length).toBeGreaterThan(1);
    expect(
      [...layout]
        .sort((left, right) => left.transform.translateY - right.transform.translateY)
        .map((node) => node.text)
        .join(' '),
    ).toContain('multiple lines');
  });
});
