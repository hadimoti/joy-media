import { describe, expect, it, vi } from 'vitest';
import { createJoyMediaJobBridge } from './media-job-bridge.js';

describe('JOY media-job bridge', () => {
  it('keeps media spend and model credentials at separate boundaries', async () => {
    const submit = vi.fn(async (_request: unknown) => undefined);
    const bridge = createJoyMediaJobBridge({ submit });
    await bridge.submit({
      jobId: 'job-1',
      kind: 'audio',
      assetId: 'asset-1',
      providerId: 'approved-audio-provider',
      estimatedCostUsd: 0.2,
      remoteUpload: true,
      approved: true,
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'approved-audio-provider', jobId: 'job-1' }),
    );
    expect(JSON.stringify(submit.mock.calls[0]?.[0])).not.toContain('apiKey');
  });

  it('requires explicit approval for remote uploads', async () => {
    const bridge = createJoyMediaJobBridge({ submit: vi.fn(async () => undefined) });
    await expect(
      bridge.submit({
        jobId: 'job-2',
        kind: 'audio',
        providerId: 'provider',
        remoteUpload: true,
        approved: false,
      }),
    ).rejects.toMatchObject({ code: 'approval-required' });
  });

  it('rejects malformed or unknown job identities before executor dispatch', async () => {
    const submit = vi.fn(async () => undefined);
    const bridge = createJoyMediaJobBridge({ submit });
    await expect(
      bridge.submit({
        jobId: '',
        kind: 'audio',
        providerId: 'provider',
        remoteUpload: false,
        approved: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('preserves honest indeterminate progress and validates determinate progress', () => {
    const bridge = createJoyMediaJobBridge({ submit: vi.fn(async () => undefined) });
    expect(bridge.validateProgress({ jobId: 'job-3', status: 'running' })).toEqual({
      jobId: 'job-3',
      status: 'running',
    });
    expect(() =>
      bridge.validateProgress({ jobId: 'job-3', status: 'running', current: 4, total: 2 }),
    ).toThrowError('Media job progress is not determinate');
  });

  it('reports cancellation pending when an executor does not support cancel', async () => {
    const bridge = createJoyMediaJobBridge({ submit: vi.fn(async () => undefined) });
    await expect(bridge.cancel('job-4')).rejects.toMatchObject({
      code: 'cancel-unsupported',
    });
  });
});
