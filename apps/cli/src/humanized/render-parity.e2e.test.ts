import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ROOT, createSandbox, describeRun, type Sandbox } from './harness.js';
import { expectNdjsonContract, projectDoc, writeSandboxFile } from './render-helpers.js';

const hasFfmpeg = (): boolean => {
  return (
    spawnSync('ffmpeg', ['-version']).status === 0 &&
    spawnSync('ffprobe', ['-version']).status === 0
  );
};

function decodedPcm(path: string): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8'));
  if (result.stdout.length % 4 !== 0) throw new Error('decoded audio has a partial PCM sample');
  const samples = new Float32Array(result.stdout.length / 4);
  for (let index = 0; index < samples.length; index++)
    samples[index] = result.stdout.readFloatLE(index * 4);
  if (samples.some((sample) => !Number.isFinite(sample)))
    throw new Error('decoded audio contains NaN or Inf');
  return samples;
}

function channelRms(
  samples: Float32Array,
  channel: number,
  startSeconds: number,
  durationSeconds: number,
): number {
  const start = Math.floor(startSeconds * 48_000) * 2 + channel;
  const endFrame = Math.min(
    samples.length / 2,
    Math.floor((startSeconds + durationSeconds) * 48_000),
  );
  const end = endFrame * 2 + channel;
  let energy = 0;
  let count = 0;
  for (let index = start; index < end; index += 2) {
    energy += samples[index]! ** 2;
    count++;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

function channelFrequency(samples: Float32Array, channel: number, startSeconds: number): number {
  const startFrame = Math.floor(startSeconds * 48_000);
  const endFrame = Math.min(samples.length / 2, startFrame + 24_000);
  let crossings = 0;
  for (let frame = startFrame + 1; frame < endFrame; frame++) {
    const previous = samples[(frame - 1) * 2 + channel]!;
    const current = samples[frame * 2 + channel]!;
    if (previous <= 0 && current > 0) crossings++;
  }
  return crossings / ((endFrame - startFrame) / 48_000);
}

describe('render parity and unsupported-feature contract', () => {
  let sandbox: Sandbox | undefined;
  const source = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-hard-cut.mkv',
  );
  const stereoSource = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-stereo-tones.wav',
  );
  const silentSource = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-silent.mp4',
  );
  const alphaSource = resolve(
    CLI_ROOT,
    '..',
    '..',
    'packages',
    'test-fixtures',
    'media',
    'readiness-alpha.png',
  );

  beforeAll(() => {
    expect(hasFfmpeg(), 'FFmpeg and FFprobe are required for real render acceptance').toBe(true);
    sandbox = createSandbox('render-parity');
  });
  afterAll(() => sandbox?.cleanup());

  const expectUnsupportedDocument = async (
    id: string,
    document: Record<string, unknown>,
  ): Promise<void> => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);
    const result = await sandbox.run([
      'render',
      '--project',
      projectPath,
      '--out',
      outputDirectory,
      '--json',
    ]);
    expect(result.code, describeRun(result)).toBe(1);
    const events = expectNdjsonContract(result, ['error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unsupported-feature' });
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(existsSync(outputDirectory)).toBe(false);
  };

  it.each([
    ['playback rate', { playbackRate: 2 }],
    ['reverse playback', { reversed: true }],
    ['time remapping', { timeRemap: { keyframes: [{ timeUs: 0, sourceUs: 0 }] } }],
  ] as const)(
    'fails closed for %s and leaves no output or false completion event',
    async (label, feature) => {
      const id = `unsupported-${label.replaceAll(' ', '-')}`;
      const document = projectDoc({
        id,
        tracks: [
          {
            id: 'video-1',
            clips: [
              {
                id: 'unsupported-clip',
                assetId: source,
                durationUs: 1_000_000,
                ...feature,
              },
            ],
          },
        ],
      });
      if (!sandbox) throw new Error('render parity sandbox was not created');
      const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
      const outputDirectory = sandbox.path('output', id);

      const result = await sandbox.run([
        'render',
        '--project',
        projectPath,
        '--out',
        outputDirectory,
        '--json',
      ]);

      expect(result.code, describeRun(result)).toBe(1);
      const events = expectNdjsonContract(result, ['error']);
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unsupported-feature' });
      expect(events.some((event) => event.type === 'complete')).toBe(false);
      expect(events.at(-1)?.['message']).toContain('unsupported-clip');
      expect(existsSync(outputDirectory)).toBe(false);
    },
  );

  it('keeps explicit manifest-only planning available for unsupported timelines', async () => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const id = 'manifest-only-speed';
    const document = projectDoc({
      id,
      tracks: [
        {
          id: 'video-1',
          clips: [
            {
              id: 'unsupported-clip',
              assetId: source,
              durationUs: 1_000_000,
              playbackRate: 2,
            },
          ],
        },
      ],
    });
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);

    const result = await sandbox.run(
      ['render', '--project', projectPath, '--manifest-only', '--out', outputDirectory, '--json'],
      { env: { JOY_MEDIA_FFMPEG: 'missing-ffmpeg-for-manifest-only' } },
    );

    expect(result.code, describeRun(result)).toBe(0);
    const events = expectNdjsonContract(result, ['complete']);
    expect(events.at(-1)).toMatchObject({ type: 'complete', mediaProduced: false });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('matches completion and manifest totals to the decoded gap/overlap timeline', async () => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const id = 'timeline-metadata';
    const document = projectDoc({
      id,
      durationUs: 3_000_000,
      frameRate: { num: 30, den: 1 },
      tracks: [
        {
          id: 'video-1',
          clips: [
            { id: 'opening', assetId: source, durationUs: 1_000_000 },
            {
              id: 'ending',
              assetId: source,
              startUs: 2_000_000,
              sourceInUs: 1_000_000,
              durationUs: 1_000_000,
            },
          ],
        },
        {
          id: 'video-2',
          clips: [{ id: 'overlay', assetId: source, startUs: 500_000, durationUs: 2_000_000 }],
        },
      ],
    });
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);
    const result = await sandbox.run([
      'render',
      '--project',
      projectPath,
      '--out',
      outputDirectory,
      '--json',
    ]);

    expect(result.code, describeRun(result)).toBe(0);
    const events = expectNdjsonContract(result, ['complete']);
    const complete = events.at(-1)!;
    const mediaPath = String(complete['mediaPath']);
    const decoded = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=avg_frame_rate,nb_read_frames',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        mediaPath,
      ],
      { encoding: 'utf8' },
    );
    expect(decoded.status, decoded.stderr).toBe(0);
    const media = JSON.parse(decoded.stdout) as {
      format: { duration: string };
      streams: Array<{ avg_frame_rate: string; nb_read_frames: string }>;
    };
    const manifest = JSON.parse(readFileSync(`${mediaPath}.manifest.json`, 'utf8')) as {
      totalFrames: number;
      composition: { durationUs: number | null };
      media: { durationUs: number; fps: string };
      clips: Array<{ clipId: string; frames: number; frameRange: { first: number; last: number } }>;
    };
    const video = media.streams[0]!;

    expect(complete).toMatchObject({ totalFrames: 90, mediaProduced: true });
    expect(Number(video.nb_read_frames)).toBe(90);
    expect(video.avg_frame_rate).toBe('30/1');
    expect(Math.abs(Number(media.format.duration) - 3)).toBeLessThanOrEqual(1 / 30);
    expect(manifest.totalFrames).toBe(90);
    expect(manifest.composition.durationUs).toBe(3_000_000);
    expect(manifest.media).toMatchObject({ durationUs: 3_000_000, fps: '30/1' });
    expect(manifest.clips).toMatchObject([
      { clipId: 'opening', frames: 30, frameRange: { first: 0, last: 29 } },
      { clipId: 'ending', frames: 30, frameRange: { first: 60, last: 89 } },
      { clipId: 'overlay', frames: 60, frameRange: { first: 15, last: 74 } },
    ]);
  });

  it.each([
    ['gain and pan', { gain: 0.5, pan: -0.5, mute: false, solo: false }],
    ['mute', { gain: 1, pan: 0, mute: true, solo: false }],
    ['solo', { gain: 1, pan: 0, mute: false, solo: true }],
    ['fade', { gain: 1, pan: 0, mute: false, solo: false, fadeInUs: 500_000 }],
  ] as const)(
    'fails closed when an audio clip uses unsupported %s settings',
    async (_label, config) => {
      if (!sandbox) throw new Error('render parity sandbox was not created');
      const id = 'unsupported-audio-settings';
      const document = projectDoc({
        id,
        durationUs: 1_000_000,
        tracks: [
          {
            id: 'audio-1',
            family: 'audio',
            clips: [{ id: 'tone', assetId: stereoSource, durationUs: 1_000_000 }],
          },
        ],
      });
      document['audio'] = { clips: { tone: config }, buses: [], effects: [] };
      const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
      const outputDirectory = sandbox.path('output', id);
      const result = await sandbox.run([
        'render',
        '--project',
        projectPath,
        '--out',
        outputDirectory,
        '--json',
      ]);

      expect(result.code, describeRun(result)).toBe(1);
      const events = expectNdjsonContract(result, ['error']);
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unsupported-feature' });
      expect(events.some((event) => event.type === 'complete')).toBe(false);
      expect(existsSync(outputDirectory)).toBe(false);
    },
  );

  it('preserves audio-only stereo channels and their timeline placement', async () => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const id = 'audio-only-placement';
    const document = projectDoc({
      id,
      width: 320,
      height: 180,
      durationUs: 2_000_000,
      frameRate: { num: 30, den: 1 },
      tracks: [
        {
          id: 'audio-1',
          family: 'audio',
          clips: [
            { id: 'stereo-tone', assetId: stereoSource, startUs: 500_000, durationUs: 1_500_000 },
          ],
        },
      ],
    });
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);
    const result = await sandbox.run([
      'render',
      '--project',
      projectPath,
      '--out',
      outputDirectory,
      '--json',
    ]);

    expect(result.code, describeRun(result)).toBe(0);
    const complete = expectNdjsonContract(result, ['complete']).at(-1)!;
    const samples = decodedPcm(String(complete['mediaPath']));
    expect(channelRms(samples, 0, 0.2, 0.2)).toBeLessThan(0.02);
    expect(channelRms(samples, 1, 0.2, 0.2)).toBeLessThan(0.02);
    expect(channelRms(samples, 0, 0.8, 0.4)).toBeGreaterThan(0.1);
    expect(channelRms(samples, 1, 0.8, 0.4)).toBeGreaterThan(0.1);
    expect(Math.abs(channelFrequency(samples, 0, 0.8) - 440)).toBeLessThanOrEqual(4);
    expect(Math.abs(channelFrequency(samples, 1, 0.8) - 880)).toBeLessThanOrEqual(4);
  });

  it.each([
    [
      'audio bus gain',
      {
        clips: { tone: { gain: 1, pan: 0, mute: false, solo: false } },
        buses: [
          { id: 'master', name: 'Master', gain: 0.5, pan: 0, mute: false, solo: false, inputs: [] },
        ],
        effects: [],
      },
    ],
    [
      'audio effects',
      {
        clips: { tone: { gain: 1, pan: 0, mute: false, solo: false } },
        buses: [],
        effects: [{ id: 'limiter', targetId: 'master', effect: { kind: 'limiter' } }],
      },
    ],
  ] as const)('fails closed for unsupported %s', async (label, audio) => {
    const id = `unsupported-${label.replaceAll(' ', '-')}`;
    const document = projectDoc({
      id,
      tracks: [
        {
          id: 'audio-1',
          family: 'audio',
          clips: [{ id: 'tone', assetId: stereoSource, durationUs: 1_000_000 }],
        },
      ],
    });
    document['audio'] = audio;
    await expectUnsupportedDocument(id, document);
  });

  it('produces silence when a visual source has no audio', async () => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const id = 'no-audio-source';
    const document = projectDoc({
      id,
      width: 320,
      height: 180,
      durationUs: 1_000_000,
      frameRate: { num: 30, den: 1 },
      tracks: [
        {
          id: 'video-1',
          clips: [{ id: 'silent-video', assetId: silentSource, durationUs: 1_000_000 }],
        },
      ],
    });
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);
    const result = await sandbox.run([
      'render',
      '--project',
      projectPath,
      '--out',
      outputDirectory,
      '--json',
    ]);

    expect(result.code, describeRun(result)).toBe(0);
    const complete = expectNdjsonContract(result, ['complete']).at(-1)!;
    const samples = decodedPcm(String(complete['mediaPath']));
    expect(channelRms(samples, 0, 0.1, 0.8)).toBeLessThan(0.001);
    expect(channelRms(samples, 1, 0.1, 0.8)).toBeLessThan(0.001);
  });

  it('fails closed for an alpha-bearing overlay instead of flattening transparency', async () => {
    const id = 'unsupported-alpha-overlay';
    const document = projectDoc({
      id,
      width: 320,
      height: 180,
      durationUs: 1_000_000,
      tracks: [
        { id: 'video-1', clips: [{ id: 'background', assetId: source, durationUs: 1_000_000 }] },
        {
          id: 'video-2',
          clips: [{ id: 'transparent-overlay', assetId: alphaSource, durationUs: 1_000_000 }],
        },
      ],
    });
    await expectUnsupportedDocument(id, document);
  });

  it.each([
    [
      'visual transforms and effects',
      (document: Record<string, unknown>) => {
        document['visualObjects'] = {
          title: {
            id: 'title',
            kind: 'text',
            text: 'سلام',
            transform: {
              x: 0,
              y: 0,
              scaleX: 1,
              scaleY: 1,
              rotationDeg: 0,
              opacity: 1,
              crop: { left: 0, top: 0, right: 0, bottom: 0 },
            },
            effects: [{ id: 'blur', effectId: 'blur', enabled: true, params: { radius: 8 } }],
          },
        };
      },
    ],
    [
      'Persian captions',
      (document: Record<string, unknown>) => {
        document['captionDocuments'] = {
          subtitles: {
            id: 'subtitles',
            language: 'fa',
            direction: 'rtl',
            speakers: [],
            words: { hello: { id: 'hello', text: 'سلام', startUs: 0, endUs: 500_000 } },
            segments: [{ id: 'line', startUs: 0, endUs: 500_000, wordIds: ['hello'] }],
          },
        };
      },
    ],
    [
      'transitions',
      (document: Record<string, unknown>) => {
        const compositions = document['compositions'] as Record<string, Record<string, unknown>>;
        const root = compositions['root']!;
        const tracks = root['tracks'] as Array<Record<string, unknown>>;
        const clips = tracks[0]!['clips'] as Array<Record<string, unknown>>;
        clips[0] = { ...clips[0], id: 'left', startUs: 0, durationUs: 1_000_000 };
        clips.push({ ...clips[0], id: 'right', startUs: 1_000_000, durationUs: 1_000_000 });
        root['durationUs'] = 2_000_000;
        document['transitions'] = [
          {
            id: 'dissolve',
            trackId: 'video-1',
            leftClipId: 'left',
            rightClipId: 'right',
            type: 'dissolve',
            durationUs: 200_000,
          },
        ];
      },
    ],
    [
      'nested compositions',
      (document: Record<string, unknown>) => {
        const compositions = document['compositions'] as Record<string, Record<string, unknown>>;
        const root = compositions['root']!;
        const tracks = root['tracks'] as Array<Record<string, unknown>>;
        const clips = tracks[0]!['clips'] as Array<Record<string, unknown>>;
        clips[0] = {
          id: 'nested-scene',
          kind: 'composition',
          startUs: 0,
          durationUs: 1_000_000,
          compositionId: 'child',
          childOffsetUs: 0,
        };
        compositions['child'] = {
          id: 'child',
          name: 'Nested scene',
          width: 320,
          height: 180,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#000000',
          tracks: [],
        };
      },
    ],
    [
      'color grades',
      (document: Record<string, unknown>) => {
        document['colorGrade'] = { lift: 0, gamma: 1.1, gain: 1, saturation: 1, lutId: 'none' };
      },
    ],
  ] as const)('fails closed for %s instead of rendering partial media', async (label, mutate) => {
    const id = `unsupported-${label.replaceAll(' ', '-')}`;
    const document = projectDoc({
      id,
      tracks: [
        {
          id: 'video-1',
          clips: [{ id: 'source', assetId: source, durationUs: 1_000_000 }],
        },
      ],
    });
    mutate(document);
    await expectUnsupportedDocument(id, document);
  });
});
