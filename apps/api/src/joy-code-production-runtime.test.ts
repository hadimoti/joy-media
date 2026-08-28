import { describe, expect, it } from 'vitest';
import { createProductionJoyCodeRuntime } from './joy-code-production-runtime.js';
import { DEFAULT_JOY_CODE_RUNTIME } from './joy-code-runtime.js';
import { JOY_CODE_MODEL_ID, JOY_CODE_SECRET_REFERENCE } from './joy-code-runtime-config.js';

const env = {
  JOY_MEDIA_JOY_CODE_RUNTIME_MODE: 'openrouter',
  JOY_MEDIA_JOY_CODE_RUNTIME_MODEL_ID: JOY_CODE_MODEL_ID,
  JOY_MEDIA_JOY_CODE_RUNTIME_TIMEOUT_MS: '1000',
  JOY_MEDIA_JOY_CODE_RUNTIME_SPEND_LIMIT_USD_CENTS: '0',
  JOY_MEDIA_JOY_CODE_RUNTIME_SECRET_REF: JOY_CODE_SECRET_REFERENCE,
  JOY_MEDIA_JOY_CODE_RUNTIME_ALLOWED_FREE_MODEL_IDS: JOY_CODE_MODEL_ID,
};

describe('Joy Code production runtime composition', () => {
  it('stays unavailable for disabled configuration without reading credentials or network', () => {
    let reads = 0;
    let requests = 0;
    const runtime = createProductionJoyCodeRuntime(
      {},
      () => {
        reads += 1;
        return 'secret';
      },
      async () => {
        requests += 1;
        return new Response('{}');
      },
    );
    expect(runtime).toBe(DEFAULT_JOY_CODE_RUNTIME);
    expect(reads).toBe(0);
    expect(requests).toBe(0);
  });
  it('fails closed when the explicit credential is absent', async () => {
    const runtime = createProductionJoyCodeRuntime(
      env,
      () => {
        throw new Error('missing');
      },
      async () => new Response('{}'),
    );
    const result = await runtime.execute(
      {
        projectId: 'p',
        snapshotRevisionId: 'r',
        prompt: 'x',
        selection: { clipIds: [] },
        contextSummary: 'x',
        planId: 'id',
        createdAt: '2026-08-20T00:00:00.000Z',
        catalogVersion: 'v1',
        catalogs: { textTemplateIds: [], captionTemplateIds: [], transitionIds: [] },
      },
      { correlationId: 'c' },
    );
    expect(result.category).toBe('unavailable');
  });
});
