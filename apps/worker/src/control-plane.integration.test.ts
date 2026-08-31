import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalControlPlane } from '@joy-media/api';
import { renderFixture, verifyExport } from '@joy-media/export-core';
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
});
