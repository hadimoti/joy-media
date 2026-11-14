import type { EvidenceFrameArtifact } from './evidence-store.js';

export const MAX_TIMELINE_CONTACT_SHEET_FRAMES = 24;
export const DEFAULT_CONTACT_SHEET_TILE_WIDTH = 320;
export const DEFAULT_CONTACT_SHEET_TILE_HEIGHT = 180;
export const DEFAULT_CONTACT_SHEET_LABEL_HEIGHT = 26;
export const DEFAULT_CONTACT_SHEET_MAX_BYTES = 8 * 1024 * 1024;

export interface TimelineContactSheetBitmap {
  readonly width: number;
  readonly height: number;
  close?: () => void;
}

export interface TimelineContactSheetCanvasContext {
  fillStyle: string;
  font: string;
  textBaseline: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(
    image: TimelineContactSheetBitmap,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

export interface TimelineContactSheetCanvas {
  readonly width: number;
  readonly height: number;
  getContext(
    type: '2d',
    options?: { readonly alpha?: boolean },
  ): TimelineContactSheetCanvasContext | null;
  convertToBlob(options: { readonly type: 'image/jpeg'; readonly quality: number }): Promise<Blob>;
}

export type TimelineContactSheetCanvasFactory = (
  width: number,
  height: number,
) => TimelineContactSheetCanvas;

export interface TimelineContactSheetOptions {
  readonly frames: readonly EvidenceFrameArtifact[];
  readonly canvasFactory?: TimelineContactSheetCanvasFactory;
  readonly imageBitmapFactory?: (jpeg: Blob) => Promise<TimelineContactSheetBitmap>;
  readonly columns?: number;
  readonly tileWidth?: number;
  readonly tileHeight?: number;
  readonly labelHeight?: number;
  readonly maxPixels?: number;
  readonly maxBytes?: number;
  readonly jpegQuality?: number;
}

export type TimelineContactSheetErrorCode =
  | 'invalid-request'
  | 'too-many-frames'
  | 'canvas-unavailable'
  | 'bitmap-unavailable'
  | 'artifact-too-large';

export class TimelineContactSheetError extends Error {
  constructor(readonly code: TimelineContactSheetErrorCode) {
    super(`JOY timeline contact sheet failed: ${code}`);
    this.name = 'TimelineContactSheetError';
  }
}

/** Lays out at most 24 locally stored JPEG frames and burns each timecode in. */
export async function createTimelineContactSheet(
  options: TimelineContactSheetOptions,
): Promise<Blob> {
  const frames = options.frames;
  if (!Array.isArray(frames) || frames.length < 1)
    throw new TimelineContactSheetError('invalid-request');
  if (frames.length > MAX_TIMELINE_CONTACT_SHEET_FRAMES)
    throw new TimelineContactSheetError('too-many-frames');
  const tileWidth = positiveInteger(options.tileWidth, DEFAULT_CONTACT_SHEET_TILE_WIDTH);
  const tileHeight = positiveInteger(options.tileHeight, DEFAULT_CONTACT_SHEET_TILE_HEIGHT);
  const labelHeight = positiveInteger(options.labelHeight, DEFAULT_CONTACT_SHEET_LABEL_HEIGHT);
  const maxPixels = positiveInteger(options.maxPixels, 4_096 * 2_160);
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_CONTACT_SHEET_MAX_BYTES);
  const quality = options.jpegQuality ?? 0.86;
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1)
    throw new TimelineContactSheetError('invalid-request');
  const columns = options.columns ?? Math.ceil(Math.sqrt(frames.length));
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > frames.length)
    throw new TimelineContactSheetError('invalid-request');
  const rows = Math.ceil(frames.length / columns);
  const canvasWidth = columns * tileWidth;
  const canvasHeight = rows * (tileHeight + labelHeight);
  if (!Number.isSafeInteger(canvasWidth * canvasHeight) || canvasWidth * canvasHeight > maxPixels)
    throw new TimelineContactSheetError('artifact-too-large');

  const seenFrameIds = new Set<string>();
  const seenTimes = new Set<number>();
  for (const frame of frames) {
    if (
      frame === null ||
      typeof frame !== 'object' ||
      typeof frame.frameId !== 'string' ||
      frame.frameId.length < 1 ||
      seenFrameIds.has(frame.frameId) ||
      !Number.isSafeInteger(frame.timestampUs) ||
      frame.timestampUs < 0 ||
      seenTimes.has(frame.timestampUs) ||
      !(frame.jpeg instanceof Blob) ||
      frame.jpeg.type !== 'image/jpeg' ||
      frame.jpeg.size < 1 ||
      !Number.isSafeInteger(frame.width) ||
      frame.width < 1 ||
      !Number.isSafeInteger(frame.height) ||
      frame.height < 1
    )
      throw new TimelineContactSheetError('invalid-request');
    seenFrameIds.add(frame.frameId);
    seenTimes.add(frame.timestampUs);
  }

  const canvasFactory = options.canvasFactory ?? createOffscreenCanvas;
  const bitmapFactory = options.imageBitmapFactory ?? decodeBitmap;
  const canvas = canvasFactory(canvasWidth, canvasHeight);
  const context = canvas.getContext('2d', { alpha: false });
  if (context === null) throw new TimelineContactSheetError('canvas-unavailable');
  context.fillStyle = '#111111';
  context.fillRect(0, 0, canvasWidth, canvasHeight);

  for (const [index, frame] of frames.entries()) {
    let bitmap: TimelineContactSheetBitmap | undefined;
    try {
      bitmap = await bitmapFactory(frame.jpeg);
      if (
        !Number.isSafeInteger(bitmap.width) ||
        bitmap.width < 1 ||
        !Number.isSafeInteger(bitmap.height) ||
        bitmap.height < 1
      )
        throw new TimelineContactSheetError('bitmap-unavailable');
      const column = index % columns;
      const row = Math.floor(index / columns);
      const tileX = column * tileWidth;
      const tileY = row * (tileHeight + labelHeight);
      const imageScale = Math.min(tileWidth / bitmap.width, tileHeight / bitmap.height);
      const imageWidth = bitmap.width * imageScale;
      const imageHeight = bitmap.height * imageScale;
      context.fillStyle = '#111111';
      context.fillRect(tileX, tileY, tileWidth, tileHeight + labelHeight);
      context.drawImage(
        bitmap,
        tileX + (tileWidth - imageWidth) / 2,
        tileY + (tileHeight - imageHeight) / 2,
        imageWidth,
        imageHeight,
      );
      context.fillStyle = '#ffffff';
      context.font = '14px sans-serif';
      context.textBaseline = 'middle';
      context.fillText(
        formatQcTimecode(frame.timestampUs),
        tileX + 8,
        tileY + tileHeight + labelHeight / 2,
        tileWidth - 16,
      );
    } catch (error) {
      if (error instanceof TimelineContactSheetError) throw error;
      throw new TimelineContactSheetError('bitmap-unavailable');
    } finally {
      try {
        bitmap?.close?.();
      } catch {
        // A bitmap cleanup failure is not evidence and must not mask the result.
      }
    }
  }

  let jpeg: Blob;
  try {
    jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  } catch {
    throw new TimelineContactSheetError('canvas-unavailable');
  }
  if (jpeg.type !== 'image/jpeg' || jpeg.size < 1)
    throw new TimelineContactSheetError('canvas-unavailable');
  if (jpeg.size > maxBytes) throw new TimelineContactSheetError('artifact-too-large');
  return jpeg;
}

/** HH:MM:SS.mmm, using the composition's integer microsecond clock. */
export function formatQcTimecode(timeUs: number): string {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0)
    throw new TimelineContactSheetError('invalid-request');
  const milliseconds = Math.floor(timeUs / 1_000);
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function createOffscreenCanvas(width: number, height: number): TimelineContactSheetCanvas {
  if (typeof OffscreenCanvas === 'undefined')
    throw new TimelineContactSheetError('canvas-unavailable');
  return new OffscreenCanvas(width, height) as unknown as TimelineContactSheetCanvas;
}

async function decodeBitmap(jpeg: Blob): Promise<TimelineContactSheetBitmap> {
  if (typeof createImageBitmap !== 'function')
    throw new TimelineContactSheetError('bitmap-unavailable');
  return createImageBitmap(jpeg);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1)
    throw new TimelineContactSheetError('invalid-request');
  return resolved;
}
