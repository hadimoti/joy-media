import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeCustomEndpoint,
  mayRestoreProviderProfile,
  resetCustomEndpointAcknowledgementsForTests,
} from './custom-endpoint-acknowledgement.js';

afterEach(resetCustomEndpointAcknowledgementsForTests);

describe('custom endpoint acknowledgement', () => {
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
