import { describe, expect, it } from 'vitest';
import { CUSTOM_PROVIDER_ID, evaluateEndpoint } from './registry.js';

describe('a public custom endpoint (S8)', () => {
  it('needs the owner consent, and with it allows the public origin', () => {
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'https://api.example.com/v1')).toMatchObject({
      allowed: false,
      code: 'CONSENT_REQUIRED',
    });
    expect(
      evaluateEndpoint(CUSTOM_PROVIDER_ID, 'https://api.example.com/v1/', {
        consentToPublicEndpoint: true,
      }),
    ).toEqual({
      allowed: true,
      kind: 'public',
      origin: 'https://api.example.com',
      basePath: '/v1',
    });
  });

  it('keeps http refused for a public host, even with consent', () => {
    expect(
      evaluateEndpoint(CUSTOM_PROVIDER_ID, 'http://api.example.com/v1', {
        consentToPublicEndpoint: true,
      }),
    ).toMatchObject({ allowed: false, code: 'BASE_URL_INSECURE' });
  });

  it.each([
    'https://192.168.1.1/v1',
    'https://10.0.0.4/v1',
    'https://169.254.169.254/v1',
    'https://100.64.0.1/v1',
    'https://198.18.0.9/v1',
    'https://224.0.0.1/v1',
    'https://[::ffff:7f00:1]/v1',
    'https://[fd00::1]/v1',
    'https://[fe80::1]/v1',
    'https://metadata.google.internal/v1',
    'https://printer.local/v1',
    'https://router.internal/v1',
  ])('refuses %s even with consent', (url) => {
    expect(
      evaluateEndpoint(CUSTOM_PROVIDER_ID, url, { consentToPublicEndpoint: true }),
    ).toMatchObject({
      allowed: false,
      code: 'BASE_URL_REFUSED',
    });
  });

  it('does not let consent widen a registry provider', () => {
    expect(
      evaluateEndpoint('grok', 'https://api.example.com/v1', { consentToPublicEndpoint: true })
        .allowed,
    ).toBe(false);
  });

  it('keeps a loopback server allowed without consent', () => {
    expect(evaluateEndpoint(CUSTOM_PROVIDER_ID, 'http://127.0.0.1:1234/v1')).toMatchObject({
      allowed: true,
      kind: 'loopback',
    });
  });
});
