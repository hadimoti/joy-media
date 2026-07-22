import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';

describe('BrowserControlPlaneClient', () => {
  it('gets a short-lived JOY assertion in memory and sends it only to the Media API', async () => {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({
        url,
        ...(new Headers(init?.headers).get('authorization') === null
          ? {}
          : { authorization: new Headers(init?.headers).get('authorization')! }),
      });
      if (url === 'https://joyteam.ir/api/identity/joy-media')
        return json(200, { access_token: 'joy-assertion', expires_in: 300 });
      return json(200, { data: [] });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        'https://joyteam.ir/api/identity/joy-media',
      );
      await client.workers();
      await client.jobs('project-1');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      { url: 'https://joyteam.ir/api/identity/joy-media' },
      { url: 'https://media.joyteam.ir/api/v1/workers', authorization: 'Bearer joy-assertion' },
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/jobs',
        authorization: 'Bearer joy-assertion',
      },
    ]);
  });
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
