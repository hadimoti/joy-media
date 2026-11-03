import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createControlPlaneHttpServer,
  LocalControlPlane,
  MemoryPrivateObjectStore,
} from '@joy-media/test-control-plane';
import { renderFixture, verifyExport } from '@joy-media/export-core';
import { WorkerControlPlaneClient } from './control-plane-client.js';
import type { DeviceIdentity } from './runtime.js';
import { executeLeasedExport } from './export-job.js';
describe('Worker/control-plane export integration', () => {
  it('pairs, leases, renders, verifies, completes, and replays events', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.registerAsset(owner, 'project', {
      id: 'source',
      kind: 'video',
      displayName: 'source.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1,
      descriptor: { mimeType: 'video/mp4', width: 64, height: 36, durationUs: 100_000 },
      locations: [{ kind: 'private-object', ref: 'source-object' }],
    });
    api.pairWorker(owner, 'worker');
    api.helloWorker('worker', ['render.export']);
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now, 'source', {
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 3,
      manifest: {
        projectId: 'project',
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'reels-1080',
      },
    });
    const lease = api.lease('worker', now + 1);
    expect(lease?.id).toBe('job');
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-integration-'));
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'output.mp4');
    const manifest = {
      projectId: 'project',
      revision: 0,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'reels-1080' as const,
    };
    renderFixture(manifest, source);
    const result = executeLeasedExport(
      { complete: () => undefined },
      'worker',
      'job',
      {
        sourcePath: source,
        payload: {
          schemaVersion: 1,
          frameCount: 3,
          producer: 'browser-staged-preview-export',
          manifest,
        },
      },
      output,
      lease?.leaseToken,
    );
    const bytes = readFileSync(result.outputPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const probe = verifyExport(result.outputPath);
    const receipt = {
      kind: 'render.export' as const,
      assetId: 'source',
      sha256,
      bytes: bytes.length,
      localRef: 'export-job-1',
      descriptor: {
        mimeType: 'video/mp4' as const,
        width: probe.width,
        height: probe.height,
        durationUs: probe.durationUs,
      },
    };
    api.registerWorkerCloudDerivative(
      'worker',
      'job',
      {
        id: 'derivative-job',
        assetId: 'source',
        kind: 'proxy',
        profile: 'joy-export-h264-aac',
        sha256,
        bytes: bytes.length,
        descriptor: receipt.descriptor,
        availability: 'available-cloud',
        locations: [{ kind: 'private-object', ref: 'derivative-object' }],
      },
      now + 2,
      lease?.leaseToken,
    );
    api.complete('worker', 'job', now + 3, receipt, lease?.leaseToken);
    expect(api.eventsAfter(owner, 'project', 0).map((event) => event.type)).toEqual([
      'queued',
      'leased',
      'completed',
    ]);
  });
  it('recovers from an expired Worker lease without accepting stale completion', () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    api.createProject(owner, 'project', 'Reference');
    api.registerAsset(owner, 'project', {
      id: 'source',
      kind: 'video',
      displayName: 'source.mp4',
      sha256: 'a'.repeat(64),
      bytes: 1,
      descriptor: { mimeType: 'video/mp4', width: 64, height: 36, durationUs: 100_000 },
      locations: [{ kind: 'private-object', ref: 'source-object' }],
    });
    api.pairWorker(owner, 'worker-old');
    api.pairWorker(owner, 'worker-new');
    api.helloWorker('worker-old', ['render.export']);
    api.helloWorker('worker-new', ['render.export']);
    const now = Date.now();
    api.enqueue(owner, 'job', 'project', 'render.export', now, 'source', {
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 3,
      manifest: {
        projectId: 'project',
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'reels-1080',
      },
    });
    const oldLease = api.lease('worker-old', now + 1, 5);
    expect(oldLease?.leaseOwner).toBe('worker-old');
    const newLease = api.lease('worker-new', now + 6, 30_000);
    expect(newLease?.leaseOwner).toBe('worker-new');
    expect(() => api.complete('worker-old', 'job', now + 7)).toThrow(
      expect.objectContaining({ code: 'LEASE_NOT_OWNED' }),
    );
    const directory = mkdtempSync(join(tmpdir(), 'joy-media-recovered-export-'));
    const source = join(directory, 'source.mp4');
    const output = join(directory, 'output.mp4');
    const manifest = {
      projectId: 'project',
      revision: 0,
      width: 64,
      height: 36,
      frameRate: 30,
      durationUs: 100_000,
      preset: 'reels-1080' as const,
    };
    renderFixture(manifest, source);
    const result = executeLeasedExport(
      { complete: () => undefined },
      'worker-new',
      'job',
      {
        sourcePath: source,
        payload: {
          schemaVersion: 1,
          frameCount: 3,
          producer: 'browser-staged-preview-export',
          manifest,
        },
      },
      output,
      newLease?.leaseToken,
    );
    const bytes = readFileSync(result.outputPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const probe = verifyExport(result.outputPath);
    const receipt = {
      kind: 'render.export' as const,
      assetId: 'source',
      sha256,
      bytes: bytes.length,
      localRef: 'export-job-recovered',
      descriptor: {
        mimeType: 'video/mp4' as const,
        width: probe.width,
        height: probe.height,
        durationUs: probe.durationUs,
      },
    };
    api.registerWorkerCloudDerivative(
      'worker-new',
      'job',
      {
        id: 'derivative-job',
        assetId: 'source',
        kind: 'proxy',
        profile: 'joy-export-h264-aac',
        sha256,
        bytes: bytes.length,
        descriptor: receipt.descriptor,
        availability: 'available-cloud',
        locations: [{ kind: 'private-object', ref: 'derivative-object-recovered' }],
      },
      now + 8,
      newLease?.leaseToken,
    );
    api.complete('worker-new', 'job', now + 9, receipt, newLease?.leaseToken);
    expect(api.eventsAfter(owner, 'project', 0).at(-1)?.type).toBe('completed');
  });

  it('downloads a leased source and uploads its derivative over the Worker HTTP client', async () => {
    const api = new LocalControlPlane();
    const owner = { id: 'owner' };
    const workerId = 'worker-http';
    const projectId = 'project-http';
    const jobId = 'job-http';
    const sourceBytes = new Uint8Array([1, 2, 3, 4]);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const objectStore = new MemoryPrivateObjectStore();
    api.createProject(owner, projectId, 'HTTP Worker fixture');
    api.registerAsset(owner, projectId, {
      id: 'source-http',
      kind: 'video',
      displayName: 'source.mp4',
      sha256: sourceSha256,
      bytes: sourceBytes.byteLength,
      descriptor: { mimeType: 'video/mp4', width: 64, height: 36, durationUs: 100_000 },
      locations: [{ kind: 'private-object', ref: 'source-http-object' }],
    });
    await objectStore.put(
      {
        ref: 'source-http-object',
        sha256: sourceSha256,
        bytes: sourceBytes.byteLength,
        mimeType: 'video/mp4',
      },
      sourceBytes,
    );
    const pairingCode = 'pairing-code-http';
    const sessionToken = 'worker-session-http';
    const now = Date.now();
    const hashToken = (value: string) => createHash('sha256').update(value).digest('base64url');
    const pairingCodeHash = hashToken(pairingCode);
    api.createPairingOffer(workerId, pairingCodeHash, now + 60_000);
    api.approvePairing(owner, workerId, pairingCodeHash, now);
    api.claimWorkerSession(workerId, pairingCodeHash, hashToken(sessionToken), now + 60_000, now);
    api.helloWorker(workerId, ['render.export'], [], now);
    api.enqueue(owner, jobId, projectId, 'render.export', now, 'source-http', {
      schemaVersion: 1,
      producer: 'browser-staged-preview-export',
      frameCount: 3,
      manifest: {
        projectId,
        revision: 0,
        width: 64,
        height: 36,
        frameRate: 30,
        durationUs: 100_000,
        preset: 'reels-1080',
      },
    });

    const server = createControlPlaneHttpServer({
      controlPlane: api,
      authentication: { authenticate: () => owner },
      privateObjectStore: objectStore,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('test server did not bind');
    const identity: DeviceIdentity = { workerId, createdAt: new Date(now).toISOString() };
    let currentSession: string | undefined = sessionToken;
    const client = new WorkerControlPlaneClient({
      apiUrl: `http://127.0.0.1:${address.port}`,
      identity,
      sessionStore: {
        loadWorkerSession: () => currentSession,
        clearWorkerSession: () => {
          currentSession = undefined;
        },
      },
    });

    try {
      const lease = await client.lease();
      expect(lease).toMatchObject({ id: jobId, assetId: 'source-http' });
      const sourcePath = join(mkdtempSync(join(tmpdir(), 'source-download-')), 'source.mp4');
      await client.downloadJobAsset(jobId, lease!.leaseToken, sourcePath);
      expect(new Uint8Array(readFileSync(sourcePath))).toEqual(new Uint8Array(sourceBytes));

      const derivativeBytes = new Uint8Array([9, 8, 7, 6]);
      const sha256 = createHash('sha256').update(derivativeBytes).digest('hex');
      await client.uploadDerivative(
        jobId,
        {
          kind: 'render.export',
          assetId: 'source-http',
          sha256,
          bytes: derivativeBytes.byteLength,
          descriptor: { mimeType: 'video/mp4', width: 64, height: 36, durationUs: 100_000 },
        },
        derivativeBytes,
        lease!.leaseToken,
      );

      const derivatives = api.derivativesForAsset(owner, projectId, 'source-http');
      expect(derivatives).toHaveLength(1);
      expect(derivatives[0]).toMatchObject({
        availability: 'available-cloud',
        sha256,
        bytes: derivativeBytes.byteLength,
        locations: [{ kind: 'private-object' }],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
