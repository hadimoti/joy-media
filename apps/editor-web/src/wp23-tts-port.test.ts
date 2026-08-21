import { describe, expect, it } from 'vitest';
import { createFixtureFirstPartyLibrary } from './first-party-handlers.js';

describe('generation.speech edge-tts port', () => {
  it('drops __stub and discloses remote Edge TTS deferral', () => {
    const library = createFixtureFirstPartyLibrary();
    const handler = library.handlers['generation.speech'];
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    const result = handler({
      node: {
        id: 'speech',
        category: 'generation',
        type: 'generation.speech',
        params: { text: 'سلام', voiceId: 'stock:fa', language: 'fa-IR' },
        deterministic: false,
      },
      upstream: {},
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
    expect(output.method).toBe('edge-tts');
    expect(output.dataLeavesDevice).toBe(true);
    expect(output.deferredEndpoint).toBe('/v1/providers/speech/synthesize');
    expect(String(output.voiceId)).toContain('fa-IR');
  });
});
