/**
 * Browser-side export adapter for RGBA frames.
 *
 * `export-core` shells out to ffmpeg/ffprobe via `node:child_process`, which
 * is unreachable in the browser. This module produces a downloadable Blob
 * directly from the supplied RGBA frames, with a documented fallback to an
 * `.rgba` container when MP4 muxing is unavailable without a real encoder.
 *
 * Scope (WP-11.x): the goal is a *downloadable video file* the user can save
 * from the Export button. True H.264/AAC muxing requires either a WebCodecs
 * `VideoEncoder` implementation or a WebAssembly ffmpeg; neither is in scope
 * for this spike. The MVP therefore writes a small `.rgba` (raw frame dump)
 * container, which preserves the per-frame content for downstream tools and
 * proves the browser export wiring end-to-end.
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
   * `true` when only a raw RGBA container was emitted. `false` when a real
   * encoded container (e.g. WebM/MP4) was produced. Browser MVP always
   * reports `false`; the field exists so a future WebCodecs encoder can flip
   * the flag without changing the consumer.
   */
  readonly encoded: boolean;
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
    document.body.removeChild(anchor);
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
