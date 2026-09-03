import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalControlPlane,
  type Actor,
  type AssetLocationRecord,
  type MediaAssetRecord,
} from './control-plane.js';
import { createControlPlaneHttpServer } from './http-server.js';
import { DisabledMediaAuth } from './media-auth.js';
import type { PrivateObjectDescriptor, PrivateObjectStore } from './private-object-store.js';
import {
  ORIGINAL_UPLOAD_PART_BYTES,
  ResumableOriginalUploadCoordinator,
} from './resumable-original-upload.js';

const servers: Server[] = [];
const stagingDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
  for (const directory of stagingDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resumable original upload HTTP protocol', () => {
  it('accepts idempotent 4 MiB parts, finalizes asynchronously, and reports cloud backing', async () => {
    const actor = { id: 'owner-1' };
    const controlPlane = new RecordingControlPlane();
    const bytes = new Uint8Array(19);
    bytes.fill(0x61);
    const sha256 = digest(bytes);
    controlPlane.createProject(actor, 'project-1', 'Project');
    controlPlane.registerAsset(actor, 'project-1', {
      id: 'asset-1',
      kind: 'video',
      displayName: 'large.mp4',
      sha256,
      bytes: bytes.byteLength,
      descriptor: { mimeType: 'video/mp4', durationUs: 1_000_000 },
      locations: [{ kind: 'opfs-cache', ref: 'opfs-large' }],
    });

    const stagingDirectory = mkdtempSync(join(tmpdir(), 'joy-upload-test-'));
    stagingDirectories.push(stagingDirectory);
    const store = new DeferredPrivateObjectStore();
    const coordinator = new ResumableOriginalUploadCoordinator({
      rootDirectory: stagingDirectory,
      controlPlane,
      privateObjectStore: store,
    });
    const server = createControlPlaneHttpServer({
      controlPlane,
      authentication: {
        authenticate: (request) =>
          request.headers.authorization === 'Bearer test-token' ? actor : undefined,
      },
      mediaAuth: new DisabledMediaAuth(),
      privateObjectStore: store,
      resumableOriginalUploads: coordinator,
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server unavailable');
    const baseUrl = `http://127.0.0.1:${address.port}/v1/projects/project-1/assets/asset-1/original/uploads`;
    const identityHeaders = {
      authorization: 'Bearer test-token',
      'x-joy-sha256': sha256,
      'x-joy-bytes': String(bytes.byteLength),
      'x-joy-mime-type': 'video/mp4',
    };

    const rejected = await fetch(baseUrl, {
      method: 'POST',
      headers: { ...identityHeaders, 'x-joy-bytes': String(bytes.byteLength + 1) },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'REQUEST_INVALID' } });

    const created = await fetchJson(baseUrl, { method: 'POST', headers: identityHeaders });
    expect(created.status).toBe(200);
    const sessionId = uploadFrom(created.body).sessionId;
    expect(uploadFrom(created.body)).toMatchObject({
      state: 'uploading',
      partSize: ORIGINAL_UPLOAD_PART_BYTES,
      partCount: 1,
      uploadedParts: [],
    });

    const putPart = async (index: number, part: Uint8Array) =>
      fetchJson(`${baseUrl}/${sessionId}/parts/${index}`, {
        method: 'PUT',
        headers: {
          ...identityHeaders,
          'content-type': 'video/mp4',
          'x-joy-part-sha256': digest(part),
        },
        body: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer,
      });
    expect((await putPart(0, bytes)).status).toBe(200);
    expect((await putPart(0, bytes)).status).toBe(200);

    const finalized = await fetchJson(`${baseUrl}/${sessionId}/complete`, {
      method: 'POST',
      headers: identityHeaders,
    });
    expect(finalized.status).toBe(202);
    expect(uploadFrom(finalized.body).state).toBe('committing');

    const committing = await fetchJson(`${baseUrl}/${sessionId}`, {
      method: 'GET',
      headers: identityHeaders,
    });
    expect(uploadFrom(committing.body).state).toBe('committing');
    await store.started;
    store.release();

    let completed: Awaited<ReturnType<typeof fetchJson>> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      completed = await fetchJson(`${baseUrl}/${sessionId}`, {
        method: 'GET',
        headers: identityHeaders,
      });
      if (uploadFrom(completed.body).state === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(completed?.status).toBe(200);
    expect(completed?.body).toMatchObject({
      data: { upload: { state: 'complete' }, asset: { id: 'asset-1', cloudBacked: true } },
    });
    expect(JSON.stringify(completed?.body)).not.toMatch(/upload-test-|private-object|orig-/i);
    expect(store.objects).toHaveLength(1);
    expect(store.objects[0]?.bytes).toEqual(bytes);
    expect(controlPlane.commitEvents).toEqual(['metadata', 'attach']);
  });
});

class RecordingControlPlane extends LocalControlPlane {
  readonly commitEvents: string[] = [];

  override updateAssetMetadata(
    actor: Actor,
    projectId: string,
    assetId: string,
    patch: { readonly tags?: readonly string[]; readonly sortName?: string },
  ): MediaAssetRecord {
    this.commitEvents.push('metadata');
    return super.updateAssetMetadata(actor, projectId, assetId, patch);
  }

  override attachCloudOriginal(
    actor: Actor,
    projectId: string,
    assetId: string,
    location: AssetLocationRecord & { readonly kind: 'private-object' },
  ): MediaAssetRecord {
    this.commitEvents.push('attach');
    return super.attachCloudOriginal(actor, projectId, assetId, location);
  }
}

class DeferredPrivateObjectStore implements PrivateObjectStore {
  readonly objects: Array<{
    readonly descriptor: PrivateObjectDescriptor;
    readonly bytes: Uint8Array;
  }> = [];
  readonly started: Promise<void>;
  readonly #gate: Promise<void>;
  #markStarted!: () => void;
  #release!: () => void;

  constructor() {
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    this.#markStarted();
    await this.#gate;
    this.objects.push({ descriptor, bytes: bytes.slice() });
  }

  async get(): Promise<Uint8Array> {
    throw new Error('not used');
  }

  async remove(): Promise<void> {}
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

function uploadFrom(body: unknown): {
  readonly sessionId: string;
  readonly state: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly uploadedParts: readonly number[];
} {
  return (
    body as {
      readonly data: {
        readonly upload: {
          readonly sessionId: string;
          readonly state: string;
          readonly partSize: number;
          readonly partCount: number;
          readonly uploadedParts: readonly number[];
        };
      };
    }
  ).data.upload;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
