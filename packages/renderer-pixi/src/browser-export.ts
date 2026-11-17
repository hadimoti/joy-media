/**
 * Browser-side export adapter for RGBA frames and native MP4 recording.
 *
 * `export-core` shells out to ffmpeg/ffprobe via `node:child_process`, which
 * is unreachable in the browser. This module produces a downloadable Blob
 * directly from supplied RGBA frames. Chromium's native MediaRecorder can
 * mux H.264 video and AAC audio into MP4, so the editor's Export button uses
 * that path. The raw `.rgba` packer remains available as a non-encoded
 * interchange fallback for callers that explicitly need raw pixels.
 */

export interface BrowserExportFrameSource {
  /** Manifest describing the intended output dimensions / frame rate. */
  readonly manifest: BrowserExportManifest;
  /** RGBA frames in presentation order, top-left origin. */
  readonly frames: readonly Uint8Array[];
  /** Filename suggested to the user when the download is triggered. */
  readonly filename?: string;
}

export interface BrowserExportManifest {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly durationUs: number;
  readonly videoBitrate?: number;
  readonly audio?: {
    readonly codec: 'aac';
    readonly sampleRate: number;
    readonly channels: number;
    readonly bitrate: number;
  };
}

export interface BrowserExportResult {
  /** Number of RGBA frames included in the export. */
  readonly frameCount: number;
  /** Total payload size in bytes (header + all frames). */
  readonly totalBytes: number;
  /** MIME type advertised on the produced Blob. */
  readonly mimeType: string;
  /** The filename that was used (or suggested) for the download. */
  readonly filename: string;
  /**
   * The encoded payload, when the caller wants to re-offer the download
   * (e.g. an export-history panel). Omitted by producers that cannot or
   * should not retain the bytes.
   */
  readonly blob?: Blob;
  /**
   * `true` when a real encoded container (e.g. MP4) was emitted; `false` for
   * the explicit raw-RGBA interchange fallback.
   */
  readonly encoded: boolean;
}

// Chromium can report a blob download asynchronously, especially after a
// long-running export or when the renderer is under headless CI load. Keep
// the object URL alive long enough for the browser to claim it, while still
// bounding its lifetime if the click is ignored.
export const BROWSER_DOWNLOAD_URL_RETENTION_MS = 10_000;

/** The color description shared by WebCodecs frames and browser MP4 metadata. */
export const EXPORT_BT709_COLOR_SPACE = Object.freeze({
  primaries: 'bt709' as const,
  transfer: 'bt709' as const,
  matrix: 'bt709' as const,
  fullRange: false,
});

/** HTML canvas pixels use sRGB, which shares BT.709 primaries but not its transfer/range. */
export const EXPORT_CANVAS_COLOR_SPACE = Object.freeze({
  primaries: 'bt709' as const,
  transfer: 'iec61966-2-1' as const,
  matrix: 'rgb' as const,
  fullRange: true,
});

export type BrowserExportVideoFrameConstructor = new (
  source: CanvasImageSource,
  init: VideoFrameInit,
) => VideoFrame;

/** Creates a canvas frame with explicit sRGB color metadata. */
export function createCanvasExportVideoFrame(
  source: CanvasImageSource,
  init: Omit<VideoFrameInit, 'colorSpace'>,
  VideoFrameConstructor: BrowserExportVideoFrameConstructor = VideoFrame,
): VideoFrame {
  return new VideoFrameConstructor(source, {
    ...init,
    colorSpace: { ...EXPORT_CANVAS_COLOR_SPACE },
  } as VideoFrameInit);
}

/** Materializes canvas pixels as limited-range BT.709 YUV before MediaRecorder sees them. */
export async function createBt709YuvExportVideoFrame(
  source: CanvasImageSource,
  init: Omit<VideoFrameInit, 'colorSpace'>,
): Promise<VideoFrame> {
  const sourceFrame = createCanvasExportVideoFrame(source, init);
  try {
    const copyableFrame = sourceFrame as VideoFrame & {
      allocationSize?: (options?: { readonly format?: VideoPixelFormat }) => number;
      copyTo?: (
        destination: AllowSharedBufferSource,
        options?: { readonly format?: VideoPixelFormat },
      ) => Promise<PlaneLayout[]>;
    };
    if (copyableFrame.allocationSize === undefined || copyableFrame.copyTo === undefined)
      throw new Error('This browser cannot produce color-tagged BT.709 video frames.');

    const rgbaFormat = 'RGBA';
    const rgba = new Uint8Array(copyableFrame.allocationSize({ format: rgbaFormat }));
    const [rgbaLayout] = await copyableFrame.copyTo(rgba, { format: rgbaFormat });
    if (rgbaLayout === undefined) throw new Error('Browser returned no RGBA frame layout.');
    const data = convertSrgbRgbaToBt709I420(
      rgba,
      sourceFrame.codedWidth,
      sourceFrame.codedHeight,
      rgbaLayout.offset,
      rgbaLayout.stride,
    );
    const RawVideoFrameConstructor = VideoFrame as unknown as new (
      source: AllowSharedBufferSource,
      init: VideoFrameInit,
    ) => VideoFrame;
    return new RawVideoFrameConstructor(data, {
      format: 'I420',
      codedWidth: sourceFrame.codedWidth,
      codedHeight: sourceFrame.codedHeight,
      timestamp: init.timestamp,
      duration: init.duration,
      colorSpace: { ...EXPORT_BT709_COLOR_SPACE },
    } as VideoFrameInit);
  } finally {
    sourceFrame.close();
  }
}

function convertSrgbRgbaToBt709I420(
  rgba: Uint8Array,
  width: number,
  height: number,
  offset: number,
  stride: number,
): Uint8Array {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const lumaSize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  const output = new Uint8Array(lumaSize + chromaSize * 2);
  const clampByte = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

  for (let pixel = 0; pixel < lumaSize; pixel += 1) {
    const row = Math.floor(pixel / width);
    const column = pixel % width;
    const sourceOffset = offset + row * stride + column * 4;
    const r = rgba[sourceOffset]! / 255;
    const g = rgba[sourceOffset + 1]! / 255;
    const b = rgba[sourceOffset + 2]! / 255;
    const yPrime = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    output[pixel] = clampByte(16 + 219 * yPrime);
  }

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let cbTotal = 0;
      let crTotal = 0;
      let sampleCount = 0;
      for (let dy = 0; dy < 2 && y + dy < height; dy += 1) {
        for (let dx = 0; dx < 2 && x + dx < width; dx += 1) {
          const sourceOffset = offset + (y + dy) * stride + (x + dx) * 4;
          const r = rgba[sourceOffset]! / 255;
          const g = rgba[sourceOffset + 1]! / 255;
          const b = rgba[sourceOffset + 2]! / 255;
          const yPrime = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          cbTotal += 128 + (224 * (b - yPrime)) / (2 * (1 - 0.0722));
          crTotal += 128 + (224 * (r - yPrime)) / (2 * (1 - 0.2126));
          sampleCount += 1;
        }
      }
      const chromaPixel = (y / 2) * chromaWidth + x / 2;
      output[lumaSize + chromaPixel] = clampByte(cbTotal / sampleCount);
      output[lumaSize + chromaSize + chromaPixel] = clampByte(crTotal / sampleCount);
    }
  }

  return output;
}

/** Sets the BT.709 output hint for engines that accept the Chromium extension. */
export function setBt709EncoderColorSpace(config: VideoEncoderConfig): void {
  (config as VideoEncoderConfig & { colorSpace?: VideoColorSpaceInit }).colorSpace = {
    ...EXPORT_BT709_COLOR_SPACE,
  };
}

/** Preferred native MP4 profile for Chromium's H.264/AAC MediaRecorder. */
export const BROWSER_MP4_MIME_TYPE = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

/**
 * MP4 candidates are ordered to preserve authored audio whenever the browser
 * can advertise it explicitly, then accept the browser's MP4 muxer default,
 * and only then fall back to an H.264-only declaration. WebM is deliberately
 * absent because the editor promises an MP4 download.
 */
export const BROWSER_MP4_MIME_CANDIDATES = [
  BROWSER_MP4_MIME_TYPE,
  'video/mp4',
  'video/mp4;codecs=avc1.42E01E',
] as const;

export type BrowserMp4MimeType = (typeof BROWSER_MP4_MIME_CANDIDATES)[number];
export type BrowserMp4MimeSupport = (mimeType: BrowserMp4MimeType) => boolean;

export interface BrowserMp4Sink {
  append(chunk: Blob): void;
  finish(type: string): Promise<Blob>;
  discard(): Promise<void>;
}

interface BrowserOpfsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserOpfsDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserOpfsFile>;
  removeEntry(name: string): Promise<void>;
  entries?: () => AsyncIterableIterator<[string, BrowserOpfsFile]>;
}

interface BrowserOpfsFile {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
  getFile(): Promise<File>;
}

/** A staging file younger than this may belong to another window's running export. */
export const STALE_EXPORT_STAGE_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Whether a staging entry may be removed as abandoned. A file whose modification time cannot be
 * read is kept: it may be another window's open writable, and removing it would break that export.
 */
export async function isAbandonedExportStage(handle: {
  readonly getFile?: () => Promise<{ readonly lastModified?: number }>;
}): Promise<boolean> {
  const modified = await Promise.resolve()
    .then(() => handle.getFile?.())
    .then((file) => file?.lastModified)
    .catch(() => undefined);
  return typeof modified === 'number' && Date.now() - modified >= STALE_EXPORT_STAGE_AGE_MS;
}

/**
 * Removes a staged file. Reports `true` only when the file is really gone: removed now, or already
 * missing. A removal the browser refuses (the file is still in use) reports `false`, so a later
 * discard can try again.
 */
async function removeStagedFile(directory: BrowserOpfsDirectory, name: string): Promise<boolean> {
  try {
    await directory.removeEntry(name);
    return true;
  } catch (error) {
    return (error as { readonly name?: unknown } | null)?.name === 'NotFoundError';
  }
}

/** Stages the recorder's chunks in OPFS, or in memory when OPFS is unavailable. Exported for the staging tests. */
export async function createBrowserMp4Sink(): Promise<BrowserMp4Sink> {
  const parts: Blob[] = [];
  let discarded = false;
  const fallback: BrowserMp4Sink = {
    append: (chunk) => {
      if (!discarded) parts.push(chunk);
    },
    finish: async (type) => new Blob(parts, { type }),
    discard: async () => {
      discarded = true;
      parts.length = 0;
    },
  };
  const storage = globalThis.navigator?.storage as
    (StorageManager & { getDirectory?: () => Promise<BrowserOpfsDirectory> }) | undefined;
  const fileHandleConstructor = (
    globalThis as typeof globalThis & {
      FileSystemFileHandle?: { prototype?: { createWritable?: unknown } };
    }
  ).FileSystemFileHandle;
  if (
    typeof storage?.getDirectory !== 'function' ||
    typeof fileHandleConstructor?.prototype?.createWritable !== 'function'
  )
    return fallback;

  let root: BrowserOpfsDirectory;
  let directory: BrowserOpfsDirectory | undefined;
  let name = '';
  let file: BrowserOpfsFile;
  let writable: Awaited<ReturnType<BrowserOpfsFile['createWritable']>>;
  try {
    root = await storage.getDirectory();
    directory = await root.getDirectoryHandle('export-staging', { create: true });
    if (directory.entries !== undefined) {
      for await (const [staleName, staleHandle] of directory.entries()) {
        if (
          staleName.startsWith('export-staged-') &&
          staleName.endsWith('.mp4.part') &&
          (await isAbandonedExportStage(staleHandle))
        )
          await directory.removeEntry(staleName).catch(() => undefined);
      }
    }
    name = `export-staged-${crypto.randomUUID()}.mp4.part`;
    file = await directory.getFileHandle(name, { create: true });
    writable = await file.createWritable();
  } catch {
    if (directory !== undefined && name !== '')
      await directory.removeEntry(name).catch(() => undefined);
    return fallback;
  }

  let queue = Promise.resolve();
  let failure: unknown;
  let size = 0;
  let fallbackMode = false;
  let closed = false;
  let removed = false;
  return {
    append(chunk) {
      if (discarded || failure !== undefined) return;
      queue = queue
        .then(async () => {
          if (discarded || failure !== undefined) return;
          if (fallbackMode) {
            parts.push(chunk);
            return;
          }
          try {
            await writable.write(chunk);
            size += chunk.size;
          } catch (error) {
            if (size !== 0) throw error;
            await writable.abort?.().catch(() => undefined);
            removed = await removeStagedFile(directory!, name);
            fallbackMode = true;
            parts.push(chunk);
          }
        })
        .catch((error: unknown) => {
          failure = error;
        });
    },
    async finish(type) {
      await queue;
      if (failure !== undefined) throw failure;
      if (fallbackMode) return new Blob(parts, { type });
      await writable.close();
      closed = true;
      const blob = await file.getFile();
      return blob.type === type ? blob : new Blob([blob], { type });
    },
    async discard() {
      discarded = true;
      // A chunk already being written (the recorder's final `dataavailable`) settles before the
      // stream is aborted and the file removed. Appends after this point are skipped.
      await queue;
      if (fallbackMode) parts.length = 0;
      else if (!closed) await writable.abort?.().catch(() => undefined);
      if (!removed) removed = await removeStagedFile(directory!, name);
    },
  };
}

/** Actionable capability failure raised before browser capture is mutated. */
export class UnsupportedBrowserMp4Error extends Error {
  readonly candidates = BROWSER_MP4_MIME_CANDIDATES;

  constructor() {
    super(
      `This browser cannot encode an MP4 export. Update to the latest Chrome or use a browser with MediaRecorder MP4 support. Tried: ${BROWSER_MP4_MIME_CANDIDATES.join(', ')}`,
    );
    this.name = 'UnsupportedBrowserMp4Error';
  }
}

/** Selects the first supported MP4 recorder type in deterministic preference order. */
export function selectBrowserMp4MimeType(
  isTypeSupported?: BrowserMp4MimeSupport,
): BrowserMp4MimeType {
  const supports =
    isTypeSupported ??
    (typeof MediaRecorder === 'undefined'
      ? undefined
      : (mimeType: BrowserMp4MimeType) => MediaRecorder.isTypeSupported(mimeType));
  if (supports !== undefined) {
    for (const candidate of BROWSER_MP4_MIME_CANDIDATES) {
      if (supports(candidate)) return candidate;
    }
  }
  throw new UnsupportedBrowserMp4Error();
}

interface FrameTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>;
}

interface VideoTrackGeneratorContainer {
  readonly track: MediaStreamTrack;
  readonly writable: WritableStream<VideoFrame>;
}

type MediaStreamTrackGeneratorConstructor = new (options: {
  readonly kind: 'video';
}) => FrameTrackGenerator;
type VideoTrackGeneratorConstructor = new () => VideoTrackGeneratorContainer;

function createVideoFrameTrack(): {
  readonly track: MediaStreamTrack;
  readonly writer: WritableStreamDefaultWriter<VideoFrame>;
} {
  const globals = globalThis as typeof globalThis & {
    MediaStreamTrackGenerator?: MediaStreamTrackGeneratorConstructor;
    VideoTrackGenerator?: VideoTrackGeneratorConstructor;
  };
  const mediaStreamTrackGenerator = globals.MediaStreamTrackGenerator;
  if (mediaStreamTrackGenerator !== undefined) {
    const generator = new mediaStreamTrackGenerator({ kind: 'video' });
    return { track: generator, writer: generator.writable.getWriter() };
  }
  const videoTrackGenerator = globals.VideoTrackGenerator;
  if (videoTrackGenerator === undefined)
    throw new Error('This browser cannot provide color-managed video frames for MP4 export.');
  const generator = new videoTrackGenerator();
  const track = generator.track;
  return { track, writer: generator.writable.getWriter() };
}

/**
 * Streaming source for a real browser MP4 export. Keeping rendering lazy is
 * important: a 30 s 1920x1080 RGBA export is about 7 GiB if every frame is
 * retained in memory before encoding.
 */
export interface BrowserMp4ExportSource {
  readonly manifest: BrowserExportManifest;
  readonly frameCount: number;
  /** Draws one frame into `canvas`; this preserves the GPU preview path. */
  readonly paintFrame?: (index: number) => void | Promise<void>;
  /** CPU fallback that writes RGBA pixels into the recorder canvas. */
  readonly renderFrame?: (index: number) => Uint8Array | Promise<Uint8Array>;
  /** Optional canvas already owned by the preview renderer. */
  readonly canvas?: HTMLCanvasElement;
  /** Authored/program audio supplied by the caller, when available. */
  readonly audioTrack?: MediaStreamTrack;
  /** MP4 MIME selected by `selectBrowserMp4MimeType`; selected here when omitted. */
  readonly mimeType?: BrowserMp4MimeType;
  /** Runs after MediaRecorder emits `start`, for synchronized media starts. */
  readonly onRecordingStart?: () => void;
  readonly filename?: string;
  /** When false, the caller owns the final download (for server remux). */
  readonly autoDownload?: boolean;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
  /** Required content families are checked before canvas capture starts. */
  readonly requiredFontFamilies?: readonly string[];
  readonly fontReadiness?: (families: readonly string[]) => Promise<void>;
  /** Cancels the realtime recorder and releases all media resources. */
  readonly signal?: AbortSignal;
}

/**
 * Renders frames at the requested cadence into a canvas capture stream and
 * records a downloadable MP4. When the caller has no authored audio, a
 * nearly-silent oscillator keeps an audio stream available to MP4 muxers
 * without inventing audible program audio.
 */
export async function downloadBrowserMp4(
  source: BrowserMp4ExportSource,
): Promise<BrowserExportResult> {
  const { manifest, frameCount } = source;
  const { width, height, frameRate } = manifest;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1)
    throw new RangeError('frameCount must be a positive integer');
  if (!Number.isSafeInteger(width) || width < 1)
    throw new RangeError('manifest.width must be a positive integer');
  if (!Number.isSafeInteger(height) || height < 1)
    throw new RangeError('manifest.height must be a positive integer');
  if (!Number.isFinite(frameRate) || frameRate <= 0)
    throw new RangeError('manifest.frameRate must be a positive finite number');
  if (source.paintFrame === undefined && source.renderFrame === undefined)
    throw new TypeError('paintFrame or renderFrame is required for browser MP4 export');
  if (source.paintFrame !== undefined && source.renderFrame !== undefined)
    throw new TypeError('provide either paintFrame or renderFrame, not both');
  if (source.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
  if (source.requiredFontFamilies !== undefined && source.fontReadiness !== undefined)
    await source.fontReadiness(source.requiredFontFamilies);
  const selectedMimeType = source.mimeType ?? selectBrowserMp4MimeType();

  const ownsCanvas = source.canvas === undefined;
  const canvas = source.canvas ?? document.createElement('canvas');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  let stream: MediaStream | undefined;
  let videoTrack: MediaStreamTrack | undefined;
  let frameWriter: WritableStreamDefaultWriter<VideoFrame> | undefined;
  let fallbackAudio: AudioContext | undefined;
  let fallbackAudioTrack: MediaStreamTrack | undefined;
  let oscillator: OscillatorNode | undefined;
  let oscillatorStarted = false;
  let recorder: MediaRecorder | undefined;
  let stopped: Promise<void> | undefined;
  let sink: BrowserMp4Sink | undefined;
  const bytesPerFrame = width * height * 4;
  const frameDurationMs = 1_000 / frameRate;
  try {
    const generatedVideo = createVideoFrameTrack();
    videoTrack = generatedVideo.track;
    frameWriter = generatedVideo.writer;
    stream = new MediaStream([videoTrack]);
    const context =
      source.renderFrame === undefined
        ? undefined
        : canvas.getContext('2d', { colorSpace: 'srgb' });
    if (source.renderFrame !== undefined && context === null)
      throw new Error('2D canvas is unavailable for browser MP4 export');

    fallbackAudio = source.audioTrack === undefined ? new AudioContext() : undefined;
    const audioDestination = fallbackAudio?.createMediaStreamDestination();
    oscillator = fallbackAudio?.createOscillator();
    const gain = fallbackAudio?.createGain();
    if (oscillator !== undefined && gain !== undefined && audioDestination !== undefined) {
      gain.gain.value = 0.00001;
      oscillator.connect(gain).connect(audioDestination);
    }
    fallbackAudioTrack = audioDestination?.stream.getAudioTracks()[0];
    const audioTrack = source.audioTrack ?? fallbackAudioTrack;
    if (audioTrack === undefined)
      throw new Error('audio capture did not produce an AAC source track');
    stream.addTrack(audioTrack);

    sink = await createBrowserMp4Sink();
    recorder = new MediaRecorder(stream, {
      mimeType: selectedMimeType,
      videoBitsPerSecond: manifest.videoBitrate ?? Math.max(2_000_000, width * height * frameRate),
      audioBitsPerSecond: manifest.audio?.bitrate ?? 128_000,
    });
    const recorderMimeType = recorder.mimeType || selectedMimeType;
    if (!recorderMimeType.toLowerCase().startsWith('video/mp4')) {
      throw new Error(
        `browser recorder reported a non-MP4 MIME (${recorderMimeType}) for selected MP4 MIME (${selectedMimeType})`,
      );
    }
    stopped = new Promise<void>((resolve, reject) => {
      recorder!.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) sink!.append(event.data);
      });
      recorder!.addEventListener('stop', () => resolve(), { once: true });
      recorder!.addEventListener(
        'error',
        () => reject(new Error(`browser MP4 recorder failed (${recorderMimeType})`)),
        { once: true },
      );
    });

    if (fallbackAudio !== undefined) await fallbackAudio.resume();
    if (oscillator !== undefined) {
      oscillator.start();
      oscillatorStarted = true;
    }
    const paintExportFrame = async (index: number): Promise<void> => {
      if (source.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (source.paintFrame !== undefined) await source.paintFrame(index);
      else {
        const frame = await source.renderFrame!(index);
        if (frame.length !== bytesPerFrame) {
          throw new RangeError(
            `frame ${index} length ${frame.length} does not match ${bytesPerFrame} bytes (${width}x${height} RGBA)`,
          );
        }
        const pixels = new Uint8ClampedArray(frame.length);
        pixels.set(frame);
        context!.putImageData(new ImageData(pixels, width, height), 0, 0);
      }
      // A requestAnimationFrame boundary lets a 2D/WebGL paint commit before
      // the frame is copied to the generated video track.
      await waitForBrowserPaint(source.signal);
    };

    const writeExportFrame = async (index: number): Promise<void> => {
      const frame = await createBt709YuvExportVideoFrame(canvas, {
        timestamp: Math.round((index * 1_000_000) / frameRate),
        duration: Math.round(1_000_000 / frameRate),
      });
      try {
        await frameWriter!.write(frame);
      } finally {
        frame.close();
      }
    };

    // Queue the initial frame before recorder start, but await both together:
    // the generated track may apply backpressure until the recorder consumes it.
    await paintExportFrame(0);
    await Promise.all([writeExportFrame(0), startMediaRecorder(recorder, source.signal)]);
    source.onRecordingStart?.();
    source.onProgress?.(1, frameCount);
    let nextFrameAt = performance.now();
    nextFrameAt += frameDurationMs;
    await waitForBrowserExportFrame(Math.max(0, nextFrameAt - performance.now()), source.signal);
    for (let index = 1; index < frameCount; index++) {
      await paintExportFrame(index);
      await writeExportFrame(index);
      source.onProgress?.(index + 1, frameCount);
      nextFrameAt += frameDurationMs;
      await waitForBrowserExportFrame(Math.max(0, nextFrameAt - performance.now()), source.signal);
      if (source.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    }
    recorder.stop();
    await stopped;
    await frameWriter.close();

    const blob = await sink.finish(recorderMimeType);
    if (blob.size === 0)
      throw new Error(`browser MP4 recorder produced an empty file (${recorderMimeType})`);
    const filename = source.filename ?? `joy-media-export-${Date.now()}.mp4`;
    if (source.autoDownload !== false) triggerBrowserDownload(blob, filename);
    return {
      frameCount,
      totalBytes: blob.size,
      mimeType: blob.type,
      filename,
      blob,
      encoded: true,
    };
  } catch (error) {
    if (recorder !== undefined && recorder.state !== 'inactive') {
      recorder.stop();
      await stopped?.catch(() => undefined);
    }
    if (frameWriter !== undefined) await frameWriter.abort().catch(() => undefined);
    await sink?.discard();
    throw error;
  } finally {
    if (oscillatorStarted && oscillator !== undefined && oscillator.context.state !== 'closed') {
      try {
        oscillator.stop();
      } catch {
        // Continue releasing tracks and the context if the oscillator already ended.
      }
    }
    try {
      videoTrack?.stop();
    } catch {
      // Continue cleanup if the capture implementation already stopped this track.
    }
    try {
      frameWriter?.releaseLock();
    } catch {
      // The writer may already be released after a failed stream write.
    }
    try {
      fallbackAudioTrack?.stop();
    } catch {
      // Closing the owned AudioContext below remains the final fallback.
    }
    if (source.audioTrack !== undefined) {
      try {
        stream?.removeTrack(source.audioTrack);
      } catch {
        // The caller still owns and releases its authored track.
      }
    }
    if (fallbackAudio !== undefined && fallbackAudio.state !== 'closed')
      await fallbackAudio.close().catch(() => undefined);
    if (ownsCanvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function startMediaRecorder(recorder: MediaRecorder, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      recorder.removeEventListener('start', onStart);
      recorder.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onStart = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`browser MP4 recorder failed to start (${recorder.mimeType})`));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    recorder.addEventListener('start', onStart, { once: true });
    recorder.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      recorder.start();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function waitForBrowserPaint(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    let frameId = 0;
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameId);
      cleanup();
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    frameId = requestAnimationFrame(() => {
      cleanup();
      resolve();
    });
    if (signal?.aborted) onAbort();
  });
}

function waitForBrowserExportFrame(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Export cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Packs RGBA frames into a single `Blob` suitable for download.
 *
 * Container format: a 16-byte header followed by concatenated RGBA frames.
 *  - bytes  0..3   : `'RGBA'` ASCII magic
 *  - bytes  4..7   : little-endian uint32 frame count
 *  - bytes  8..11  : little-endian uint32 width
 *  - bytes 12..15  : little-endian uint32 height
 *  - bytes 16..    : frame pixels, each `width * height * 4` bytes
 *
 * Throws when `frames` is empty, or any frame does not match
 * `width * height * 4` bytes.
 */
export function packBrowserExport(source: BrowserExportFrameSource): {
  readonly blob: Blob;
  readonly result: BrowserExportResult;
} {
  const { manifest, frames } = source;
  if (frames.length === 0) throw new RangeError('at least one RGBA frame is required for export');
  const { width, height, frameRate } = manifest;
  if (!Number.isSafeInteger(width) || width < 1)
    throw new RangeError('manifest.width must be a positive integer');
  if (!Number.isSafeInteger(height) || height < 1)
    throw new RangeError('manifest.height must be a positive integer');
  if (!Number.isFinite(frameRate) || frameRate <= 0)
    throw new RangeError('manifest.frameRate must be a positive finite number');
  const bytesPerFrame = width * height * 4;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    if (frame.length !== bytesPerFrame) {
      throw new RangeError(
        `frame ${index} length ${frame.length} does not match ${bytesPerFrame} bytes (${width}x${height} RGBA)`,
      );
    }
  }

  const header = new Uint8Array(16);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 0x52474241, false); // 'RGBA' big-endian
  headerView.setUint32(4, frames.length, true);
  headerView.setUint32(8, width, true);
  headerView.setUint32(12, height, true);

  const totalBytes = header.byteLength + frames.length * bytesPerFrame;
  // Frames are plain-array RGBA buffers, never SharedArrayBuffer-backed; BlobPart's
  // stricter ArrayBuffer-only typing (TS 5.9 generic TypedArrays) doesn't affect
  // runtime behavior here, so this narrowing cast is safe.
  const blob = new Blob([header, ...frames] as BlobPart[], { type: 'application/octet-stream' });
  if (blob.size !== totalBytes) {
    throw new Error(
      `browser export produced ${blob.size} bytes, expected ${totalBytes}; this indicates a Blob implementation bug`,
    );
  }
  const filename = source.filename ?? `joy-media-export-${Date.now()}.rgba`;
  return {
    blob,
    result: {
      frameCount: frames.length,
      totalBytes,
      mimeType: 'application/octet-stream',
      filename,
      encoded: false,
    },
  };
}

/**
 * Triggers a browser download for the given Blob. Uses an off-DOM anchor and
 * keeps its object URL alive for a bounded handoff window: Chromium can report
 * the download asynchronously after a long export, and revoking the URL on
 * the next animation frame can race that handoff in headless CI.
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  let cleanupScheduled = false;
  const cleanup = (): void => {
    if (anchor.isConnected) document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };
  const scheduleCleanup = (): void => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    globalThis.setTimeout(cleanup, BROWSER_DOWNLOAD_URL_RETENTION_MS);
  };
  anchor.addEventListener('click', scheduleCleanup, { once: true });
  anchor.click();
  // Fallback cleanup in case the click handler never runs (e.g. headless
  // environments that synthesize the download without firing `click`).
  scheduleCleanup();
}

/**
 * Convenience: pack and trigger download in one call. Returns the export
 * result for status reporting.
 */
export function downloadBrowserExport(source: BrowserExportFrameSource): BrowserExportResult {
  const { blob, result } = packBrowserExport(source);
  triggerBrowserDownload(blob, result.filename);
  return result;
}
