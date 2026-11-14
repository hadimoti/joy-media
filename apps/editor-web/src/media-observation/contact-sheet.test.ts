import { describe, expect, it } from 'vitest';

const loadContactSheet = async () => import('./contact-sheet.js').catch(() => undefined);

describe('timeline QC contact sheet', () => {
  it('lays out JPEG frames and burns a readable timecode into each tile', async () => {
    const contactSheet = await loadContactSheet();
    expect(contactSheet).toBeDefined();
    if (contactSheet === undefined) return;

    const labels: string[] = [];
    const drawCalls: unknown[][] = [];
    const canvasFactory = (width: number, height: number) => ({
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
    const frames = [
      {
        frameId: 'frame-1',
        timestampUs: 1_000_000,
        jpeg: new Blob(['a'], { type: 'image/jpeg' }),
        width: 320,
        height: 180,
        coverage: {
          sourceDurationUs: 130_000_000,
          sampledFrameCount: 2,
          sampledCutCount: 0,
          totalCutCount: 0,
          completeSourceCoverage: false as const,
        },
      },
      {
        frameId: 'frame-2',
        timestampUs: 123_450_000,
        jpeg: new Blob(['b'], { type: 'image/jpeg' }),
        width: 320,
        height: 180,
        coverage: {
          sourceDurationUs: 130_000_000,
          sampledFrameCount: 2,
          sampledCutCount: 0,
          totalCutCount: 0,
          completeSourceCoverage: false as const,
        },
      },
    ];

    const sheet = await contactSheet.createTimelineContactSheet({
      frames,
      canvasFactory,
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
    expect(contactSheet.formatQcTimecode(3_661_234_000)).toBe('01:01:01.234');
  });

  it('rejects more than 24 frames instead of silently omitting evidence', async () => {
    const contactSheet = await loadContactSheet();
    expect(contactSheet).toBeDefined();
    if (contactSheet === undefined) return;

    const frames = Array.from({ length: 25 }, (_, index) => ({
      frameId: `frame-${index}`,
      timestampUs: index * 1_000_000,
      jpeg: new Blob(['a'], { type: 'image/jpeg' }),
      width: 1,
      height: 1,
      coverage: {
        sourceDurationUs: 25_000_000,
        sampledFrameCount: 25,
        sampledCutCount: 0,
        totalCutCount: 0,
        completeSourceCoverage: false as const,
      },
    }));

    await expect(contactSheet.createTimelineContactSheet({ frames })).rejects.toMatchObject({
      code: 'too-many-frames',
    });
  });
});
