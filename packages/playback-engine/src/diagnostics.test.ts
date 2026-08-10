import { describe, expect, it } from 'vitest';
import { PlaybackDiagnosticsSession } from './diagnostics.js';

describe('PlaybackDiagnosticsSession', () => {
  it('uses presented-frame metadata and reports drift percentiles per clip', () => {
    const diagnostics = new PlaybackDiagnosticsSession();
    diagnostics.start('clip-a', 'full');
    diagnostics.recordFrame(
      { mediaTime: 1, presentedFrames: 1, expectedDisplayTime: 10 },
      950_000,
      10_000,
    );
    diagnostics.recordFrame(
      { mediaTime: 1.05, presentedFrames: 3, expectedDisplayTime: 10.05 },
      1_000_000,
      10_040,
    );

    expect(diagnostics.snapshot()).toMatchObject({
      clipId: 'clip-a',
      sourceQuality: 'full',
      decodedFrames: 2,
      presentationFrames: 3,
      presentationDrops: 1,
      p50DriftUs: 50_000,
      p95DriftUs: 50_000,
      maxDriftUs: 50_000,
    });
    diagnostics.recordFrame(
      { mediaTime: 0.8, presentedFrames: 4, expectedDisplayTime: 10.1 },
      1_000_000,
      10_100,
    );
    expect(diagnostics.snapshot().p95DriftUs).toBe(200_000);
  });

  it('separates decode misses and resets on a seek/session boundary', () => {
    const diagnostics = new PlaybackDiagnosticsSession();
    diagnostics.start('clip-a', 'proxy');
    diagnostics.recordDecodeMiss();
    diagnostics.beginStall(100_000);
    diagnostics.endStall(700_000);
    expect(diagnostics.snapshot()).toMatchObject({
      decodeMisses: 1,
      droppedFrames: 1,
      stalls: 1,
      maxStallUs: 600_000,
      quality: 'proxy',
    });
    const priorSession = diagnostics.snapshot().sessionId;
    diagnostics.reset();
    expect(diagnostics.snapshot()).toMatchObject({
      sessionId: priorSession + 1,
      clipId: 'clip-a',
      decodeMisses: 0,
      droppedFrames: 0,
      maxStallUs: 0,
    });
  });
});
