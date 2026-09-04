import { describe, expect, it } from 'vitest';
import { createByokSession, forgetByokConfig } from './byok-session.js';

describe('page-session BYOK lifecycle', () => {
  it('retains only public status and clears it without persistence', () => {
    const config = {
      provider: 'openrouter' as const,
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      apiKey: 'session-secret',
    };
    const session = createByokSession(config);
    expect(session.status).toEqual({
      provider: 'openrouter',
      modelId: 'openrouter/auto',
      capability: 'untested',
    });
    session.clear();
    expect(session.status).toEqual({ provider: 'openrouter', modelId: '', capability: 'untested' });
  });

  it('forgets a config object on explicit teardown', () => {
    const config = {
      provider: 'openrouter' as const,
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/auto',
      apiKey: 'session-secret',
    };
    forgetByokConfig(config);
    expect(config).toEqual({ provider: 'openrouter', baseUrl: '', modelId: '', apiKey: '' });
  });
});
