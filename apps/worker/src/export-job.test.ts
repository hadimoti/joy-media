import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as exportCore from '@joy-media/export-core';
import * as renderPage from '@joy-media/render-host/render-page';
import { createRenderBundle } from '@joy-media/render-planner';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
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
    const video = writeSourceVideo(directory);
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
        }),
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
    expect(pageEvents).toEqual(['destroy']);
    expect(existsSync(join(directory, 'job-1.mp4'))).toBe(true);
    expect(readFileSync(join(directory, 'job-1.mp4')).length).toBe(result.bytes);
    expect(calls).toEqual(['worker-1:job-1']);
  });

  it('rejects truncated renders against the original delivery promise before completing', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-truncated-export-'));
    const video = writeSourceVideo(directory);

    await expect(
      executeLeasedExport(
        { complete: (workerId, jobId) => calls.push(`${workerId}:${jobId}`) },
        'worker-1',
        'job-1',
        renderBundle(),
        {
          outputDirectory: directory,
          mediaResolver: new StaticWorkerMediaResolver({
            'asset:video-a': video,
            'asset:video-b': video,
          }),
          frameLimit: 3,
        },
      ),
    ).rejects.toThrow(/partial frame limit/);
    expect(calls).toEqual([]);
  });

  it('refuses bundles whose required opaque assets are missing from the Worker', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const video = writeSourceVideo(directory);

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
          }),
        },
      ),
    ).rejects.toThrow(/video-b/);
    expect(calls).toEqual([]);
    expect(existsSync(join(directory, 'job-1.mp4'))).toBe(false);
  });

  it('refuses a render-host receipt that did not leave an inspectable artifact', async () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const driverCalls: string[] = [];

    await expect(
      executeLeasedExport(
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
      ),
    ).rejects.toThrow(/artifact/i);

    expect(driverCalls).toEqual(['1:worker-render']);
    expect(calls).toEqual([]);
  });
});

function renderBundle() {
  return createRenderBundle({
    timelineProject: timelineProject(),
    visualProject: visualProject(),
    outputPreset: 'social-h264-aac',
    seed: 'worker-render',
  });
}

function writeSourceVideo(directory: string): string {
  const path = join(directory, 'source-backed.mp4');
  const generated = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x36:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      path,
    ],
    { shell: false, encoding: 'utf8' },
  );
  if (generated.status !== 0) {
    throw new Error(`failed to create source-backed test video: ${generated.stderr}`);
  }
  return path;
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
                sourceInUs: 0,
              },
              {
                kind: 'video',
                id: 'clip-b',
                startUs: SECOND,
                durationUs: SECOND,
                assetId: 'video-b',
                sourceInUs: SECOND,
              },
            ],
          },
        ],
      },
    },
  };
}

function visualProject(): JoyProjectV1 {
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
            id: 'video-track',
            kind: 'video',
            name: 'Video',
            order: 0,
            enabled: true,
            locked: false,
            clips: [
              {
                id: 'clip-a',
                kind: 'video',
                startUs: 0,
                durationUs: SECOND,
                assetId: 'video-a',
                sourceInUs: 0,
              },
              {
                id: 'clip-b',
                kind: 'video',
                startUs: SECOND,
                durationUs: SECOND,
                assetId: 'video-b',
                sourceInUs: SECOND,
              },
            ],
          },
        ],
      },
    },
    assets: {
      'video-a': { id: 'video-a', kind: 'video', displayName: 'Moving timecode' },
      'video-b': { id: 'video-b', kind: 'video', displayName: 'Transition right' },
    },
    variables: {},
    markers: [],
    visualObjects: {},
    captionDocuments: {},
    pluginData: {},
    audio: {
      clips: { 'clip-a': { gain: 0.75, pan: -0.2, mute: false, solo: false } },
      buses: [],
      effects: [],
    },
  };
}
