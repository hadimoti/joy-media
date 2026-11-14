import { afterEach, describe, expect, it, vi } from 'vitest';
import { Output } from 'mediabunny';
import { exportOfflineMp4, type OfflineMp4ExportSource } from './offline-mp4-export.js';
import {
  downloadBrowserMp4,
  type BrowserMp4ExportSource,
} from '@joy-media/renderer-pixi/browser-export';

/**
 * These tests check track metadata and the requested canvas color space only.
 * They do not encode, decode, or compare real pixels. That comparison belongs in an E2E browser
 * export spec and the attended T-A10 export matrix; it remains unverified here.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offline MP4 export metadata', () => {
  it('does not pass incomplete decoder metadata to mediabunny for the first and later exports', async () => {
    const capturedMetadata: unknown[] = [];
    const stopBeforeEncoding = new Error('stop before frame encoding');

    class TestCanvas {}
    vi.stubGlobal('HTMLCanvasElement', TestCanvas);

    class InspectingOutput extends Output {
      override addVideoTrack(
        source: Parameters<Output['addVideoTrack']>[0],
        metadata?: Parameters<Output['addVideoTrack']>[1],
      ) {
        const track = super.addVideoTrack(source, metadata);
        capturedMetadata.push(metadata);
        return track;
      }

      override async start(): Promise<void> {
        throw stopBeforeEncoding;
      }
    }

    const canvas = Object.assign(new TestCanvas(), { width: 160, height: 90 }) as HTMLCanvasElement;
    const source: OfflineMp4ExportSource = {
      manifest: { width: 160, height: 90, frameRate: 30, durationUs: 33_333 },
      frameCount: 1,
      canvas,
      paintFrame: () => undefined,
      capability: {
        ok: true,
        codec: 'avc1.640028',
        hardwareAcceleration: 'prefer-hardware',
        bitrate: 8_000_000,
      },
    };

    for (let exportIndex = 0; exportIndex < 2; exportIndex += 1) {
      await expect(
        exportOfflineMp4(source, {
          Output: InspectingOutput as unknown as typeof Output,
          cancelGraceMs: 0,
        }),
      ).rejects.toBe(stopBeforeEncoding);
    }

    expect(capturedMetadata).toHaveLength(2);
    expect(capturedMetadata[0]).toEqual(capturedMetadata[1]);
    expect(capturedMetadata[0]).toEqual({ frameRate: 30 });
  });
});

describe('recorder export canvas setup', () => {
  it('requests an sRGB canvas context for first and later recorder exports', async () => {
    const requestedContexts: { kind: string; options?: unknown }[] = [];
    const width = 160;
    const height = 90;
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      putImageData: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray(width * height * 4),
      })),
    };
    const track = { stop: vi.fn(), requestFrame: vi.fn() };
    const stream = {
      getVideoTracks: () => [track],
      addTrack: vi.fn(),
      removeTrack: vi.fn(),
    };
    const canvas = {
      width,
      height,
      getContext: vi.fn((kind: string, options?: unknown) => {
        requestedContexts.push({ kind, options });
        return context;
      }),
      captureStream: vi.fn(() => stream),
    } as unknown as HTMLCanvasElement;

    class FakeImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    }

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
            data: new Blob(['mock-recorder-output'], { type: 'video/mp4' }),
          });
          this.dispatchEvent(event);
          this.dispatchEvent(new Event('stop'));
        });
      }
    }

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const source: BrowserMp4ExportSource = {
      manifest: { width, height, frameRate: 30, durationUs: 33_333 },
      frameCount: 1,
      canvas,
      audioTrack: { stop: vi.fn() } as unknown as MediaStreamTrack,
      mimeType: 'video/mp4',
      renderFrame: () => new Uint8Array(width * height * 4),
      autoDownload: false,
    };

    const first = await downloadBrowserMp4(source);
    const later = await downloadBrowserMp4(source);

    expect(first.encoded).toBe(true);
    expect(later.encoded).toBe(true);
    expect(requestedContexts.length).toBeGreaterThanOrEqual(2);
    for (const request of requestedContexts) {
      expect(request).toEqual({ kind: '2d', options: { colorSpace: 'srgb' } });
    }
  });
});
