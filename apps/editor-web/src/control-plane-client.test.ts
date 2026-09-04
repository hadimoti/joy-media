import { describe, expect, it } from 'vitest';
import {
  BrowserControlPlaneClient,
  RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES,
  invalidateWorkerReadCache,
} from './control-plane-client.js';

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

  it('coalesces concurrent worker and same-project job reads', async () => {
    const requests: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      await gate;
      return json(200, { data: [] });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const workerReads = [client.workers(), client.workers(), client.workers()];
      const jobReads = [client.jobs('project-1'), client.jobs('project-1')];
      // Different project scopes remain independent reads.
      const otherProjectJobs = client.jobs('project-2');
      await Promise.resolve();
      expect(requests).toEqual([
        'https://media.joyteam.ir/api/v1/workers',
        'https://media.joyteam.ir/api/v1/projects/project-1/jobs',
        'https://media.joyteam.ir/api/v1/projects/project-2/jobs',
      ]);
      release();
      await Promise.all([...workerReads, ...jobReads, otherProjectJobs]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('coalesces worker reads across independently mounted panel clients', async () => {
    const requests: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      await gate;
      return json(200, { data: [] });
    };
    try {
      const firstPanel = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const secondPanel = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const reads = [firstPanel.workers(), secondPanel.workers()];
      await Promise.resolve();
      expect(requests).toEqual(['https://media.joyteam.ir/api/v1/workers']);
      release();
      await Promise.all(reads);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('invalidates the worker projection cache for explicit pairing refreshes', async () => {
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
      await client.workers();
      invalidateWorkerReadCache();
      await client.workers();
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      'https://media.joyteam.ir/api/v1/workers',
      'https://media.joyteam.ir/api/v1/workers',
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

  it('associates a catalog asset through the active project endpoint', async () => {
    const requests: Array<{ readonly url: string; readonly method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
      });
      return json(200, {
        data: {
          id: 'catalog-video',
          projectId: 'target',
          kind: 'video',
          displayName: 'catalog.mp4',
          sha256: 'a'.repeat(64),
          bytes: 12,
          descriptor: { mimeType: 'video/mp4' },
          createdAt: 1,
          cloudBacked: true,
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.associateAsset('target', 'catalog-video')).resolves.toMatchObject({
        id: 'catalog-video',
        projectId: 'target',
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/target/assets/catalog-video/associate',
        method: 'POST',
      },
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

  it('loads the owner-authorized canonical project document and optional revision', async () => {
    const requests: Array<{ readonly url: string; readonly method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        ...(init?.method === undefined ? {} : { method: init.method }),
      });
      return json(200, {
        data: {
          projectId: 'project-1',
          revisionId: 'server-rev-2',
          document: { schemaVersion: 1, id: 'editor-doc-1', title: 'Recovered' },
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.projectDocument('project / one', 'server rev 1')).resolves.toMatchObject({
        projectId: 'project-1',
        revisionId: 'server-rev-2',
        document: { id: 'editor-doc-1' },
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project%20%2F%20one/document?revisionId=server%20rev%201',
        method: 'GET',
      },
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

  it('does not expose a non-JSON API denial body', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('unauthorized: private upstream detail', { status: 401 });
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.workers()).rejects.toMatchObject({
        message: 'JOY Media request failed (401)',
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps structured JSON registration errors while sanitizing temporary HTML responses', async () => {
    const original = globalThis.fetch;
    let response = json(409, {
      error: { code: 'ASSET_EXISTS', message: 'The asset is already registered.' },
    });
    globalThis.fetch = async () => response;
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const registration = {
        id: 'asset-1',
        kind: 'video' as const,
        displayName: 'clip.mp4',
        sha256: 'a'.repeat(64),
        bytes: 10,
        descriptor: { mimeType: 'video/mp4' },
        locations: [{ kind: 'opfs-cache' as const, ref: 'opfs-a1' }],
      };

      await expect(client.registerAsset('project-1', registration)).rejects.toMatchObject({
        message: 'ASSET_EXISTS: The asset is already registered.',
      });

      response = new Response('<!DOCTYPE html><html>private gateway marker</html>', {
        status: 503,
        headers: { 'content-type': 'text/html' },
      });
      await expect(client.registerAsset('project-1', registration)).rejects.toMatchObject({
        message: 'JOY Media is temporarily unavailable (503). Try again shortly.',
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('turns a Cloudflare 524 original-upload page into a concise retryable error', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        '<!DOCTYPE html><html><title>A timeout occurred</title>private gateway marker</html>',
        {
          status: 524,
          headers: { 'content-type': 'text/html' },
        },
      );
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.uploadAssetOriginal(
          'project-1',
          {
            id: 'asset-1',
            sha256: 'a'.repeat(64),
            bytes: 10,
            descriptor: { mimeType: 'video/mp4' },
          },
          new Blob(['0123456789'], { type: 'video/mp4' }),
        ),
      ).rejects.toMatchObject({ message: 'JOY Media request timed out (524). Try again.' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('resumes large originals in authenticated parts and polls for cloud backing', async () => {
    const original = globalThis.fetch;
    const sessionId = `upload-${'b'.repeat(48)}`;
    const bytes = new Uint8Array(RESUMABLE_ORIGINAL_UPLOAD_THRESHOLD_BYTES + 123);
    const file = new Blob([bytes], { type: 'video/mp4' });
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly headers: Headers;
      readonly bodySize?: number;
    }> = [];
    const upload = (state: string, uploadedParts: number[]) => ({
      sessionId,
      state,
      partSize: 4 * 1024 * 1024,
      partCount: 3,
      uploadedParts,
    });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body;
      requests.push({
        url,
        method,
        headers: new Headers(init?.headers),
        ...(body instanceof Blob ? { bodySize: body.size } : {}),
      });
      if (url.endsWith('/complete')) {
        return json(202, { data: { upload: upload('committing', [0, 1, 2]) } });
      }
      if (url.endsWith(`/${sessionId}`)) {
        return json(200, {
          data: {
            upload: upload('complete', []),
            asset: {
              id: 'asset-1',
              projectId: 'project-1',
              kind: 'video',
              displayName: 'large.mp4',
              sha256: 'a'.repeat(64),
              bytes: file.size,
              descriptor: { mimeType: 'video/mp4' },
              createdAt: 1,
              cloudBacked: true,
            },
          },
        });
      }
      if (url.includes('/parts/')) {
        const partIndex = Number(url.split('/').at(-1));
        return json(200, {
          data: { upload: upload('uploading', partIndex === 1 ? [0, 1] : [0, 1, 2]) },
        });
      }
      return json(200, { data: { upload: upload('uploading', [0]) } });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.uploadAssetOriginal(
          'project-1',
          {
            id: 'asset-1',
            sha256: 'a'.repeat(64),
            bytes: file.size,
            descriptor: { mimeType: 'video/mp4' },
          },
          file,
        ),
      ).resolves.toMatchObject({ id: 'asset-1', cloudBacked: true });
    } finally {
      globalThis.fetch = original;
    }

    expect(requests.map(({ method, url }) => `${method} ${url.split('/').at(-1)}`)).toEqual([
      'POST uploads',
      'PUT 1',
      'PUT 2',
      'POST complete',
      `GET ${sessionId}`,
    ]);
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe('Bearer joy-session-token');
      expect(request.headers.get('x-joy-sha256')).toBe('a'.repeat(64));
      expect(request.headers.get('x-joy-bytes')).toBe(String(file.size));
      expect(request.headers.get('x-joy-mime-type')).toBe('video/mp4');
    }
    const partRequests = requests.filter(({ method }) => method === 'PUT');
    expect(partRequests.map(({ bodySize }) => bodySize)).toEqual([4 * 1024 * 1024, 123]);
    expect(
      partRequests.every(({ headers }) =>
        /^[a-f0-9]{64}$/.test(headers.get('x-joy-part-sha256') ?? ''),
      ),
    ).toBe(true);
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
      if (url.endsWith('/assets'))
        return json(201, {
          data: {
            id: 'asset-1',
            projectId: 'project-1',
            kind: 'video',
            displayName: 'clip.mp4',
            sha256: 'a'.repeat(64),
            bytes: 10,
            descriptor: { mimeType: 'video/mp4' },
            tags: [],
            sortName: 'clip.mp4',
            createdAt: 1,
            cloudBacked: false,
          },
        });
      if (url.endsWith('/jobs'))
        return json(201, {
          data: {
            id: 'job-1',
            projectId: 'project-1',
            type: 'asset.thumbnail',
            assetId: 'asset-1',
            state: 'queued',
            progress: 0,
            cancelRequested: false,
          },
        });
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

  it('projects asset and derivative responses while dropping storage-bearing descriptor fields', async () => {
    const original = globalThis.fetch;
    const unsafeAsset = {
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'image',
      displayName: 'frame.jpg',
      sha256: 'a'.repeat(64),
      bytes: 10,
      descriptor: {
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        locations: [{ kind: 'private-object', ref: 'private-key' }],
        credentials: 'secret',
      },
      tags: ['image'],
      sortName: 'frame.jpg',
      createdAt: 123,
      cloudBacked: true,
      locations: [{ kind: 'private-object', ref: 'private-key' }],
      objectKey: 'private-key',
    };
    globalThis.fetch = async () => {
      return json(200, { data: [unsafeAsset] });
    };
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      await expect(client.assets('project-1')).resolves.toEqual([
        {
          id: 'asset-1',
          projectId: 'project-1',
          kind: 'image',
          displayName: 'frame.jpg',
          sha256: 'a'.repeat(64),
          bytes: 10,
          descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
          tags: ['image'],
          sortName: 'frame.jpg',
          createdAt: 123,
          cloudBacked: true,
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects malformed asset and job responses at the browser boundary', async () => {
    const original = globalThis.fetch;
    let response: unknown;
    globalThis.fetch = async () => json(200, response);
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      response = { data: [{ id: 'asset-1', kind: 'image' }] };
      await expect(client.assets('project-1')).rejects.toThrow('invalid asset response');
      response = {
        data: [
          {
            id: 'job-1',
            projectId: 'project-1',
            type: 'image.comfy',
            state: 'completed',
            progress: 100,
            cancelRequested: false,
            derivative: {
              id: 'derivative-job-1',
              jobId: 'job-1',
              kind: 'image.comfy',
              sha256: 'a'.repeat(64),
              bytes: 5,
              workerRef: 'worker-1',
              resultRef: 'https://private.invalid/result',
              verifiedAt: 1,
            },
          },
        ],
      };
      await expect(client.jobs('project-1')).rejects.toThrow('invalid job response');
      response = {
        data: [
          {
            id: 'job-1',
            projectId: 'project-1',
            type: 'image.comfy',
            state: 'completed',
            progress: 101,
            cancelRequested: false,
          },
        ],
      };
      await expect(client.jobs('project-1')).rejects.toThrow('invalid job response');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes the caller abort signal through browser export remux', async () => {
    const abortController = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    let requestHeaders: HeadersInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      requestHeaders = init?.headers;
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
          90,
          abortController.signal,
        ),
      ).resolves.toMatchObject({ size: 3, type: 'video/mp4' });
    } finally {
      globalThis.fetch = original;
    }
    expect(requestSignal).toBe(abortController.signal);
    expect(requestHeaders).toMatchObject({
      'x-joy-frame-rate': '30',
      'x-joy-frame-count': '90',
    });
  });

  describe('syncProjectDocument', () => {
    it('sends PUT request to the correct endpoint with URL-encoded projectId', async () => {
      const requests: Array<{ readonly url: string; readonly method: string }> = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          method: init?.method ?? 'GET',
        });
        return json(200, { data: { projectId: 'project-1', revisionId: 'rev-1' } });
      };
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project-1',
          title: 'Test Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'en' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        await client.syncProjectDocument('project-1', {
          baseRevisionId: '',
          revisionId: 'rev-1',
          document: mockDocument,
        });
      } finally {
        globalThis.fetch = original;
      }
      expect(requests).toEqual([
        {
          url: 'https://media.joyteam.ir/api/v1/projects/project-1/document',
          method: 'PUT',
        },
      ]);
    });

    it('includes authorization header', async () => {
      const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get('authorization');
        requests.push({ url, ...(authorization === null ? {} : { authorization }) });
        return json(200, { data: { projectId: 'project-1', revisionId: 'rev-1' } });
      };
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project-1',
          title: 'Test Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'en' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        await client.syncProjectDocument('project-1', {
          baseRevisionId: '',
          revisionId: 'rev-1',
          document: mockDocument,
        });
      } finally {
        globalThis.fetch = original;
      }
      expect(requests).toEqual([
        {
          url: 'https://media.joyteam.ir/api/v1/projects/project-1/document',
          authorization: 'Bearer joy-session-token',
        },
      ]);
    });

    it('sends exact envelope shape with baseRevisionId, revisionId, and document', async () => {
      const requests: Array<{ readonly url: string; readonly body?: string }> = [];
      const original = globalThis.fetch;
      const mockDocument = {
        schemaVersion: 1 as const,
        id: 'project-1',
        title: 'Test Project',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        rootCompositionId: 'comp-1',
        settings: { defaultLocale: 'en' },
        compositions: {},
        assets: {},
        variables: {},
        markers: [],
        visualObjects: {},
        captionDocuments: {},
        pluginData: {},
      };
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
        return json(200, { data: { projectId: 'project-1', revisionId: 'rev-1' } });
      };
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        await client.syncProjectDocument('project-1', {
          baseRevisionId: 'base-rev-1',
          revisionId: 'rev-1',
          document: mockDocument,
        });
      } finally {
        globalThis.fetch = original;
      }
      expect(requests).toHaveLength(1);
      const body = JSON.parse(requests[0]!.body!);
      expect(body).toEqual({
        baseRevisionId: 'base-rev-1',
        revisionId: 'rev-1',
        document: mockDocument,
      });
    });

    it('preserves Persian/RTL text in JSON document', async () => {
      const requests: Array<{ readonly url: string; readonly body?: string }> = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
        return json(200, { data: { projectId: 'project-1', revisionId: 'rev-1' } });
      };
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project-1',
          title: 'پروژه تست',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'fa' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        await client.syncProjectDocument('project-1', {
          baseRevisionId: '',
          revisionId: 'rev-1',
          document: mockDocument,
        });
      } finally {
        globalThis.fetch = original;
      }
      expect(requests).toHaveLength(1);
      const body = JSON.parse(requests[0]!.body!);
      expect(body.document.title).toBe('پروژه تست');
    });

    it('returns typed response with projectId and revisionId', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async () =>
        json(200, { data: { projectId: 'project-123', revisionId: 'rev-abc' } });
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project-123',
          title: 'Test Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'en' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        const result = await client.syncProjectDocument('project-123', {
          baseRevisionId: '',
          revisionId: 'rev-abc',
          document: mockDocument,
        });
        expect(result).toEqual({ projectId: 'project-123', revisionId: 'rev-abc' });
      } finally {
        globalThis.fetch = original;
      }
    });

    it('propagates API errors', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async () =>
        json(404, { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } });
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project-1',
          title: 'Test Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'en' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        await expect(
          client.syncProjectDocument('project-1', {
            baseRevisionId: '',
            revisionId: 'rev-1',
            document: mockDocument,
          }),
        ).rejects.toThrow('PROJECT_NOT_FOUND: Project not found');
      } finally {
        globalThis.fetch = original;
      }
    });

    it('URL-encodes special characters in projectId', async () => {
      const requests: Array<{ readonly url: string }> = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL) => {
        requests.push({ url: String(input) });
        return json(200, { data: { projectId: 'project/1', revisionId: 'rev-1' } });
      };
      try {
        const client = new BrowserControlPlaneClient(
          'https://media.joyteam.ir/api',
          () => 'joy-session-token',
        );
        const mockDocument = {
          schemaVersion: 1 as const,
          id: 'project/1',
          title: 'Test Project',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          rootCompositionId: 'comp-1',
          settings: { defaultLocale: 'en' },
          compositions: {},
          assets: {},
          variables: {},
          markers: [],
          visualObjects: {},
          captionDocuments: {},
          pluginData: {},
        };
        await client.syncProjectDocument('project/1', {
          baseRevisionId: '',
          revisionId: 'rev-1',
          document: mockDocument,
        });
      } finally {
        globalThis.fetch = original;
      }
      expect(requests).toEqual([
        {
          url: 'https://media.joyteam.ir/api/v1/projects/project%2F1/document',
        },
      ]);
    });
  });

});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
