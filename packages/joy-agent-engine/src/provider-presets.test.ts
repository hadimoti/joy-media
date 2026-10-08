import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KILO_MODEL,
  KILO_GATEWAY_BASE_URL,
  KILO_MODEL_PRESETS,
  canonicalKiloBaseUrl,
  defaultModelFor,
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

  it('keeps BytePlus presets available and defaults Kilo and JOY hosted to free models', () => {
    expect(KILO_MODEL_PRESETS.length).toBeGreaterThan(0);
    expect(KILO_MODEL_PRESETS.every(({ id }) => id.startsWith('byteplus-coding/'))).toBe(true);
    expect(DEFAULT_KILO_MODEL).toBe('kilo/kilo-auto/free');
    expect(defaultModelFor('openrouter')).toBe('openrouter/free');
    expect(defaultModelFor('joy-hosted')).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });

  it('recognizes retired model IDs', () => {
    expect(isRetiredModelId('minimax/minimax-m3')).toBe(true);
  });
});
