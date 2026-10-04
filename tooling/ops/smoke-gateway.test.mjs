import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKeyCheck, parseSmokeArgs } from './smoke-gateway-lib.mjs';

describe('gateway smoke helpers', () => {
  it('parses local base, host, and pre-cutover mode', () => {
    assert.deepEqual(
      parseSmokeArgs([
        '--base-url',
        'https://127.0.0.1/api/v1/agent',
        '--host',
        'joy.test',
        '--pre-cutover',
      ]),
      { baseUrl: 'https://127.0.0.1/api/v1/agent', host: 'joy.test', preCutover: true },
    );
  });

  it('rejects remote smoke targets', () => {
    assert.throws(
      () => parseSmokeArgs([], { JOY_GATEWAY_BASE_URL: 'https://joyst.ir/api/v1/agent' }),
      /loopback/,
    );
  });

  it('classifies an unconfigured gateway as a missing OpenRouter key', async () => {
    const response = new globalThis.Response(
      JSON.stringify({ error: { code: 'JOY_AGENT_UNCONFIGURED' } }),
      {
        status: 503,
      },
    );
    assert.match(await classifyKeyCheck(response), /OpenRouter key missing/);
  });
});
