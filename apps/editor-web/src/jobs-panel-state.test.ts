import { describe, expect, it } from 'vitest';
import {
  jobStateLabel,
  projectJobStatus,
  workerPresence,
  workerProcessView,
} from './jobs-panel-state.js';

const NOW = 1_000_000;

describe('project Jobs panel state', () => {
  it('labels a missing control-plane record as ready to initialize, never offline', () => {
    const status = projectJobStatus(true, [], NOW);

    expect(status).toContain('Ready to initialize');
    expect(status).not.toContain('Not connected');
  });

  it('distinguishes connected and disconnected Workers', () => {
    expect(workerPresence(worker({ lastSeenAt: NOW - 1 }), NOW)).toBe('connected');
    expect(workerPresence(worker({ lastSeenAt: NOW - 35_000 }), NOW)).toBe('disconnected');
    expect(projectJobStatus(false, [worker({ lastSeenAt: NOW - 1 })], NOW)).toContain('connected');
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
    expect(noGpu).toBe('Initialized · Worker connected');
    expect(noGpu).not.toContain('GPU ready');
    const withGpu = projectJobStatus(
      false,
      [worker({ lastSeenAt: NOW - 1, capabilities: ['asset.thumbnail', 'image.comfy'] })],
      NOW,
    );
    expect(withGpu).toContain('GPU ready');
    expect(
      projectJobStatus(
        false,
        [worker({ lastSeenAt: NOW - 1, capabilities: ['render.preview.gpu'] })],
        NOW,
      ),
    ).toContain('GPU ready');
  });
});

describe('desktop Worker process state', () => {
  it('shows a running Worker without a retry action', () => {
    expect(workerProcessView('online')).toEqual({
      label: 'running',
      tone: 'connected',
      canRetry: false,
    });
  });

  it('shows a Worker that is starting, stopping or not yet read without a retry action', () => {
    expect(workerProcessView('starting')).toEqual({
      label: 'starting',
      tone: 'queued',
      canRetry: false,
    });
    expect(workerProcessView('stopping')).toEqual({
      label: 'stopping',
      tone: 'queued',
      canRetry: false,
    });
    expect(workerProcessView('unknown')).toEqual({
      label: 'checking',
      tone: 'queued',
      canRetry: false,
    });
  });

  it('offers a retry once the automatic restarts are used up, or the Worker is stopped', () => {
    expect(workerProcessView('degraded')).toEqual({
      label: 'stopped',
      tone: 'disconnected',
      canRetry: true,
    });
    expect(workerProcessView('offline')).toEqual({
      label: 'stopped',
      tone: 'disconnected',
      canRetry: true,
    });
  });
});

function worker(
  input: Partial<{
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
