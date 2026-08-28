import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertApiSafeRenderReport,
  finding,
  type DeliveryPromiseV1,
  type QualityFindingV1,
  type RenderFactsV1,
  type RenderReportV1,
} from './types.js';
import { captionAssDocument } from '@joy-media/captions-core';

const PINNED_CAPTION_FONT_SHA256 =
  '932319d2ebd6fe90f6eaf3e785694a9dd9210a098575d98967709477688b1cac';
const CAPTION_FONT_PATH = fileURLToPath(
  new URL(
    '../../../apps/editor-web/public/assets/fonts/falsafeh/Falsafeh-Light.ttf',
    import.meta.url,
  ),
);

export interface RenderInspectionOptions {
  readonly mode: 'sampled';
  readonly outputRef: string;
  readonly checkedAt?: string;
}

export function inspectRenderedDelivery(
  outputPath: string,
  promise: DeliveryPromiseV1,
  options: RenderInspectionOptions,
): RenderReportV1 {
  const facts = probeFacts(outputPath, promise);
  const bytes = statSync(outputPath).size;
  const report: RenderReportV1 = {
    version: 1,
    promiseId: promise.id,
    checkedAt: options.checkedAt ?? '1970-01-01T00:00:00.000Z',
    evidenceLevel: options.mode,
    artifact: {
      outputRef: options.outputRef,
      sha256: createHash('sha256').update(readFileSync(outputPath)).digest('hex'),
      bytes,
    },
    facts,
    findings: inspectFacts(facts, promise),
  };
  assertApiSafeRenderReport(report);
  return report;
}

function probeFacts(outputPath: string, promise: DeliveryPromiseV1): RenderFactsV1 {
  const probe = runJson('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'format=format_name,duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration,nb_frames,nb_read_frames,sample_rate,channels',
    '-of',
    'json',
    outputPath,
  ]);
  const format = record(probe.format);
  const streams = Array.isArray(probe.streams) ? probe.streams.map(record) : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const subtitleStreams = streams.filter((stream) => stream.codec_type === 'subtitle').length;
  const container = String(format.format_name ?? basename(outputPath).split('.').pop() ?? '');
  return {
    container: container.includes('mp4') || container.includes('mov') ? 'mp4' : container,
    ...(videoStream === undefined ? {} : { video: videoFacts(outputPath, videoStream, promise) }),
    ...(audioStream === undefined ? {} : { audio: audioFacts(outputPath, audioStream) }),
    subtitles: { streams: subtitleStreams },
  };
}

function videoFacts(
  outputPath: string,
  stream: Record<string, unknown>,
  promise: DeliveryPromiseV1,
): NonNullable<RenderFactsV1['video']> {
  const frames = integerField(stream.nb_read_frames) ?? integerField(stream.nb_frames) ?? 0;
  const sampleLimit = 12;
  const frameBytes = promise.video.width * promise.video.height * 3;
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      outputPath,
      '-vf',
      `scale=${promise.video.width}:${promise.video.height}:flags=neighbor`,
      '-frames:v',
      String(sampleLimit),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { shell: false, maxBuffer: frameBytes * sampleLimit + 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`ffmpeg frame inspection failed: ${result.stderr.toString()}`);
  let sampledFrames = 0;
  let blackFrames = 0;
  let blankFrames = 0;
  let duplicateFrames = 0;
  let previousHash = '';
  for (let offset = 0; offset + frameBytes <= result.stdout.length; offset += frameBytes) {
    sampledFrames++;
    const frame = result.stdout.subarray(offset, offset + frameBytes);
    const stats = frameStats(frame);
    if (stats.mean < 3) blackFrames++;
    if (stats.variance < 2) blankFrames++;
    const hash = createHash('sha256').update(frame).digest('hex');
    if (hash === previousHash) duplicateFrames++;
    previousHash = hash;
  }
  const captionPixelFrames =
    promise.captions.mode === 'burned-in' && promise.captions.burnIn !== undefined
      ? captionPixelSamples(outputPath, promise)
      : 0;
  return {
    codec: String(stream.codec_name ?? ''),
    width: integerField(stream.width) ?? 0,
    height: integerField(stream.height) ?? 0,
    frameRate: parseRate(String(stream.avg_frame_rate ?? stream.r_frame_rate ?? '0/1')),
    durationUs: secondsToUs(Number(stream.duration ?? 0)),
    frames,
    sampledFrames,
    blackFrames,
    blankFrames,
    duplicateFrames,
    ...(promise.captions.burnIn === undefined ? {} : { captionPixelFrames }),
  };
}

function captionPixelSamples(outputPath: string, promise: DeliveryPromiseV1): number {
  const segments = promise.captions.burnIn?.segments ?? [];
  const fontPath = resolveCaptionFontPath();
  if (fontPath === undefined) return 0;
  const fontHash = createHash('sha256').update(readFileSync(fontPath)).digest('hex');
  if (fontHash !== PINNED_CAPTION_FONT_SHA256) return 0;
  const directory = mkdtempSync(join(dirname(outputPath), 'joy-caption-inspect-'));
  const assPath = join(directory, 'captions.ass');
  writeFileSync(
    assPath,
    captionAssDocument(promise.captions.burnIn!, {
      width: promise.video.width,
      height: promise.video.height,
    }),
  );
  let visible = 0;
  try {
    for (const segment of segments.slice(0, 12)) {
      const midpointUs = segment.startUs + Math.floor((segment.endUs - segment.startUs) / 2);
      const expected = renderCaptionMaskFrame(
        assPath,
        dirname(fontPath),
        promise.video.width,
        promise.video.height,
        promise.video.frameRate,
        midpointUs,
      );
      const result = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-ss',
          (midpointUs / 1_000_000).toFixed(6),
          '-i',
          outputPath,
          '-frames:v',
          '1',
          '-vf',
          `scale=${promise.video.width}:${promise.video.height}:flags=neighbor`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        {
          shell: false,
          maxBuffer: promise.video.width * promise.video.height * 3 + 1024,
        },
      );
      const frameBytes = promise.video.width * promise.video.height * 3;
      if (expected !== undefined && result.status === 0 && result.stdout.length >= frameBytes) {
        const frame = result.stdout.subarray(0, frameBytes);
        const comparison = compareCaptionGlyphMask(expected, frame);
        if (comparison.recall >= 0.2 && comparison.precision >= 0.28) visible++;
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return visible;
}

interface CaptionGlyphMask {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
  readonly glyphPixels: number;
  readonly minY: number;
  readonly maxY: number;
}

interface CaptionGlyphComparison {
  readonly precision: number;
  readonly recall: number;
}

function renderCaptionMaskFrame(
  assPath: string,
  fontsDirectory: string,
  width: number,
  height: number,
  frameRate: number,
  midpointUs: number,
): CaptionGlyphMask | undefined {
  const frameBytes = width * height * 3;
  const expected = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${width}x${height}:r=${frameRate}`,
      '-ss',
      (midpointUs / 1_000_000).toFixed(6),
      '-vf',
      `subtitles=${escapeFilterPath(assPath)}:fontsdir=${escapeFilterPath(fontsDirectory)}`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { shell: false, maxBuffer: frameBytes + 1024 },
  );
  if (expected.status !== 0 || expected.stdout.length < frameBytes) return undefined;
  const pixels = expected.stdout.subarray(0, frameBytes) as Buffer;
  let glyphPixels = 0;
  let minY = height;
  let maxY = -1;
  for (let offset = 0; offset < frameBytes; offset += 3) {
    // The shared ASS document includes the production outline. The expected
    // glyph surface is the bright primary face; exclude the dark outline from
    // the mask while still deriving it from the exact production document.
    if (!isCaptionFacePixel(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!)) continue;
    glyphPixels++;
    const y = Math.floor(offset / 3 / width);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (glyphPixels === 0) return undefined;
  return { pixels, width, height, glyphPixels, minY, maxY };
}

/**
 * Compare both positive glyph recall and negative (non-glyph) precision. A
 * filled lower-third can overlap every expected caption coordinate, but it
 * must not be allowed to satisfy the evidence by lighting the whole safe
 * region around the glyphs.
 */
function compareCaptionGlyphMask(
  expected: CaptionGlyphMask,
  frame: Buffer,
): CaptionGlyphComparison {
  const frameBytes = expected.width * expected.height * 3;
  let expectedHits = 0;
  let glyphHits = 0;
  let nonGlyphBright = 0;
  const expectedMask = new Uint8Array(expected.width * expected.height);
  const neighbourhood = new Uint8Array(expected.width * expected.height);
  // Restrict negative evidence to a small dilation around the expected face.
  // This prevents unrelated bright composition layers elsewhere in the
  // caption band from poisoning precision, while retaining forged lower-third
  // detection when it overlaps the caption surface.
  for (let y = 0; y < expected.height; y++) {
    for (let x = 0; x < expected.width; x++) {
      const pixel = (y * expected.width + x) * 3;
      const expectedGlyph = isCaptionFacePixel(
        expected.pixels[pixel]!,
        expected.pixels[pixel + 1]!,
        expected.pixels[pixel + 2]!,
      );
      if (expectedGlyph) {
        expectedMask[y * expected.width + x] = 1;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < expected.width && ny >= 0 && ny < expected.height)
              neighbourhood[ny * expected.width + nx] = 1;
          }
        }
      }
    }
  }
  for (let y = 0; y < expected.height; y++) {
    for (let x = 0; x < expected.width; x++) {
      const pixel = (y * expected.width + x) * 3;
      const bright = isCaptionFacePixel(frame[pixel]!, frame[pixel + 1]!, frame[pixel + 2]!);
      if (expectedMask[y * expected.width + x] !== 0) {
        expectedHits++;
        if (bright) glyphHits++;
      } else if (bright && neighbourhood[y * expected.width + x] !== 0) {
        nonGlyphBright++;
      }
    }
  }
  if (expectedHits === 0 || frame.length < frameBytes) return { precision: 0, recall: 0 };
  return {
    precision: glyphHits / Math.max(1, glyphHits + nonGlyphBright),
    recall: glyphHits / expectedHits,
  };
}

/** Bright neutral face/anti-alias pixels; excludes the production outline and plates. */
function isCaptionFacePixel(r: number, g: number, b: number): boolean {
  return Math.abs(r - 255) + Math.abs(g - 255) + Math.abs(b - 255) < 500;
}

function resolveCaptionFontPath(): string | undefined {
  const candidates = [
    CAPTION_FONT_PATH,
    join(process.cwd(), 'apps/editor-web/public/assets/fonts/falsafeh/Falsafeh-Light.ttf'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function escapeFilterPath(path: string): string {
  return `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

function audioFacts(
  outputPath: string,
  stream: Record<string, unknown>,
): NonNullable<RenderFactsV1['audio']> {
  const sampleSeconds = '1';
  const channels = integerField(stream.channels) ?? 0;
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', outputPath, '-t', sampleSeconds, '-vn', '-f', 's16le', 'pipe:1'],
    {
      shell: false,
      maxBuffer: 48000 * Math.max(1, channels) * 2 * Number(sampleSeconds) + 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(`ffmpeg audio inspection failed: ${result.stderr.toString()}`);
  let sumSquares = 0;
  let samples = 0;
  let peak = 0;
  let clippedSamples = 0;
  for (let offset = 0; offset + 1 < result.stdout.length; offset += 2) {
    const value = result.stdout.readInt16LE(offset);
    const normalized = Math.abs(value) / 32768;
    sumSquares += normalized * normalized;
    peak = Math.max(peak, normalized);
    if (Math.abs(value) >= 32760) clippedSamples++;
    samples++;
  }
  return {
    codec: String(stream.codec_name ?? ''),
    sampleRate: Number(stream.sample_rate ?? 0),
    channels,
    durationUs: secondsToUs(Number(stream.duration ?? 0)),
    sampledDurationUs: Math.min(secondsToUs(Number(stream.duration ?? 0)), 1_000_000),
    rms: samples === 0 ? 0 : Math.sqrt(sumSquares / samples),
    peak,
    clippedSamples,
  };
}

function inspectFacts(
  facts: RenderFactsV1,
  promise: DeliveryPromiseV1,
): readonly QualityFindingV1[] {
  const findings: QualityFindingV1[] = [];
  const video = facts.video;
  if (promise.video.required && video === undefined) {
    findings.push(finding('video-presence', 'fail', 'video stream is missing'));
  } else if (video !== undefined) {
    findings.push(
      match(
        'video-codec',
        video.codec === promise.video.codec,
        'video codec matches promise',
        'video codec does not match promise',
      ),
    );
    findings.push(
      match(
        'dimensions',
        video.width === promise.video.width && video.height === promise.video.height,
        'dimensions match promise',
        'dimensions do not match promise',
      ),
    );
    findings.push(
      match(
        'frame-rate',
        Math.abs(video.frameRate - promise.video.frameRate) <= promise.video.fpsTolerance,
        'frame rate matches promise',
        'frame rate is outside tolerance',
      ),
    );
    findings.push(
      match(
        'duration',
        Math.abs(video.durationUs - promise.video.durationUs) <= promise.video.durationToleranceUs,
        'duration matches promise',
        'duration is outside tolerance',
      ),
    );
    findings.push(
      match(
        'frame-count',
        Math.abs(video.frames - promise.video.expectedFrames) <= promise.video.frameTolerance,
        'frame count matches promise',
        'frame count is outside tolerance',
      ),
    );
    findings.push(
      match(
        'black-frames',
        video.blackFrames <= promise.video.maxBlackFrames,
        'black frame sample is within limit',
        'too many black frames were detected',
      ),
    );
    findings.push(
      match(
        'blank-frames',
        (video.blankFrames ?? 0) <= promise.video.maxBlankFrames,
        'blank frame sample is within limit',
        'too many blank frames were detected',
      ),
    );
    findings.push(
      match(
        'duplicate-frames',
        video.duplicateFrames <= promise.video.maxDuplicateFrames,
        'duplicate frame sample is within limit',
        'too many duplicate frames were detected',
      ),
    );
  }
  const audio = facts.audio;
  if (promise.audio.required && audio === undefined) {
    findings.push(finding('audio-presence', 'fail', 'audio stream is missing'));
  } else if (audio !== undefined) {
    findings.push(
      match(
        'audio-codec',
        audio.codec === promise.audio.codec,
        'audio codec matches promise',
        'audio codec does not match promise',
      ),
    );
    findings.push(
      match(
        'audio-sample-rate',
        audio.sampleRate === promise.audio.sampleRate,
        'audio sample rate matches promise',
        'audio sample rate does not match promise',
      ),
    );
    findings.push(
      match(
        'audio-channels',
        audio.channels === promise.audio.channels,
        'audio channels match promise',
        'audio channels do not match promise',
      ),
    );
    findings.push(
      match(
        'audio-silence',
        audio.rms >= promise.audio.minRms,
        'audio RMS is above silence floor',
        'audio appears silent',
      ),
    );
    findings.push(
      match(
        'audio-peak',
        audio.peak <= promise.audio.maxPeak,
        'audio peak is within limit',
        'audio peak is above limit',
      ),
    );
    findings.push(
      match(
        'audio-clipping',
        audio.clippedSamples <= promise.audio.maxClippedSamples,
        'audio clipping is within limit',
        'audio clipping was detected',
      ),
    );
  }
  if (promise.captions.required && promise.captions.mode === 'sidecar') {
    findings.push(
      match(
        'caption-sidecar',
        (facts.subtitles?.streams ?? 0) > 0,
        'subtitle stream is present',
        'sidecar subtitle stream is missing',
      ),
    );
  }
  if (promise.captions.required && promise.captions.mode === 'burned-in') {
    const evidence = promise.captions.burnIn;
    if (evidence === undefined) {
      findings.push(
        finding(
          'caption-pixels-unproven',
          'warn',
          'generic inspection does not prove burned-in caption pixels without cue evidence',
        ),
      );
    } else if (evidence.segments.length > 0) {
      findings.push(
        match(
          'caption-pixels',
          (facts.video?.captionPixelFrames ?? 0) > 0,
          'sampled burned-in caption pixels are present in the safe area',
          'sampled frames contain no burned-in caption pixels in the safe area',
        ),
      );
    } else {
      findings.push(
        finding('caption-pixels', 'pass', 'burn-in intent contains no caption segments'),
      );
    }
  }
  if (findings.length === 0)
    findings.push(finding('delivery', 'pass', 'delivery promise is satisfied'));
  return findings;
}

function match(code: string, ok: boolean, pass: string, fail: string): QualityFindingV1 {
  return finding(code, ok ? 'pass' : 'fail', ok ? pass : fail);
}

function runJson(command: string, args: readonly string[]): Record<string, unknown> {
  const result = spawnSync(command, args, { shell: false, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integerField(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseRate(value: string): number {
  const parts = value.split('/').map(Number);
  const num = parts[0] ?? 0;
  const den = parts[1] ?? 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function secondsToUs(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(seconds * 1_000_000) : 0;
}

function frameStats(frame: Buffer): { readonly mean: number; readonly variance: number } {
  let sum = 0;
  for (const value of frame) sum += value;
  const mean = frame.length === 0 ? 0 : sum / frame.length;
  let squared = 0;
  for (const value of frame) squared += (value - mean) ** 2;
  return { mean, variance: frame.length === 0 ? 0 : squared / frame.length };
}
