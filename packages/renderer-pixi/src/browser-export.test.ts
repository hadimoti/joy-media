import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_MP4_MIME_CANDIDATES,
  BROWSER_MP4_MIME_TYPE,
  UnsupportedBrowserMp4Error,
  downloadBrowserMp4,
  packBrowserExport,
  selectBrowserMp4MimeType,
  type BrowserMp4MimeType,
} from './browser-export.js';

const manifest = { width: 1, height: 1, frameRate: 1_000, durationUs: 1_000 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser export contracts', () => {
  it('selects exact H.264/AAC, generic MP4, then H.264-only in order without WebM', () => {
    expect(BROWSER_MP4_MIME_CANDIDATES).toEqual([
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E',
    ]);
    expect(BROWSER_MP4_MIME_CANDIDATES.every((candidate) => !candidate.includes('webm'))).toBe(
      true,
    );

    for (const selected of BROWSER_MP4_MIME_CANDIDATES) {
      const checked: BrowserMp4MimeType[] = [];
      expect(
        selectBrowserMp4MimeType((candidate) => {
          checked.push(candidate);
          return candidate === selected;
        }),
      ).toBe(selected);
      expect(checked).toEqual(
        BROWSER_MP4_MIME_CANDIDATES.slice(0, BROWSER_MP4_MIME_CANDIDATES.indexOf(selected) + 1),
      );
    }
  });

  it('raises an actionable typed failure when no MP4 candidate is supported', () => {
    expect(() => selectBrowserMp4MimeType(() => false)).toThrow(UnsupportedBrowserMp4Error);
    expect(() => selectBrowserMp4MimeType(() => false)).toThrow(/latest Chrome.*MediaRecorder MP4/);
  });

  it('fails capability preflight before recorder construction or DOM capture', async () => {
    let recorderConstructions = 0;
    class UnsupportedRecorder {
      static isTypeSupported(): boolean {
        return false;
      }

      constructor() {
        recorderConstructions++;
      }
    }
    vi.stubGlobal('MediaRecorder', UnsupportedRecorder);

    await expect(
      downloadBrowserMp4({ manifest, frameCount: 1, paintFrame: () => {} }),
    ).rejects.toBeInstanceOf(UnsupportedBrowserMp4Error);
    expect(recorderConstructions).toBe(0);
  });

  it('uses selected and recorder-reported MP4 MIME while retaining caller-owned audio', async () => {
    const harness = installRecorderHarness('video/mp4;codecs=avc1.640028,mp4a.40.2');
    const result = await downloadBrowserMp4({
      manifest,
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
      filename: 'selected.mp4',
    });

    expect(harness.captureStream).toHaveBeenCalledWith(0);
    expect(harness.recorderOptions).toMatchObject({ mimeType: 'video/mp4' });
    expect(harness.addTrack).toHaveBeenCalledWith(harness.audioTrack);
    expect(result.mimeType).toBe('video/mp4;codecs=avc1.640028,mp4a.40.2');
    expect(result.blob?.type).toBe(result.mimeType);
    expect(result.encoded).toBe(true);
    expect(harness.videoTrack.requestFrame).toHaveBeenCalledOnce();
    expect(harness.videoTrack.stop).toHaveBeenCalledOnce();
    expect(harness.audioTrack.stop).not.toHaveBeenCalled();
    expect(harness.removeTrack).toHaveBeenCalledWith(harness.audioTrack);
  });

  it('falls back to a timed capture stream when manual frame requests are unavailable', async () => {
    const harness = installRecorderHarness('video/mp4', { manualCapture: false });
    await downloadBrowserMp4({
      manifest,
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
    });

    expect(harness.captureStream.mock.calls.map(([rate]) => rate)).toEqual([0, 1_000]);
    expect(harness.unsupportedManualTrack.stop).toHaveBeenCalledOnce();
    expect(harness.videoTrack.requestFrame).toBeUndefined();
  });

  it('stops recorder and owned video resources on render failure without stopping authored audio', async () => {
    const harness = installRecorderHarness('video/mp4');
    await expect(
      downloadBrowserMp4({
        manifest,
        frameCount: 2,
        canvas: harness.canvas,
        audioTrack: harness.audioTrack,
        mimeType: 'video/mp4',
        paintFrame: (index) => {
          if (index === 1) throw new Error('paint failed');
        },
      }),
    ).rejects.toThrow('paint failed');

    expect(harness.recorderStarts).toBe(1);
    expect(harness.recorderStops).toBe(1);
    expect(harness.videoTrack.stop).toHaveBeenCalledOnce();
    expect(harness.audioTrack.stop).not.toHaveBeenCalled();
    expect(harness.removeTrack).toHaveBeenCalledWith(harness.audioTrack);
  });

  it('releases fallback audio track, oscillator, and context on failure', async () => {
    const harness = installRecorderHarness('video/mp4');
    const fallback = installFallbackAudioHarness();
    await expect(
      downloadBrowserMp4({
        manifest,
        frameCount: 1,
        canvas: harness.canvas,
        mimeType: 'video/mp4',
        paintFrame: () => {
          throw new Error('fallback paint failed');
        },
      }),
    ).rejects.toThrow('fallback paint failed');

    expect(harness.addTrack).toHaveBeenCalledWith(fallback.audioTrack);
    expect(fallback.oscillator.start).toHaveBeenCalledOnce();
    expect(fallback.oscillator.stop).toHaveBeenCalledOnce();
    expect(fallback.audioTrack.stop).toHaveBeenCalledOnce();
    expect(fallback.close).toHaveBeenCalledOnce();
  });

  it('cancels the frame wait and releases recorder resources', async () => {
    const harness = installRecorderHarness('video/mp4');
    const abortController = new AbortController();
    await expect(
      downloadBrowserMp4({
        manifest: { ...manifest, frameRate: 1 },
        frameCount: 1,
        canvas: harness.canvas,
        audioTrack: harness.audioTrack,
        mimeType: 'video/mp4',
        paintFrame: () => {},
        onProgress: () => abortController.abort(),
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(harness.recorderStops).toBe(1);
    expect(harness.videoTrack.stop).toHaveBeenCalledOnce();
    expect(harness.audioTrack.stop).not.toHaveBeenCalled();
  });

  it('retains the explicit raw-RGBA interchange fallback', () => {
    const pixels = new Uint8Array([255, 0, 0, 255]);
    const { result } = packBrowserExport({
      manifest: { width: 1, height: 1, frameRate: 30, durationUs: 33_333 },
      frames: [pixels],
      filename: 'fallback.rgba',
    });
    expect(result).toMatchObject({ encoded: false, filename: 'fallback.rgba', totalBytes: 20 });
  });

  it('requires exactly one browser paint source before touching DOM APIs', async () => {
    expect(BROWSER_MP4_MIME_TYPE).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    await expect(downloadBrowserMp4({ manifest, frameCount: 1 })).rejects.toThrow(
      'paintFrame or renderFrame is required',
    );
    await expect(
      downloadBrowserMp4({
        manifest,
        frameCount: 1,
        paintFrame: () => {},
        renderFrame: () => new Uint8Array(4),
      }),
    ).rejects.toThrow('provide either paintFrame or renderFrame, not both');
  });
});

function installRecorderHarness(
  reportedMimeType: string,
  options: { readonly manualCapture?: boolean } = {},
) {
  const videoTrack =
    options.manualCapture === false
      ? { requestFrame: undefined, stop: vi.fn() }
      : { requestFrame: vi.fn(), stop: vi.fn() };
  const unsupportedManualTrack = { stop: vi.fn() };
  const audioTrack = { kind: 'audio', stop: vi.fn() };
  const streamTracks: unknown[] = [videoTrack];
  const removeTrack = vi.fn((track: unknown) => {
    const index = streamTracks.indexOf(track);
    if (index >= 0) streamTracks.splice(index, 1);
  });
  const addTrack = vi.fn((track: unknown) => streamTracks.push(track));
  const stream = {
    addTrack,
    removeTrack,
    getVideoTracks: () => [videoTrack],
  };
  const unsupportedManualStream = {
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    getVideoTracks: () => [unsupportedManualTrack],
  };
  const captureStream = vi.fn((frameRate: number) =>
    frameRate === 0 && options.manualCapture === false ? unsupportedManualStream : stream,
  );
  const canvas = { width: 1, height: 1, captureStream };
  const recorderState = {
    starts: 0,
    stops: 0,
    options: undefined as MediaRecorderOptions | undefined,
  };

  class Recorder extends EventTarget {
    static isTypeSupported(mimeType: string): boolean {
      return mimeType.startsWith('video/mp4');
    }

    readonly mimeType = reportedMimeType;
    state: RecordingState = 'inactive';

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      recorderState.options = options;
    }

    start(): void {
      recorderState.starts++;
      this.state = 'recording';
      queueMicrotask(() => this.dispatchEvent(new Event('start')));
    }

    stop(): void {
      recorderState.stops++;
      this.state = 'inactive';
      const dataEvent = Object.assign(new Event('dataavailable'), {
        data: new Blob(['encoded-mp4'], { type: reportedMimeType }),
      });
      this.dispatchEvent(dataEvent);
      this.dispatchEvent(new Event('stop'));
    }
  }

  const body = {
    appendChild: vi.fn((anchor: { isConnected: boolean }) => {
      anchor.isConnected = true;
    }),
    removeChild: vi.fn((anchor: { isConnected: boolean }) => {
      anchor.isConnected = false;
    }),
  };
  const anchor = new EventTarget() as EventTarget & {
    href: string;
    download: string;
    rel: string;
    style: { display: string };
    isConnected: boolean;
    click: () => void;
  };
  Object.assign(anchor, {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    isConnected: false,
    click: () => anchor.dispatchEvent(new Event('click')),
  });
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('document', { createElement: () => anchor, body });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:test'),
    revokeObjectURL: vi.fn(),
  });

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    audioTrack: audioTrack as unknown as MediaStreamTrack,
    videoTrack,
    unsupportedManualTrack,
    addTrack,
    removeTrack,
    captureStream,
    get recorderStarts() {
      return recorderState.starts;
    },
    get recorderStops() {
      return recorderState.stops;
    },
    get recorderOptions() {
      return recorderState.options;
    },
  };
}

function installFallbackAudioHarness() {
  const audioTrack = { stop: vi.fn() };
  const close = vi.fn(async () => {
    context.state = 'closed';
  });
  const gain = {
    gain: { value: 0 },
    connect: vi.fn((destination: unknown) => destination),
  };
  const oscillator = {
    context: undefined as unknown as AudioContext,
    connect: vi.fn(() => gain),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const context = {
    state: 'suspended' as AudioContextState,
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [audioTrack] } }),
    createOscillator: () => oscillator,
    createGain: () => gain,
    resume: vi.fn(async () => {
      context.state = 'running';
    }),
    close,
  };
  oscillator.context = context as unknown as AudioContext;
  class FallbackAudioContext {
    constructor() {
      return context;
    }
  }
  vi.stubGlobal('AudioContext', FallbackAudioContext);
  return { audioTrack, oscillator, close };
}
