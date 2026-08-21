import { describe, expect, it } from 'vitest';
import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';

describe('WP-22 analysis.detectSilence port', () => {
  it('runs real audio-core DSP without __stub', () => {
    const library = createFixtureFirstPartyLibrary();
    const handler = library.handlers['analysis.silence'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'silence',
        category: 'analysis',
        type: 'analysis.silence',
        params: { thresholdDb: -40, minSilenceMs: 100 },
        deterministic: true,
      },
      upstream: { src: { assetId: 'a1' } },
      workflowInputs: {},
      attempt: 1,
      runKey: 'rk',
      runId: 'run-1',
      projectRevision: 'rev',
    });

    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result) || !result.ok) return;
    const output = result.output as {
      readonly ranges: readonly { readonly startUs: number; readonly endUs: number }[];
      readonly thresholdDb: number;
      readonly __stub?: true;
    };
    expect(output.__stub).toBeUndefined();
    expect(output.thresholdDb).toBe(-40);
    expect(output.ranges.length).toBeGreaterThanOrEqual(1);
    const gap = output.ranges[0]!;
    // Fixture silence starts at 0.5s and lasts ~0.4s.
    expect(gap.startUs).toBeGreaterThanOrEqual(450_000);
    expect(gap.startUs).toBeLessThanOrEqual(550_000);
    expect(gap.endUs - gap.startUs).toBeGreaterThanOrEqual(350_000);
    expect(gap.endUs - gap.startUs).toBeLessThanOrEqual(450_000);
  });
});
