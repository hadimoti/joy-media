import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KILO_MODEL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODEL_PRESETS,
  canonicalKiloBaseUrl,
  isRetiredModelId,
} from './provider-presets.js';

describe('provider presets', () => {
  it.each([
    'https://api.kilo.ai/api/gateway',
    'https://api.kilo.ai/api/gateway/',
    'https://api.kilo.ai/v1',
    'https://api.kilo.ai/v1/',
    'https://api.kilo.ai/api/gateway/v1',
    'https://api.kilo.ai/api/gateway/v1/',
  ])('canonicalizes Kilo URL %s', (url) => {
    expect(canonicalKiloBaseUrl(url)).toBe(KILO_GATEWAY_BASE_URL);
  });

  it('uses only BytePlus Kilo presets and selects the vision model by default', () => {
    expect(KILO_MODEL_PRESETS.length).toBeGreaterThan(0);
    expect(KILO_MODEL_PRESETS.every(({ id }) => id.startsWith('byteplus-coding/'))).toBe(true);
    expect(DEFAULT_KILO_MODEL).toBe('byteplus-coding/dola-seed-2.0-pro');
  });

  it('recognizes retired model IDs', () => {
    expect(isRetiredModelId('minimax/minimax-m3')).toBe(true);
  });
});
