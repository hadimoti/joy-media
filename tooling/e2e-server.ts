import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { executeLeasedExport, type ExportJobPayload } from '../apps/worker/src/export-job.js';
import { verifyExport } from '@joy-media/export-core';
import { createControlPlaneHttpServer, LocalControlPlane } from '../apps/api/src/index.js';
import type { ApiAuthentication } from '../apps/api/src/http-server.js';
import type { MediaAuthApi, MediaAuthMethod } from '../apps/api/src/media-auth.js';
import type {
  MediaAssetRecord,
  PrivateObjectDescriptor,
  PrivateObjectStore,
} from '../apps/api/src/index.js';

/** Test-only owner/session. This file is never imported by production builds. */
export const E2E_TOKEN = 'joy-media-e2e-token';
export const E2E_OWNER = 'e2e-owner@example.test';

class MemoryPrivateObjectStore implements PrivateObjectStore {
  readonly #objects = new Map<
    string,
    { readonly descriptor: PrivateObjectDescriptor; readonly bytes: Uint8Array }
  >();

  async put(descriptor: PrivateObjectDescriptor, bytes: Uint8Array): Promise<void> {
    this.#objects.set(descriptor.ref, { descriptor, bytes: new Uint8Array(bytes) });
  }

  async get(descriptor: PrivateObjectDescriptor): Promise<Uint8Array> {
    const object = this.#objects.get(descriptor.ref);
    if (object === undefined) throw new Error(`test object ${descriptor.ref} is missing`);
    return new Uint8Array(object.bytes);
  }

  async remove(ref: string): Promise<void> {
    this.#objects.delete(ref);
  }
}

class TestMediaAuth implements MediaAuthApi {
  async requestOtp(_contact: string, _method: MediaAuthMethod): Promise<{ message: string }> {
    return { message: 'Test OTP requested.' };
  }

  async verifyOtp(_contact: string, _method: MediaAuthMethod, _code: string): Promise<string> {
    return E2E_TOKEN;
  }

  async logout(_token: string): Promise<void> {}

  async authenticate(request: IncomingMessage): Promise<{ readonly id: string } | undefined> {
    return bearer(request) === E2E_TOKEN ? { id: E2E_OWNER } : undefined;
  }

  async sessionProfile(request: IncomingMessage): Promise<
    | {
        readonly contact: string;
        readonly method: MediaAuthMethod;
        readonly displayName: string;
        readonly avatarAvailable: false;
      }
    | undefined
  > {
    if (bearer(request) !== E2E_TOKEN) return undefined;
    return {
      contact: E2E_OWNER,
      method: 'gmail',
      displayName: 'JOY E2E',
      avatarAvailable: false,
    };
  }

  async avatarBytes(_request: IncomingMessage): Promise<undefined> {
    return undefined;
  }
}

const authentication: ApiAuthentication = {
  authenticate: (request) => (bearer(request) === E2E_TOKEN ? { id: E2E_OWNER } : undefined),
};

const controlPlane = new LocalControlPlane();
const objectStore = new MemoryPrivateObjectStore();
const E2E_WORKER_ID = 'e2e-render-worker';
const e2eWorkerDirectory = mkdtempSync(join(tmpdir(), 'joy-media-e2e-worker-'));
let e2eWorkerStopped = false;

// The fixture-only browser lane still exercises the production Worker-backed
// export contract. This in-process Worker uses the same remux/ffprobe
// implementation as the daemon, while sharing the harness's private object
// store and control plane. It is test infrastructure, never a production
// fixture handler or fallback.
controlPlane.pairWorker({ id: E2E_OWNER }, E2E_WORKER_ID);
controlPlane.helloWorker(E2E_WORKER_ID, ['render.export']);

const server = createControlPlaneHttpServer({
  controlPlane,
  authentication,
  mediaAuth: new TestMediaAuth(),
  privateObjectStore: objectStore,
  // The browser suite intentionally exercises dozens of flows with one
  // disposable owner/IP. Abuse protection is covered by the API transport
  // tests; keep this deterministic harness from turning a long suite into a
  // cascade of unrelated 429s.
  rateLimit: { maxRequests: 100_000 },
  queryObservability: true,
});

const e2eWorkerPromise = runE2eRenderWorker();

server.listen(Number(process.env.JOY_MEDIA_E2E_API_PORT ?? 4174), '127.0.0.1');
server.once('listening', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('E2E API failed to bind\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`JOY_MEDIA_E2E_API_READY http://127.0.0.1:${address.port}\n`);
});

const shutdown = () => {
  e2eWorkerStopped = true;
  server.close();
  void e2eWorkerPromise.finally(() => rmSync(e2eWorkerDirectory, { recursive: true, force: true }));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function runE2eRenderWorker(): Promise<void> {
  let lastHelloAt = 0;
  while (!e2eWorkerStopped) {
    const now = Date.now();
    if (now - lastHelloAt >= 10_000) {
      controlPlane.helloWorker(E2E_WORKER_ID, ['render.export'], [], now);
      lastHelloAt = now;
    }
    const job = controlPlane.lease(E2E_WORKER_ID, now, 300_000);
    if (job === undefined) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }
    process.stderr.write(`JOY_MEDIA_E2E_WORKER_LEASED ${job.id} ${job.type}\n`);
    if (job.type !== 'render.export' || job.assetId === undefined || job.payload === undefined) {
      controlPlane.fail(
        E2E_WORKER_ID,
        job.id,
        'fixture Worker received unsupported job',
        Date.now(),
        job.leaseToken,
      );
      continue;
    }
    const sourcePath = join(e2eWorkerDirectory, `${safeToken(job.id)}-${job.generation}.source`);
    const outputPath = join(
      e2eWorkerDirectory,
      `${safeToken(job.id)}-${job.generation}.export.mp4`,
    );
    try {
      const asset = controlPlane.workerJobAsset(E2E_WORKER_ID, job.id, Date.now(), job.leaseToken);
      const sourceDescriptor = privateDescriptor(asset);
      const sourceBytes = await objectStore.get(sourceDescriptor);
      writeFileSync(sourcePath, Buffer.from(sourceBytes), { mode: 0o600 });
      const payload = job.payload as ExportJobPayload;
      executeLeasedExport(
        { complete: () => undefined },
        E2E_WORKER_ID,
        job.id,
        { sourcePath, payload },
        outputPath,
        job.leaseToken,
      );
      const bytes = readFileSync(outputPath);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const probe = verifyExport(outputPath);
      const localRef = `export-e2e-${sha256.slice(0, 40)}`;
      const objectRef = `e2e-${localRef}`;
      await objectStore.put(
        { ref: objectRef, sha256, bytes: bytes.byteLength, mimeType: 'video/mp4' },
        new Uint8Array(bytes),
      );
      controlPlane.registerWorkerCloudDerivative(
        E2E_WORKER_ID,
        job.id,
        {
          id: `upload-${sha256.slice(0, 32)}`,
          assetId: job.assetId,
          kind: 'proxy',
          profile: 'render.export',
          sha256,
          bytes: bytes.byteLength,
          descriptor: {
            mimeType: 'video/mp4',
            width: probe.width,
            height: probe.height,
            durationUs: probe.durationUs,
          },
          availability: 'available-cloud',
          locations: [{ kind: 'private-object', ref: objectRef }],
        },
        Date.now(),
        job.leaseToken,
      );
      controlPlane.complete(
        E2E_WORKER_ID,
        job.id,
        Date.now(),
        {
          kind: 'render.export',
          assetId: job.assetId,
          sha256,
          bytes: bytes.byteLength,
          localRef,
          descriptor: {
            mimeType: 'video/mp4',
            width: probe.width,
            height: probe.height,
            durationUs: probe.durationUs,
          },
        },
        job.leaseToken,
      );
      process.stderr.write(`JOY_MEDIA_E2E_WORKER_COMPLETED ${job.id}\n`);
    } catch (error) {
      process.stderr.write(
        `JOY_MEDIA_E2E_WORKER_FAILED ${job.id} ${
          error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 500) : String(error)
        }\n`,
      );
      controlPlane.fail(
        E2E_WORKER_ID,
        job.id,
        error instanceof Error ? error.message.slice(0, 500) : 'fixture Worker export failed',
        Date.now(),
        job.leaseToken,
      );
    } finally {
      rmSync(sourcePath, { force: true });
      rmSync(outputPath, { force: true });
    }
  }
}

function privateDescriptor(asset: MediaAssetRecord): PrivateObjectDescriptor {
  const location = asset.locations.find((candidate) => candidate.kind === 'private-object');
  if (location === undefined) throw new Error(`asset ${asset.id} has no private source`);
  return {
    ref: location.ref,
    sha256: asset.sha256,
    bytes: asset.bytes,
    mimeType: asset.descriptor.mimeType,
  };
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ')
    ? value.slice('Bearer '.length)
    : undefined;
}
