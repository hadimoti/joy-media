import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeCustomEndpoint,
  isCustomEndpointAcknowledged,
  mayRestoreProviderProfile,
  requiresCustomEndpointConsent,
  resetCustomEndpointAcknowledgementsForTests,
  revokeCustomEndpointAcknowledgement,
  revokeCustomEndpointAcknowledgementsForUrl,
} from './custom-endpoint-acknowledgement.js';

afterEach(resetCustomEndpointAcknowledgementsForTests);

describe('custom endpoint acknowledgement', () => {
  it('trusts only each provider exact HTTPS endpoint', () => {
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai/api/v1')).toBe(false);
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai/api/v1/')).toBe(
      false,
    );
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai:443/api/v1')).toBe(
      false,
    );
    // A sub-path is a different configured endpoint and needs consent.
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai/api/v1/chat')).toBe(
      true,
    );
    expect(requiresCustomEndpointConsent('kilo', 'https://api.kilo.ai/v1')).toBe(false);
    expect(requiresCustomEndpointConsent('joy-hosted', 'https://joyst.ir/api/v1/agent')).toBe(
      false,
    );
    expect(
      requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai.evil.example/api/v1'),
    ).toBe(true);
    expect(requiresCustomEndpointConsent('openrouter', 'http://openrouter.ai/api/v1')).toBe(true);
    expect(
      requiresCustomEndpointConsent('openrouter', 'https://user:pass@openrouter.ai/api/v1'),
    ).toBe(true);
    expect(requiresCustomEndpointConsent('openrouter', 'https://@openrouter.ai/api/v1')).toBe(true);
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai:8443/api/v1')).toBe(
      true,
    );
    expect(requiresCustomEndpointConsent('openrouter', 'https://openrouter.ai/api/v10')).toBe(true);
    expect(requiresCustomEndpointConsent('openrouter', 'https://other.example/v1')).toBe(true);
  });

  it('requires acknowledgement for OpenRouter-labeled custom profiles before startup restore', () => {
    const profile = {
      provider: 'openrouter',
      baseUrl: 'https://custom.example/api/v1',
      profileId: 'p1',
    };
    expect(mayRestoreProviderProfile(profile)).toBe(false);
    acknowledgeCustomEndpoint({ ...profile, provider: 'custom' });
    expect(mayRestoreProviderProfile(profile)).toBe(true);
    expect(mayRestoreProviderProfile({ ...profile, baseUrl: 'https://other.example/api/v1' })).toBe(
      false,
    );
  });

  it('allows startup restore of profiles at trusted provider endpoints', () => {
    expect(
      mayRestoreProviderProfile({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe(true);
    expect(mayRestoreProviderProfile({ provider: 'kilo', baseUrl: 'https://api.kilo.ai/v1' })).toBe(
      true,
    );
    expect(
      mayRestoreProviderProfile({
        provider: 'joy-hosted',
        baseUrl: 'https://joyst.ir/api/v1/agent',
      }),
    ).toBe(true);
  });

  it('withdraws consent when the acknowledgement is revoked', () => {
    const endpoint = { provider: 'custom', baseUrl: 'https://custom.example/v1' };
    acknowledgeCustomEndpoint(endpoint);
    expect(isCustomEndpointAcknowledged(endpoint)).toBe(true);
    revokeCustomEndpointAcknowledgement({ ...endpoint, baseUrl: 'https://custom.example/v1/' });
    expect(isCustomEndpointAcknowledged(endpoint)).toBe(false);
  });

  it('revokes profile-bound acknowledgements for a URL too', () => {
    const bound = { provider: 'custom', baseUrl: 'https://custom.example/v1', profileId: 'p1' };
    const other = { provider: 'custom', baseUrl: 'https://other.example/v1', profileId: 'p2' };
    acknowledgeCustomEndpoint(bound);
    acknowledgeCustomEndpoint({ provider: 'custom', baseUrl: 'https://custom.example/v1' });
    acknowledgeCustomEndpoint(other);
    revokeCustomEndpointAcknowledgementsForUrl('https://custom.example/v1/');
    expect(isCustomEndpointAcknowledged(bound)).toBe(false);
    expect(
      isCustomEndpointAcknowledged({ provider: 'custom', baseUrl: 'https://custom.example/v1' }),
    ).toBe(false);
    expect(isCustomEndpointAcknowledged(other)).toBe(true);
  });

  it('blocks startup restore before consent and permits only the acknowledged exact profile', () => {
    const profile = { provider: 'custom', baseUrl: 'https://custom.example/v1/', profileId: 'p1' };
    expect(mayRestoreProviderProfile(profile)).toBe(false);
    acknowledgeCustomEndpoint(profile);
    expect(mayRestoreProviderProfile({ ...profile, baseUrl: 'https://custom.example/v1' })).toBe(
      true,
    );
    expect(mayRestoreProviderProfile({ ...profile, baseUrl: 'https://other.example/v1' })).toBe(
      false,
    );
    expect(mayRestoreProviderProfile({ ...profile, profileId: 'p2' })).toBe(false);
  });
});
