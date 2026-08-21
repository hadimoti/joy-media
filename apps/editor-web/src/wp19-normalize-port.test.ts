import { describe, expect, it } from 'vitest';
import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';

describe('WP-19 normalizeAudio port', () => {
  it('runs real audio-core DSP without __stub', () => {
    const library = createFixtureFirstPartyLibrary();
    const handler = library.handlers['transform.normalizeAudio'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'normalize',
        category: 'transform',
        type: 'transform.normalizeAudio',
        params: { targetLufs: -16, duckMusic: true },
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
    const output = result.output as Record<string, unknown>;
    expect(output.__stub).toBeUndefined();
    expect(typeof output.measuredLufs).toBe('number');
    expect(output.targetLufs).toBe(-16);
    expect(output.duckMusic).toBe(true);
    expect(Math.abs(Number(output.measuredLufs) - -16)).toBeLessThan(1.5);
  });
});
