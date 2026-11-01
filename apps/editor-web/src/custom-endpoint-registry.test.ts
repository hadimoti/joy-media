import { describe, expect, it } from 'vitest';
import { requiresCustomEndpointConsent } from './custom-endpoint-acknowledgement.js';

describe('consent for registry providers', () => {
  it('needs no acknowledgement at a registry region, including the China region', () => {
    expect(requiresCustomEndpointConsent('kimi', 'https://api.moonshot.ai/v1')).toBe(false);
    expect(requiresCustomEndpointConsent('kimi', 'https://api.moonshot.cn/v1/')).toBe(false);
    expect(requiresCustomEndpointConsent('claude', 'https://api.anthropic.com/v1')).toBe(false);
  });

  it('still needs acknowledgement for a registry provider at another origin', () => {
    expect(requiresCustomEndpointConsent('grok', 'https://api.x.ai/v2')).toBe(true);
    expect(requiresCustomEndpointConsent('grok', 'https://api.moonshot.ai/v1')).toBe(true);
  });
});
