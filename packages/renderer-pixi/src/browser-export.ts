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
   * `true` when a real encoded container (e.g. MP4) was emitted; `false` for
   * the explicit raw-RGBA interchange fallback.
   */
  readonly encoded: boolean;
}

/** Native MP4 profile accepted by Chromium's H.264/AAC MediaRecorder. */
export const BROWSER_MP4_MIME_TYPE = 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';

/**
 * Streaming source for a real browser MP4 export. Keeping rendering lazy is
 * important: a 30 s 1920x1080 RGBA export is about 7 GiB if every frame is
 * retained in memory before encoding.
 */
export interface BrowserMp4ExportSource {
  readonly manifest: BrowserExportManifest;
  readonly frameCount: number;
  readonly renderFrame: (index: number) => Uint8Array | Promise<Uint8Array>;
  readonly filename?: string;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
}

/**
 * Renders frames at the requested cadence into a canvas capture stream and
 * records a downloadable H.264/AAC MP4. The nearly-silent oscillator is
 * deliberate: it keeps a real AAC stream in the container until project
 * audio mixing lands, without inventing audible program audio.
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
  if (
    typeof MediaRecorder === 'undefined' ||
    !MediaRecorder.isTypeSupported(BROWSER_MP4_MIME_TYPE)
  ) {
    throw new Error(`H.264/AAC MP4 recording is unavailable (${BROWSER_MP4_MIME_TYPE})`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('2D canvas is unavailable for browser MP4 export');
  const stream = canvas.captureStream(frameRate);
  const videoTrack = stream.getVideoTracks()[0] as
    (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (videoTrack === undefined) throw new Error('canvas capture did not produce a video track');

  const audioContext = new AudioContext();
  const audioDestination = audioContext.createMediaStreamDestination();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  gain.gain.value = 0.00001;
  oscillator.connect(gain).connect(audioDestination);
  const audioTrack = audioDestination.stream.getAudioTracks()[0];
  if (audioTrack === undefined)
    throw new Error('audio capture did not produce an AAC source track');
  stream.addTrack(audioTrack);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: BROWSER_MP4_MIME_TYPE,
    videoBitsPerSecond: Math.max(2_000_000, width * height * frameRate),
    audioBitsPerSecond: 128_000,
  });
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.addEventListener('error', () => reject(new Error('browser MP4 recorder failed')), {
      once: true,
    });
  });

  const bytesPerFrame = width * height * 4;
  const frameDurationMs = 1_000 / frameRate;
  try {
    await audioContext.resume();
    oscillator.start();
    recorder.start();
    let nextFrameAt = performance.now();
    for (let index = 0; index < frameCount; index++) {
      const frame = await source.renderFrame(index);
      if (frame.length !== bytesPerFrame) {
        throw new RangeError(
          `frame ${index} length ${frame.length} does not match ${bytesPerFrame} bytes (${width}x${height} RGBA)`,
        );
      }
      const pixels = new Uint8ClampedArray(frame.length);
      pixels.set(frame);
      context.putImageData(new ImageData(pixels, width, height), 0, 0);
      videoTrack.requestFrame?.();
      source.onProgress?.(index + 1, frameCount);
      nextFrameAt += frameDurationMs;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, nextFrameAt - performance.now())),
      );
    }
    recorder.stop();
    await stopped;
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped.catch(() => undefined);
    throw error;
  } finally {
    if (oscillator.context.state !== 'closed') oscillator.stop();
    videoTrack.stop();
    audioTrack.stop();
    await audioContext.close();
  }

  const blob = new Blob(chunks, { type: BROWSER_MP4_MIME_TYPE });
  if (blob.size === 0) throw new Error('browser MP4 recorder produced an empty file');
  const filename = source.filename ?? `joy-media-export-${Date.now()}.mp4`;
  triggerBrowserDownload(blob, filename);
  return {
    frameCount,
    totalBytes: blob.size,
    mimeType: blob.type,
    filename,
    encoded: true,
  };
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
 * `requestAnimationFrame` so the click is dispatched on a later tick — this
 * keeps the calling stack free to settle, and avoids the Safari quirk where
 * synchronous anchor clicks inside async handlers are dropped.
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  const cleanup = (): void => {
    if (anchor.isConnected) document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };
  anchor.addEventListener('click', () => {
    requestAnimationFrame(cleanup);
  });
  anchor.click();
  // Fallback cleanup in case the click handler never runs (e.g. headless
  // environments that synthesize the download without firing `click`).
  requestAnimationFrame(cleanup);
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
