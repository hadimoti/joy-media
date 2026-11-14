import { describe, expect, it } from 'vitest';
import { createTimelineContactSheet, formatQcTimecode } from './contact-sheet.js';
import type { EvidenceFrameArtifact } from './evidence-store.js';

function createFrames(count: number): EvidenceFrameArtifact[] {
  return Array.from({ length: count }, (_, index) => ({
    frameId: `frame-${index}`,
    timestampUs: index * 1_000_000,
    jpeg: new Blob(['a'], { type: 'image/jpeg' }),
    width: 320,
    height: 180,
    coverage: {
      sourceDurationUs: count * 1_000_000,
      sampledFrameCount: count,
      sampledCutCount: 0,
      totalCutCount: 0,
      completeSourceCoverage: false,
    },
  }));
}

function canvasFactory() {
  return (width: number, height: number) => ({
    width,
    height,
    getContext: () => ({
      fillStyle: '',
      font: '',
      textBaseline: '',
      fillRect: () => undefined,
      drawImage: () => undefined,
      fillText: () => undefined,
    }),
    convertToBlob: async ({ type }: { type: string }) =>
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }),
  });
}

const imageBitmapFactory = async () => ({ width: 320, height: 180 });

describe('timeline QC contact sheet', () => {
  it('lays out JPEG frames and burns a readable timecode into each tile', async () => {
    const labels: string[] = [];
    const drawCalls: unknown[][] = [];
    const factory = (width: number, height: number) => ({
      width,
      height,
      getContext: () => ({
        fillStyle: '',
        font: '',
        textBaseline: '',
        fillRect: (...args: number[]) => drawCalls.push(['fillRect', ...args]),
        drawImage: (...args: unknown[]) => drawCalls.push(['drawImage', ...args]),
        fillText: (text: string) => labels.push(text),
      }),
      convertToBlob: async ({ type }: { type: string }) =>
        new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type }),
    });
    const frames = createFrames(2);
    frames[0] = { ...frames[0]!, timestampUs: 1_000_000 };
    frames[1] = { ...frames[1]!, timestampUs: 123_450_000 };

    const sheet = await createTimelineContactSheet({
      frames,
      canvasFactory: factory,
      imageBitmapFactory: async (blob: Blob) => ({
        width: 320,
        height: 180,
        close: () => drawCalls.push(['close', blob.size]),
      }),
      tileWidth: 320,
      tileHeight: 180,
      labelHeight: 24,
    });

    expect(sheet).toMatchObject({ type: 'image/jpeg', size: 4 });
    expect(labels).toEqual(['00:00:01.000', '00:02:03.450']);
    expect(drawCalls.filter(([kind]) => kind === 'drawImage')).toHaveLength(2);
    expect(formatQcTimecode(3_661_234_000)).toBe('01:01:01.234');
  });

  it('accepts exactly the 24-frame contact-sheet cap', async () => {
    const sheet = await createTimelineContactSheet({
      frames: createFrames(24),
      canvasFactory: canvasFactory(),
      imageBitmapFactory,
    });

    expect(sheet).toMatchObject({ type: 'image/jpeg', size: 4 });
  });

  it('rejects more than 24 frames instead of silently omitting evidence', async () => {
    await expect(
      createTimelineContactSheet({
        frames: createFrames(25),
        canvasFactory: canvasFactory(),
        imageBitmapFactory,
      }),
    ).rejects.toMatchObject({ code: 'too-many-frames' });
  });
});
