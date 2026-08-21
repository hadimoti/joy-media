import { describe, expect, it } from 'vitest';
import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';

describe('analysis.loudness port', () => {
  it('runs real audio-core measureLoudness without __stub', () => {
    const library = createFixtureFirstPartyLibrary();
    const handler = library.handlers['analysis.loudness'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'loudness',
        category: 'analysis',
        type: 'analysis.loudness',
        params: {},
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
      readonly integratedLufs: number;
      readonly shortTermLufs: number;
      readonly loudnessRange: number;
      readonly __stub?: true;
    };
    expect(output.__stub).toBeUndefined();
    expect(Number.isFinite(output.integratedLufs)).toBe(true);
    expect(Number.isFinite(output.shortTermLufs)).toBe(true);
    expect(Number.isFinite(output.loudnessRange)).toBe(true);
  });
});
