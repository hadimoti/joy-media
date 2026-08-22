import { describe, expect, it } from 'vitest';
import { buildBrowserSmokeCliPlan } from './run.js';

describe('browser smoke CLI planning', () => {
  it('reuses an external browser URL without starting a local server', () => {
    const plan = buildBrowserSmokeCliPlan(
      { JOY_MEDIA_BROWSER_URL: 'http://127.0.0.1:6199' },
      'linux',
    );

    expect(plan.baseUrl).toBe('http://127.0.0.1:6199');
    expect(plan.server).toBeUndefined();
  });

  it('starts the repo editor dev server with the platform pnpm executable by default', () => {
    const plan = buildBrowserSmokeCliPlan({ JOY_MEDIA_BROWSER_PORT: '6123' }, 'win32');

    expect(plan.baseUrl).toBe('http://127.0.0.1:6123');
    expect(plan.server).toEqual({
      command: 'pnpm.cmd',
      args: [
        '--filter',
        '@joy-media/editor-web',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        '6123',
        '--strictPort',
      ],
      port: 6123,
    });
  });
});
