import { decompressFrames, parseGIF } from 'gifuct-js';
import type { ImageDataLike } from '@joy-media/playback-engine';
import {
  validateImageAnimationBudget,
  type ImageAnimationDescriptor,
} from './animated-image-metadata.js';

export interface AnimatedImageFrame {
  readonly startUs: number;
  readonly endUs: number;
  readonly bitmap: ImageDataLike;
}

export interface AnimatedImageFrameSource {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly AnimatedImageFrame[];
  frameAt(sourceTimeUs: number): AnimatedImageFrame;
  dispose(): void;
}

/**
 * Decodes GIF pixels into composited RGBA frames. The source is immutable and
 * can therefore be shared by Monitor and export without two timing models.
 */
export async function createAnimatedImageFrameSource(
  blob: Blob,
  descriptor: ImageAnimationDescriptor,
): Promise<AnimatedImageFrameSource> {
  validateImageAnimationBudget(descriptor);
  const bytes = await blob.arrayBuffer();
  if (blob.type.toLowerCase() === 'image/gif' || isGif(bytes))
    return decodeGifFrameSource(bytes, descriptor);
  if (blob.type.toLowerCase() === 'image/webp' || isWebp(bytes))
    return decodeWebpFrameSource(bytes, descriptor);
  throw new Error('animated image format is unsupported');
}

function decodeGifFrameSource(
  bytes: ArrayBuffer,
  descriptor: ImageAnimationDescriptor,
): AnimatedImageFrameSource {
  const parsed = parseGIF(bytes);
  const decoded = decompressFrames(parsed, true);
  const width = parsed.lsd.width;
  const height = parsed.lsd.height;
  validateImageAnimationBudget(descriptor, width, height);
  if (decoded.length !== descriptor.frameCount || width < 1 || height < 1) {
    throw new Error('animated GIF metadata does not match decoded frames');
  }

  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: AnimatedImageFrame[] = [];
  let startUs = 0;
  let previous: PreviousFrame | undefined;
  for (const frame of decoded) {
    applyDisposal(canvas, width, height, previous);
    const before = frame.disposalType === 3 ? canvas.slice() : undefined;
    drawPatch(canvas, width, frame.dims, frame.patch);
    const durationUs = Math.max(10_000, frame.delay * 1_000);
    frames.push({
      startUs,
      endUs: startUs + durationUs,
      bitmap: { width, height, data: canvas.slice() },
    });
    previous = {
      disposalType: frame.disposalType,
      dims: frame.dims,
      before,
    };
    startUs += durationUs;
  }

  if (frames.length === 0 || startUs <= 0) throw new Error('animated GIF has no playable frames');
  return new GifFrameSource(width, height, frames, startUs);
}

async function decodeWebpFrameSource(
  bytes: ArrayBuffer,
  descriptor: ImageAnimationDescriptor,
): Promise<AnimatedImageFrameSource> {
  const Decoder = (globalThis as unknown as { ImageDecoder?: ImageDecoderConstructor })
    .ImageDecoder;
  if (Decoder === undefined)
    throw new Error('animated WebP decoding is not available in this browser build');
  const decoder = new Decoder({ data: bytes, type: 'image/webp' });
  try {
    await decoder.completed;
    if (decoder.tracks.ready !== undefined) await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (track === undefined || track.frameCount !== descriptor.frameCount) {
      throw new Error('animated WebP metadata does not match decoded frames');
    }
    const width = track.codedWidth;
    const height = track.codedHeight;
    validateImageAnimationBudget(descriptor, width, height);
    if (width < 1 || height < 1) throw new Error('animated WebP dimensions are invalid');
    const frameDurationUs = descriptor.cycleDurationUs / track.frameCount;
    const frames: AnimatedImageFrame[] = [];
    for (let index = 0; index < track.frameCount; index += 1) {
      const result = await decoder.decode({ frameIndex: index });
      const image = result.image;
      try {
        const pixels = new Uint8Array(width * height * 4);
        await image.copyTo(pixels, { format: 'RGBA' });
        const startUs = Math.round(index * frameDurationUs);
        const endUs =
          index === track.frameCount - 1
            ? descriptor.cycleDurationUs
            : Math.round((index + 1) * frameDurationUs);
        frames.push({
          startUs,
          endUs,
          bitmap: { width, height, data: new Uint8ClampedArray(pixels) },
        });
      } finally {
        image.close();
      }
    }
    if (frames.length === 0) throw new Error('animated WebP has no playable frames');
    return new ArrayFrameSource(width, height, frames, descriptor.cycleDurationUs);
  } finally {
    decoder.close();
  }
}

interface ImageDecoderConstructor {
  new (options: { readonly data: ArrayBuffer; readonly type: string }): ImageDecoderLike;
}

interface ImageDecoderLike {
  readonly completed: Promise<void>;
  readonly tracks: {
    readonly ready?: Promise<void>;
    readonly selectedTrack?: {
      readonly frameCount: number;
      readonly codedWidth: number;
      readonly codedHeight: number;
    };
  };
  decode(options: { readonly frameIndex: number }): Promise<{ readonly image: VideoFrameLike }>;
  close(): void;
}

interface VideoFrameLike {
  copyTo(destination: Uint8Array, options?: { readonly format?: string }): Promise<void>;
  close(): void;
}

interface PreviousFrame {
  readonly disposalType: number;
  readonly dims: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly before: Uint8ClampedArray | undefined;
}

function applyDisposal(
  canvas: Uint8ClampedArray,
  width: number,
  height: number,
  previous: PreviousFrame | undefined,
): void {
  if (previous === undefined) return;
  if (previous.disposalType === 3 && previous.before !== undefined) {
    canvas.set(previous.before);
    return;
  }
  if (previous.disposalType !== 2) return;
  const left = Math.max(0, previous.dims.left);
  const top = Math.max(0, previous.dims.top);
  const right = Math.min(width, left + previous.dims.width);
  const bottom = Math.min(height, top + previous.dims.height);
  for (let y = top; y < bottom; y += 1) {
    canvas.fill(0, (y * width + left) * 4, (y * width + right) * 4);
  }
}

function drawPatch(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  dims: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  patch: Uint8ClampedArray,
): void {
  for (let y = 0; y < dims.height; y += 1) {
    for (let x = 0; x < dims.width; x += 1) {
      const source = (y * dims.width + x) * 4;
      const alpha = patch[source + 3];
      if (alpha === undefined || alpha === 0) continue;
      const targetX = dims.left + x;
      const targetY = dims.top + y;
      if (targetX < 0 || targetY < 0) continue;
      const target = (targetY * canvasWidth + targetX) * 4;
      if (target < 0 || target + 3 >= canvas.length) continue;
      canvas[target] = patch[source]!;
      canvas[target + 1] = patch[source + 1]!;
      canvas[target + 2] = patch[source + 2]!;
      canvas[target + 3] = alpha;
    }
  }
}

class GifFrameSource implements AnimatedImageFrameSource {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly frames: readonly AnimatedImageFrame[],
    private readonly cycleDurationUs: number,
  ) {}

  frameAt(sourceTimeUs: number): AnimatedImageFrame {
    const cycleTimeUs = positiveModulo(sourceTimeUs, this.cycleDurationUs);
    return (
      this.frames.find((frame) => cycleTimeUs >= frame.startUs && cycleTimeUs < frame.endUs) ??
      this.frames[this.frames.length - 1]!
    );
  }

  dispose(): void {
    // Frames are plain RGBA data; dropping the source allows the caller's
    // owning cache to release them without browser object handles to revoke.
  }
}

class ArrayFrameSource extends GifFrameSource {}

function positiveModulo(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}

function isGif(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes, 0, Math.min(6, bytes.byteLength));
  return ascii(view) === 'GIF87a' || ascii(view) === 'GIF89a';
}

function isWebp(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  return ascii(view.slice(0, 4)) === 'RIFF' && ascii(view.slice(8, 12)) === 'WEBP';
}

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}
