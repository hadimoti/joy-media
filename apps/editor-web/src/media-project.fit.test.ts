import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { bindMediaClipToProject, type ImportedMediaAsset } from './media-project.js';

const video: ImportedMediaAsset = {
  id: 'wide-video',
  kind: 'video',
  displayName: 'wide.mp4',
  descriptor: { mimeType: 'video/mp4', width: 1920, height: 1080 },
};

describe('new media is fitted to the frame it is placed in (T-D01)', () => {
  it('contains and centres a 16:9 video in a 9:16 frame', () => {
    const next = bindMediaClipToProject(INITIAL_EDITOR_PROJECT, video, 'clip-fit', {
      width: 1080,
      height: 1920,
    });
    const transform = next.visualObjects['media-controller-clip-fit']!.transform;
    expect(transform.scaleX).toBeCloseTo(0.5625, 6);
    expect(transform.scaleY).toBeCloseTo(0.5625, 6);
    expect(transform.x).toBeCloseTo(0, 6);
    expect(transform.y).toBeCloseTo(656.25, 6);
  });

  it('keeps the old identity transform without a frame, for audio, and for an existing controller', () => {
    const noFrame = bindMediaClipToProject(INITIAL_EDITOR_PROJECT, video, 'clip-a');
    expect(noFrame.visualObjects['media-controller-clip-a']!.transform).toMatchObject({
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
    });
    const audio = bindMediaClipToProject(
      INITIAL_EDITOR_PROJECT,
      {
        id: 'sound',
        kind: 'audio',
        displayName: 'sound.wav',
        descriptor: { mimeType: 'audio/wav' },
      },
      'clip-b',
      { width: 1080, height: 1920 },
    );
    expect(audio.visualObjects['media-controller-clip-b']!.transform.scaleX).toBe(1);
    const first = bindMediaClipToProject(INITIAL_EDITOR_PROJECT, video, 'clip-c', {
      width: 1080,
      height: 1920,
    });
    const second = bindMediaClipToProject(first, video, 'clip-c', { width: 1920, height: 1080 });
    expect(second.visualObjects['media-controller-clip-c']!.transform).toEqual(
      first.visualObjects['media-controller-clip-c']!.transform,
    );
  });
});
