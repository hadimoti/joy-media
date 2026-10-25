// Caption evidence for the P0-4 boundary check and for the caption-timing and encoded-output tests.
//
// Two responsibilities, kept apart:
//   1. Timing. The composite is the CLI's own FFmpeg filter graph. It is captured from the render the CLI
//      itself runs (loadProject and runHeadlessRender), and only the encoder output is replaced by raw frames.
//      Nothing in this module rebuilds the graph, so it cannot drift from production.
//   2. Encoded output. The MP4 the CLI writes is decoded and compared frame by frame with the composite it was
//      encoded from. Codec history is judged against each frame's own input, never against another encode.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadProject } from '../utils/project-loader.js';
import { ffmpegBinary, ffprobeBinary } from '../utils/media-probe.js';
import { runHeadlessRender } from './render-cmd.js';
import { setEncodeSpawnForTests } from './render-media.js';

export const RENDER_WIDTH = 1280;
export const RENDER_HEIGHT = 720;
export const FRAME_RATE = 30;

interface CommandResult {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Runs a command without blocking the test worker's event loop, so the test runner keeps its RPC channel responsive. */
function runCommand(
  command: string,
  args: readonly string[],
  _options?: unknown,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const LUMA_SAMPLES = RENDER_WIDTH * RENDER_HEIGHT;
const CHROMA_WIDTH = RENDER_WIDTH / 2;
const CHROMA_HEIGHT = RENDER_HEIGHT / 2;
const CHROMA_SAMPLES = CHROMA_WIDTH * CHROMA_HEIGHT;
const YUV_FRAME_BYTES = LUMA_SAMPLES + 2 * CHROMA_SAMPLES;

/** Caption band (luma geometry) and the RGB pixel-detection threshold used by the P0 design since 2026-10-20. */
export const CAPTION_BAND = Object.freeze({ x: 120, y: 560, width: 1040, height: 100 });
export const CAPTION_PIXEL_THRESHOLD = 12;
const CAPTION_BAND_RGB_BYTES = CAPTION_BAND.width * CAPTION_BAND.height * 3;
/** The same rectangle in 4:2:0 chroma samples. */
const CHROMA_BAND = Object.freeze({
  x: CAPTION_BAND.x / 2,
  y: CAPTION_BAND.y / 2,
  width: CAPTION_BAND.width / 2,
  height: CAPTION_BAND.height / 2,
});

/**
 * Encoded-output limits. Each is set from the measured run recorded in docs/qa/evidence. Re-measure them if the
 * production encoder configuration changes.
 */
export const ENCODED_MIN_LUMA_PSNR_DB = 40;
/** Measured caption ink on active frames is 10,601 to 10,753 pixels; the encoded output must keep at least half. */
export const ENCODED_MIN_VISIBLE_CAPTION_PIXELS = 5_000;
/** On caption-free frames the encoded band may differ from its own input by codec noise only. */
export const ENCODED_RESIDUAL_THRESHOLD = 24;
/** Measured codec residual above 24 on caption-free frames peaks at 49 pixels; 200 leaves a 4x margin. */
export const ENCODED_MAX_IDLE_RESIDUAL_PIXELS = 200;

/** A cue expressed in frames: visible from `firstFrame` up to, not including, `endFrame`. */
export interface CueFrames {
  readonly firstFrame: number;
  readonly endFrame: number;
}

export interface ProductionComposite {
  readonly frameCount: number;
  /** Uncompressed yuv420p frames, exactly what the encoder receives. */
  readonly yuvPath: string;
  /** rgb24 crop of the caption band, one frame after another. */
  readonly bandRgbPath: string;
  /** SHA-256 of the production `-filter_complex` string, for provenance. */
  readonly filterGraphSha256: string;
}

export interface CaptureOptions {
  readonly projectFile: string;
  readonly workDir: string;
  /**
   * The environment of the CLI calls that prepared the project. The in-process render must see the same values (the
   * isolated profile and the Chromium that the frozen caption preparation was validated against), or the render
   * refuses the preparation as changed.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CaptionTimingReport {
  readonly frameCount: number;
  /** RGB pixels in the band that differ from the no-caption composite (threshold CAPTION_PIXEL_THRESHOLD). */
  readonly bandPixels: readonly number[];
  /** Samples outside the caption band that differ from the no-caption composite (any plane, threshold 0). */
  readonly outsideBandSamples: readonly number[];
  readonly violations: readonly string[];
}

export interface EncodedFidelityReport {
  readonly frameCount: number;
  readonly lumaPsnrDb: readonly number[];
  readonly minLumaPsnrDb: number;
  readonly minPsnrFrame: number;
  readonly averageLumaPsnrDb: number;
  /** Caption-band pixels that differ from the no-caption composite on each active frame. */
  readonly activeVisiblePixels: readonly number[];
  /** Largest count of caption-band pixels differing from the frame's own input on a caption-free frame. */
  readonly maxIdleResidualPixels: number;
  readonly ffmpeg: string;
  readonly x264Build: string | null;
  readonly violations: readonly string[];
}

// ---------------------------------------------------------------------------
// Production composite capture
// ---------------------------------------------------------------------------

/**
 * Renders the project through the CLI's own render path and captures the uncompressed composite that the encoder
 * would receive. The FFmpeg argument list is taken from the render (`setEncodeSpawnForTests`), so the filter graph
 * is the production one. Only the output sink changes, from the MP4 encoder to raw yuv420p frames.
 */
export async function captureProductionComposite(
  options: CaptureOptions,
): Promise<ProductionComposite> {
  mkdirSync(options.workDir, { recursive: true });
  const loaded = loadProject(options.projectFile);
  const yuvPath = join(options.workDir, 'composite.yuv');
  const bandRgbPath = join(options.workDir, 'composite-band.rgb');
  let graph: string | undefined;
  let renderExit: number | undefined;
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (value === undefined) continue;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  setEncodeSpawnForTests(((command: string, args: readonly string[]) => {
    graph = filterGraphOf(args);
    return spawn(command, compositeOutputArgs(args, yuvPath), {
      windowsHide: true,
    }) as unknown as ChildProcess;
  }) as never);
  try {
    renderExit = (
      await runHeadlessRender({
        project: loaded.project,
        preset: 'mp4',
        outDir: options.workDir,
        concurrency: 2,
        json: true,
        manifestOnly: false,
        projectFilePath: loaded.path,
      })
    ).exitCode;
  } catch (error) {
    // The render reports the missing encoded file after the composite exists. Only a failure before FFmpeg is fatal.
    if (graph === undefined) throw error;
  } finally {
    setEncodeSpawnForTests(undefined);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  if (graph === undefined)
    throw new Error(
      `The render did not reach FFmpeg, so no production composite was captured (render exit ${String(renderExit)}).`,
    );
  const bytes = existsSync(yuvPath) ? statSync(yuvPath).size : 0;
  if (bytes === 0 || bytes % YUV_FRAME_BYTES !== 0)
    throw new Error(
      `The composite capture wrote ${bytes} bytes, which is not a whole number of ${YUV_FRAME_BYTES}-byte frames.`,
    );
  await writeBandRgb(yuvPath, bandRgbPath);
  return {
    frameCount: bytes / YUV_FRAME_BYTES,
    yuvPath,
    bandRgbPath,
    filterGraphSha256: `sha256:${createHash('sha256').update(graph).digest('hex')}`,
  };
}

function filterGraphOf(args: readonly string[]): string {
  return args[args.indexOf('-filter_complex') + 1] ?? '';
}

/** Replaces the encoder output of a production render with raw yuv420p frames of the same video graph. */
function compositeOutputArgs(args: readonly string[], yuvPath: string): string[] {
  const graph = args.indexOf('-filter_complex');
  const video = args[graph + 3];
  const duration = graph < 0 ? -1 : args.indexOf('-t', graph);
  const durationValue = duration < 0 ? undefined : args[duration + 1];
  if (
    args.indexOf('[aout]') < graph ||
    graph < 0 ||
    args[graph + 2] !== '-map' ||
    video === undefined ||
    !/^\[b\d+\]$/u.test(video) ||
    durationValue === undefined
  )
    throw new Error('The render did not produce the expected single video filter graph.');
  return [
    ...args.slice(0, graph + 2),
    '-map',
    video,
    '-t',
    durationValue,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    yuvPath,
    // The audio chain of the production graph still runs; its output is discarded here, not encoded.
    '-map',
    '[aout]',
    '-t',
    durationValue,
    '-c:a',
    'pcm_s16le',
    '-f',
    'null',
    '-',
  ];
}

async function writeBandRgb(yuvPath: string, bandRgbPath: string): Promise<void> {
  const run = await runCommand(
    ffmpegBinary(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      '-s',
      `${RENDER_WIDTH}x${RENDER_HEIGHT}`,
      '-i',
      yuvPath,
      '-vf',
      `crop=${CAPTION_BAND.width}:${CAPTION_BAND.height}:${CAPTION_BAND.x}:${CAPTION_BAND.y}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      bandRgbPath,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.status !== 0)
    throw new Error(`Caption band extraction failed: ${run.stderr.trim() || 'no output'}`);
}

// ---------------------------------------------------------------------------
// Frame access
// ---------------------------------------------------------------------------

class FrameReader {
  private readonly fd: number;
  private readonly buffer: Buffer;

  constructor(
    path: string,
    private readonly frameBytes: number,
  ) {
    this.fd = openSync(path, 'r');
    this.buffer = Buffer.alloc(frameBytes);
  }

  /** Returns the frame as a buffer that the next call overwrites. */
  read(index: number): Buffer {
    const read = readSync(this.fd, this.buffer, 0, this.frameBytes, index * this.frameBytes);
    if (read !== this.frameBytes)
      throw new Error(`Frame ${index} is missing (read ${read} of ${this.frameBytes} bytes).`);
    return this.buffer;
  }

  close(): void {
    closeSync(this.fd);
  }
}

function inRect(
  x: number,
  y: number,
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Counts differing yuv420p samples in the whole frame and outside the caption band. */
function compareYuv(a: Buffer, b: Buffer): { differing: number; outside: number } {
  let differing = 0;
  let outside = 0;
  for (let y = 0; y < RENDER_HEIGHT; y++) {
    for (let x = 0; x < RENDER_WIDTH; x++) {
      const p = y * RENDER_WIDTH + x;
      if (a[p]! !== b[p]!) {
        differing++;
        if (!inRect(x, y, CAPTION_BAND)) outside++;
      }
    }
  }
  for (const plane of [LUMA_SAMPLES, LUMA_SAMPLES + CHROMA_SAMPLES]) {
    for (let y = 0; y < CHROMA_HEIGHT; y++) {
      for (let x = 0; x < CHROMA_WIDTH; x++) {
        const p = plane + y * CHROMA_WIDTH + x;
        if (a[p]! !== b[p]!) {
          differing++;
          if (!inRect(x, y, CHROMA_BAND)) outside++;
        }
      }
    }
  }
  return { differing, outside };
}

/** Counts band pixels whose largest RGB channel difference is above `threshold`. */
function countRgbBandDifferences(a: Buffer, b: Buffer, threshold: number): number {
  let count = 0;
  for (let p = 0; p < CAPTION_BAND_RGB_BYTES; p += 3) {
    const difference = Math.max(
      Math.abs(a[p]! - b[p]!),
      Math.abs(a[p + 1]! - b[p + 1]!),
      Math.abs(a[p + 2]! - b[p + 2]!),
    );
    if (difference > threshold) count++;
  }
  return count;
}

/** Counts luma samples inside the caption band whose difference is above `threshold`. */
function countLumaBandDifferences(a: Buffer, b: Buffer, threshold: number): number {
  let count = 0;
  for (let y = CAPTION_BAND.y; y < CAPTION_BAND.y + CAPTION_BAND.height; y++) {
    for (let x = CAPTION_BAND.x; x < CAPTION_BAND.x + CAPTION_BAND.width; x++) {
      const p = y * RENDER_WIDTH + x;
      if (Math.abs(a[p]! - b[p]!) > threshold) count++;
    }
  }
  return count;
}

function lumaPsnrDb(a: Buffer, b: Buffer): number {
  let squared = 0;
  for (let p = 0; p < LUMA_SAMPLES; p++) {
    const difference = a[p]! - b[p]!;
    squared += difference * difference;
  }
  // A perfect frame has no error term; report the cap used for averages.
  if (squared === 0) return 100;
  return 10 * Math.log10((255 * 255 * LUMA_SAMPLES) / squared);
}

// ---------------------------------------------------------------------------
// Timing: pre-encoding composite against the no-caption composite
// ---------------------------------------------------------------------------

/**
 * Checks the pre-encoding composite. Before the cue and from its end onward, the caption project must equal the
 * no-caption project exactly. Across the cue, the band must show caption ink on every frame, and nothing outside
 * the band may change.
 */
export async function checkCaptionTiming(
  caption: ProductionComposite,
  baseline: ProductionComposite,
  cue: CueFrames,
): Promise<CaptionTimingReport> {
  const violations: string[] = [];
  if (caption.frameCount !== baseline.frameCount) {
    violations.push(
      `frame count differs: ${caption.frameCount} with caption, ${baseline.frameCount} without`,
    );
  }
  const frameCount = Math.min(caption.frameCount, baseline.frameCount);
  const readers = {
    captionYuv: new FrameReader(caption.yuvPath, YUV_FRAME_BYTES),
    baselineYuv: new FrameReader(baseline.yuvPath, YUV_FRAME_BYTES),
    captionBand: new FrameReader(caption.bandRgbPath, CAPTION_BAND_RGB_BYTES),
    baselineBand: new FrameReader(baseline.bandRgbPath, CAPTION_BAND_RGB_BYTES),
  };
  const bandPixels: number[] = [];
  const outsideBandSamples: number[] = [];
  try {
    for (let n = 0; n < frameCount; n++) {
      if (n % 5 === 0) await yieldToEventLoop();
      const yuv = compareYuv(readers.captionYuv.read(n), readers.baselineYuv.read(n));
      const band = countRgbBandDifferences(
        readers.captionBand.read(n),
        readers.baselineBand.read(n),
        CAPTION_PIXEL_THRESHOLD,
      );
      bandPixels.push(band);
      outsideBandSamples.push(yuv.outside);
      const active = n >= cue.firstFrame && n < cue.endFrame;
      if (!active) {
        if (yuv.differing > 0)
          violations.push(
            `frame ${n}: ${yuv.differing} samples differ from the no-caption composite outside the cue (exact match required)`,
          );
        continue;
      }
      if (band === 0) violations.push(`frame ${n}: no caption ink in the band on an active frame`);
      if (yuv.outside > 0)
        violations.push(
          `frame ${n}: ${yuv.outside} samples outside the caption band differ from the no-caption composite`,
        );
    }
  } finally {
    for (const reader of Object.values(readers)) reader.close();
  }
  return { frameCount, bandPixels, outsideBandSamples, violations };
}

// ---------------------------------------------------------------------------
// Encoded output: decoded MP4 against the composite it was encoded from
// ---------------------------------------------------------------------------

interface VideoProbe {
  readonly codec: string | undefined;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly pixelFormat: string | undefined;
  readonly timestamps: readonly number[];
}

async function probeVideo(mp4Path: string): Promise<VideoProbe> {
  const stream = await runCommand(
    ffprobeBinary(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,pix_fmt',
      '-of',
      'json',
      mp4Path,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (stream.status !== 0)
    throw new Error(`ffprobe could not read the encoded output: ${String(stream.stderr)}`);
  const info = (JSON.parse(String(stream.stdout)) as { streams?: Array<Record<string, unknown>> })
    .streams?.[0];
  const frames = await runCommand(
    ffprobeBinary(),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      mp4Path,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (frames.status !== 0)
    throw new Error(`ffprobe could not list the encoded frames: ${String(frames.stderr)}`);
  const timestamps = String(frames.stdout)
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => Number(line));
  return {
    codec: info?.['codec_name'] as string | undefined,
    width: info?.['width'] as number | undefined,
    height: info?.['height'] as number | undefined,
    pixelFormat: info?.['pix_fmt'] as string | undefined,
    timestamps,
  };
}

/** The x264 build line that libx264 writes into the stream's SEI, or null when the stream has none. */
async function x264Build(mp4Path: string): Promise<string | null> {
  const run = await runCommand(
    ffmpegBinary(),
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      mp4Path,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-f',
      'h264',
      'pipe:1',
    ],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.status !== 0 || !run.stdout) return null;
  const at = run.stdout.indexOf(Buffer.from('x264 - core'));
  if (at < 0) return null;
  let end = at;
  while (
    end < run.stdout.length &&
    end - at < 512 &&
    run.stdout[end] !== 0 &&
    run.stdout[end] !== 0x0a
  )
    end++;
  return run.stdout.subarray(at, end).toString('latin1').trim();
}

/**
 * Decodes the encoded output and checks it frame by frame against its own composite. Requirements: decodable,
 * the same frame count, dimensions and timestamps, luma PSNR of at least ENCODED_MIN_LUMA_PSNR_DB on every frame,
 * caption ink in the band on every active frame, and no caption-shaped residual on caption-free frames.
 */
export async function checkEncodedFidelity(options: {
  readonly mp4Path: string;
  readonly workDir: string;
  readonly caption: ProductionComposite;
  readonly baseline: ProductionComposite;
  readonly cue: CueFrames;
}): Promise<EncodedFidelityReport> {
  const { mp4Path, workDir, caption, baseline, cue } = options;
  const violations: string[] = [];
  const probe = await probeVideo(mp4Path);
  if (probe.codec !== 'h264') violations.push(`codec is ${String(probe.codec)}, expected h264`);
  if (probe.width !== RENDER_WIDTH || probe.height !== RENDER_HEIGHT)
    violations.push(
      `dimensions are ${String(probe.width)}x${String(probe.height)}, expected ${RENDER_WIDTH}x${RENDER_HEIGHT}`,
    );
  if (probe.pixelFormat !== 'yuv420p')
    violations.push(`pixel format is ${String(probe.pixelFormat)}, expected yuv420p`);
  if (probe.timestamps.length !== caption.frameCount)
    violations.push(
      `encoded output has ${probe.timestamps.length} frames, composite has ${caption.frameCount}`,
    );
  probe.timestamps.forEach((time, index) => {
    if (Math.abs(time - index / FRAME_RATE) > 1e-6 && violations.length < 20)
      violations.push(
        `frame ${index} presentation time ${time} differs from ${index}/${FRAME_RATE}`,
      );
  });

  const decodedPath = join(workDir, 'decoded.yuv');
  mkdirSync(workDir, { recursive: true });
  const decode = await runCommand(
    ffmpegBinary(),
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-i',
      mp4Path,
      '-map',
      '0:v:0',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      decodedPath,
    ],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  const decodeMessage = String(decode.stderr ?? '').trim();
  if (decode.status !== 0 || decodeMessage !== '')
    violations.push(`decoding failed: ${decodeMessage || `exit ${String(decode.status)}`}`);
  const decodedBytes = existsSync(decodedPath) ? statSync(decodedPath).size : 0;
  const decodedFrames = decodedBytes / YUV_FRAME_BYTES;
  if (decodedBytes % YUV_FRAME_BYTES !== 0 || decodedFrames !== caption.frameCount)
    violations.push(`decoded ${decodedBytes} bytes, expected ${caption.frameCount} whole frames`);

  const readers = {
    decoded: new FrameReader(decodedPath, YUV_FRAME_BYTES),
    caption: new FrameReader(caption.yuvPath, YUV_FRAME_BYTES),
    baseline: new FrameReader(baseline.yuvPath, YUV_FRAME_BYTES),
  };
  const lumaPsnrs: number[] = [];
  const activeVisiblePixels: number[] = [];
  let maxIdleResidualPixels = 0;
  try {
    const frames = Math.min(caption.frameCount, decodedFrames);
    for (let n = 0; n < frames; n++) {
      if (n % 5 === 0) await yieldToEventLoop();
      const decoded = readers.decoded.read(n);
      const psnr = lumaPsnrDb(decoded, readers.caption.read(n));
      lumaPsnrs.push(psnr);
      if (psnr < ENCODED_MIN_LUMA_PSNR_DB)
        violations.push(
          `frame ${n}: luma PSNR ${psnr.toFixed(2)} dB is below ${ENCODED_MIN_LUMA_PSNR_DB} dB`,
        );
      if (n >= cue.firstFrame && n < cue.endFrame) {
        const visible = countLumaBandDifferences(
          decoded,
          readers.baseline.read(n),
          CAPTION_PIXEL_THRESHOLD,
        );
        activeVisiblePixels.push(visible);
        if (visible < ENCODED_MIN_VISIBLE_CAPTION_PIXELS)
          violations.push(
            `frame ${n}: only ${visible} caption-band pixels differ from the no-caption composite (at least ${ENCODED_MIN_VISIBLE_CAPTION_PIXELS} expected)`,
          );
      } else {
        const residual = countLumaBandDifferences(
          decoded,
          readers.caption.read(n),
          ENCODED_RESIDUAL_THRESHOLD,
        );
        maxIdleResidualPixels = Math.max(maxIdleResidualPixels, residual);
        if (residual > ENCODED_MAX_IDLE_RESIDUAL_PIXELS)
          violations.push(
            `frame ${n}: ${residual} caption-band pixels differ from the frame's own input by more than ${ENCODED_RESIDUAL_THRESHOLD} on a caption-free frame (at most ${ENCODED_MAX_IDLE_RESIDUAL_PIXELS} allowed)`,
          );
      }
    }
  } finally {
    for (const reader of Object.values(readers)) reader.close();
  }

  const finitePsnrs = lumaPsnrs.filter((value) => Number.isFinite(value));
  const minLumaPsnrDb = Math.min(...lumaPsnrs);
  return {
    frameCount: caption.frameCount,
    lumaPsnrDb: lumaPsnrs,
    minLumaPsnrDb,
    minPsnrFrame: lumaPsnrs.indexOf(minLumaPsnrDb),
    averageLumaPsnrDb:
      finitePsnrs.reduce((sum, value) => sum + value, 0) / Math.max(1, finitePsnrs.length),
    activeVisiblePixels,
    maxIdleResidualPixels,
    ffmpeg: String(
      (await runCommand(ffmpegBinary(), ['-version'], { encoding: 'utf8' })).stdout.toString() ??
        '',
    ).split(/\r?\n/u)[0]!,
    x264Build: await x264Build(mp4Path),
    violations,
  };
}
