import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from './local-database.js';
import type { GenerationJobRecord } from './generation-job-store.js';

describe('local generation job store', () => {
  const directories: string[] = [];

  afterEach(() => {
    const workspace = path.resolve(process.cwd());
    for (const directory of directories.splice(0)) {
      const resolved = path.resolve(directory);
      if (!resolved.startsWith(`${workspace}${path.sep}`)) {
        throw new Error('Refusing to remove a test directory outside the workspace');
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the job row when the local database is reopened', () => {
    const directory = mkdtempSync(path.join(process.cwd(), '.joy-generation-jobs-'));
    directories.push(directory);
    const filePath = path.join(directory, 'local.sqlite');
    const first = new LocalDatabase({ filePath });
    const job: GenerationJobRecord = {
      id: 'generation-1',
      kind: 'video',
      provider: 'minimax',
      profileId: 'profile-1',
      model: 'MiniMax-H3-Lite',
      prompt: 'A paper boat on a quiet lake',
      state: 'queued',
      costNote: 'Provider pricing applies; JOY Media does not estimate the charge.',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T00:00:00.000Z',
    };
    try {
      first.generationJobs.save(job);
    } finally {
      first.close();
    }

    const reopened = new LocalDatabase({ filePath });
    try {
      expect(reopened.generationJobs.get(job.id)).toEqual(job);
      expect(reopened.generationJobs.list()).toEqual([job]);
    } finally {
      reopened.close();
    }
  });
});
