import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as exportCore from '@joy-media/export-core';
import * as renderPage from '@joy-media/render-host/render-page';
import { CAPTION_BURN_IN_KEY, createRenderBundle } from '@joy-media/render-planner';
import type {
  JoyProjectV1,
  SpikeProject,
  VisualObjectTransformV1,
} from '@joy-media/project-schema';
import { executeLeasedExport } from './export-job.js';
import { StaticWorkerMediaResolver } from './worker-media-resolver.js';

const SECOND = 1_000_000;

describe('leased export job', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a real bundle through the render host without calling the fixture helper', async () => {
    const calls: string[] = [];
    const pageEvents: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const video = join(directory, 'timecode-tone.mp4');
    const image = join(directory, 'sticker.png');
    writeFileSync(video, 'worker-private-video');
    writeFileSync(image, 'worker-private-sticker');
    const fixtureSpy = vi.spyOn(exportCore, 'renderFixture');
    const pageSpy = vi.spyOn(renderPage, 'createOfflineRenderPage').mockResolvedValue({
      paint(input) {
        pageEvents.push(`paint:${input.plan.frame.timeUs}`);
        return new Uint8Array(
          input.plan.frame.viewport.width * input.plan.frame.viewport.height * 4,
        ).fill(0x20);
      },
      destroy() {
        pageEvents.push('destroy');
      },
    });

    const result = await executeLeasedExport(
      { complete: (workerId, jobId) => calls.push(`${workerId}:${jobId}`) },
      'worker-1',
      'job-1',
      renderBundle(),
      {
        outputDirectory: directory,
        mediaResolver: new StaticWorkerMediaResolver({
          'asset:video-a': video,
          'asset:video-b': video,
          'asset:image-a': image,
          'html-scene:joy.firstparty.title': 'joy.firstparty.title',
        }),
        frameLimit: 3,
      },
    );

    expect(result).toMatchObject({
      kind: 'render.export',
      reportRef: 'report-job-1',
      videoCodec: 'h264',
      audioCodec: 'aac',
      bytes: expect.any(Number),
      manifest: expect.objectContaining({ projectId: 'visual', preset: 'social-h264-aac' }),
      toolVersions: expect.objectContaining({ renderHost: expect.any(String) }),
      qualityReport: expect.objectContaining({
        artifact: expect.objectContaining({ outputRef: expect.stringMatching(/^render-job-1-/) }),
      }),
    });
    expect(result.qualityReport.findings.filter((finding) => finding.status === 'fail')).toEqual(
      [],
    );
    expect(result.outputRef).toMatch(/^render-job-1-[a-f0-9]{16}$/);
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]|file:|\/tmp\//);
    expect(fixtureSpy).not.toHaveBeenCalled();
    expect(pageSpy).toHaveBeenCalled();
    expect(pageEvents).toEqual(['paint:0', 'paint:33333', 'paint:66666', 'destroy']);
    expect(calls).toEqual(['worker-1:job-1']);
  });

  it('refuses bundles whose required opaque assets are missing from the Worker', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const video = join(directory, 'timecode-tone.mp4');
    writeFileSync(video, 'worker-private-video');

    await expect(
      executeLeasedExport(
        { complete: (_workerId, jobId) => calls.push(jobId) },
        'worker-1',
        'job-1',
        renderBundle(),
        {
          outputDirectory: directory,
          mediaResolver: new StaticWorkerMediaResolver({
            'asset:video-a': video,
            'asset:video-b': video,
            'html-scene:joy.firstparty.title': 'joy.firstparty.title',
          }),
        },
      ),
    ).rejects.toThrow(/image-a/);
    expect(calls).toEqual([]);
    expect(existsSync(join(directory, 'job-1.mp4'))).toBe(false);
  });

  it('drives export through the render-host driver protocol', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const driverCalls: string[] = [];

    const result = await executeLeasedExport(
      { complete: (workerId, jobId) => calls.push(`${workerId}:${jobId}`) },
      'worker-1',
      'job-1',
      renderBundle(),
      {
        outputDirectory: directory,
        mediaResolver: new StaticWorkerMediaResolver({}),
        renderHostDriver: {
          export: async (request) => {
            driverCalls.push(`${request.protocolVersion}:${request.bundle.seed}`);
            return {
              manifest: {
                projectId: 'visual',
                revision: 0,
                width: 64,
                height: 36,
                frameRate: 30,
                durationUs: 100_000,
                preset: 'social-h264-aac',
              },
              frames: 3,
              videoCodec: 'h264',
              audioCodec: 'aac',
              width: 64,
              height: 36,
              sha256: 'a'.repeat(64),
              bytes: 1234,
              toolVersions: {
                renderHost: 'test-driver',
                ffmpeg: 'test-ffmpeg',
                ffprobe: 'test-ffprobe',
              },
            };
          },
        },
      },
    );

    expect(driverCalls).toEqual(['1:worker-render']);
    expect(result).toMatchObject({
      reportRef: 'report-job-1',
      outputRef: 'render-job-1-aaaaaaaaaaaaaaaa',
      qualityReport: expect.objectContaining({
        artifact: expect.objectContaining({ outputRef: 'render-job-1-aaaaaaaaaaaaaaaa' }),
      }),
    });
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]|file:|\/tmp\//);
    expect(calls).toEqual(['worker-1:job-1']);
  });
});

function renderBundle() {
  return createRenderBundle({
    timelineProject: timelineProject(),
    visualProject: visualProject({ transition: true }),
    outputPreset: 'social-h264-aac',
    seed: 'worker-render',
  });
}

function timelineProject(): SpikeProject {
  return {
    schemaVersion: 0,
    id: 'timeline',
    rootCompositionId: 'root',
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        tracks: [
          {
            id: 'track-1',
            kind: 'video',
            order: 0,
            enabled: true,
            clips: [
              {
                kind: 'video',
                id: 'clip-a',
                startUs: 0,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: SECOND,
                durationUs: SECOND,
                assetId: 'video-b',
                sourceInUs: 10 * SECOND,
              },
            ],
          },
        ],
      },
    },
  };
}

function visualProject(options: { readonly transition?: boolean } = {}): JoyProjectV1 {
  return {
    schemaVersion: 1,
    id: 'visual',
    title: 'Visual',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    rootCompositionId: 'root',
    settings: { defaultLocale: 'en' },
    compositions: {
      root: {
        id: 'root',
        name: 'Root',
        width: 64,
        height: 36,
        pixelAspectRatio: { num: 1, den: 1 },
        frameRate: { num: 30, den: 1 },
        durationUs: 2 * SECOND,
        background: '#000000',
        tracks: [
          {
            id: 'caption-track',
            kind: 'caption',
            name: 'Captions',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'caption-1',
                kind: 'caption',
                startUs: 250_000,
                durationUs: SECOND,
                captionDocumentId: 'doc-1',
              },
            ],
          },
          {
            id: 'video-track',
            kind: 'video',
            name: 'Video',
            order: 1,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-a',
                kind: 'video',
                startUs: 0,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 5 * SECOND,
              },
              {
                id: 'clip-b',
                kind: 'video',
                startUs: SECOND,
                durationUs: SECOND,
                assetId: 'video-b',
                sourceInUs: 10 * SECOND,
              },
            ],
          },
        ],
      },
    },
    assets: {
      'video-a': { id: 'video-a', kind: 'video', displayName: 'Moving timecode' },
      'video-b': { id: 'video-b', kind: 'video', displayName: 'Transition right' },
      'image-a': { id: 'image-a', kind: 'image', displayName: 'Sticker' },
    },
    variables: {},
    markers: [],
    visualObjects: {
      title: {
        id: 'title',
        kind: 'text',
        text: 'JOY',
        transform: transform(4, 4),
        effects: [
          { id: 'effect-noise', effectId: 'noise', enabled: true, params: { amount: 0.1 } },
        ],
      },
      sticker: {
        id: 'sticker',
        kind: 'image',
        assetId: 'image-a',
        transform: transform(20, 12),
        animations: {
          x: {
            keyframes: [
              { timeUs: 0, value: 20, interpolation: 'linear' },
              { timeUs: SECOND, value: 28, interpolation: 'linear' },
            ],
          },
        },
      },
      scene: {
        id: 'scene',
        kind: 'html-scene',
        scenePackageId: 'joy.firstparty.title',
        transform: transform(0, 0),
      },
    },
    captionDocuments: {
      'doc-1': {
        id: 'doc-1',
        language: 'en',
        direction: 'ltr',
        speakers: [],
        words: { w1: { id: 'w1', text: 'Caption', startUs: 0, endUs: SECOND } },
        segments: [{ id: 's1', startUs: 0, endUs: SECOND, wordIds: ['w1'] }],
      },
    },
    pluginData: { [CAPTION_BURN_IN_KEY]: true },
    audio: {
      clips: { 'clip-a': { gain: 0.75, pan: -0.2, mute: false, solo: false } },
      buses: [],
      effects: [],
    },
    ...(options.transition
      ? {
          transitions: [
            {
              id: 'transition-1',
              trackId: 'video-track',
              type: 'dissolve',
              leftClipId: 'clip-a',
              rightClipId: 'clip-b',
              durationUs: 500_000,
              params: {},
            },
          ],
        }
      : {}),
  };
}

function transform(x: number, y: number): VisualObjectTransformV1 {
  return {
    x,
    y,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}
