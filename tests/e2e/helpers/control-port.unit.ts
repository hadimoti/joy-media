import { describe, expect, it } from 'vitest';
import { controlPortConfig } from './control-port.js';

describe('synthetic control port configuration', () => {
  it('reads the token and the default port in a fixture-only run', () => {
    expect(
      controlPortConfig({
        JOY_MEDIA_CI_ACCEPTANCE_PROFILE: 'fixture-only',
        JOY_MEDIA_E2E_CONTROL_TOKEN: 'token-1',
      }),
    ).toEqual({ token: 'token-1', baseUrl: 'http://127.0.0.1:4175' });
  });

  it('uses the port the fixture server was started on', () => {
    expect(
      controlPortConfig({
        JOY_MEDIA_E2E_CONTROL_PORT: '5001',
        JOY_MEDIA_E2E_CONTROL_TOKEN: 'token-2',
      }).baseUrl,
    ).toBe('http://127.0.0.1:5001');
  });

  it('refuses to run in a real-services acceptance profile', () => {
    expect(() =>
      controlPortConfig({
        JOY_MEDIA_CI_ACCEPTANCE_PROFILE: 'real-services',
        JOY_MEDIA_E2E_CONTROL_TOKEN: 'token-3',
      }),
    ).toThrow(/fixture-only/u);
  });
});
