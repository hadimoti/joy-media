import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { READINESS_TOLERANCES } from './tolerances.js';

type ProbeStream = {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  nb_read_frames?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
};

type ProbeResult = {
  streams: ProbeStream[];
  format: { duration?: string; format_name?: string };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');
const generatorPath = join(repositoryRoot, 'tooling/generate-media-fixtures.mjs');
const FIXTURE_NAMES = [
  'readiness-hard-cut.mkv',
  'readiness-flash-click.mkv',
  'readiness-silent.mp4',
  'readiness-audio-only.wav',
  'readiness-stereo-tones.wav',
  'readiness-tone-44100.wav',
  'readiness-tone-48000.wav',
  'readiness-vfr.mkv',
  'readiness-ntsc-30000-1001.mp4',
  'readiness-rotation.mp4',
  'readiness-alpha.png',
  'readiness-odd-161x91.mkv',
  'readiness-truncated.mp4',
  'readiness-mislabeled.jpg',
  'paths with spaces/فارسی 😀 tone.wav',
] as const;

const run = (tool: string, args: readonly string[]): Buffer => {
  const result = spawnSync(tool, [...args], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${tool} failed (${String(result.status)}): ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
};

const probe = (path: string): ProbeResult =>
  JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      path,
    ]).toString('utf8'),
  ) as ProbeResult;

const videoStream = (path: string): ProbeStream => {
  const stream = probe(path).streams.find((candidate) => candidate.codec_type === 'video');
  if (!stream) throw new Error(`fixture has no video stream: ${path}`);
  return stream;
};

const audioStream = (path: string): ProbeStream => {
  const stream = probe(path).streams.find((candidate) => candidate.codec_type === 'audio');
  if (!stream) throw new Error(`fixture has no audio stream: ${path}`);
  return stream;
};

const durationUs = (path: string): number => Number(probe(path).format.duration) * 1_000_000;

function assertDuration(path: string, expectedUs: number, frameRate: number): void {
  const maximumDeltaUs = (1_000_000 / frameRate) * READINESS_TOLERANCES.durationFrames;
  const deltaUs = Math.abs(durationUs(path) - expectedUs);
  if (deltaUs > maximumDeltaUs) {
    throw new Error(
      `duration differs by ${Math.round(deltaUs)}us (limit ${Math.round(maximumDeltaUs)}us)`,
    );
  }
}

function pixelAt(path: string, seconds: number): readonly [number, number, number] {
  const bytes = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-ss',
    String(seconds),
    '-vf',
    'scale=1:1',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ]);
  if (bytes.length !== 3)
    throw new Error(`expected one RGB pixel from ${path}, got ${bytes.length} bytes`);
  return [bytes[0]!, bytes[1]!, bytes[2]!];
}

function audioSamples(path: string, sampleRate: number, channels: number): Float32Array {
  const bytes = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-',
  ]);
  if (bytes.length % 4 !== 0) throw new Error(`decoded PCM has a partial float sample: ${path}`);
  const samples = new Float32Array(bytes.length / 4);
  for (let index = 0; index < samples.length; index++)
    samples[index] = bytes.readFloatLE(index * 4);
  if (samples.some((sample) => !Number.isFinite(sample)))
    throw new Error(`decoded PCM has NaN or Inf: ${path}`);
  return samples;
}

function channelSamples(samples: Float32Array, channels: number, channel: number): Float32Array {
  return Float32Array.from(
    { length: Math.floor(samples.length / channels) },
    (_, index) => samples[index * channels + channel]!,
  );
}

function measureFrequency(samples: Float32Array, sampleRate: number, startSeconds: number): number {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.min(samples.length, start + sampleRate / 2);
  let crossings = 0;
  for (let index = start + 1; index < end; index++) {
    if (samples[index - 1]! <= 0 && samples[index]! > 0) crossings++;
  }
  return crossings / ((end - start) / sampleRate);
}

function measureRms(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
): number {
  const start = Math.floor(startSeconds * sampleRate);
  const end = Math.min(samples.length, start + Math.floor(sampleRate * durationSeconds));
  let energy = 0;
  for (let index = start; index < end; index++) energy += samples[index]! ** 2;
  return Math.sqrt(energy / Math.max(1, end - start));
}

function findSignalOnset(samples: Float32Array, sampleRate: number, threshold: number): number {
  const windowSize = Math.floor(sampleRate * 0.005);
  for (let start = 0; start + windowSize <= samples.length; start += windowSize) {
    if (measureRms(samples, sampleRate, start / sampleRate, windowSize / sampleRate) >= threshold) {
      return start / sampleRate;
    }
  }
  throw new Error('no signal onset found');
}

function expectTone(samples: Float32Array, sampleRate: number, expectedHz: number): void {
  const actualHz = measureFrequency(samples, sampleRate, 0.25);
  if (Math.abs(actualHz - expectedHz) > READINESS_TOLERANCES.toneFrequencyHz) {
    throw new Error(`tone frequency ${actualHz}Hz differs from ${expectedHz}Hz`);
  }
}

function verifyReadinessFixtures(root: string): void {
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    toolchain: { ffmpegVersion: string; ffprobeVersion: string };
    files: Record<string, { expectedDecoded?: Record<string, unknown>; generatedBy?: string }>;
  };
  expect(manifest.toolchain.ffmpegVersion).not.toContain('\r');
  expect(manifest.toolchain.ffprobeVersion).not.toContain('\r');
  for (const [name, entry] of Object.entries(manifest.files)) {
    expect(entry.generatedBy, name).not.toContain('\r');
  }
  for (const name of FIXTURE_NAMES) {
    const path = join(root, name);
    if (!existsSync(path)) throw new Error(`generated fixture is missing: ${name}`);
    expect(manifest.files[name]?.expectedDecoded, name).toBeTypeOf('object');
  }
  expect(
    Object.keys(manifest.files)
      .filter((name) => name.startsWith('readiness-') || name.startsWith('paths with spaces/'))
      .sort(),
  ).toEqual([...FIXTURE_NAMES].sort());

  const hardCut = join(root, 'readiness-hard-cut.mkv');
  const hardCutProbe = probe(hardCut);
  expect(Math.abs(durationUs(hardCut) - 2_000_000)).toBeLessThanOrEqual(40_000);
  expect(hardCutProbe.streams.filter((stream) => stream.codec_type === 'video')).toHaveLength(1);
  expect(hardCutProbe.streams.filter((stream) => stream.codec_type === 'audio')).toHaveLength(1);
  expect(videoStream(hardCut)).toMatchObject({ width: 320, height: 180, nb_read_frames: '50' });
  const [redR, redG, redB] = pixelAt(hardCut, 0.5);
  const [blueR, blueG, blueB] = pixelAt(hardCut, 1.5);
  expect(redR).toBeGreaterThan(READINESS_TOLERANCES.solidColors.red.redMin);
  expect(redG).toBeLessThan(READINESS_TOLERANCES.solidColors.red.greenMax);
  expect(redB).toBeLessThan(READINESS_TOLERANCES.solidColors.red.blueMax);
  expect(blueR).toBeLessThan(READINESS_TOLERANCES.solidColors.blue.redMax);
  expect(blueG).toBeLessThan(READINESS_TOLERANCES.solidColors.blue.greenMax);
  expect(blueB).toBeGreaterThan(READINESS_TOLERANCES.solidColors.blue.blueMin);
  const hardCutAudio = audioSamples(hardCut, 48_000, 1);
  expect(Math.abs(measureFrequency(hardCutAudio, 48_000, 0.25) - 440)).toBeLessThanOrEqual(
    READINESS_TOLERANCES.toneFrequencyHz,
  );
  expect(Math.abs(measureFrequency(hardCutAudio, 48_000, 1.25) - 880)).toBeLessThanOrEqual(
    READINESS_TOLERANCES.toneFrequencyHz,
  );

  const marker = join(root, 'readiness-flash-click.mkv');
  const [darkR, darkG, darkB] = pixelAt(marker, 0.92);
  const [flashR, flashG, flashB] = pixelAt(marker, 1.0);
  const [nextR, nextG, nextB] = pixelAt(marker, 1.04);
  const [afterR, afterG, afterB] = pixelAt(marker, 1.08);
  expect(
    [darkR, darkG, darkB].every((value) => value < READINESS_TOLERANCES.solidColors.dark.redMax),
  ).toBe(true);
  expect(
    [flashR, flashG, flashB].every(
      (value) => value > READINESS_TOLERANCES.solidColors.white.redMin,
    ),
  ).toBe(true);
  expect(
    [nextR, nextG, nextB].every((value) => value < READINESS_TOLERANCES.solidColors.dark.redMax),
  ).toBe(true);
  expect(
    [afterR, afterG, afterB].every((value) => value < READINESS_TOLERANCES.solidColors.dark.redMax),
  ).toBe(true);
  const markerAudio = audioSamples(marker, 48_000, 1);
  const quietRms = measureRms(markerAudio, 48_000, 0.9, 0.02);
  const clickRms = measureRms(markerAudio, 48_000, 1.0, 0.02);
  expect(quietRms).toBeLessThan(READINESS_TOLERANCES.normalizedPcmRmsAbsolute);
  expect(clickRms).toBeGreaterThan(0.2);
  const clickOnsetUs = findSignalOnset(markerAudio, 48_000, 0.2) * 1_000_000;
  expect(Math.abs(clickOnsetUs - 1_000_000)).toBeLessThanOrEqual(
    (1_000_000 / 25) * READINESS_TOLERANCES.syncFrames,
  );

  const silent = probe(join(root, 'readiness-silent.mp4'));
  expect(silent.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
  expect(silent.streams.some((stream) => stream.codec_type === 'audio')).toBe(false);
  expect(
    probe(join(root, 'readiness-audio-only.wav')).streams.map((stream) => stream.codec_type),
  ).toEqual(['audio']);

  const stereoPath = join(root, 'readiness-stereo-tones.wav');
  expect(audioStream(stereoPath)).toMatchObject({ sample_rate: '48000', channels: 2 });
  const stereo = audioSamples(stereoPath, 48_000, 2);
  const left = channelSamples(stereo, 2, 0);
  const right = channelSamples(stereo, 2, 1);
  expect(Math.abs(measureFrequency(left, 48_000, 0.25) - 440)).toBeLessThanOrEqual(
    READINESS_TOLERANCES.toneFrequencyHz,
  );
  expect(Math.abs(measureFrequency(right, 48_000, 0.25) - 880)).toBeLessThanOrEqual(
    READINESS_TOLERANCES.toneFrequencyHz,
  );
  expect(Math.abs(measureRms(left, 48_000, 0.25, 0.5) - Math.SQRT1_2 * 0.5)).toBeLessThanOrEqual(
    READINESS_TOLERANCES.normalizedPcmRmsAbsolute,
  );

  expect(audioStream(join(root, 'readiness-tone-44100.wav')).sample_rate).toBe('44100');
  expect(audioStream(join(root, 'readiness-tone-48000.wav')).sample_rate).toBe('48000');

  const vfr = videoStream(join(root, 'readiness-vfr.mkv'));
  expect(vfr.nb_read_frames).toBe('5');
  const timestamps = JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'json',
      join(root, 'readiness-vfr.mkv'),
    ]).toString('utf8'),
  ) as { frames: Array<{ best_effort_timestamp_time: string }> };
  const deltas = timestamps.frames
    .slice(1)
    .map(
      (frame, index) =>
        Number(frame.best_effort_timestamp_time) -
        Number(timestamps.frames[index]!.best_effort_timestamp_time),
    );
  expect(new Set(deltas.map((delta) => delta.toFixed(3))).size).toBeGreaterThan(1);

  const ntsc = videoStream(join(root, 'readiness-ntsc-30000-1001.mp4'));
  expect(ntsc.avg_frame_rate).toBe('30000/1001');
  expect(ntsc.nb_read_frames).toBe('60');

  const rotation = videoStream(join(root, 'readiness-rotation.mp4'));
  const rotationDegrees = [
    Number(rotation.tags?.rotate),
    ...(rotation.side_data_list ?? []).map((entry) => Number(entry.rotation)),
  ];
  expect(rotationDegrees.some((degrees) => Math.abs(degrees) === 90)).toBe(true);

  const alpha = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    join(root, 'readiness-alpha.png'),
    '-vf',
    'format=rgba,crop=1:1:0:32',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  const transparent = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    join(root, 'readiness-alpha.png'),
    '-vf',
    'format=rgba,crop=1:1:63:32',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ]);
  expect(alpha[3]).toBe(255);
  expect(transparent[3]).toBe(0);

  expect(videoStream(join(root, 'readiness-odd-161x91.mkv'))).toMatchObject({
    codec_name: 'ffv1',
    width: 161,
    height: 91,
    coded_width: 161,
    coded_height: 91,
    pix_fmt: 'yuv444p',
  });
  expect(
    spawnSync('ffprobe', ['-v', 'error', join(root, 'readiness-truncated.mp4')]).status,
  ).not.toBe(0);
  const emptyPath = join(root, 'empty.bin');
  expect(readFileSync(emptyPath)).toHaveLength(0);
  expect(spawnSync('ffprobe', ['-v', 'error', emptyPath]).status).not.toBe(0);
  expect(probe(join(root, 'readiness-mislabeled.jpg')).streams[0]?.codec_type).toBe('audio');
  expect(audioStream(join(root, 'paths with spaces/فارسی 😀 tone.wav')).sample_rate).toBe('48000');
}

describe('generated readiness media semantics', () => {
  let outputRoot: string;

  beforeAll(() => {
    outputRoot = mkdtempSync(join(tmpdir(), 'joy-media-readiness-fixtures-'));
    const source = readFileSync(generatorPath, 'utf8');
    expect(source, 'fixture generator must support a disposable --out-dir').toContain('--out-dir');
    execFileSync(process.execPath, [generatorPath, '--out-dir', outputRoot], {
      cwd: repositoryRoot,
      stdio: 'pipe',
      windowsHide: true,
    });
  }, 120_000);

  afterAll(() => {
    if (outputRoot) rmSync(outputRoot, { recursive: true, force: true });
  });

  it('probes and decodes generated fixtures against independent semantic expectations', () => {
    verifyReadinessFixtures(outputRoot);
  }, 120_000);

  it('rejects deliberately wrong duration and tone in disposable outputs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-readiness-negative-'));
    try {
      const shortVideo = join(directory, 'short.mkv');
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          join(outputRoot, 'readiness-hard-cut.mkv'),
          '-t',
          '1',
          '-c',
          'copy',
          shortVideo,
        ],
        { windowsHide: true },
      );
      expect(() => assertDuration(shortVideo, 2_000_000, 25)).toThrow(/duration differs/u);

      const wrongTone = join(directory, 'wrong-tone.wav');
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:sample_rate=48000:duration=1',
          '-c:a',
          'pcm_s16le',
          wrongTone,
        ],
        { windowsHide: true },
      );
      expect(() =>
        expectTone(channelSamples(audioSamples(wrongTone, 48_000, 1), 1, 0), 48_000, 440),
      ).toThrow(/tone frequency/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
