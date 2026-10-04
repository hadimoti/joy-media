import { describe, expect, it } from 'vitest';
import { chooseJoyAgentRestoreTarget } from './restore-target.js';
import type { DesktopProviderProfile } from '../desktop-client.js';

const openRouterProfile = {
  id: 'profile-openrouter',
  provider: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelId: 'openrouter/free',
  cachedModels: [],
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
} as DesktopProviderProfile;

describe('Joy Agent restore target', () => {
  it('restores Joy Model when signed in and the last preset was Joy Hosted', () => {
    expect(
      chooseJoyAgentRestoreTarget({
        profiles: [openRouterProfile],
        token: 'session-test',
        lastPreset: 'joy-hosted',
      }),
    ).toEqual({ kind: 'joy-hosted', token: 'session-test' });
  });

  it('does not restore a BYOK profile over a signed-in JOY session with no saved preset', () => {
    expect(
      chooseJoyAgentRestoreTarget({ profiles: [openRouterProfile], token: 'session-test' }),
    ).toEqual({ kind: 'joy-hosted', token: 'session-test' });
  });

  it('waits for sign-in when Joy Hosted was selected but the session is absent', () => {
    expect(
      chooseJoyAgentRestoreTarget({ profiles: [openRouterProfile], lastPreset: 'joy-hosted' }),
    ).toEqual({ kind: 'wait-for-sign-in' });
  });
});
