import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  FontFaceDescriptorV1,
  ScenePaintFrameV1,
  TitleInstanceV1,
} from '@joy-media/project-schema';
import { buildTitleSceneFrame } from '@joy-media/motion-core';

export interface TitleFrameRate {
  readonly num: number;
  readonly den: number;
}

export interface TitleFrameLayer {
  readonly instanceId: string;
  readonly inputPattern: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly trackOrder: number;
}

export interface TitleFrameSource {
  readonly instanceId: string;
  readonly instance: TitleInstanceV1;
  readonly startUs: number;
  readonly durationUs: number;
  readonly trackOrder: number;
}

export interface RenderedTitleFrames {
  readonly layers: readonly TitleFrameLayer[];
  readonly rendererFacts: {
    readonly chromiumVersion: string;
    readonly fontManifestHashes: readonly string[];
  };
  cleanup(): void;
}

interface ChromiumDriverModule {
  readonly scenePaintFontDescriptors: () => readonly FontFaceDescriptorV1[];
  readonly createChromiumSceneDriver: (options?: { executablePath?: string }) => {
    capture(request: {
      markup: string;
      width: number;
      height: number;
      transparent: boolean;
      timeUs: number;
      frameRate: TitleFrameRate;
      locale: string;
      seed: string;
      paint?: ScenePaintFrameV1;
      rejectImages?: boolean;
    }): { readonly rgba: Uint8Array };
    readonly browserVersion?: string;
    close?(): void;
  };
  readonly findChromiumExecutable: () => string | undefined;
  readonly loadNotoSansArabicFaces: () => readonly { readonly sha256: string }[];
}

export async function titleRendererFacts(): Promise<{
  readonly chromiumVersion: string | null;
  readonly fontManifestHashes: readonly string[];
}> {
  try {
    const runtime = (await import('@joy-media/html-scene-runtime')) as ChromiumDriverModule;
    return {
      chromiumVersion: null,
      fontManifestHashes: runtime
        .loadNotoSansArabicFaces()
        .map((face) => face.sha256)
        .sort(),
    };
  } catch {
    return { chromiumVersion: null, fontManifestHashes: [] };
  }
}

/** Number of output frames for a title clip at an exact rational frame rate. */
export function titleFrameCount(durationUs: number, fps: TitleFrameRate): number {
  validateFrameRate(fps);
  if (!Number.isSafeInteger(durationUs) || durationUs < 0)
    throw new RangeError('title durationUs must be a non-negative safe integer');
  return Number(
    (BigInt(durationUs) * BigInt(fps.num) + BigInt(1_000_000 * fps.den) - 1n) /
      BigInt(1_000_000 * fps.den),
  );
}

/** Clip-local sample times using the specified round-to-nearest frame rule. */
export function titleFrameTimes(durationUs: number, fps: TitleFrameRate): number[] {
  const count = titleFrameCount(durationUs, fps);
  return Array.from({ length: count }, (_, index) =>
    Number(
      (BigInt(index) * 1_000_000n * BigInt(fps.den) * 2n + BigInt(fps.num)) /
        (2n * BigInt(fps.num)),
    ),
  );
}

/** Encode one tightly packed RGBA surface as a minimal PNG using filter type 0. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new RangeError('PNG width and height must be positive safe integers');
  if (rgba.byteLength !== width * height * 4)
    throw new RangeError(`PNG requires ${width * height * 4} RGBA bytes`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) {
    const destination = row * (width * 4 + 1);
    rows[destination] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + row * width * 4, width * 4).copy(
      rows,
      destination + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Capture all title frame sequences with one browser driver for this render. */
export async function renderTitleFrames(
  sources: readonly TitleFrameSource[],
  frame: { readonly width: number; readonly height: number; readonly fps: TitleFrameRate },
  options: { readonly isCancelled?: () => boolean } = {},
): Promise<RenderedTitleFrames> {
  if (sources.length === 0)
    return {
      layers: [],
      rendererFacts: { chromiumVersion: '', fontManifestHashes: [] },
      cleanup() {},
    };
  if (sources.length > 8)
    throw new RangeError('SLICE_LIMIT: at most 8 title instances are supported');
  if (frame.width > 1920 || frame.height > 1920 || frame.fps.num > 60 * frame.fps.den)
    throw new RangeError('SLICE_LIMIT: title rendering supports at most 1920x1920 and 60 fps');
  let runtime: ChromiumDriverModule;
  try {
    runtime = (await import('@joy-media/html-scene-runtime')) as ChromiumDriverModule;
  } catch (error) {
    throw new Error(
      `Title instance "${sources[0]!.instanceId}" cannot render: Chromium runtime is unavailable (${errorMessage(error)}).`,
    );
  }
  const directories: string[] = [];
  let driver: ReturnType<ChromiumDriverModule['createChromiumSceneDriver']> | undefined;
  const cleanup = (): void => {
    try {
      driver?.close?.();
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
      directories.length = 0;
    }
  };
  let rendererFacts: RenderedTitleFrames['rendererFacts'] | undefined;
  let fontManifestHashes: string[];
  let captureCompleted = false;
  try {
    let executablePath: string | undefined;
    try {
      executablePath = runtime.findChromiumExecutable();
      if (!executablePath) throw new Error('Chromium executable was not found');
      fontManifestHashes = runtime
        .loadNotoSansArabicFaces()
        .map((face) => face.sha256)
        .sort();
      driver = runtime.createChromiumSceneDriver({ executablePath });
    } catch (error) {
      throw new Error(
        `Title instance "${sources[0]!.instanceId}" cannot render: Chromium is unavailable (${errorMessage(error)}).`,
      );
    }
    const layers: TitleFrameLayer[] = [];
    for (const source of sources) {
      const directory = mkdtempSync(join(tmpdir(), `title-${safeId(source.instanceId)}-`));
      directories.push(directory);
      const pattern = join(directory, `title-${safeId(source.instanceId)}-%05d.png`);
      const times = titleFrameTimes(source.durationUs, frame.fps);
      for (let index = 0; index < times.length; index++) {
        if (options.isCancelled?.()) throw new Error('Render cancelled during title capture.');
        if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        if (options.isCancelled?.()) throw new Error('Render cancelled during title capture.');
        const timeUs = times[index]!;
        const sceneFrame = buildTitleSceneFrame(
          source.instance,
          source.instanceId,
          source.durationUs,
          timeUs,
          {
            widthPx: frame.width,
            heightPx: frame.height,
            fontFaces: runtime.scenePaintFontDescriptors(),
            frameRate: frame.fps,
            locale: source.instance.direction === 'rtl' ? 'fa-IR' : 'en-US',
            seed: source.instanceId,
          },
        );
        try {
          const surface = driver.capture({
            markup: sceneFrame.markup,
            width: sceneFrame.viewport.width,
            height: sceneFrame.viewport.height,
            transparent: true,
            timeUs: sceneFrame.timeUs,
            frameRate: sceneFrame.frameRate,
            locale: sceneFrame.locale,
            seed: sceneFrame.seed,
            paint: sceneFrame.paint,
            rejectImages: true,
          });
          const chromiumVersion = driver.browserVersion;
          if (!chromiumVersion?.trim())
            throw new Error('Chromium capture session did not report its browser version');
          rendererFacts = { chromiumVersion, fontManifestHashes };
          if (surface.rgba.byteLength !== frame.width * frame.height * 4)
            throw new Error('Chromium returned an invalid RGBA surface');
          writeFileSync(
            pattern.replace('%05d', String(index).padStart(5, '0')),
            encodeRgbaPng(frame.width, frame.height, surface.rgba),
          );
        } catch (error) {
          throw new Error(
            `Title instance "${source.instanceId}" capture failed: ${errorMessage(error)}.`,
          );
        }
      }
      layers.push({
        instanceId: source.instanceId,
        inputPattern: pattern,
        startUs: source.startUs,
        durationUs: source.durationUs,
        trackOrder: source.trackOrder,
      });
    }
    if (!rendererFacts)
      throw new Error(
        `Title instance "${sources[0]!.instanceId}" cannot render: Chromium capture session did not report its browser version.`,
      );
    captureCompleted = true;
    return { layers, rendererFacts, cleanup };
  } finally {
    if (!captureCompleted) {
      try {
        cleanup();
      } catch {
        /* preserve the capture failure */
      }
    }
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.length + 8)), data.length + 8);
  return chunk;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}
function validateFrameRate(fps: TitleFrameRate): void {
  if (
    !Number.isSafeInteger(fps.num) ||
    !Number.isSafeInteger(fps.den) ||
    fps.num < 1 ||
    fps.den < 1
  )
    throw new RangeError('title frame rate must be a positive rational');
}
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'instance';
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
