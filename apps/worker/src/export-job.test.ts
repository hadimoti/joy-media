import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeLeasedExport } from './export-job.js';
describe('leased export job', () => {
  it('verifies output before completing the lease', () => {
    const calls: string[] = [];
    const output = join(mkdtempSync(join(tmpdir(), 'joy-media-leased-export-')), 'out.mp4');
    const result = executeLeasedExport(
      { complete: (workerId, jobId) => calls.push(`${workerId}:${jobId}`) },
      'worker-1',
      'job-1',
      {
        projectId: 'p',
        revision: 1,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'social-h264-aac',
      },
      output,
    );
    expect(result).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac' });
    expect(calls).toEqual(['worker-1:job-1']);
  });
  it('does not complete a lease and removes output when rendering fails', () => {
    const calls: string[] = [];
    const output = join(mkdtempSync(join(tmpdir(), 'joy-media-leased-export-')), 'out.mp4');
    expect(() =>
      executeLeasedExport(
        { complete: (_workerId, jobId) => calls.push(jobId) },
        'worker-1',
        'job-1',
        {
          projectId: 'p',
          revision: 1,
          width: 0,
          height: 36,
          frameRate: 30,
          durationUs: 100_000,
          preset: 'social-h264-aac',
        },
        output,
      ),
    ).toThrow(/manifest/);
    expect(calls).toEqual([]);
    expect(existsSync(output)).toBe(false);
  });
});
