import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localWorkerEnv } from './worker-env.js';

const route = {
  apiEnv: { JOY_MEDIA_API_URL: 'http://127.0.0.1:4000', JOY_MEDIA_WORKER_LOCAL_TOKEN: 'token' },
  workerRoot: join('state', 'worker'),
};

describe('localWorkerEnv', () => {
  it('replaces inherited variables the local route owns, so a stray cloud or asset setting cannot leak in', () => {
    const env = localWorkerEnv(
      {
        PATH: '/bin',
        JOY_MEDIA_LOCAL_ASSETS_JSON: '{"asset-product":"C:/missing.mp4"}',
        JOY_MEDIA_API_URL: 'https://api.joyst.ir',
        JOY_MEDIA_WORKER_LOCAL_TOKEN: 'stale',
        JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH: 'C:/pair.json',
      },
      route,
    );
    expect(env.JOY_MEDIA_LOCAL_ASSETS_JSON).toBeUndefined();
    expect(env.JOY_MEDIA_WORKER_PAIRING_NOTIFICATION_PATH).toBeUndefined();
    expect(env.JOY_MEDIA_API_URL).toBe('http://127.0.0.1:4000');
    expect(env.JOY_MEDIA_WORKER_LOCAL_TOKEN).toBe('token');
    expect(env.PATH).toBe('/bin');
  });

  it('keeps this machine\u2019s tool toggles and points state and derivatives into the worker root', () => {
    const env = localWorkerEnv({ JOY_MEDIA_LOCAL_COMFY_URL: 'http://127.0.0.1:8188' }, route);
    expect(env.JOY_MEDIA_LOCAL_COMFY_URL).toBe('http://127.0.0.1:8188');
    expect(env.JOY_MEDIA_WORKER_STATE_PATH).toBe(join('state', 'worker', 'worker-state.json'));
    expect(env.JOY_MEDIA_WORKER_DERIVATIVE_DIR).toBe(join('state', 'worker', 'derivatives'));
  });
});
