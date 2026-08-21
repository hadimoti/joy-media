import { describe, expect, it } from 'vitest';
import { createTTSAdapter } from './index.js';

describe('TTS adapter production mode', () => {
  it.each([
    { execution: 'worker-local' as const, engine: 'fish-speech' as const },
    { execution: 'worker-local' as const, engine: 'f5-tts' as const },
    { execution: 'worker-local' as const, engine: 'kokoro' as const },
    { execution: 'worker-local' as const, engine: 'chatterbox' as const },
    { execution: 'remote-api' as const, engine: 'elevenlabs' as const },
  ])('fails closed for unwired production engine $engine', async (config) => {
    const adapter = createTTSAdapter(config);
    const result = await adapter.invoke('speech.synthesize', { text: 'Hello world' });

    expect(result.status).toBe('failed');
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PROVIDER_UNAVAILABLE',
          message: expect.stringContaining('TTS_UNAVAILABLE'),
        }),
      ]),
    );
  });

  it('carries caller idempotency and provider decision ids through failed provenance', async () => {
    const adapter = createTTSAdapter({ execution: 'worker-local', engine: 'kokoro' });
    const input = { text: 'Hello world', decisionId: 'decision-tts-1' };

    const result = await adapter.invoke('speech.synthesize', input, {
      requestVersion: 1,
      capability: 'speech.synthesize',
      input,
      constraints: {},
      idempotencyKey: 'idem-tts-1',
    });

    expect(result.provenance.idempotencyKey).toBe('idem-tts-1');
    expect(result.provenance.providerDecisionId).toBe('decision-tts-1');
  });
});
