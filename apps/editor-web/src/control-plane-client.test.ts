import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';

describe('BrowserControlPlaneClient', () => {
  it('sends the local session token only to the Media API', async () => {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      requests.push({
        url,
        ...(new Headers(init?.headers).get('authorization') === null
          ? {}
          : { authorization: new Headers(init?.headers).get('authorization')! }),
      });
      return json(200, { data: [] });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.workers();
      await client.jobs('project-1');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/workers',
        authorization: 'Bearer joy-session-token',
      },
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/jobs',
        authorization: 'Bearer joy-session-token',
      },
    ]);
  });

  it('rejects with no network call when there is no stored session', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('should not be called');
    };
    try {
      const client = new BrowserControlPlaneClient('https://media.joyteam.ir/api', () => undefined);
      await expect(client.workers()).rejects.toThrow('JOY Media session required');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('scopes My Media requests to the active project when supplied', async () => {
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json(200, { data: [] });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.myAssets('project / one');
      await client.myAssets();
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      'https://media.joyteam.ir/api/v1/library/my-assets?projectId=project%20%2F%20one',
      'https://media.joyteam.ir/api/v1/library/my-assets',
    ]);
  });

  it('uses the idempotent ensure endpoint so refreshes do not emit conflicts', async () => {
    const requests: Array<{ readonly url: string; readonly method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
      });
      return json(200, { data: { id: 'project-1', title: 'Project', revision: 0 } });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.ensureProject('project-1', 'Project');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      { url: 'https://media.joyteam.ir/api/v1/projects/ensure', method: 'POST' },
    ]);
  });

  it('accepts an idempotent ensure response when the project already exists', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      json(200, { data: { id: 'project-1', title: 'Project', revision: 3 } });
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.ensureProject('project-1', 'Project')).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports a plain-text API denial without a JSON parsing failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.workers()).rejects.toThrow('unauthorized');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('fetches derivative bytes only from the authenticated Media API, never the object store', async () => {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push({ url, ...(authorization === null ? {} : { authorization }) });
      return new Response('jpeg', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.derivativeBytes('project-1', 'asset-1', 'derivative-1'),
      ).resolves.toMatchObject({
        type: 'image/jpeg',
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/assets/asset-1/derivatives/derivative-1/content',
        authorization: 'Bearer joy-session-token',
      },
    ]);
  });

  it('registers only asset metadata and the mandatory-sync compatibility call through the owner API', async () => {
    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      return json(201, { data: { id: 'asset-1', assetSyncEnabled: true } });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.registerAsset('project-1', {
        id: 'asset-1',
        kind: 'video',
        displayName: 'clip.mp4',
        sha256: 'a'.repeat(64),
        bytes: 10,
        descriptor: { mimeType: 'video/mp4' },
        locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
      });
      await client.setAssetSync('project-1', true);
      await client.enqueueAssetThumbnail('project-1', 'job-1', 'asset-1');
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/assets',
        body: expect.stringContaining('"displayName":"clip.mp4"'),
      },
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/asset-sync',
        body: '{"enabled":true}',
      },
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/jobs',
        body: '{"id":"job-1","type":"asset.thumbnail","assetId":"asset-1"}',
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain('C:\\');
  });

  it('passes the caller abort signal through browser export remux', async () => {
    const abortController = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.remuxBrowserMp4(
          'project-1',
          new Blob(['browser mp4'], { type: 'video/mp4' }),
          30,
          abortController.signal,
        ),
      ).resolves.toMatchObject({ size: 3, type: 'video/mp4' });
    } finally {
      globalThis.fetch = original;
    }
    expect(requestSignal).toBe(abortController.signal);
  });
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
