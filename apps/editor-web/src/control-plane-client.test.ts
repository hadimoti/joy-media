import { describe, expect, it } from 'vitest';
import { validateWorkerJobV1 } from '@joy-media/job-protocol';
import { createQueuedProductionRunRecord } from '@joy-media/workflow-engine';
import { BrowserControlPlaneClient } from './control-plane-client.js';

describe('BrowserControlPlaneClient', () => {
  it('creates a typed recovered copy with the exact stale-revision contract', async () => {
    let request: { readonly url: string; readonly init?: RequestInit } | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), ...(init === undefined ? {} : { init }) };
      return json(201, {
        data: {
          kind: 'recovered-copy',
          projectId: 'recovered-project-1',
          name: 'Campaign (Recovered copy)',
          document: { schemaVersion: 2, projectId: 'recovered-project-1' },
          basedOnRevision: 3,
          serverRevision: 7,
          createdAt: '2026-08-26T00:00:00.000Z',
          provenance: {
            sourceProjectId: 'source-project-1',
            baseRevision: 3,
            sourceHeadRevision: 7,
            operation: {
              kind: 'append',
              document: { schemaVersion: 2, projectId: 'source-project-1' },
            },
            requestedDocumentHash: 'hash-requested',
          },
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      await expect(
        client.recoverStaleRevision('source/project', {
          baseRevision: 3,
          idempotencyKey: 'recover-1',
          suggestedName: 'Campaign (Recovered copy)',
          operation: {
            kind: 'append',
            document: { schemaVersion: 2, projectId: 'source-project-1' },
          },
        }),
      ).resolves.toMatchObject({
        kind: 'recovered-copy',
        projectId: 'recovered-project-1',
        provenance: { sourceProjectId: 'source-project-1', sourceHeadRevision: 7 },
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(request?.url).toBe('/api/v2/projects/source%2Fproject/recovered-copies');
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      baseRevision: 3,
      idempotencyKey: 'recover-1',
      suggestedName: 'Campaign (Recovered copy)',
      operation: {
        kind: 'append',
        document: { schemaVersion: 2, projectId: 'source-project-1' },
      },
    });
  });

  it('preserves recovery API error codes and status', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      json(409, { error: { code: 'REVISION_CONFLICT', message: 'stale source revision' } });
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      await expect(
        client.recoverStaleRevision('source-project', {
          baseRevision: 1,
          idempotencyKey: 'recover-2',
          suggestedName: 'Recovered',
          operation: {
            kind: 'restore',
            targetRevision: 1,
          },
        }),
      ).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
        status: 409,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('does not make a recovery request without a session token', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error('network should not be reached');
    };
    try {
      const client = new BrowserControlPlaneClient('/api', () => undefined);
      await expect(
        client.recoverStaleRevision('source-project', {
          baseRevision: 1,
          idempotencyKey: 'recover-3',
          suggestedName: 'Recovered',
          operation: { kind: 'restore', targetRevision: 1 },
        }),
      ).rejects.toThrow('JOY Media session required');
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(false);
  });

  it('returns typed restore metadata including its source revision', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      json(201, {
        data: {
          projectId: 'project-1',
          revision: 2,
          baseRevision: 1,
          idempotencyKey: 'restore-1',
          operation: {
            kind: 'restore',
            idempotencyKey: 'restore-1',
            label: 'restore revision 1',
            targetRevision: 1,
          },
          document: { schemaVersion: 2, projectId: 'project-1' },
          documentHash: 'hash',
          createdAt: 'now',
        },
      });
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      const restored = await client.restoreProjectRevision('project-1', {
        baseRevision: 1,
        revision: 1,
        idempotencyKey: 'restore-1',
      });
      expect(restored.operation).toMatchObject({ kind: 'restore', targetRevision: 1 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends the selected reference asset without claiming server-side range trimming', async () => {
    let requestBody = '';
    const original = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return json(200, {
        data: {
          language: 'en-US',
          words: [],
          speakers: [],
          provenance: { providerId: 'whisper', modelId: 'tiny', createdAt: 'now' },
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await client.transcribeSpeech('en-US', {
        referenceAssetId: 'asset-selected',
        sourceStartUs: 2_000_000,
        sourceDurationUs: 4_000_000,
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(JSON.parse(requestBody)).toEqual({
      language: 'en-US',
      referenceAssetId: 'asset-selected',
    });
  });

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
      if (authorization === null) requests.push({ url });
      else requests.push({ url, authorization });
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

  it('fetches render artifact bytes only from the authenticated Media API', async () => {
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push({ url, ...(authorization === null ? {} : { authorization }) });
      return new Response('mp4', { status: 200, headers: { 'content-type': 'video/mp4' } });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.renderArtifactBytes('project-1', 'artifact-job-1-aaaaaaaaaaaaaaaa'),
      ).resolves.toMatchObject({
        type: 'video/mp4',
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/render-artifacts/artifact-job-1-aaaaaaaaaaaaaaaa/content',
        authorization: 'Bearer joy-session-token',
      },
    ]);
  });

  it('projects every asset response and nested descriptor before exposing it to editor code', async () => {
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
        cloudRef: 'private-descriptor-ref',
        credentials: 'descriptor-credential',
      },
      tags: ['image'],
      sortName: 'frame.jpg',
      createdAt: 123,
      locations: [{ kind: 'private-object', ref: 'private-object-key' }],
      cloudRef: 'private-object-key',
      objectKey: 'private-object-key',
      credentials: 'credential-value',
    };
    const unsafeDerivative = {
      id: 'derivative-1',
      projectId: 'project-1',
      assetId: 'asset-1',
      kind: 'thumbnail',
      profile: 'jpeg-640',
      sha256: 'b'.repeat(64),
      bytes: 5,
      descriptor: {
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        objectKey: 'private-derivative-key',
      },
      availability: 'available-cloud',
      verifiedAt: 456,
      locations: [{ kind: 'private-object', ref: 'private-derivative-key' }],
    };
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/original'))
        return json(201, { data: { asset: unsafeAsset, tagProvenance: 'heuristic' } });
      if (url.endsWith('/derivatives')) return json(200, { data: [unsafeDerivative] });
      if (url.includes('/library/')) return json(200, { data: [unsafeAsset] });
      if (url.endsWith('/retag')) return json(200, { data: unsafeAsset });
      if (url.endsWith('/assets') && init?.method === 'POST')
        return json(201, { data: unsafeAsset });
      return json(200, { data: [unsafeAsset] });
    };
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      const assets = [
        ...(await client.assets('project-1')),
        ...(await client.sharedCloudAssets()),
        ...(await client.myAssets()),
        await client.registerAsset('project-1', {
          id: 'asset-1',
          kind: 'image',
          displayName: 'frame.jpg',
          sha256: 'a'.repeat(64),
          bytes: 10,
          descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
          locations: [{ kind: 'opfs-cache', ref: 'opfs-a1' }],
        }),
        await client.uploadAssetOriginal(
          'project-1',
          {
            id: 'asset-1',
            sha256: 'a'.repeat(64),
            bytes: 10,
            descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
          },
          new Blob(['image']),
        ),
        await client.retagAsset('project-1', 'asset-1'),
      ];
      const derivatives = await client.derivatives('project-1', 'asset-1');

      for (const asset of assets) {
        expect(asset).toEqual({
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
        });
      }
      expect(derivatives).toEqual([
        {
          id: 'derivative-1',
          projectId: 'project-1',
          assetId: 'asset-1',
          kind: 'thumbnail',
          profile: 'jpeg-640',
          sha256: 'b'.repeat(64),
          bytes: 5,
          descriptor: { mimeType: 'image/jpeg', width: 1, height: 1 },
          availability: 'available-cloud',
          verifiedAt: 456,
        },
      ]);
      expect(JSON.stringify({ assets, derivatives })).not.toMatch(
        /locations|cloudRef|objectKey|credentials|private-object-key|private-descriptor-ref|private-derivative-key/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects malformed asset responses instead of casting them into the editor', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => json(200, { data: [{ id: 'asset-without-safe-shape' }] });
    try {
      const client = new BrowserControlPlaneClient('/api', () => 'token');
      await expect(client.assets('project-1')).rejects.toThrow(
        'JOY Media API returned an invalid asset response',
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('registers only asset metadata and explicit sync consent through the owner API', async () => {
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

  it('refreshes authoritative sync state when ensuring an existing project', async () => {
    const requests: Array<{ readonly url: string; readonly method?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.method === undefined ? {} : { method: init.method }) });
      if (url.endsWith('/v1/projects')) {
        return json(409, { error: { code: 'PROJECT_EXISTS', message: 'project-1' } });
      }
      return json(200, {
        data: {
          id: 'project-1',
          title: 'Project',
          revision: 2,
          ownerId: 'owner',
          assetSyncEnabled: true,
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(client.ensureProject('project-1', 'Project')).resolves.toMatchObject({
        id: 'project-1',
        assetSyncEnabled: true,
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(requests).toEqual([
      { url: 'https://media.joyteam.ir/api/v1/projects', method: 'POST' },
      { url: 'https://media.joyteam.ir/api/v1/projects/project-1', method: 'GET' },
    ]);
  });

  it('queues one executable render export job with a bundle and linked report reference', async () => {
    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      return json(201, {
        data: {
          id: 'job-1',
          projectId: 'project-1',
          type: 'render.export',
          state: 'queued',
          progress: 0,
          cancelRequested: false,
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const payload = {
        projectRef: 'project-1',
        compositionId: 'root-composition',
        presetId: 'reels-1080',
        reportRef: 'report-delivery-1',
        bundle: renderBundle(),
      };
      await client.enqueueRenderExport('project-1', 'delivery-1-export', payload);
    } finally {
      globalThis.fetch = original;
    }

    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    const { id, ...workerJobFields } = body;
    expect(() =>
      validateWorkerJobV1({
        ...workerJobFields,
        jobId: id,
      } as Parameters<typeof validateWorkerJobV1>[0]),
    ).not.toThrow();
    expect(requests).toEqual([
      {
        url: 'https://media.joyteam.ir/api/v1/projects/project-1/jobs',
        body: expect.stringContaining('"bundle":{"version":1'),
      },
    ]);
    expect(requests[0]?.body).toContain('"opaqueRef":"asset:clip"');
    expect(requests[0]?.body).not.toContain('C:\\');
  });

  it('uses authenticated production-run routes with record refs instead of local media payloads', async () => {
    const requests: Array<{
      readonly url: string;
      readonly method?: string;
      readonly body?: string;
    }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        ...(init?.method === undefined ? {} : { method: init.method }),
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      if (url.includes('/production-runs?')) {
        return json(200, {
          data: {
            runs: [
              {
                recordVersion: 1,
                runId: 'run-1',
                workflowId: 'workflow-1',
                workflowVersion: '1.0.0',
                projectRevision: 'project-revision-1',
                state: 'queued',
                checkpointRevision: 0,
                links: {},
                events: [],
                approvals: [],
                nodes: [],
                createdSeq: 1,
                updatedSeq: 1,
              },
            ],
          },
        });
      }
      return json(200, {
        data: {
          recordVersion: 1,
          runId: 'run-1',
          workflowId: 'workflow-1',
          workflowVersion: '1.0.0',
          projectRevision: 'project-revision-1',
          state: 'queued',
          checkpointRevision: 0,
          links: {},
          events: [],
          approvals: [],
          nodes: [],
          createdSeq: 1,
          updatedSeq: 1,
          snapshot: { snapshotVersion: 1, counts: {}, runs: [] },
        },
      });
    };
    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      const record = createQueuedProductionRunRecord({
        runId: 'run-1',
        workflowId: 'workflow-1',
        workflowVersion: '1.0.0',
        projectRevision: 'project-revision-1',
        links: { artifactIds: ['asset:clip'] },
        authority: { principalId: 'owner-1', role: 'owner' },
      });
      await client.createProductionRun('project-1', {
        runKey: 'run-key-1',
        authority: { principalId: 'owner-1', role: 'owner' },
        record,
      });
      await expect(
        client.productionRuns('project-1', { limit: 25, cursor: 'next', state: 'queued' }),
      ).resolves.toMatchObject({
        runs: [
          {
            runId: 'run-1',
          },
        ],
      });
      await client.productionRun('project-1', 'run-1');
      await client.updateProductionRunCheckpoint('project-1', {
        runId: 'run-1',
        expectedRevision: 0,
        checkpoint: {
          checkpointVersion: 1,
          runId: 'run-1',
          workflowId: 'workflow-1',
          workflowVersion: '1.0.0',
          projectRevision: 'project-revision-1',
          state: 'succeeded',
          nodes: {},
        },
        authority: { principalId: 'owner-1', role: 'owner' },
      });
      await client.respondToProductionRunApproval('project-1', 'run-1', {
        approvalId: 'approval-1',
        approved: true,
        responseRef: 'decision:approval-1',
        response: { approved: true },
        rejectionReason: 'not used on approval',
        expectedUpdatedSeq: 2,
        authority: { principalId: 'owner-1', role: 'owner' },
      });
      await client.cancelProductionRun('project-1', 'run-1', {
        authority: { principalId: 'owner-1', role: 'owner' },
        expectedUpdatedSeq: 3,
      });
    } finally {
      globalThis.fetch = original;
    }

    expect(requests.map((request) => request.url)).toEqual([
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs',
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs?limit=25&cursor=next&state=queued',
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1',
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/checkpoint',
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/approvals/approval-1/respond',
      'https://media.joyteam.ir/api/v1/projects/project-1/production-runs/run-1/cancel',
    ]);
    expect(requests[0]?.body).toContain('"runKey":"run-key-1"');
    expect(requests[0]?.body).toContain('"authority":{"principalId":"owner-1","role":"owner"}');
    expect(requests[0]?.body).toContain('"artifactIds":["asset:clip"]');
    expect(requests[4]?.body).toContain('"expectedUpdatedSeq":2');
    expect(requests[4]?.body).toContain('"response":{"approved":true}');
    expect(requests[4]?.body).toContain('"rejectionReason":"not used on approval"');
    expect(requests[5]?.body).toContain('"expectedUpdatedSeq":3');
    expect(JSON.stringify(requests)).not.toContain('C:\\');
    expect(JSON.stringify(requests)).not.toContain('bytesBase64');
  });
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderBundle() {
  return {
    version: 1,
    timelineProject: {
      schemaVersion: 0,
      id: 'timeline',
      rootCompositionId: 'root',
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 1080,
          height: 1920,
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          tracks: [],
        },
      },
    },
    visualProject: {
      schemaVersion: 1,
      id: 'visual',
      title: 'Visual',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      rootCompositionId: 'root',
      settings: { defaultLocale: 'en' },
      compositions: {
        root: {
          id: 'root',
          name: 'Root',
          width: 1080,
          height: 1920,
          pixelAspectRatio: { num: 1, den: 1 },
          frameRate: { num: 30, den: 1 },
          durationUs: 1_000_000,
          background: '#000000',
          tracks: [],
        },
      },
      assets: { clip: { id: 'clip', kind: 'video', displayName: 'Clip' } },
      variables: {},
      markers: [],
      visualObjects: {},
      captionDocuments: {},
      pluginData: {},
    },
    compositionId: 'root',
    outputPreset: 'reels-1080',
    seed: 'delivery-1',
    assets: {
      clip: {
        id: 'clip',
        kind: 'video',
        displayName: 'Clip',
        opaqueRef: 'asset:clip',
        availability: 'ready',
      },
    },
  };
}
