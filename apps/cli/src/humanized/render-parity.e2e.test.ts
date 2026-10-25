import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { probeCanonicalCaptionFace } from '../commands/render-features.js';
import {
  freezeRenderPreparation,
  type RenderPreparationFacts,
} from '../services/render-preparation.js';
import {
  loadNotoSansArabicFaces,
  missingCanonicalFontCodePoints,
} from '@joy-media/html-scene-runtime';
import { CLI_ROOT, createSandbox, describeRun, type Sandbox } from './harness.js';
import { expectNdjsonContract, projectDoc, writeSandboxFile } from './render-helpers.js';

// Real CLI child processes get their own 60s hang guard. Let that guard return a
// structured failure before Vitest's outer timeout, even during the full suite's
// CPU-heavy fixture render tests.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const hasFfmpeg = (): boolean => {
  return (
    spawnSync('ffmpeg', ['-version']).status === 0 &&
    spawnSync('ffprobe', ['-version']).status === 0
  );
};

function captionBandDifferencePixels(withCaptions: string, withoutCaptions: string): number {
  const band = (path: string): Buffer => {
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        '0.5',
        '-i',
        path,
        '-vf',
        'crop=iw:ih/5:0:ih*4/5',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    if (decoded.status !== 0) throw new Error(decoded.stderr.toString('utf8'));
    return Buffer.from(decoded.stdout);
  };
  const caption = band(withCaptions);
  const baseline = band(withoutCaptions);
  if (caption.length !== baseline.length || caption.length % 3 !== 0)
    throw new Error('Caption and baseline band decodes have incompatible dimensions.');
  let changed = 0;
  for (let index = 0; index < caption.length; index += 3) {
    if (
      Math.max(
        Math.abs(caption[index]! - baseline[index]!),
        Math.abs(caption[index + 1]! - baseline[index + 1]!),
        Math.abs(caption[index + 2]! - baseline[index + 2]!),
      ) > 12
    )
      changed++;
  }
  return changed;
}

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

  it('refuses a Persian title line with a real uncovered canonical-font glyph', () => {
    const titleLine = 'عنوان 🚀';
    const rocket = 0x1f680;
    const latinBoldFace = loadNotoSansArabicFaces().find(
      (face) => face.subset === 'latin' && face.weight === 700,
    );
    expect(
      latinBoldFace,
      'canonical Latin 700 face is part of the bundled font fixture',
    ).toBeDefined();
    expect(missingCanonicalFontCodePoints(latinBoldFace!, titleLine)).toContain(rocket);

    // A title is checked only while its clip is on an enabled video track, so the fixture places it there.
    const document = projectDoc({
      id: 'persian-title-uncovered-glyph',
      tracks: [{ id: 'title-track', clips: [{ id: 'title-clip', durationUs: 2_000_000 }] }],
    }) as {
      pluginData: Record<string, unknown>;
    };
    document.pluginData['joy.contentTemplates'] = {
      version: 1,
      instances: {
        title: {
          clipId: 'title-clip',
          font: { weight: 700 },
          lines: { primary: titleLine, secondary: '' },
        },
      },
    };
    const facts: RenderPreparationFacts = {
      libassProbe: {
        usable: true,
        executablePath: 'ffmpeg',
        canonicalFace: 'Noto Sans Arabic Arabic 400',
        log: '',
      },
      libassAvailable: true,
      canonicalFaces: loadNotoSansArabicFaces(),
      chromium: {
        launchable: true,
        executablePath: 'fixture-chromium',
        executableSha256: 'sha256:fixture-chromium',
        version: 'Chromium fixture',
      },
      ffmpeg: {
        executablePath: 'ffmpeg',
        executableSha256: 'sha256:fixture-ffmpeg',
        version: 'ffmpeg fixture',
        buildConfiguration: '--enable-libass',
        requiredFilters: ['ass', 'subtitles'],
        libassVersion: 'fixture-libass',
        shaperVersion: 'fixture-harfbuzz',
      },
    };
    let refusal: unknown;
    try {
      freezeRenderPreparation(document as never, [{ op: 'instantiateTemplate' }], facts);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'FONT_UNSUPPORTED_GLYPH' });
  });

  it('changes the caption band when Persian captions render and refuses when the canonical face is unavailable', async () => {
    if (!sandbox) throw new Error('render parity sandbox was not created');
    const id = 'persian-caption-face-contract';
    const document: Record<string, unknown> = projectDoc({
      id,
      durationUs: 1_000_000,
      frameRate: { num: 30, den: 1 },
      tracks: [
        { id: 'video-1', clips: [{ id: 'picture', assetId: source, durationUs: 1_000_000 }] },
      ],
    });
    const compositions = document['compositions'] as Record<string, Record<string, unknown>>;
    const tracks = compositions['root']!['tracks'] as Array<Record<string, unknown>>;
    tracks.push({
      id: 'caption-1',
      kind: 'caption',
      family: 'caption',
      name: 'Persian captions',
      order: 1,
      enabled: true,
      locked: false,
      clips: [
        {
          id: 'persian-line',
          kind: 'caption',
          startUs: 0,
          durationUs: 1_000_000,
          captionDocumentId: 'persian-subtitles',
        },
      ],
    });
    document['captionDocuments'] = {
      'persian-subtitles': {
        id: 'persian-subtitles',
        language: 'fa',
        direction: 'rtl',
        speakers: [],
        words: { greeting: { id: 'greeting', text: 'سلام دنیا', startUs: 0, endUs: 1_000_000 } },
        segments: [{ id: 'greeting-line', startUs: 0, endUs: 1_000_000, wordIds: ['greeting'] }],
      },
    };
    const projectPath = writeSandboxFile(sandbox, `${id}.json`, document);
    const outputDirectory = sandbox.path('output', id);
    const operationsPath = writeSandboxFile(sandbox, `${id}-operations.json`, {
      schemaVersion: 1,
      operations: [],
    });
    const planPath = sandbox.path(`${id}-plan.json`);
    const faceProbe = probeCanonicalCaptionFace();
    // JOY_MEDIA_REQUIRE_CAPTION_FACE=1 makes the refusal below a failure, because it passes without
    // rendering a caption. Set it only where the canonical face loads. The Windows release lifecycle does
    // not set it: no available FFmpeg build can open the WOFF2 face, and the owner accepted that refusal
    // on 2026-10-20. Without it the refusal below is asserted, never skipped.
    if (!faceProbe.usable && process.env['JOY_MEDIA_REQUIRE_CAPTION_FACE'] === '1') {
      throw new Error(
        'the canonical caption face is unavailable, so the release gate cannot accept a caption refusal in place of a rendered caption',
      );
    }
    const preparation = await sandbox.run([
      'plan',
      'prepare',
      operationsPath,
      '--project',
      projectPath,
      '--output',
      planPath,
      '--json',
    ]);
    if (!faceProbe.usable) {
      expect(preparation.code, describeRun(preparation)).toBe(1);
      const refusal = expectNdjsonContract(preparation, ['error']).at(-1);
      expect(refusal).toMatchObject({ type: 'error', code: 'SETUP_REQUIRED' });
      const refusalMessage = String(refusal?.['message']);
      expect(JSON.parse(refusalMessage.slice(refusalMessage.indexOf('{')))).toMatchObject({
        kind: 'canonical-caption-face-unavailable',
      });
      expect(existsSync(planPath)).toBe(false);
      expect(existsSync(outputDirectory)).toBe(false);
      return;
    }

    expect(preparation.code, describeRun(preparation)).toBe(0);
    expect(existsSync(planPath)).toBe(true);
    expect(preparation.json()).toMatchObject({ schemaVersion: 1, projectId: id });
    const preparedPlan = JSON.parse(readFileSync(planPath, 'utf8')) as {
      baseRevision: number;
    };
    const applied = await sandbox.run([
      'plan',
      'apply',
      planPath,
      '--project',
      projectPath,
      '--expected-revision',
      String(preparedPlan.baseRevision),
      '--idempotency-key',
      `${id}-apply`,
      '--json',
    ]);
    expect(applied.code, describeRun(applied)).toBe(0);
    expect(applied.json()).toMatchObject({
      schemaVersion: 1,
      idempotencyKey: `${id}-apply`,
      baseRevision: preparedPlan.baseRevision,
      revision: preparedPlan.baseRevision + 1,
      replayed: false,
    });
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
    expect(complete).toMatchObject({ type: 'complete', mediaProduced: true });
    const mediaPath = String(complete['mediaPath']);
    expect(existsSync(mediaPath)).toBe(true);
    expect(readFileSync(mediaPath).byteLength).toBeGreaterThan(0);
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mediaPath],
      { encoding: 'utf8' },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const media = JSON.parse(probe.stdout) as {
      streams: Array<{ codec_type: string }>;
      format: { duration: string };
    };
    expect(media.streams.some((stream) => stream.codec_type === 'video')).toBe(true);
    expect(Number(media.format.duration)).toBeCloseTo(1, 2);

    const baselineId = `${id}-without-captions`;
    const baselineDocument = projectDoc({
      id: baselineId,
      width: 1080,
      height: 1920,
      durationUs: 1_000_000,
      frameRate: { num: 30, den: 1 },
      tracks: [
        { id: 'video-1', clips: [{ id: 'picture', assetId: source, durationUs: 1_000_000 }] },
      ],
    });
    const baselineProjectPath = writeSandboxFile(sandbox, `${baselineId}.json`, baselineDocument);
    const baselineOutputDirectory = sandbox.path('output', baselineId);
    const baselineResult = await sandbox.run([
      'render',
      '--project',
      baselineProjectPath,
      '--out',
      baselineOutputDirectory,
      '--json',
    ]);
    expect(baselineResult.code, describeRun(baselineResult)).toBe(0);
    const baselineComplete = expectNdjsonContract(baselineResult, ['complete']).at(-1)!;
    const baselineMediaPath = String(baselineComplete['mediaPath']);
    expect(existsSync(baselineMediaPath)).toBe(true);
    const captionBandPixels = 1080 * (1920 / 5);
    const minimumPersianInkPixels = Math.ceil(captionBandPixels * 0.0001);
    expect(
      captionBandDifferencePixels(mediaPath, baselineMediaPath),
      `caption band change detection must exceed ${minimumPersianInkPixels} pixels (0.01% of the lower fifth band)`,
    ).toBeGreaterThan(minimumPersianInkPixels);
  });

  // Gain, mute and fades are rendered now (timeline-audio.e2e.test.ts checks the decoded sound).
  // Pan, solo and out-of-range gain still fail closed.
  it.each([
    ['pan', { gain: 1, pan: -0.5, mute: false, solo: false }],
    ['solo', { gain: 1, pan: 0, mute: false, solo: true }],
    ['gain above 4', { gain: 9, pan: 0, mute: false, solo: false }],
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
