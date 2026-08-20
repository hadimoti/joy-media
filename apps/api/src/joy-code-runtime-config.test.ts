import { describe, expect, it } from 'vitest';
import { JOY_CODE_CONSENT_VERSION, JOY_CODE_MODEL_ID, JOY_CODE_SECRET_REFERENCE, parseJoyCodeRuntimeConfig } from './joy-code-runtime-config.js';

describe('Joy Code runtime config', () => {
  it('is disabled by default and fails closed for malformed policy', () => {
    expect(parseJoyCodeRuntimeConfig({})).toEqual({ mode: 'disabled' });
    expect(parseJoyCodeRuntimeConfig({ JOY_MEDIA_JOY_CODE_RUNTIME_MODE: 'openrouter', JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID: 'openrouter/free' })).toEqual({ mode: 'disabled' });
  });
  it('accepts only the exact free model, ref, singleton allowlist, and zero spend', () => {
    expect(parseJoyCodeRuntimeConfig({ JOY_MEDIA_JOY_CODE_RUNTIME_MODE: 'openrouter', JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID: JOY_CODE_MODEL_ID, JOY_MEDIA_JOY_CODE_RUNTIME_TIMEOUT_MS: '1000', JOY_MEDIA_JOY_CODE_RUNTIME_SPEND_LIMIT_USD_CENTS: '0', JOY_MEDIA_JOY_CODE_RUNTIME_SECRET_REF: JOY_CODE_SECRET_REFERENCE, JOY_MEDIA_JOY_CODE_RUNTIME_ALLOWED_FREE_MODEL_IDS: JOY_CODE_MODEL_ID })).toMatchObject({ mode: 'openrouter', modelId: JOY_CODE_MODEL_ID, spendLimitUsdCents: 0 });
    expect(JOY_CODE_CONSENT_VERSION).toBe('openrouter-nvidia-free-edit-planning-v1');
  });
});
