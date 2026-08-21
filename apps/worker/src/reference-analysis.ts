import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  ReferenceAnalysisEvidence,
  ReferenceAnalysisFinding,
  VideoReferenceAnalyzePayload,
  VideoReferenceAnalyzeReceipt,
} from '@joy-media/job-protocol';

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3;
const AUDIO_SAMPLE_RATE = 8_000;
const AUDIO_WINDOW_US = 500_000;

export class ReferenceAnalysisError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReferenceAnalysisError';
    this.code = code;
  }
}

export async function analyzeReferenceVideo(options: {
  readonly jobId: string;
  readonly assetId: string;
  readonly sourcePath: string;
  readonly payload: VideoReferenceAnalyzePayload;
  readonly cancelled: () => boolean;
  readonly progress: (progress: number) => Promise<void>;
  readonly modelAnalyze?: (
    receipt: VideoReferenceAnalyzeReceipt,
  ) => Promise<readonly ReferenceAnalysisFinding[]>;
}): Promise<VideoReferenceAnalyzeReceipt> {
  assertNotCanceled(options.cancelled);
  await options.progress(5);

  const sourceStats = statSync(options.sourcePath);
  if (sourceStats.size > options.payload.maxBytes) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_SOURCE_TOO_LARGE',
      `reference source is ${sourceStats.size} bytes, above ${options.payload.maxBytes}`,
    );
  }

  const descriptor = probeVideo(options.sourcePath);
  if (descriptor.durationUs > options.payload.maxDurationUs) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_SOURCE_TOO_LONG',
      `reference source is ${descriptor.durationUs}µs, above ${options.payload.maxDurationUs}`,
    );
  }
  await options.progress(15);

  assertNotCanceled(options.cancelled);
  const sourceBytes = readFileSync(options.sourcePath);
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
  await options.progress(25);

  const sampleTimesUs = buildSampleTimes(descriptor.durationUs, options.payload.sampleCount ?? 3);
  const sampledFrames = sampleTimesUs.map((timeUs, index) => {
    assertNotCanceled(options.cancelled);
    const rgb = sampleFrame(options.sourcePath, timeUs);
    return { timeUs, rgb, index };
  });
  await options.progress(45);

  assertNotCanceled(options.cancelled);
  const shotEvidence = buildShotEvidence(sampledFrames, descriptor.durationUs);
  const paletteEvidence = sampledFrames.map(({ timeUs, rgb }) => buildPaletteEvidence(timeUs, rgb));
  const compositionEvidence = sampledFrames.map(({ timeUs, rgb }) =>
    buildCompositionEvidence(timeUs, rgb),
  );
  const safeZoneEvidence = buildSafeZoneEvidence(sampledFrames[0]?.rgb);
  const transcriptEvidence = buildTranscriptEvidence();
  await options.progress(60);

  assertNotCanceled(options.cancelled);
  const audioBeatEvidence = buildAudioBeatEvidence(
    decodeAudioPcm(options.sourcePath),
    descriptor.durationUs,
    options.payload.maxAudioBeats ?? 6,
  );
  await options.progress(80);

  const cutRhythmEvidence = buildCutRhythmEvidence(shotEvidence);
  const evidence: ReferenceAnalysisEvidence[] = [
    ...shotEvidence,
    cutRhythmEvidence,
    ...paletteEvidence,
    ...compositionEvidence,
    safeZoneEvidence,
    transcriptEvidence,
    ...audioBeatEvidence,
  ];
  const baseReceipt: VideoReferenceAnalyzeReceipt = {
    kind: 'video.reference-analyze',
    assetId: options.assetId,
    sha256,
    bytes: sourceStats.size,
    descriptor,
    summary: {
      shotCount: shotEvidence.length,
      cutCount: Math.max(0, shotEvidence.length - 1),
      averageShotDurationUs: cutRhythmEvidence.averageShotDurationUs,
      fastestShotDurationUs: cutRhythmEvidence.fastestShotDurationUs,
      sampleCount: sampledFrames.length,
      transcriptSegmentCount: transcriptEvidence.segments.length,
      audioBeatCount: audioBeatEvidence.length,
    },
    evidence,
    evidenceIds: evidence.map((entry) => entry.id),
  };

  let findings: readonly ReferenceAnalysisFinding[] | undefined;
  if (options.modelAnalyze !== undefined) {
    assertNotCanceled(options.cancelled);
    const nextFindings = await options.modelAnalyze(baseReceipt);
    findings = validateReferenceAnalysisModelFindings(baseReceipt, nextFindings);
  }
  await options.progress(100);
  return findings === undefined ? baseReceipt : { ...baseReceipt, findings };
}

export function validateReferenceAnalysisModelFindings(
  receipt: VideoReferenceAnalyzeReceipt,
  findings: readonly ReferenceAnalysisFinding[],
): readonly ReferenceAnalysisFinding[] {
  const evidenceIds = new Set(receipt.evidenceIds);
  return findings.map((finding, index) => {
    if (finding.source !== 'model' && finding.source !== 'deterministic') {
      throw new ReferenceAnalysisError(
        'REFERENCE_ANALYSIS_FINDING_INVALID',
        `finding ${index} has an invalid source`,
      );
    }
    if (finding.evidenceIds.length === 0) {
      throw new ReferenceAnalysisError(
        'REFERENCE_ANALYSIS_FINDING_INVALID',
        `finding ${finding.id} must cite at least one evidence id`,
      );
    }
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new ReferenceAnalysisError(
          'REFERENCE_ANALYSIS_FINDING_INVALID',
          `finding ${finding.id} references unknown evidence ${evidenceId}`,
        );
      }
    }
    return { ...finding, evidenceIds: [...finding.evidenceIds] };
  });
}

function assertNotCanceled(cancelled: () => boolean): void {
  if (cancelled()) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_CANCELED',
      'reference analysis was canceled',
    );
  }
}

function probeVideo(sourcePath: string): VideoReferenceAnalyzeReceipt['descriptor'] {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,duration:format=format_name',
      '-of',
      'json',
      sourcePath,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_PROBE_FAILED',
      'ffprobe could not inspect the source video',
    );
  }
  const parsed = JSON.parse(probe.stdout) as {
    readonly streams?: ReadonlyArray<{
      readonly width?: number;
      readonly height?: number;
      readonly duration?: string;
    }>;
    readonly format?: { readonly format_name?: string };
  };
  const stream = parsed.streams?.[0];
  if (
    stream === undefined ||
    !Number.isSafeInteger(stream.width) ||
    !Number.isSafeInteger(stream.height) ||
    typeof stream.duration !== 'string'
  ) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_PROBE_FAILED',
      'video descriptor is incomplete',
    );
  }
  const durationUs = Math.round(Number(stream.duration) * 1_000_000);
  if (!Number.isSafeInteger(durationUs) || durationUs < 1) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_PROBE_FAILED',
      'video duration is invalid',
    );
  }
  return {
    mimeType: mimeTypeFromFormat(parsed.format?.format_name, sourcePath),
    width: Number(stream.width),
    height: Number(stream.height),
    durationUs,
  };
}

function sampleFrame(sourcePath: string, timeUs: number): Uint8Array {
  const seconds = (timeUs / 1_000_000).toFixed(6);
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      seconds,
      '-i',
      sourcePath,
      '-frames:v',
      '1',
      '-vf',
      `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { shell: false, encoding: 'buffer', maxBuffer: FRAME_BYTES * 4 },
  );
  if (ffmpeg.status !== 0 || ffmpeg.stdout.length < FRAME_BYTES) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_FRAME_FAILED',
      `ffmpeg could not sample the frame at ${seconds}s`,
    );
  }
  return new Uint8Array(ffmpeg.stdout.subarray(0, FRAME_BYTES));
}

function buildSampleTimes(durationUs: number, requestedSamples: number): readonly number[] {
  const sampleCount = Math.max(1, Math.min(6, requestedSamples));
  if (sampleCount === 1) return [0];
  const stepUs = Math.floor(durationUs / sampleCount);
  const result: number[] = [];
  for (let index = 0; index < sampleCount; index++) {
    result.push(Math.min(durationUs - 1, stepUs * index));
  }
  return [...new Set(result)];
}

function buildShotEvidence(
  samples: readonly { readonly timeUs: number; readonly rgb: Uint8Array }[],
  durationUs: number,
): readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[] {
  const cutTimesUs: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) continue;
    const delta = frameDelta(previous.rgb, current.rgb);
    if (delta >= 0.2) cutTimesUs.push(current.timeUs);
  }
  const boundaries = [0, ...cutTimesUs, durationUs];
  const shots: Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const startUs = boundaries[index] ?? 0;
    const endUs = boundaries[index + 1] ?? durationUs;
    shots.push({
      id: `shot-${String(startUs).padStart(8, '0')}`,
      kind: 'shot',
      label: `Shot ${index + 1}`,
      summary:
        cutTimesUs.length === 0
          ? 'No deterministic cut boundary exceeded the threshold; the clip reads as one shot.'
          : `Shot from ${(startUs / 1_000_000).toFixed(1)}s to ${(endUs / 1_000_000).toFixed(1)}s.`,
      startUs,
      durationUs: endUs - startUs,
    });
  }
  return shots;
}

function buildCutRhythmEvidence(
  shots: readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'shot' }>[],
): Extract<ReferenceAnalysisEvidence, { readonly kind: 'cut-rhythm' }> {
  const durations = shots.map((shot) => shot.durationUs);
  const totalDurationUs = durations.reduce((total, value) => total + value, 0);
  const averageShotDurationUs = Math.round(totalDurationUs / Math.max(1, durations.length));
  const fastestShotDurationUs = Math.min(...durations);
  const cutCount = Math.max(0, shots.length - 1);
  return {
    id: 'cut-rhythm-00000000',
    kind: 'cut-rhythm',
    label: 'Cut rhythm',
    summary:
      cutCount === 0
        ? 'No cut boundary exceeded the deterministic threshold.'
        : `${cutCount} deterministic cut(s) across ${shots.length} shots.`,
    cutCount,
    averageShotDurationUs,
    fastestShotDurationUs,
  };
}

function buildPaletteEvidence(
  timeUs: number,
  rgb: Uint8Array,
): Extract<ReferenceAnalysisEvidence, { readonly kind: 'palette' }> {
  const counts = new Map<string, number>();
  for (let offset = 0; offset < rgb.length; offset += 9) {
    const color = quantizeColor(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  const swatches = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([color]) => color);
  return {
    id: `palette-${String(timeUs).padStart(8, '0')}`,
    kind: 'palette',
    label: `Palette ${(timeUs / 1_000_000).toFixed(1)}s`,
    summary: `Dominant swatches sampled at ${(timeUs / 1_000_000).toFixed(1)}s.`,
    startUs: timeUs,
    swatches,
  };
}

function buildCompositionEvidence(
  timeUs: number,
  rgb: Uint8Array,
): Extract<ReferenceAnalysisEvidence, { readonly kind: 'composition' }> {
  let totalWeight = 0;
  let weightedX = 0;
  let weightedY = 0;
  let brightestTopRow = 0;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    let rowWeight = 0;
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const offset = (y * FRAME_WIDTH + x) * 3;
      const weight = luminance(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0) + 1;
      totalWeight += weight;
      rowWeight += weight;
      weightedX += weight * x;
      weightedY += weight * y;
    }
    if (rowWeight > brightestTopRow && y < FRAME_HEIGHT / 3) brightestTopRow = rowWeight;
  }
  const xPct = totalWeight === 0 ? 0.5 : weightedX / totalWeight / (FRAME_WIDTH - 1);
  const yPct = totalWeight === 0 ? 0.5 : weightedY / totalWeight / (FRAME_HEIGHT - 1);
  return {
    id: `composition-${String(timeUs).padStart(8, '0')}`,
    kind: 'composition',
    label: `Composition ${(timeUs / 1_000_000).toFixed(1)}s`,
    summary: `Weighted focal point near ${(xPct * 100).toFixed(0)}% × ${(yPct * 100).toFixed(0)}%.`,
    startUs: timeUs,
    focalPoint: { xPct, yPct },
    balance: xPct < 0.4 ? 'left' : xPct > 0.6 ? 'right' : 'center',
    headroomPct: Math.max(0, Math.min(1, brightestTopRow / (FRAME_WIDTH * 256))),
  };
}

function buildSafeZoneEvidence(
  rgb: Uint8Array | undefined,
): Extract<ReferenceAnalysisEvidence, { readonly kind: 'text-safe-zone' }> {
  const boxes: { leftPct: number; topPct: number; widthPct: number; heightPct: number }[] = [];
  if (rgb !== undefined) {
    let minX = FRAME_WIDTH;
    let minY = FRAME_HEIGHT;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < Math.ceil(FRAME_HEIGHT * 0.3); y++) {
      for (let x = 0; x < Math.ceil(FRAME_WIDTH * 0.4); x++) {
        const offset = (y * FRAME_WIDTH + x) * 3;
        if (luminance(rgb[offset] ?? 0, rgb[offset + 1] ?? 0, rgb[offset + 2] ?? 0) < 18) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (maxX >= minX && maxY >= minY) {
      boxes.push({
        leftPct: minX / FRAME_WIDTH,
        topPct: minY / FRAME_HEIGHT,
        widthPct: (maxX - minX + 1) / FRAME_WIDTH,
        heightPct: (maxY - minY + 1) / FRAME_HEIGHT,
      });
    }
  }
  const safe = boxes.every(
    (box) =>
      box.leftPct >= 0.1 &&
      box.topPct >= 0.1 &&
      box.leftPct + box.widthPct <= 0.9 &&
      box.topPct + box.heightPct <= 0.9,
  );
  return {
    id: 'text-safe-zone-00000000',
    kind: 'text-safe-zone',
    label: 'Text safe zone',
    summary:
      boxes.length === 0
        ? 'No deterministic text-like dark box was detected in the sampled frame.'
        : safe
          ? 'Detected text region stays within the title-safe zone.'
          : 'Detected text region touches the frame edge and falls outside the title-safe zone.',
    safe,
    boxes,
  };
}

function buildTranscriptEvidence(): Extract<
  ReferenceAnalysisEvidence,
  { readonly kind: 'transcript' }
> {
  return {
    id: 'transcript-00000000',
    kind: 'transcript',
    label: 'Transcript',
    summary:
      'Deterministic analysis does not infer speech text; no transcript segments were produced.',
    segments: [],
  };
}

function decodeAudioPcm(sourcePath: string): Int16Array {
  const ffmpeg = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-ac',
      '1',
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      '-f',
      's16le',
      '-',
    ],
    { shell: false, encoding: 'buffer', maxBuffer: 8_000_000 },
  );
  if (ffmpeg.status !== 0 || ffmpeg.stdout.length === 0) {
    throw new ReferenceAnalysisError(
      'REFERENCE_ANALYSIS_AUDIO_FAILED',
      'ffmpeg could not decode the audio track',
    );
  }
  const buffer = ffmpeg.stdout;
  return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
}

function buildAudioBeatEvidence(
  pcm: Int16Array,
  durationUs: number,
  maxAudioBeats: number,
): readonly Extract<ReferenceAnalysisEvidence, { readonly kind: 'audio-beat' }>[] {
  if (pcm.length === 0 || maxAudioBeats === 0) return [];
  const samplesPerWindow = Math.max(
    1,
    Math.round((AUDIO_SAMPLE_RATE * AUDIO_WINDOW_US) / 1_000_000),
  );
  const windows = Math.ceil(pcm.length / samplesPerWindow);
  const energies: number[] = [];
  for (let windowIndex = 0; windowIndex < windows; windowIndex++) {
    let energy = 0;
    let count = 0;
    const start = windowIndex * samplesPerWindow;
    const end = Math.min(pcm.length, start + samplesPerWindow);
    for (let index = start; index < end; index++) {
      const sample = pcm[index] ?? 0;
      energy += sample * sample;
      count++;
    }
    energies.push(count === 0 ? 0 : Math.sqrt(energy / count));
  }
  const averageEnergy = energies.reduce((total, value) => total + value, 0) / energies.length;
  const candidates = energies
    .map((energy, index) => ({ energy, index }))
    .filter(({ energy, index }) => {
      const previous = energies[index - 1] ?? -Infinity;
      const next = energies[index + 1] ?? -Infinity;
      return energy >= previous && energy >= next && energy >= averageEnergy * 1.05;
    })
    .sort((left, right) => right.energy - left.energy || left.index - right.index)
    .slice(0, maxAudioBeats)
    .sort((left, right) => left.index - right.index);
  if (candidates.length === 0) {
    const strongest = energies
      .map((energy, index) => ({ energy, index }))
      .sort((left, right) => right.energy - left.energy || left.index - right.index)
      .slice(0, Math.min(1, maxAudioBeats));
    candidates.push(...strongest);
  }
  return candidates.map(({ energy, index }) => {
    const startUs = Math.min(durationUs - 1, index * AUDIO_WINDOW_US);
    return {
      id: `audio-beat-${String(startUs).padStart(8, '0')}`,
      kind: 'audio-beat',
      label: `Audio beat ${(startUs / 1_000_000).toFixed(1)}s`,
      summary: `Energy peak sampled in the ${(AUDIO_WINDOW_US / 1_000_000).toFixed(1)}s analysis window.`,
      startUs,
      durationUs: AUDIO_WINDOW_US,
      strength: Number((energy / 32_768).toFixed(4)),
    };
  });
}

function frameDelta(left: Uint8Array, right: Uint8Array): number {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++)
    total += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  return total / Math.max(1, length) / 255;
}

function quantizeColor(red: number, green: number, blue: number): string {
  const quantize = (value: number) => Math.round(value / 51) * 51;
  return `#${[quantize(red), quantize(green), quantize(blue)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function luminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function mimeTypeFromFormat(formatName: string | undefined, sourcePath: string): string {
  if (formatName?.includes('mp4') === true || extname(sourcePath).toLowerCase() === '.mp4') {
    return 'video/mp4';
  }
  return 'video/quicktime';
}
