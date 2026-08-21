import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBrowserSmokeCliPlan } from './run.js';

describe('browser smoke CLI planning', () => {
  it('reuses an external browser URL without starting a local server', () => {
    const plan = buildBrowserSmokeCliPlan(
      { JOY_MEDIA_BROWSER_URL: 'http://127.0.0.1:6199' },
      'linux',
    );

    assert.equal(plan.baseUrl, 'http://127.0.0.1:6199');
    assert.equal(plan.server, undefined);
  });

  it('starts the repo editor dev server with the platform pnpm executable by default', () => {
    const plan = buildBrowserSmokeCliPlan({ JOY_MEDIA_BROWSER_PORT: '6123' }, 'win32');

    assert.equal(plan.baseUrl, 'http://127.0.0.1:6123');
    assert.deepEqual(plan.server, {
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
