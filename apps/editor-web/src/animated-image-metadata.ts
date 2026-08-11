/**
 * Safe, byte-level animation metadata for GIF and animated WebP originals.
 *
 * This parser deliberately does not decode pixels. It validates the container
 * structure, extracts timing/loop facts, and lets the rendering decoder own
 * the expensive frame work later in the pipeline.
 */
export interface ImageAnimationDescriptor {
  readonly frameCount: number;
  readonly cycleDurationUs: number;
  /** GIF/WebP source loop count. Zero means infinite. */
  readonly loopCount: number;
  readonly hasAlpha: boolean;
}

const GIF_HEADER_87A = 'GIF87a';
const GIF_HEADER_89A = 'GIF89a';
const WEBP_RIFF = 'RIFF';
const WEBP_FORM = 'WEBP';
const GIF_MIN_FRAME_DELAY_US = 10_000;
const WEBP_MIN_FRAME_DELAY_US = 1_000;
export const MAX_ANIMATION_FRAME_COUNT = 10_000;
export const MAX_ANIMATION_CYCLE_DURATION_US = 24 * 60 * 60 * 1_000_000;
export const MAX_ANIMATION_DECODE_BYTES = 256 * 1024 * 1024;

export function inspectImageAnimation(
  input: ArrayBuffer | Uint8Array,
  _mimeType?: string,
): ImageAnimationDescriptor | undefined {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (ascii(bytes, 0, 6) === GIF_HEADER_87A || ascii(bytes, 0, 6) === GIF_HEADER_89A) {
    const animation = parseGif(bytes);
    if (animation !== undefined) validateImageAnimationBudget(animation);
    return animation;
  }
  if (ascii(bytes, 0, 4) === WEBP_RIFF && ascii(bytes, 8, 4) === WEBP_FORM) {
    const animation = parseWebp(bytes);
    if (animation !== undefined) validateImageAnimationBudget(animation);
    return animation;
  }
  return undefined;
}

export function validateImageAnimationBudget(
  animation: ImageAnimationDescriptor,
  width?: number,
  height?: number,
): void {
  if (
    !Number.isSafeInteger(animation.frameCount) ||
    animation.frameCount < 2 ||
    animation.frameCount > MAX_ANIMATION_FRAME_COUNT
  ) {
    throw new Error('animated image exceeds the frame-count resource limit');
  }
  if (
    !Number.isSafeInteger(animation.cycleDurationUs) ||
    animation.cycleDurationUs <= 0 ||
    animation.cycleDurationUs > MAX_ANIMATION_CYCLE_DURATION_US
  ) {
    throw new Error('animated image exceeds the cycle-duration resource limit');
  }
  if (width !== undefined && height !== undefined) {
    const decodedBytes = animation.frameCount * width * height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_ANIMATION_DECODE_BYTES) {
      throw new Error('animated image exceeds the decoded-memory resource limit');
    }
  }
}

function parseGif(bytes: Uint8Array): ImageAnimationDescriptor | undefined {
  if (bytes.length < 13) throw malformed('GIF header is truncated');
  const packed = byteAt(bytes, 10);
  let offset = 13;
  if ((packed & 0x80) !== 0) offset = skipBytes(bytes, offset, 3 * 2 ** ((packed & 0x07) + 1));

  let frameCount = 0;
  let cycleDurationUs = 0;
  let loopCount = 0;
  let hasAlpha = false;
  let pendingDelayUs = GIF_MIN_FRAME_DELAY_US;

  while (offset < bytes.length) {
    const marker = byteAt(bytes, offset++);
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = byteAt(bytes, offset++);
      if (label === 0xf9) {
        if (byteAt(bytes, offset++) !== 4) throw malformed('GIF graphic control is invalid');
        const control = byteAt(bytes, offset++);
        const delayCs = byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
        offset = skipBytes(bytes, offset + 2, 2);
        pendingDelayUs = Math.max(GIF_MIN_FRAME_DELAY_US, delayCs * 10_000);
        hasAlpha ||= (control & 0x01) !== 0;
      } else if (label === 0xff) {
        const blockSize = byteAt(bytes, offset++);
        const application = ascii(bytes, offset, blockSize);
        offset = skipBytes(bytes, offset, blockSize);
        const applicationDataStart = offset;
        const chunks: Uint8Array[] = [];
        offset = readSubBlocks(bytes, offset, chunks);
        if (application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') {
          const data = chunks[0];
          if (data !== undefined && data.length >= 3 && data[0] === 1) {
            loopCount = data[1]! | (data[2]! << 8);
          }
        }
        // Keep the local variable to make malformed application blocks easy to
        // diagnose while retaining one parser path for all sub-block layouts.
        void applicationDataStart;
      } else {
        offset = skipBytes(bytes, offset, 1);
        offset = skipSubBlocks(bytes, offset);
      }
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > bytes.length) throw malformed('GIF image descriptor is truncated');
      offset = skipBytes(bytes, offset, 8);
      const descriptorPacked = byteAt(bytes, offset++);
      if ((descriptorPacked & 0x80) !== 0) {
        offset = skipBytes(bytes, offset, 3 * 2 ** ((descriptorPacked & 0x07) + 1));
      }
      offset = skipBytes(bytes, offset, 1); // LZW minimum code size
      offset = skipSubBlocks(bytes, offset);
      frameCount += 1;
      cycleDurationUs += pendingDelayUs;
      pendingDelayUs = GIF_MIN_FRAME_DELAY_US;
      continue;
    }
    throw malformed(`GIF contains unknown block 0x${marker.toString(16)}`);
  }

  if (frameCount <= 1) return undefined;
  return { frameCount, cycleDurationUs, loopCount, hasAlpha };
}

function parseWebp(bytes: Uint8Array): ImageAnimationDescriptor | undefined {
  if (bytes.length < 20) throw malformed('WebP header is truncated');
  let offset = 12;
  let animated = false;
  let hasAlpha = false;
  let frameCount = 0;
  let cycleDurationUs = 0;
  let loopCount = 0;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw malformed('WebP chunk header is truncated');
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = littleEndian32(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) throw malformed(`WebP ${chunkType} chunk is truncated`);
    if (chunkType === 'VP8X') {
      if (chunkSize < 10) throw malformed('WebP VP8X chunk is invalid');
      const flags = byteAt(bytes, dataStart);
      animated ||= (flags & 0x02) !== 0;
      hasAlpha ||= (flags & 0x10) !== 0;
    } else if (chunkType === 'ANIM') {
      if (chunkSize < 6) throw malformed('WebP ANIM chunk is invalid');
      loopCount = littleEndian16(bytes, dataStart + 4);
      animated = true;
    } else if (chunkType === 'ANMF') {
      if (chunkSize < 16) throw malformed('WebP ANMF chunk is invalid');
      const durationMs =
        byteAt(bytes, dataStart + 12) |
        (byteAt(bytes, dataStart + 13) << 8) |
        (byteAt(bytes, dataStart + 14) << 16);
      frameCount += 1;
      cycleDurationUs += Math.max(WEBP_MIN_FRAME_DELAY_US, durationMs * 1_000);
      animated = true;
    } else if (chunkType === 'ALPH') {
      hasAlpha = true;
    }
    offset = dataEnd + (chunkSize & 1);
  }

  if (!animated || frameCount <= 1) return undefined;
  return { frameCount, cycleDurationUs, loopCount, hasAlpha };
}

function readSubBlocks(bytes: Uint8Array, offset: number, output: Uint8Array[]): number {
  for (;;) {
    const size = byteAt(bytes, offset++);
    if (size === 0) return offset;
    if (offset + size > bytes.length) throw malformed('GIF sub-block is truncated');
    output.push(bytes.slice(offset, offset + size));
    offset += size;
  }
}

function skipSubBlocks(bytes: Uint8Array, offset: number): number {
  return readSubBlocks(bytes, offset, []);
}

function skipBytes(bytes: Uint8Array, offset: number, count: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || offset + count > bytes.length) {
    throw malformed('image data is truncated');
  }
  return offset + count;
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw malformed('image data is truncated');
  return value;
}

function littleEndian16(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

function littleEndian32(bytes: Uint8Array, offset: number): number {
  return (
    byteAt(bytes, offset) |
    (byteAt(bytes, offset + 1) << 8) |
    (byteAt(bytes, offset + 2) << 16) |
    (byteAt(bytes, offset + 3) * 0x1000000)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function malformed(reason: string): Error {
  return new Error(`animated image metadata is invalid: ${reason}`);
}
