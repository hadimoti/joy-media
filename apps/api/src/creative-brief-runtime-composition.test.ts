import { describe, expect, it } from 'vitest';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import { composeCreativeBriefRuntime } from './creative-brief-runtime-composition.js';
import {
  CREATIVE_BRIEF_MODEL_ID,
  CREATIVE_BRIEF_SECRET_REFERENCE,
} from './creative-brief-runtime-config.js';

const OPENROUTER_ENV = {
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODE: 'openrouter',
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODEL_ID: CREATIVE_BRIEF_MODEL_ID,
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_TIMEOUT_MS: '30000',
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SPEND_LIMIT_USD_CENTS: '0',
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_SECRET_REF: CREATIVE_BRIEF_SECRET_REFERENCE,
  JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_ALLOWED_FREE_MODEL_IDS: CREATIVE_BRIEF_MODEL_ID,
} satisfies Readonly<Record<string, string>>;

function dependencies() {
  return {
    secretResolver: { resolve: (_ref: string) => 'opaque-test-secret' },
    transport: {
      post: async (_url: string, _options?: RequestInit): Promise<Response> =>
        new Response('{}', { status: 200 }),
    },
  };
}

describe('composeCreativeBriefRuntime', () => {
  it('keeps the runtime unavailable when env is empty', () => {
    const runtime = composeCreativeBriefRuntime({ env: {} });
    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
  });

  it('keeps the runtime unavailable for disabled mode even with dependencies', () => {
    const runtime = composeCreativeBriefRuntime({
      env: { JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_MODE: 'disabled' },
      ...dependencies(),
    });
    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
  });

  it('fails closed when enabled configuration has no dependencies', () => {
    const runtime = composeCreativeBriefRuntime({ env: OPENROUTER_ENV });
    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
  });

  it('composes an enabled runtime only from valid injected inputs', () => {
    const runtime = composeCreativeBriefRuntime({
      env: OPENROUTER_ENV,
      ...dependencies(),
    });
    expect(runtime).not.toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
    expect(typeof runtime.execute).toBe('function');
  });

  it('does not consult process.env', () => {
    const runtime = composeCreativeBriefRuntime({
      env: {},
      ...dependencies(),
    });
    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
  });

  it('fails closed for an unknown prefixed key', () => {
    const runtime = composeCreativeBriefRuntime({
      env: {
        ...OPENROUTER_ENV,
        JOY_MEDIA_CREATIVE_BRIEF_RUNTIME_UNSAFE: 'ignored',
      },
      ...dependencies(),
    });
    expect(runtime).toBe(DEFAULT_CREATIVE_BRIEF_RUNTIME);
  });
});
