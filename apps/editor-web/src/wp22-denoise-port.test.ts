import { describe, expect, it } from 'vitest';
import { createStubFirstPartyLibrary } from './first-party-handlers.js';

describe('transform.denoise port', () => {
  it('runs real noise-gate DSP without __stub', () => {
    const library = createStubFirstPartyLibrary();
    const handler = library.handlers['transform.denoise'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'denoise',
        category: 'transform',
        type: 'transform.denoise',
        params: { strength: 0.4 },
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
      readonly method: string;
      readonly strength: number;
      readonly thresholdDb: number;
      readonly inputPeakDb: number;
      readonly outputPeakDb: number;
      readonly __stub?: true;
    };
    expect(output.__stub).toBeUndefined();
    expect(output.method).toBe('noise-gate');
    expect(output.strength).toBe(0.4);
    expect(Number.isFinite(output.thresholdDb)).toBe(true);
    expect(Number.isFinite(output.inputPeakDb)).toBe(true);
    expect(Number.isFinite(output.outputPeakDb)).toBe(true);
  });

  it('defers high-strength / spectral denoise to ffmpeg-afftdn', () => {
    const library = createStubFirstPartyLibrary();
    const handler = library.handlers['transform.denoise'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'denoise',
        category: 'transform',
        type: 'transform.denoise',
        params: { strength: 0.9 },
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
    expect(output.method).toBe('ffmpeg-afftdn');
    expect(output.deferredEndpoint).toBe('/v1/providers/audio/denoise');
  });
});
