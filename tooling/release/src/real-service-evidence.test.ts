import { describe, expect, it, vi } from 'vitest';
import {
  EXPECTED_SANDBOX_STORAGE_ERROR,
  assertJourneyTelemetryClean,
  buildProfileSummary,
  createJourneyTelemetry,
  summarizeJourneyTelemetry,
} from '../../../ops/self-hosted/linux-runner/real-service-evidence.mjs';
import {
  createLeaseHeartbeatLoop,
  throwIfLeaseCanceled,
} from '../../../ops/self-hosted/linux-runner/lease-heartbeat.mjs';

describe('real-service evidence helpers', () => {
  it('keeps expected sandbox page errors out of the failing telemetry summary', () => {
    const telemetry = createJourneyTelemetry();
    telemetry.consoleWarnings.push('warning');
    telemetry.pageErrors.push(EXPECTED_SANDBOX_STORAGE_ERROR);
    const summary = summarizeJourneyTelemetry(telemetry);

    expect(summary.console.warnings).toBe(1);
    expect(summary.pageErrors.total).toBe(1);
    expect(summary.pageErrors.unexpected).toBe(0);
    expect(() => assertJourneyTelemetryClean(telemetry)).not.toThrow();
  });

  it('fails closed when unexpected browser telemetry is observed', () => {
    const telemetry = createJourneyTelemetry();
    telemetry.consoleErrors.push('boom');

    expect(() => assertJourneyTelemetryClean(telemetry)).toThrow(/console error\(s\): boom/);
  });

  it('builds a machine-readable per-profile summary from Playwright JSON output', () => {
    const report = JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                { results: [{ status: 'passed' }] },
                { results: [{ status: 'skipped' }] },
                { results: [{ status: 'timedOut' }] },
              ],
            },
          ],
        },
      ],
    });

    const summary = buildProfileSummary({
      project: 'desktop-1280',
      reportText: report,
      exitCode: 1,
      startedAt: '2026-08-31T08:00:00.000Z',
      finishedAt: '2026-08-31T08:00:05.000Z',
      sourceProvenance: {
        commitSha: 'a'.repeat(40),
        treeHash: 'b'.repeat(40),
        lockfileSha256: 'c'.repeat(64),
        worktreeClean: true,
      },
    });

    expect(summary).toMatchObject({
      project: 'desktop-1280',
      status: 'failed',
      exitCode: 1,
      durationMs: 5000,
      stats: {
        total: 3,
        passed: 1,
        skipped: 1,
        timedOut: 1,
      },
    });
  });

  it('retains a failed profile when Playwright exits before producing JSON', () => {
    const summary = buildProfileSummary({
      project: 'desktop-1920',
      reportText: 'playwright failed to start',
      exitCode: 1,
      startedAt: '2026-08-31T08:00:00.000Z',
      finishedAt: '2026-08-31T08:00:01.000Z',
      sourceProvenance: {
        commitSha: 'a'.repeat(40),
        treeHash: 'b'.repeat(40),
        lockfileSha256: 'c'.repeat(64),
        worktreeClean: true,
      },
    });

    expect(summary).toMatchObject({
      project: 'desktop-1920',
      status: 'failed',
      exitCode: 1,
      stats: { reportParseError: true },
    });
  });

  it('serializes overlapping lease heartbeats and flushes the in-flight request on stop', async () => {
    let resolveHeartbeat: ((value: { cancelRequested: boolean }) => void) | undefined;
    let cancelRequested = false;
    const heartbeat = vi.fn(
      () =>
        new Promise<{ cancelRequested: boolean }>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );
    const loop = createLeaseHeartbeatLoop({
      heartbeat,
      intervalMs: 1,
      onHeartbeat: (result) => {
        cancelRequested ||= result.cancelRequested;
      },
    });

    const first = loop.send();
    await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledTimes(1));
    const second = loop.send();
    expect(heartbeat).toHaveBeenCalledTimes(1);
    const stop = loop.stop();
    resolveHeartbeat?.({ cancelRequested: true });
    await Promise.all([first, second]);
    await stop;
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(cancelRequested).toBe(true);
    expect(() => throwIfLeaseCanceled(cancelRequested)).toThrow(
      'render export was canceled by the control plane',
    );
  });
});
