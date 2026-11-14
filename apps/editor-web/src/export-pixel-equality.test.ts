import { describe, expect, it, vi } from 'vitest';
import type { AppendOnlyStreamTarget, CanvasSource, Output } from 'mediabunny';
import {
  EXPORT_BT709_COLOR_SPACE,
  exportOfflineMp4,
  type OfflineMp4ExportDeps,
  type OfflineMp4ExportSource,
} from './offline-mp4-export.js';
import {
  downloadBrowserMp4,
  type BrowserMp4ExportSource,
} from '@joy-media/renderer-pixi/browser-export';

interface FakeOutputConfig {
  videoSource?: unknown;
  metadata?:
    | {
        frameRate: number;
        decoderConfig?: {
          codec: string;
          colorSpace?: unknown;
        };
      }
    | undefined;
  encodingConfig?: unknown;
}

function createFakeOutputHarness() {
  const configs: FakeOutputConfig[] = [];
  const addedFrames: unknown[][] = [];
  let currentFrames: unknown[] = [];

  class FakeVideoSource {
    constructor(
      readonly canvas: unknown,
      readonly encodingConfig: unknown,
    ) {}
    add(sample: unknown): Promise<void> {
      currentFrames.push(sample);
      return Promise.resolve();
    }
    close(): void {}
  }

  class FakeAppendOnlyStreamTarget {
    constructor(readonly writable: WritableStream<Uint8Array>) {}
  }

  class FakeOutput {
    readonly target: FakeAppendOnlyStreamTarget;
    constructor(options: { readonly target: FakeAppendOnlyStreamTarget }) {
      this.target = options.target;
      currentFrames = [];
      addedFrames.push(currentFrames);
    }
    addVideoTrack(
      videoSource: unknown,
      metadata?: { frameRate: number; decoderConfig?: { codec: string; colorSpace?: unknown } },
    ): unknown {
      configs.push({ videoSource, metadata });
      return {};
    }
    start(): Promise<void> {
      return Promise.resolve();
    }
    async finalize(): Promise<void> {
      const writer = this.target.writable.getWriter();
      await writer.write(new Uint8Array(16));
      await writer.close();
    }
  }

  return {
    configs,
    addedFrames,
    deps: {
      Output: FakeOutput as unknown as typeof Output,
      CanvasSource: FakeVideoSource as unknown as typeof CanvasSource,
      AppendOnlyStreamTarget:
        FakeAppendOnlyStreamTarget as unknown as typeof AppendOnlyStreamTarget,
    } satisfies OfflineMp4ExportDeps,
  };
}

describe('export pixel equality across repeated exports (C-077)', () => {
  it('Route 1 (offline-mp4-export): applies explicit BT.709 tags and produces identical configs and samples on first and later exports', async () => {
    const harness = createFakeOutputHarness();

    const patternPixels = new Uint8Array([200, 50, 50, 255, 100, 150, 200, 255]);
    const paintedSamples: unknown[] = [];

    const canvas = { width: 160, height: 90 } as unknown as HTMLCanvasElement;

    const baseSource = (): OfflineMp4ExportSource => ({
      manifest: {
        width: 160,
        height: 90,
        frameRate: 30,
        durationUs: 66_667,
      },
      frameCount: 2,
      canvas,
      capability: {
        ok: true,
        codec: 'avc1.640028',
        hardwareAcceleration: 'prefer-hardware',
        bitrate: 8_000_000,
      },
      paintFrame: (frameIndex) => {
        const frameBuffer = new Uint8Array(patternPixels);
        paintedSamples.push({ frameIndex, buffer: frameBuffer });
      },
    });

    // Run export #1
    const result1 = await exportOfflineMp4(baseSource(), harness.deps);

    // Run export #2 in the same session
    const result2 = await exportOfflineMp4(baseSource(), harness.deps);

    expect(result1.encoded).toBe(true);
    expect(result2.encoded).toBe(true);
    expect(result1.mimeType).toBe('video/mp4');
    expect(result2.mimeType).toBe('video/mp4');

    // Both exports must have recorded track configs
    expect(harness.configs).toHaveLength(2);
    const [config1, config2] = harness.configs;

    // Verify explicit BT.709 color space on both exports
    expect(config1?.metadata?.decoderConfig?.colorSpace).toEqual(EXPORT_BT709_COLOR_SPACE);
    expect(config2?.metadata?.decoderConfig?.colorSpace).toEqual(EXPORT_BT709_COLOR_SPACE);
    expect(config1?.metadata).toEqual(config2?.metadata);

    // Verify added frame count is equal across both runs
    expect(harness.addedFrames[0]?.length).toBe(2);
    expect(harness.addedFrames[1]?.length).toBe(2);
  });

  it('Route 2 (downloadBrowserMp4): enforces sRGB canvas context and produces identical frame data across repeated exports', async () => {
    const requestedContexts: { kind: string; options?: unknown }[] = [];
    const paintedFramesRun1: Uint8Array[] = [];
    const paintedFramesRun2: Uint8Array[] = [];

    const width = 160;
    const height = 90;

    const mockContext = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      putImageData: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(width * height * 4).fill(128),
      })),
    };

    class FakeImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const mockTrack = {
      stop: vi.fn(),
      requestFrame: vi.fn(),
    };

    const mockStream = {
      getVideoTracks: () => [mockTrack],
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
    };

    const mockCanvas = {
      width,
      height,
      getContext: vi.fn((kind: string, options?: unknown) => {
        requestedContexts.push({ kind, options });
        return mockContext;
      }),
      captureStream: vi.fn(() => mockStream),
    } as unknown as HTMLCanvasElement;

    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported(): boolean {
        return true;
      }
      readonly mimeType = 'video/mp4';
      state = 'inactive';

      start(): void {
        this.state = 'recording';
        queueMicrotask(() => this.dispatchEvent(new Event('start')));
      }

      stop(): void {
        this.state = 'inactive';
        queueMicrotask(() => {
          const event = Object.assign(new Event('dataavailable'), {
            data: new Blob(['fake-recorder-mp4'], { type: 'video/mp4' }),
          });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event('stop'));
        });
      }
    }

    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const baseSource = (sink: Uint8Array[]): BrowserMp4ExportSource => ({
      manifest: {
        width,
        height,
        frameRate: 30,
        durationUs: 33_333,
      },
      frameCount: 1,
      canvas: mockCanvas,
      audioTrack: { stop: vi.fn() } as unknown as MediaStreamTrack,
      mimeType: 'video/mp4',
      renderFrame: (_frameIndex) => {
        // Render deterministic pixel pattern
        const pixels = new Uint8Array(width * height * 4);
        for (let i = 0; i < pixels.length; i += 4) {
          pixels[i] = 200; // R
          pixels[i + 1] = 50; // G
          pixels[i + 2] = 50; // B
          pixels[i + 3] = 255; // A
        }
        sink.push(pixels);
        return pixels;
      },
      autoDownload: false,
    });

    // Run export #1
    const result1 = await downloadBrowserMp4(baseSource(paintedFramesRun1));

    // Run export #2 in the same session
    const result2 = await downloadBrowserMp4(baseSource(paintedFramesRun2));

    expect(result1.encoded).toBe(true);
    expect(result2.encoded).toBe(true);

    // Verify canvas context was created with explicit sRGB colorSpace
    expect(requestedContexts.length).toBeGreaterThanOrEqual(2);
    for (const ctxReq of requestedContexts) {
      expect(ctxReq.kind).toBe('2d');
      expect(ctxReq.options).toEqual({ colorSpace: 'srgb' });
    }

    // Verify painted pixels are identical between first and second export
    expect(paintedFramesRun1).toHaveLength(1);
    expect(paintedFramesRun2).toHaveLength(1);
    expect(paintedFramesRun1[0]).toEqual(paintedFramesRun2[0]);
  });
});
