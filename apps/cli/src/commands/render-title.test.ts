import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeRgbaPng } from '../services/title-frames.js';
import { isPreviewTimeInRange, previewFrameIndex } from './render-cmd.js';
import { buildFfmpegArgs, startEncode, type MediaPlanReady } from './render-media.js';
import { hasUsableChromium } from './render-features.js';
import { normalizeUniversalTimeline } from '@joy-media/project-schema';

const emptyPlan: MediaPlanReady = {
  mode: 'media',
  clips: [],
  captions: [],
  fontFile: null,
  width: 320,
  height: 240,
  fps: '30/1',
  durationUs: 2_000_000,
  warnings: [],
};

describe('title composition rendering', () => {
  it('keeps the no-title ffmpeg argument golden unchanged', () => {
    expect(buildFfmpegArgs(emptyPlan, 'mp4', 'out.mp4')).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-progress',
      'pipe:1',
      '-nostats',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      '-filter_complex',
      'color=c=black:s=320x240:r=30/1:d=2.000000,format=yuv420p[b0];anullsrc=r=48000:cl=stereo,atrim=0:2.000000[aout]',
      '-map',
      '[b0]',
      '-map',
      '[aout]',
      '-t',
      '2.000000',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-x264-params',
      'threads=1:lookahead-threads=1:sync-lookahead=0:sliced-threads=0:cpu-independent=1',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      'out.mp4',
    ]);
  });

  it('adds a title image input and an RGBA overlay limited to the clip window', () => {
    const args = buildFfmpegArgs(emptyPlan, 'mp4', 'out.mp4', [
      {
        instanceId: 'speaker',
        inputPattern: 'frames/title-speaker-%05d.png',
        startUs: 500_000,
        durationUs: 1_000_000,
      },
    ]);
    expect(args).toContain('-framerate');
    expect(args).toContain('30/1');
    expect(args).toContain('frames/title-speaker-%05d.png');
    expect(args.join(' ')).toContain('[0:v]setpts=PTS+0.500000/TB,format=rgba[title0]');
    expect(args.join(' ')).toContain("enable='gte(t,0.500000)*lt(t,1.500000)'");
  });

  it('composes title and media overlays in track order', () => {
    const mediaPlan: MediaPlanReady = {
      ...emptyPlan,
      clips: [0, 2].map((trackOrder, index) => ({
        clipId: `clip-${index}`,
        trackId: `track-${trackOrder}`,
        trackOrder,
        startUs: 0,
        durationUs: 2_000_000,
        sourceInUs: 0,
        assetId: `asset-${index}`,
        sourcePath: `input-${index}.mp4`,
        info: {
          hasVideo: true,
          hasAudio: false,
          hasAlpha: false,
          isImage: false,
          durationUs: 2_000_000,
          width: 320,
          height: 240,
          mimeType: 'video/mp4',
        },
        visual: true,
        audio: false,
        audioSettings: { gain: 1, mute: false, fadeInUs: 0, fadeOutUs: 0 },
        transitionInUs: 0,
        transitionOutUs: 0,
      })),
    };
    const graph = buildFfmpegArgs(mediaPlan, 'mp4', 'out.mp4', [
      {
        instanceId: 'middle-title',
        inputPattern: 'title-%05d.png',
        startUs: 0,
        durationUs: 2_000_000,
        trackOrder: 1,
      },
    ]).join(' ');
    expect(graph.indexOf('[b0][v0]')).toBeLessThan(graph.indexOf('[b1][title0]'));
    expect(graph.indexOf('[b1][title0]')).toBeLessThan(graph.indexOf('[b2][v1]'));
  });

  it('stacks overlapping title and media layers by normalized track order', () => {
    const project = {
      schemaVersion: 1,
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          tracks: ['top', 'bottom', 'middle'].map((id, index) => ({
            id,
            kind: 'video',
            order: index,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: `clip-${id}`,
                assetId: `asset-${id}`,
                startUs: 0,
                durationUs: 2_000_000,
              },
            ],
          })),
        },
      },
      assets: Object.fromEntries(
        ['top', 'bottom', 'middle'].map((id) => [
          `asset-${id}`,
          { id: `asset-${id}`, kind: 'video', displayName: id },
        ]),
      ),
      timelineTrackDeck: {
        rows: [
          { compositionId: 'root', trackId: 'bottom', order: 0, enabled: true, locked: false },
          { compositionId: 'root', trackId: 'middle', order: 1, enabled: true, locked: false },
          { compositionId: 'root', trackId: 'top', order: 2, enabled: true, locked: false },
        ],
      },
      pluginData: {},
    } as never;
    const items = normalizeUniversalTimeline(project).items;
    const mediaTracks = ['bottom', 'top'];
    const clips = mediaTracks.map((trackId, index) => ({
      clipId: `clip-${trackId}`,
      trackId,
      trackOrder: items.find((item) => item.trackId === trackId)!.trackOrder,
      startUs: 0,
      durationUs: 2_000_000,
      sourceInUs: 0,
      assetId: `asset-${trackId}`,
      sourcePath: `input-${index}.mp4`,
      info: {
        hasVideo: true,
        hasAudio: false,
        hasAlpha: false,
        isImage: false,
        durationUs: 2_000_000,
        width: 320,
        height: 240,
        mimeType: 'video/mp4',
      },
      visual: true,
      audio: false,
      audioSettings: { gain: 1, mute: false, fadeInUs: 0, fadeOutUs: 0 },
      transitionInUs: 0,
      transitionOutUs: 0,
    }));
    const middleTrackOrder = items.find((item) => item.trackId === 'middle')!.trackOrder;
    const graph = buildFfmpegArgs({ ...emptyPlan, clips }, 'mp4', 'out.mp4', [
      {
        instanceId: 'middle-title',
        inputPattern: 'title-%05d.png',
        startUs: 0,
        durationUs: 2_000_000,
        trackOrder: middleTrackOrder,
      },
    ]).join(' ');

    expect(graph.indexOf('[b0][v0]')).toBeLessThan(graph.indexOf('[b1][title0]'));
    expect(graph.indexOf('[b1][title0]')).toBeLessThan(graph.indexOf('[b2][v1]'));
  });

  it('does not advertise Chromium when discovery returns undefined', () => {
    const readVersion = (path: string): string => `Chromium ${path}`;
    expect(hasUsableChromium(undefined, readVersion)).toBe(false);
    expect(hasUsableChromium('browser.exe', readVersion)).toBe(true);
    expect(() =>
      hasUsableChromium('bad.exe', () => {
        throw new Error('launch failed');
      }),
    ).toThrow('launch failed');
  });

  it('removes explicitly owned ASS directories even when Windows filter paths are escaped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-caption-ass-win-'));
    writeFileSync(join(directory, 'owned.txt'), 'owned');
    const windowsFilterPath = `C:/${directory.replace(/\\/g, '/')}`.replace(/^([A-Z]):/, '$1\\:');
    expect(windowsFilterPath).toContain('\\:');
    const handle = startEncode(
      ['-filter_complex', `ass=filename=${windowsFilterPath}`],
      1,
      () => {},
      [directory],
    );
    await handle.done;
    expect(existsSync(directory)).toBe(false);
  });

  it('uses integer arithmetic for the 2.5 second preview index at 30 fps', () => {
    expect(previewFrameIndex(2_500_000, { num: 30, den: 1 })).toBe(75);
  });

  it('refuses a preview time past the composition duration', () => {
    expect(isPreviewTimeInRange(2_000_000, 2_000_000)).toBe(false);
    expect(isPreviewTimeInRange(2_500_000, 2_000_000)).toBe(false);
    expect(isPreviewTimeInRange(1_999_999, 2_000_000)).toBe(true);
  });
});

const ffmpeg = process.env.JOY_MEDIA_FFMPEG?.trim() || 'ffmpeg';
const ffmpegProbe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
const ffmpegAvailable = ffmpegProbe.status === 0;
if (!ffmpegAvailable && process.env.JOY_REQUIRE_FFMPEG === '1') {
  throw new Error('JOY_REQUIRE_FFMPEG=1 but ffmpeg is not available on PATH.');
}

describe('real ffmpeg title pixels', () => {
  const directory = ffmpegAvailable ? mkdtempSync(join(tmpdir(), 'joy-render-title-')) : '';
  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.skipIf(!ffmpegAvailable)('changes the title region and preserves pixels outside it', () => {
    const source = join(directory, 'testsrc.mp4');
    const withoutTitle = join(directory, 'without-title.mp4');
    const withTitle = join(directory, 'with-title.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '0',
      source,
    ]);
    const mediaPlan: MediaPlanReady = {
      ...emptyPlan,
      clips: [
        {
          clipId: 'video-1',
          trackId: 'track-1',
          startUs: 0,
          durationUs: 2_000_000,
          sourceInUs: 0,
          assetId: source,
          sourcePath: source,
          info: {
            hasVideo: true,
            hasAudio: false,
            hasAlpha: false,
            isImage: false,
            durationUs: 2_000_000,
            width: 320,
            height: 240,
            mimeType: 'video/mp4',
          },
          visual: true,
          audio: false,
          audioSettings: { gain: 1, mute: false, fadeInUs: 0, fadeOutUs: 0 },
          transitionInUs: 0,
          transitionOutUs: 0,
        },
      ],
    };
    const rgba = new Uint8Array(320 * 240 * 4);
    for (let y = 40; y < 100; y++)
      for (let x = 40; x < 160; x++) {
        const at = (y * 320 + x) * 4;
        rgba[at] = 255;
        rgba[at + 1] = 255;
        rgba[at + 2] = 255;
        rgba[at + 3] = 255;
      }
    const pattern = join(directory, 'title-speaker-%05d.png');
    for (let frame = 0; frame < 60; frame++) {
      writeFileSync(
        pattern.replace('%05d', String(frame).padStart(5, '0')),
        encodeRgbaPng(320, 240, rgba),
      );
    }
    const noTitleLossless = buildFfmpegArgs(mediaPlan, 'mp4', withoutTitle);
    noTitleLossless[noTitleLossless.indexOf('20')] = '0';
    const titleLossless = buildFfmpegArgs(mediaPlan, 'mp4', withTitle, [
      {
        instanceId: 'speaker',
        inputPattern: pattern,
        startUs: 0,
        durationUs: 2_000_000,
      },
    ]);
    titleLossless[titleLossless.indexOf('20')] = '0';
    execFileSync(ffmpeg, noTitleLossless, { windowsHide: true });
    execFileSync(ffmpeg, titleLossless, { windowsHide: true });
    const decode = (path: string): Buffer =>
      execFileSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        path,
        '-ss',
        '1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ]);
    const plain = decode(withoutTitle);
    const titled = decode(withTitle);
    const center = (50 * 320 + 50) * 4;
    expect([...titled.subarray(center, center + 3)]).not.toEqual([
      ...plain.subarray(center, center + 3),
    ]);
    for (let y = 0; y < 240; y++)
      for (let x = 0; x < 320; x++) {
        if (x >= 40 && x < 160 && y >= 40 && y < 100) continue;
        const at = (y * 320 + x) * 4;
        expect(titled.subarray(at, at + 4)).toEqual(plain.subarray(at, at + 4));
      }
  });
});
