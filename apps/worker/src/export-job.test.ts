import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderFixture } from '@joy-media/export-core';
import { executeLeasedExport, exportJobPayload } from './export-job.js';
describe('leased export job', () => {
  it('verifies output before completing the lease', () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'out.mp4');
    const manifest = {
      projectId: 'p',
      revision: 1,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'reels-1080' as const,
    };
    renderFixture(manifest, source);
    const result = executeLeasedExport(
      { complete: (workerId, jobId) => calls.push(`${workerId}:${jobId}`) },
      'worker-1',
      'job-1',
      {
        sourcePath: source,
        payload: {
          schemaVersion: 1,
          frameCount: 3,
          producer: 'browser-staged-preview-export',
          manifest,
        },
      },
      output,
    );
    expect(result).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(calls).toEqual(['worker-1:job-1']);
  });
  it('does not complete a lease and removes output when rendering fails', () => {
    const calls: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-leased-export-'));
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'out.mp4');
    renderFixture(
      {
        projectId: 'p',
        revision: 1,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'reels-1080',
      },
      source,
    );
    expect(() =>
      executeLeasedExport(
        { complete: (_workerId, jobId) => calls.push(jobId) },
        'worker-1',
        'job-1',
        {
          sourcePath: source,
          payload: {
            schemaVersion: 1,
            frameCount: 3,
            producer: 'browser-staged-preview-export',
            manifest: {
              projectId: 'p',
              revision: 1,
              width: 0,
              height: 36,
              frameRate: 30,
              durationUs: 100_000,
              preset: 'reels-1080',
            },
          },
        },
        output,
      ),
    ).toThrow(/manifest|dimensions|duration|frame rate/i);
    expect(calls).toEqual([]);
    expect(existsSync(output)).toBe(false);
  });
  it('rejects malformed or cadence-mismatched Worker payloads before FFmpeg', () => {
    const manifest = {
      projectId: 'p',
      revision: 1,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'reels-1080' as const,
    };
    expect(() =>
      exportJobPayload({
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 2,
        manifest,
      }),
    ).toThrow(/frameCount/);
    expect(() =>
      exportJobPayload({
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 3,
        manifest: { ...manifest, preset: 'unknown' },
      }),
    ).toThrow(/preset/);
    expect(
      exportJobPayload({
        schemaVersion: 1,
        producer: 'browser-staged-preview-export',
        frameCount: 3,
        manifest,
      }),
    ).toMatchObject({ frameCount: 3, manifest });
  });
});
