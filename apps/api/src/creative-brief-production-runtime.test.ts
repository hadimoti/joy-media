import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import {
  CREATIVE_BRIEF_MODEL_ID,
  CREATIVE_BRIEF_SECRET_REFERENCE,
} from './creative-brief-runtime-config.js';
import { createProductionCreativeBriefRuntime } from './creative-brief-production-runtime.js';

const PREFIX = 'JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_';

function validEnv(): Record<string, string> {
  return {
    [`${PREFIX}MODE`]: 'openrouter',
    [`${PREFIX}MODEL_ID`]: CREATIVE_BRIEF_MODEL_ID,
    [`${PREFIX}TIMEOUT_MS`]: '30000',
    [`${PREFIX}SPEND_LIMIT_USD_CENTS`]: '0',
    [`${PREFIX}SECRET_REF`]: CREATIVE_BRIEF_SECRET_REFERENCE,
    [`${PREFIX}ALLOWED_FREE_MODEL_IDS`]: CREATIVE_BRIEF_MODEL_ID,
  };
}

describe('createProductionCreativeBriefRuntime', () => {
  it('keeps production unavailable when runtime mode is disabled', () => {
    const fetchImpl = vi.fn();
    const runtime = createProductionCreativeBriefRuntime({}, () => 'sk-test', fetchImpl);

    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed for invalid configuration before any provider activity', () => {
    const fetchImpl = vi.fn();
    const env = { ...validEnv(), [`${PREFIX}MODEL_ID`]: 'openrouter/free' };
    const runtime = createProductionCreativeBriefRuntime(env, () => 'sk-test', fetchImpl);

    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('composes valid dependencies without reading process.env or calling the network', () => {
    const fetchImpl = vi.fn();
    const readCredential = vi.fn(() => 'sk-test');
    const runtime = createProductionCreativeBriefRuntime(validEnv(), readCredential, fetchImpl);

    expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remains unavailable when the configured credential cannot be read', () => {
    const fetchImpl = vi.fn();
    const runtime = createProductionCreativeBriefRuntime(
      validEnv(),
      () => {
        throw new Error('missing credential');
      },
      fetchImpl,
    );

    expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
