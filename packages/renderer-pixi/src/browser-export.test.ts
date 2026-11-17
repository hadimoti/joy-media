import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_MP4_MIME_CANDIDATES,
  BROWSER_MP4_MIME_TYPE,
  EXPORT_BT709_COLOR_SPACE,
  EXPORT_CANVAS_COLOR_SPACE,
  UnsupportedBrowserMp4Error,
  createBrowserMp4Sink,
  downloadBrowserMp4,
  packBrowserExport,
  selectBrowserMp4MimeType,
  triggerBrowserDownload,
  type BrowserMp4MimeType,
} from './browser-export.js';

type ExplicitVideoFrameInit = VideoFrameInit & {
  readonly colorSpace?: VideoColorSpaceInit;
  readonly format?: VideoPixelFormat;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
};

const manifest = { width: 1, height: 1, frameRate: 1_000, durationUs: 1_000 };

afterEach(() => {
  vi.useRealTimers();
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

  it('waits for required content fonts before constructing capture resources', async () => {
    const readiness = vi.fn(async () => {});
    const harness = installRecorderHarness('video/mp4');
    await downloadBrowserMp4({
      manifest,
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
      requiredFontFamilies: ['YekanBakh', 'Vazin'],
      fontReadiness: readiness,
    });
    expect(readiness).toHaveBeenCalledWith(['YekanBakh', 'Vazin']);
    expect(readiness.mock.invocationCallOrder[0]).toBeLessThan(
      harness.generatorCreated.mock.invocationCallOrder[0]!,
    );
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

    expect(harness.generatorCreated).toHaveBeenCalledOnce();
    expect(harness.recorderOptions).toMatchObject({ mimeType: 'video/mp4' });
    expect(harness.addTrack).toHaveBeenCalledWith(harness.audioTrack);
    expect(result.mimeType).toBe('video/mp4;codecs=avc1.640028,mp4a.40.2');
    expect(result.blob?.type).toBe(result.mimeType);
    expect(result.encoded).toBe(true);
    expect(harness.writtenFrames).toHaveLength(1);
    expect(harness.videoTrack.stop).toHaveBeenCalledOnce();
    expect(harness.audioTrack.stop).not.toHaveBeenCalled();
    expect(harness.removeTrack).toHaveBeenCalledWith(harness.audioTrack);
  });

  it('writes recorder data events to OPFS in order and returns the staged MP4 blob', async () => {
    const harness = installRecorderHarness('video/mp4');
    const written: Blob[] = [];
    const directory = {
      async getDirectoryHandle() {
        return this;
      },
      async getFileHandle(name: string) {
        return {
          async createWritable() {
            return {
              async write(chunk: Blob) {
                written.push(chunk);
              },
              async close() {},
              async abort() {},
            };
          },
          async getFile() {
            return new File(written, name, { type: 'video/mp4' });
          },
        };
      },
      async removeEntry() {},
      async *entries() {
        // No stale staging files.
      },
    };
    const fileHandleConstructor = function FakeFileHandle() {};
    Object.assign(fileHandleConstructor.prototype, { createWritable() {} });
    vi.stubGlobal('FileSystemFileHandle', fileHandleConstructor);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });

    const result = await downloadBrowserMp4({
      manifest,
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
      autoDownload: false,
    });

    expect(written).toHaveLength(1);
    expect(result.blob?.type).toBe('video/mp4');
    expect(result.blob?.size).toBe(written[0]?.size);
  });

  it('uses the preset video and audio bitrates supplied by the export manifest', async () => {
    const harness = installRecorderHarness('video/mp4');
    await downloadBrowserMp4({
      manifest: {
        ...manifest,
        width: 640,
        height: 360,
        frameRate: 24,
        videoBitrate: 8_000_000,
        audio: { codec: 'aac', sampleRate: 44_100, channels: 2, bitrate: 96_000 },
      },
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
    });

    expect(harness.recorderOptions).toMatchObject({
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 96_000,
    });
    expect(harness.canvas).toMatchObject({ width: 640, height: 360 });
  });

  it('uses explicit sRGB input and BT.709 output frames for first and second recorder exports', async () => {
    const harness = installRecorderHarness('video/mp4');
    const source = {
      manifest,
      frameCount: 1,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4' as const,
      paintFrame: () => {},
    };
    await downloadBrowserMp4(source);
    await downloadBrowserMp4(source);

    expect(harness.frameOptions).toHaveLength(4);
    expect(harness.frameOptions.map((options) => options.colorSpace)).toEqual([
      EXPORT_CANVAS_COLOR_SPACE,
      EXPORT_BT709_COLOR_SPACE,
      EXPORT_CANVAS_COLOR_SPACE,
      EXPORT_BT709_COLOR_SPACE,
    ]);
    expect(harness.frameOptions.map((options) => options.format)).toEqual([
      undefined,
      'I420',
      undefined,
      'I420',
    ]);
    expect(harness.writtenFrames).toHaveLength(2);
    expect(harness.generatorCreated).toHaveBeenCalledTimes(2);
  });

  it('writes each authored frame to the generated track with explicit BT.709 metadata', async () => {
    const harness = installRecorderHarness('video/mp4');
    await downloadBrowserMp4({
      manifest,
      frameCount: 2,
      canvas: harness.canvas,
      audioTrack: harness.audioTrack,
      mimeType: 'video/mp4',
      paintFrame: () => {},
    });

    expect(harness.frameOptions).toHaveLength(4);
    expect(harness.frameOptions.map((options) => options.timestamp)).toEqual([0, 0, 1_000, 1_000]);
    expect(harness.frameOptions.filter((options) => options.format === 'I420')).toEqual([
      expect.objectContaining({
        colorSpace: EXPORT_BT709_COLOR_SPACE,
        format: 'I420',
      }),
      expect.objectContaining({
        colorSpace: EXPORT_BT709_COLOR_SPACE,
        format: 'I420',
      }),
    ]);
    expect(harness.frameOptions.filter((options) => options.format !== 'I420')).toEqual([
      expect.objectContaining({ colorSpace: EXPORT_CANVAS_COLOR_SPACE }),
      expect.objectContaining({ colorSpace: EXPORT_CANVAS_COLOR_SPACE }),
    ]);
    expect(harness.writtenFrames).toHaveLength(2);
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

  it('keeps the blob URL alive for the browser download handoff', () => {
    vi.useFakeTimers();
    const { anchor, body, revokeObjectURL } = installBrowserDownloadHarness(true);

    triggerBrowserDownload(new Blob(['encoded-mp4'], { type: 'video/mp4' }), 'export.mp4');

    expect(body.appendChild).toHaveBeenCalledWith(anchor);
    expect(vi.getTimerCount()).toBe(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9_999);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // The event listener is one-shot, and the explicit fallback call must not
    // create a second timer when a browser dispatches duplicate clicks.
    anchor.dispatchEvent(new Event('click'));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(body.removeChild).toHaveBeenCalledWith(anchor);
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('uses the same bounded cleanup when the browser omits the click event', () => {
    vi.useFakeTimers();
    const { body, revokeObjectURL } = installBrowserDownloadHarness(false);

    triggerBrowserDownload(new Blob(['encoded-mp4'], { type: 'video/mp4' }), 'export.mp4');

    expect(vi.getTimerCount()).toBe(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(body.removeChild).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
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

describe('browser export staging files', () => {
  it('waits for the recorder chunk being written before removing a cancelled staging file', async () => {
    const harness = installRecorderHarness('video/mp4');
    // An abort that does not wait for the chunk still in flight: the removal must not depend on it.
    const opfs = installOpfsStaging({ writeDelayMs: 5, abortWaitsForWrite: false });
    const abortController = new AbortController();
    await expect(
      downloadBrowserMp4({
        manifest: { ...manifest, frameRate: 1 },
        frameCount: 2,
        canvas: harness.canvas,
        audioTrack: harness.audioTrack,
        mimeType: 'video/mp4',
        paintFrame: () => {},
        onProgress: () => abortController.abort(),
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(opfs.files.size).toBe(0);
    expect(opfs.removed).toHaveLength(1);
  });

  it('keeps a staged file whose removal was refused, and removes it on a later discard', async () => {
    const opfs = installOpfsStaging({ removeFailures: 1 });
    const sink = await createBrowserMp4Sink();
    sink.append(new Blob(['chunk']));
    await sink.discard();
    expect(opfs.files.size).toBe(1);

    await sink.discard();
    expect(opfs.files.size).toBe(0);
  });

  it('keeps a staging file whose modification time cannot be read and removes only aged ones', async () => {
    const now = Date.now();
    const opfs = installOpfsStaging({
      existing: {
        'export-staged-unreadable.mp4.part': 'unreadable',
        'export-staged-old.mp4.part': now - 3 * 3_600_000,
        'export-staged-recent.mp4.part': now - 60_000,
        'keep.mp4': now - 3 * 3_600_000,
      },
    });
    const sink = await createBrowserMp4Sink();
    await sink.discard();

    expect(opfs.removed).toContain('export-staged-old.mp4.part');
    expect(opfs.removed).not.toContain('export-staged-unreadable.mp4.part');
    expect(opfs.removed).not.toContain('export-staged-recent.mp4.part');
    expect(opfs.files.has('export-staged-unreadable.mp4.part')).toBe(true);
    expect(opfs.files.has('keep.mp4')).toBe(true);
  });
});

/**
 * An in-memory OPFS staging directory. `abortWaitsForWrite` defaults to true, as a WHATWG stream
 * does; `removeFailures` makes the next removals fail the way a file in use does.
 */
function installOpfsStaging(
  options: {
    readonly existing?: Readonly<Record<string, number | 'unreadable'>>;
    readonly abortWaitsForWrite?: boolean;
    readonly writeDelayMs?: number;
    readonly removeFailures?: number;
  } = {},
) {
  interface FakeFile {
    readonly name: string;
    readonly chunks: Blob[];
    readonly modified: number | 'unreadable';
    pending: number;
  }
  const files = new Map<string, FakeFile>();
  const removed: string[] = [];
  let removeFailures = options.removeFailures ?? 0;
  const addFile = (name: string, modified: number | 'unreadable'): FakeFile => {
    const file: FakeFile = { name, chunks: [], modified, pending: 0 };
    files.set(name, file);
    return file;
  };
  for (const [name, modified] of Object.entries(options.existing ?? {})) addFile(name, modified);
  const handleFor = (file: FakeFile) => ({
    async createWritable() {
      return {
        async write(chunk: Blob) {
          file.pending++;
          try {
            await new Promise((resolve) => setTimeout(resolve, options.writeDelayMs ?? 0));
            file.chunks.push(chunk);
          } finally {
            file.pending--;
          }
        },
        async close() {},
        async abort() {
          if (options.abortWaitsForWrite === false) return;
          while (file.pending > 0) await new Promise((resolve) => setTimeout(resolve, 1));
        },
      };
    },
    async getFile() {
      if (file.modified === 'unreadable')
        throw new DOMException('file is in use', 'NoModificationAllowedError');
      return new File(file.chunks, file.name, { lastModified: file.modified });
    },
  });
  const directory = {
    async getDirectoryHandle() {
      return this;
    },
    async getFileHandle(name: string) {
      return handleFor(files.get(name) ?? addFile(name, Date.now()));
    },
    async removeEntry(name: string) {
      if (removeFailures > 0) {
        removeFailures -= 1;
        throw new DOMException('file is in use', 'NoModificationAllowedError');
      }
      const file = files.get(name);
      if (file === undefined) throw new DOMException('no such file', 'NotFoundError');
      if (file.pending > 0) throw new DOMException('file is in use', 'NoModificationAllowedError');
      files.delete(name);
      removed.push(name);
    },
    async *entries() {
      for (const file of [...files.values()]) yield [file.name, handleFor(file)] as const;
    },
  };
  const fileHandleConstructor = function FakeFileHandle() {};
  Object.assign(fileHandleConstructor.prototype, { createWritable() {} });
  vi.stubGlobal('FileSystemFileHandle', fileHandleConstructor);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory } });
  return { files, removed };
}

function installRecorderHarness(reportedMimeType: string) {
  const videoTracks: { readonly kind: string; readonly stop: ReturnType<typeof vi.fn> }[] = [];
  const writtenFrames: unknown[] = [];
  const frameOptions: ExplicitVideoFrameInit[] = [];
  const generatorCreated = vi.fn();
  const audioTrack = { kind: 'audio', stop: vi.fn() };
  const addTrack = vi.fn();
  const removeTrack = vi.fn();
  const canvas = { width: 1, height: 1 };
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

  class FakeVideoFrame {
    readonly width: number;
    readonly height: number;

    constructor(
      source: unknown,
      readonly init: ExplicitVideoFrameInit,
    ) {
      frameOptions.push(init);
      const sourceSize = source as { readonly width?: number; readonly height?: number };
      this.width = init.codedWidth ?? sourceSize.width ?? 1;
      this.height = init.codedHeight ?? sourceSize.height ?? 1;
    }

    allocationSize(): number {
      return this.width * this.height * 4;
    }

    async copyTo(destination: AllowSharedBufferSource): Promise<PlaneLayout[]> {
      const bytes = new Uint8Array(destination as ArrayBuffer);
      for (let offset = 0; offset < bytes.length; offset += 4) {
        bytes.set([200, 50, 50, 255], offset);
      }
      return [{ offset: 0, stride: this.width * 4 }];
    }

    close(): void {}
  }

  class FakeTrackGenerator {
    readonly kind = 'video';
    readonly writable: WritableStream<VideoFrame>;
    readonly stop: ReturnType<typeof vi.fn>;

    constructor() {
      generatorCreated();
      const videoTrack = { kind: 'video', stop: vi.fn() };
      videoTracks.push(videoTrack);
      this.stop = videoTrack.stop;
      const writer = {
        ready: Promise.resolve(),
        write: vi.fn(async (frame: unknown) => {
          writtenFrames.push(frame);
        }),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };
      this.writable = { getWriter: () => writer } as unknown as WritableStream<VideoFrame>;
    }
  }

  class FakeMediaStream {
    readonly tracks: unknown[];

    constructor(tracks: unknown[] = []) {
      this.tracks = [...tracks];
    }

    addTrack(track: unknown): void {
      addTrack(track);
      this.tracks.push(track);
    }

    removeTrack(track: unknown): void {
      removeTrack(track);
      const index = this.tracks.indexOf(track);
      if (index >= 0) this.tracks.splice(index, 1);
    }

    getVideoTracks(): unknown[] {
      return this.tracks.filter((track) => (track as { kind?: string }).kind === 'video');
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
  vi.stubGlobal('VideoFrame', FakeVideoFrame);
  vi.stubGlobal('MediaStreamTrackGenerator', FakeTrackGenerator);
  vi.stubGlobal('MediaStream', FakeMediaStream);
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
    get videoTrack() {
      return videoTracks[0]!;
    },
    frameOptions,
    writtenFrames,
    generatorCreated,
    addTrack,
    removeTrack,
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

function installBrowserDownloadHarness(dispatchClick: boolean) {
  const body = {
    appendChild: vi.fn((element: { isConnected: boolean }) => {
      element.isConnected = true;
    }),
    removeChild: vi.fn((element: { isConnected: boolean }) => {
      element.isConnected = false;
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
    click: dispatchClick ? () => anchor.dispatchEvent(new Event('click')) : () => undefined,
  });
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('document', { createElement: () => anchor, body });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL });
  return { anchor, body, revokeObjectURL };
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
