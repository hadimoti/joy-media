import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  assertApiSafeRenderReport,
  finding,
  type DeliveryPromiseV1,
  type QualityFindingV1,
  type RenderFactsV1,
  type RenderReportV1,
} from './types.js';

export interface RenderInspectionOptions {
  readonly mode: 'sampled' | 'strict';
  readonly outputRef: string;
  readonly checkedAt?: string;
}

export function inspectRenderedDelivery(
  outputPath: string,
  promise: DeliveryPromiseV1,
  options: RenderInspectionOptions,
): RenderReportV1 {
  const facts = probeFacts(outputPath, promise, options.mode);
  const bytes = statSync(outputPath).size;
  const report: RenderReportV1 = {
    version: 1,
    promiseId: promise.id,
    checkedAt: options.checkedAt ?? '1970-01-01T00:00:00.000Z',
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

function probeFacts(
  outputPath: string,
  promise: DeliveryPromiseV1,
  mode: 'sampled' | 'strict',
): RenderFactsV1 {
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
    ...(videoStream === undefined
      ? {}
      : { video: videoFacts(outputPath, videoStream, promise, mode) }),
    ...(audioStream === undefined ? {} : { audio: audioFacts(outputPath, audioStream, mode) }),
    subtitles: { streams: subtitleStreams },
  };
}

function videoFacts(
  outputPath: string,
  stream: Record<string, unknown>,
  promise: DeliveryPromiseV1,
  mode: 'sampled' | 'strict',
): NonNullable<RenderFactsV1['video']> {
  const frames = integerField(stream.nb_read_frames) ?? integerField(stream.nb_frames) ?? 0;
  const sampleLimit =
    mode === 'strict' ? Math.min(60, Math.max(1, frames || promise.video.expectedFrames)) : 12;
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
  };
}

function audioFacts(
  outputPath: string,
  stream: Record<string, unknown>,
  mode: 'sampled' | 'strict',
): NonNullable<RenderFactsV1['audio']> {
  const sampleSeconds = mode === 'strict' ? '2' : '1';
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
