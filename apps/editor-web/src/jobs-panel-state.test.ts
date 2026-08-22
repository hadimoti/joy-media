import { describe, expect, it } from 'vitest';
import { jobStateLabel, projectJobStatus, workerPresence } from './jobs-panel-state.js';
import { jobsPanelToolbarActions } from './JobsPanel.js';

const NOW = 1_000_000;

describe('project Jobs panel state', () => {
  it('labels a missing control-plane record as ready to initialize, never offline', () => {
    const status = projectJobStatus(true, [], NOW);

    expect(status).toContain('آمادهٔ راه‌اندازی');
    expect(status).toContain('هیچ Workerی متصل نیست');
  });

  it('distinguishes connected, disconnected, and revoked Workers', () => {
    expect(workerPresence(worker({ lastSeenAt: NOW - 1 }), NOW)).toBe('connected');
    expect(workerPresence(worker({ lastSeenAt: NOW - 35_000 }), NOW)).toBe('disconnected');
    expect(workerPresence(worker({ revoked: true, lastSeenAt: NOW - 1 }), NOW)).toBe('revoked');
    expect(projectJobStatus(false, [worker({ lastSeenAt: NOW - 1 })], NOW)).toContain(
      'Worker متصل است',
    );
  });

  it('gives queued, running, canceled, failed, and completed jobs distinct labels', () => {
    expect(jobStateLabel({ state: 'queued', cancelRequested: false })).toBe('Queued');
    expect(jobStateLabel({ state: 'leased', cancelRequested: false })).toBe('Running');
    expect(jobStateLabel({ state: 'leased', cancelRequested: true })).toBe('Cancel requested');
    expect(jobStateLabel({ state: 'canceled', cancelRequested: false })).toBe('Canceled');
    expect(jobStateLabel({ state: 'failed', cancelRequested: false })).toBe('Failed');
    expect(jobStateLabel({ state: 'completed', cancelRequested: false })).toBe('Completed');
  });
  it('mentions GPU ready only when Comfy/ML capabilities are present', () => {
    const noGpu = projectJobStatus(
      false,
      [worker({ lastSeenAt: NOW - 1, capabilities: ['asset.thumbnail'] })],
      NOW,
    );
    expect(noGpu).toBe('راه‌اندازی شد · Worker متصل است');
    expect(noGpu).not.toContain('GPU آماده است');
    const withGpu = projectJobStatus(
      false,
      [worker({ lastSeenAt: NOW - 1, capabilities: ['asset.thumbnail', 'image.comfy'] })],
      NOW,
    );
    expect(withGpu).toContain('GPU آماده است');
  });

  it('keeps initialize and refresh toolbar controls but removes the fixture thumbnail queue action', () => {
    expect(jobsPanelToolbarActions(false)).toEqual(['initialize', 'refresh']);
    expect(jobsPanelToolbarActions(true)).toEqual(['refresh']);
  });
});

function worker(
  input: Partial<{
    readonly revoked: boolean;
    readonly lastSeenAt: number;
    readonly capabilities: readonly string[];
  }>,
) {
  return {
    id: 'worker-1',
    paired: true,
    revoked: false,
    capabilities: [] as readonly string[],
    ...input,
  };
}
