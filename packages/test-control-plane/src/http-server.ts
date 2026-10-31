import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ControlPlaneError,
  MAX_WORKER_ATTEMPTS,
  MAX_WORKER_LEASE_DURATION_MS,
  type Actor,
  type AssetLocationRecord,
  type AssetRegistration,
  type ControlPlane,
  type Job,
  type LocalDerivativeRegistration,
  type MediaAssetRecord,
  type MediaDescriptor,
  type MediaDerivativeRecord,
  type WorkerModelInventoryRecord,
} from './control-plane.js';
import type { GpuPreviewFrameRequest } from '@joy-media/job-protocol';
import {
  GpuPreviewTransport,
  deserializeGpuPreviewResponse,
  type SerializedGpuPreviewFrameResponse,
} from './gpu-preview-transport.js';
import {
  MAX_PROJECT_DOCUMENT_SYNC_BYTES,
  validateProjectDocumentSyncRequest,
  isProjectDocumentSyncValidationSuccess,
} from './project-document-sync-request-validation.js';
import { createClientAddressResolver, type ClientAddressResolver } from './client-address.js';
import type { PrivateObjectStore } from './private-object-store.js';

const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 600;
export const DEFAULT_MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

export interface ApiAuthentication {
  authenticate(request: IncomingMessage): Actor | undefined | Promise<Actor | undefined>;
}

export interface ControlPlaneHttpServerOptions {
  readonly controlPlane: ControlPlane;
  readonly authentication: ApiAuthentication;
  readonly privateObjectStore?: PrivateObjectStore;
  readonly gpuPreview?: GpuPreviewTransport;
  readonly rateLimit?: {
    readonly windowMs?: number;
    readonly maxRequests?: number;
  };
  readonly maxJsonBodyBytes?: number;
  readonly clientAddressResolver?: ClientAddressResolver;
}

/** HTTP transport for the local job-control contract. This fixture has no account, cloud,
 * billing, gateway, or release routes and is never a production dependency. */
export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
  const rateLimitWindowMs = options.rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const rateLimitMaxRequests = options.rateLimit?.maxRequests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS;
  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  if (!Number.isSafeInteger(maxJsonBodyBytes) || maxJsonBodyBytes < 1)
    throw new RangeError('maxJsonBodyBytes must be a positive safe integer');

  const buckets = new Map<string, { windowStart: number; count: number }>();
  const clientAddressResolver = options.clientAddressResolver ?? createClientAddressResolver();
  const gpuPreview = options.gpuPreview ?? new GpuPreviewTransport(options.controlPlane);
  return createServer(async (request, response) => {
    const path = request.url?.split('?', 1)[0] ?? '/';
    if (
      path.startsWith('/v1/') &&
      !consumeRateLimit(
        request,
        buckets,
        rateLimitWindowMs,
        rateLimitMaxRequests,
        clientAddressResolver,
      )
    ) {
      response.setHeader('retry-after', String(Math.ceil(rateLimitWindowMs / 1000)));
      respondJson(response, 429, { error: { code: 'RATE_LIMITED' } });
      return;
    }
    try {
      await route(options, gpuPreview, request, response, maxJsonBodyBytes);
    } catch (error) {
      respondError(response, error);
    }
  });
}

async function route(
  options: ControlPlaneHttpServerOptions,
  gpuPreview: GpuPreviewTransport,
  request: IncomingMessage,
  response: ServerResponse,
  maxJsonBodyBytes: number,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://joy-media.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    respondJson(response, 200, {
      ok: true,
      service: 'joy-media-test-control-plane',
      controlPlane: true,
    });
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/live' || url.pathname === '/health/live')) {
    respondJson(response, 200, {
      ok: true,
      service: 'joy-media-test-control-plane',
      liveness: true,
    });
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/health/ready')) {
    respondJson(response, 200, {
      ok: true,
      service: 'joy-media-test-control-plane',
      readiness: true,
      controlPlane: true,
    });
    return;
  }
  if (!url.pathname.startsWith('/v1/')) {
    respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/worker-pair/offers') {
    const body = await readJson(request, maxJsonBodyBytes);
    const workerId = requiredString(body, 'workerId');
    const pairingCode = requiredString(body, 'pairingCode');
    const expiresAt = Date.now() + 5 * 60_000;
    respondJson(response, 201, {
      data: await options.controlPlane.createPairingOffer(
        workerId,
        secretHash(pairingCode),
        expiresAt,
      ),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/worker-pair/claim') {
    const body = await readJson(request, maxJsonBodyBytes);
    const workerId = requiredString(body, 'workerId');
    const pairingCode = requiredString(body, 'pairingCode');
    const sessionToken = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 30 * 24 * 60 * 60_000;
    const session = await options.controlPlane.claimWorkerSession(
      workerId,
      secretHash(pairingCode),
      secretHash(sessionToken),
      expiresAt,
    );
    if (session === undefined) throw new ControlPlaneError('PAIRING_CLAIM_DENIED', workerId);
    respondJson(response, 201, { data: { ...session, sessionToken } });
    return;
  }

  const workerLease = /^\/v1\/workers\/([^/]+)\/leases$/.exec(url.pathname);
  const workerHello = /^\/v1\/workers\/([^/]+)\/hello$/.exec(url.pathname);
  const workerHeartbeat = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/heartbeat$/.exec(url.pathname);
  const workerComplete = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/complete$/.exec(url.pathname);
  const workerFail = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/fail$/.exec(url.pathname);
  const workerDerivativeUpload = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/derivative$/.exec(
    url.pathname,
  );
  const workerSource = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/source$/.exec(url.pathname);
  const workerPreviewNext = /^\/v1\/workers\/([^/]+)\/preview\/next$/.exec(url.pathname);
  const workerPreviewComplete = /^\/v1\/workers\/([^/]+)\/preview\/frames\/([^/]+)\/([0-9]+)$/.exec(
    url.pathname,
  );
  const workerRoute =
    (request.method === 'POST' &&
      (workerLease !== null ||
        workerHello !== null ||
        workerHeartbeat !== null ||
        workerComplete !== null ||
        workerFail !== null ||
        workerDerivativeUpload !== null ||
        workerPreviewNext !== null ||
        workerPreviewComplete !== null)) ||
    (request.method === 'GET' && (workerPreviewNext !== null || workerSource !== null));
  if (workerRoute) {
    const workerId =
      workerLease?.[1] ??
      workerHello?.[1] ??
      workerHeartbeat?.[1] ??
      workerComplete?.[1] ??
      workerFail?.[1] ??
      workerDerivativeUpload?.[1] ??
      workerSource?.[1] ??
      workerPreviewNext?.[1] ??
      workerPreviewComplete?.[1];
    const authenticatedWorker = await options.controlPlane.authenticateWorker(
      workerSessionHash(request),
    );
    if (workerId === undefined || authenticatedWorker !== workerId)
      throw new ControlPlaneError('WORKER_SESSION_REQUIRED', 'worker session required');

    if (workerDerivativeUpload !== null) {
      const store = options.privateObjectStore;
      if (store === undefined)
        throw new ControlPlaneError(
          'PRIVATE_STORE_UNAVAILABLE',
          'private media storage is unavailable',
        );
      const bytes = await readBytes(request, 512 * 1024 * 1024);
      const receipt = workerDerivativeHeaders(request);
      if (bytes.byteLength !== receipt.bytes)
        throw new ControlPlaneError(
          'REQUEST_INVALID',
          'derivative byte length does not match receipt',
        );
      const jobId = decodeURIComponent(workerDerivativeUpload[2]!);
      // Keep the object key stable for an exact retry, but include every
      // integrity field so a conflicting retry cannot overwrite an object
      // referenced by a prior registration.
      const ref = workerDerivativeObjectRef(jobId, receipt.leaseToken, receipt);
      await store.put(
        {
          ref,
          sha256: receipt.sha256,
          bytes: receipt.bytes,
          mimeType: receipt.descriptor.mimeType,
        },
        bytes,
      );
      try {
        const derivative = await options.controlPlane.registerWorkerCloudDerivative(
          decodeURIComponent(workerId),
          jobId,
          {
            id: `derivative-${jobId}`,
            assetId: receipt.assetId,
            kind: receipt.kind,
            profile:
              receipt.kind === 'thumbnail'
                ? 'jpeg-640'
                : receipt.kind === 'proxy'
                  ? 'joy-export-h264-aac'
                  : receipt.kind === 'mask'
                    ? receipt.descriptor.mimeType === 'video/webm'
                      ? 'tracked-alpha-webm-v1'
                      : 'alpha-matte-png-v1'
                    : receipt.kind === 'upscale'
                      ? 'ai-upscale-v1'
                      : 'audio-processed',
            sha256: receipt.sha256,
            bytes: receipt.bytes,
            descriptor: receipt.descriptor,
            availability: 'available-cloud',
            locations: [{ kind: 'private-object', ref }],
          },
          undefined,
          receipt.leaseToken,
        );
        respondJson(response, 201, { data: derivativeForBrowser(derivative) });
        return;
      } catch (error) {
        // Remove only the object written by this attempt. Prefix cleanup could
        // delete a valid result from a previous generation.
        try {
          await store.remove(ref);
        } catch (cleanupError) {
          throw new ControlPlaneError(
            'DERIVATIVE_CLEANUP_FAILED',
            cleanupError instanceof Error ? cleanupError.message.slice(0, 200) : 'cleanup failed',
          );
        }
        throw error;
      }
    }
    if (workerSource !== null) {
      const store = options.privateObjectStore;
      if (store === undefined)
        throw new ControlPlaneError(
          'PRIVATE_STORE_UNAVAILABLE',
          'private media storage is unavailable',
        );
      const jobId = decodeURIComponent(workerSource[2]!);
      const leaseToken = requiredHeader(request, 'x-joy-lease-token');
      const asset = await options.controlPlane.workerJobAsset(
        decodeURIComponent(workerId),
        jobId,
        Date.now(),
        leaseToken,
      );
      const location = asset.locations.find((candidate) => candidate.kind === 'private-object');
      if (location === undefined) throw new ControlPlaneError('ASSET_UNAVAILABLE', asset.id);
      const bytes = await store.get({
        ref: location.ref,
        sha256: asset.sha256,
        bytes: asset.bytes,
        mimeType: asset.descriptor.mimeType,
      });
      response.writeHead(200, {
        'content-type': asset.descriptor.mimeType,
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      });
      response.end(Buffer.from(bytes));
      return;
    }

    if (workerLease !== null) {
      const body = await readJson(request, maxJsonBodyBytes);
      const durationMs =
        optionalPositiveInteger(body, 'durationMs', MAX_WORKER_LEASE_DURATION_MS) ?? 30_000;
      const job = await options.controlPlane.lease(
        decodeURIComponent(workerId),
        Date.now(),
        durationMs,
      );
      respondJson(response, 200, { data: job ?? null });
      return;
    }
    if (workerPreviewNext !== null) {
      await readJson(request, 1_024);
      respondNoStoreJson(response, 200, {
        data: gpuPreview.take(decodeURIComponent(workerId)),
      });
      return;
    }
    if (workerPreviewComplete !== null) {
      const body = await readJson(request, 24 * 1024 * 1024);
      const serialized = serializedGpuPreviewResponse(body);
      if (
        serialized.sessionId !== decodeURIComponent(workerPreviewComplete[2]!) ||
        serialized.requestId !== Number(workerPreviewComplete[3]!)
      )
        throw new ControlPlaneError('REQUEST_INVALID', 'GPU preview response identity mismatch');
      gpuPreview.complete(decodeURIComponent(workerId), deserializeGpuPreviewResponse(serialized));
      respondNoStoreJson(response, 200, { data: { accepted: true } });
      return;
    }
    if (workerHello !== null) {
      const body = await readJson(request, maxJsonBodyBytes);
      respondJson(response, 200, {
        data: await options.controlPlane.helloWorker(
          decodeURIComponent(workerId),
          requiredStringArray(body, 'capabilities'),
          optionalStringArray(body, 'assetIds') ?? [],
          undefined,
          optionalWorkerModelInventory(body.modelInventory),
        ),
      });
      return;
    }
    if (workerHeartbeat !== null) {
      const body = await readJson(request, maxJsonBodyBytes);
      respondJson(response, 200, {
        data: await options.controlPlane.heartbeat(
          decodeURIComponent(workerId),
          decodeURIComponent(workerHeartbeat[2]!),
          requiredProgress(body),
          undefined,
          undefined,
          requiredString(body, 'leaseToken'),
        ),
      });
      return;
    }
    if (workerFail !== null) {
      const body = await readJson(request, maxJsonBodyBytes);
      respondJson(response, 200, {
        data: await options.controlPlane.fail(
          decodeURIComponent(workerId),
          decodeURIComponent(workerFail[2]!),
          requiredString(body, 'error'),
          undefined,
          requiredString(body, 'leaseToken'),
        ),
      });
      return;
    }
    const body = await readJson(request, maxJsonBodyBytes);
    respondJson(response, 200, {
      data: await options.controlPlane.complete(
        decodeURIComponent(workerId),
        decodeURIComponent(workerComplete![2]!),
        undefined,
        optionalWorkerResult(body),
        requiredString(body, 'leaseToken'),
      ),
    });
    return;
  }

  const actor = await options.authentication.authenticate(request);
  if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');

  const openPreview = /^\/v1\/projects\/([^/]+)\/preview-sessions$/.exec(url.pathname);
  if (request.method === 'POST' && openPreview !== null) {
    await readJson(request, 1_024);
    respondNoStoreJson(response, 201, {
      data: await gpuPreview.open(actor, decodeURIComponent(openPreview[1]!)),
    });
    return;
  }
  const previewFrame = /^\/v1\/preview-sessions\/([^/]+)\/frames$/.exec(url.pathname);
  if (request.method === 'POST' && previewFrame !== null) {
    const body = await readJson(request, 24 * 1024 * 1024);
    const frame = body as unknown as GpuPreviewFrameRequest;
    if (frame.sessionId !== decodeURIComponent(previewFrame[1]!))
      throw new ControlPlaneError('REQUEST_INVALID', 'GPU preview request identity mismatch');
    gpuPreview.offer(actor, frame);
    respondNoStoreJson(response, 202, { data: { accepted: true, requestId: frame.requestId } });
    return;
  }
  const previewResult = /^\/v1\/preview-sessions\/([^/]+)\/frames\/([0-9]+)$/.exec(url.pathname);
  if (request.method === 'GET' && previewResult !== null) {
    const result = gpuPreview.result(
      actor,
      decodeURIComponent(previewResult[1]!),
      Number(previewResult[2]!),
    );
    if (result === undefined) {
      respondNoStoreJson(response, 202, { data: null });
      return;
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(result.bytes.byteLength),
      'cache-control': 'private, no-store, max-age=0',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-joy-preview-renderer': result.renderer,
      'x-joy-preview-quality': result.quality,
      'x-joy-preview-width': String(result.width),
      'x-joy-preview-height': String(result.height),
      'x-joy-preview-request-id': String(result.requestId),
    });
    response.end(Buffer.from(result.bytes));
    return;
  }
  const closePreview = /^\/v1\/preview-sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && closePreview !== null) {
    gpuPreview.close(actor, decodeURIComponent(closePreview[1]!));
    respondNoStoreJson(response, 200, { data: { closed: true } });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/workers') {
    respondJson(response, 200, { data: await options.controlPlane.workersForOwner(actor) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/library/my-assets') {
    const projectId = url.searchParams.has('projectId')
      ? requiredQuery(url, 'projectId')
      : undefined;
    const assets =
      projectId === undefined
        ? await options.controlPlane.assetsForOwner(actor)
        : await options.controlPlane.assetsForProject(actor, projectId);
    respondJson(response, 200, { data: assets.map(assetForBrowser) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/projects/ensure') {
    const body = await readJson(request, maxJsonBodyBytes);
    const id = requiredString(body, 'id');
    const title = requiredString(body, 'title');
    let project;
    try {
      project = await options.controlPlane.getProject(actor, id);
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
      try {
        project = await options.controlPlane.createProject(actor, id, title);
      } catch (createError) {
        if (!(createError instanceof ControlPlaneError) || createError.code !== 'PROJECT_EXISTS')
          throw createError;
        project = await options.controlPlane.getProject(actor, id);
      }
    }
    respondJson(response, 200, { data: project });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/projects') {
    const body = await readJson(request, maxJsonBodyBytes);
    respondJson(response, 201, {
      data: await options.controlPlane.createProject(
        actor,
        requiredString(body, 'id'),
        requiredString(body, 'title'),
      ),
    });
    return;
  }

  const document = /^\/v1\/projects\/([^/]+)\/document$/.exec(url.pathname);
  if (request.method === 'GET' && document !== null) {
    const projectId = decodeURIComponent(document[1]!);
    const requestedRevisionId = url.searchParams.get('revisionId') ?? undefined;
    const result = await options.controlPlane.readProjectDocument(
      actor,
      projectId,
      requestedRevisionId,
    );
    if (result.kind === 'ready') {
      respondJson(response, 200, {
        data: {
          projectId: result.record.projectId,
          revisionId: result.record.revisionId,
          document: result.record.document,
          ...(result.record.lookInstances === undefined
            ? {}
            : { lookInstances: result.record.lookInstances }),
        },
      });
      return;
    }
    if (result.kind === 'not-found') {
      if (url.searchParams.get('allowMissing') === 'true') {
        respondJson(response, 200, { data: null });
        return;
      }
      respondJson(response, 404, { error: { code: 'PROJECT_DOCUMENT_NOT_FOUND' } });
      return;
    }
    if (result.kind === 'stale-revision') {
      respondJson(response, 409, {
        error: { code: 'DOCUMENT_REVISION_STALE', currentRevisionId: result.currentRevisionId },
      });
      return;
    }
    if (result.kind === 'unavailable') {
      respondJson(response, 503, { error: { code: 'PROJECT_DOCUMENT_STORE_UNAVAILABLE' } });
      return;
    }
    respondJson(response, 500, { error: { code: 'INTERNAL_ERROR' } });
    return;
  }
  if (request.method === 'PUT' && document !== null) {
    const projectId = decodeURIComponent(document[1]!);
    const body = await readJson(request, MAX_PROJECT_DOCUMENT_SYNC_BYTES);
    const validation = validateProjectDocumentSyncRequest(body, projectId);
    if (!isProjectDocumentSyncValidationSuccess(validation)) {
      respondJson(response, 400, { error: { code: 'REQUEST_INVALID' } });
      return;
    }
    const result = await options.controlPlane.writeProjectDocument(
      actor,
      {
        projectId,
        ownerId: actor.id,
        revisionId: validation.envelope.revisionId,
        document: validation.envelope.document,
        ...(validation.envelope.lookInstances === undefined
          ? {}
          : { lookInstances: validation.envelope.lookInstances }),
      },
      validation.envelope.baseRevisionId,
    );
    if (result.kind === 'stored') {
      respondJson(response, 200, {
        data: { projectId: result.projectId, revisionId: result.revisionId },
      });
      return;
    }
    if (result.kind === 'not-found' || result.kind === 'owner-denied') {
      respondJson(response, 404, { error: { code: 'PROJECT_NOT_FOUND' } });
      return;
    }
    if (result.kind === 'revision-conflict') {
      respondJson(response, 409, { error: { code: 'DOCUMENT_REVISION_CONFLICT' } });
      return;
    }
    if (result.kind === 'invalid-document') {
      respondJson(response, 400, { error: { code: 'REQUEST_INVALID' } });
      return;
    }
    if (result.kind === 'unavailable') {
      respondJson(response, 503, { error: { code: 'PROJECT_DOCUMENT_STORE_UNAVAILABLE' } });
      return;
    }
    respondJson(response, 500, { error: { code: 'INTERNAL_ERROR' } });
    return;
  }

  const project = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
  if (project !== null) {
    const projectId = decodeURIComponent(project[1]!);
    if (request.method === 'GET') {
      respondJson(response, 200, { data: await options.controlPlane.getProject(actor, projectId) });
      return;
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request, maxJsonBodyBytes);
      respondJson(response, 200, {
        data: await options.controlPlane.updateProject(
          actor,
          projectId,
          requiredString(body, 'title'),
          requiredNonNegativeInteger(body, 'baseRevision'),
        ),
      });
      return;
    }
    if (request.method === 'DELETE') {
      const deleted = await options.controlPlane.deleteProject(actor, projectId);
      respondJson(response, 200, { data: { id: deleted.id } });
      return;
    }
  }
  const duplicateProject = /^\/v1\/projects\/([^/]+)\/duplicate$/.exec(url.pathname);
  if (request.method === 'POST' && duplicateProject !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    respondJson(response, 201, {
      data: await options.controlPlane.duplicateProject(
        actor,
        decodeURIComponent(duplicateProject[1]!),
        requiredString(body, 'id'),
        requiredString(body, 'title'),
        requiredNonNegativeInteger(body, 'baseRevision'),
      ),
    });
    return;
  }
  const projectState = /^\/v1\/projects\/([^/]+)\/(trash|restore)$/.exec(url.pathname);
  if (request.method === 'POST' && projectState !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    const projectId = decodeURIComponent(projectState[1]!);
    const baseRevision = requiredNonNegativeInteger(body, 'baseRevision');
    const result =
      projectState[2] === 'trash'
        ? await options.controlPlane.trashProject(actor, projectId, baseRevision)
        : await options.controlPlane.restoreProject(actor, projectId, baseRevision);
    respondJson(response, 200, { data: result });
    return;
  }
  const assetSync = /^\/v1\/projects\/([^/]+)\/asset-sync$/.exec(url.pathname);
  if (request.method === 'POST' && assetSync !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    if (typeof body.enabled !== 'boolean')
      throw new ControlPlaneError('REQUEST_INVALID', 'enabled must be boolean');
    respondJson(response, 200, {
      data: await options.controlPlane.setAssetSync(
        actor,
        decodeURIComponent(assetSync[1]!),
        body.enabled,
      ),
    });
    return;
  }

  const workerPair = /^\/v1\/workers\/([^/]+)\/pair$/.exec(url.pathname);
  if (request.method === 'POST' && workerPair !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    respondJson(response, 200, {
      data: await options.controlPlane.approvePairing(
        actor,
        decodeURIComponent(workerPair[1]!),
        secretHash(requiredString(body, 'pairingCode')),
      ),
    });
    return;
  }
  const workerRevoke = /^\/v1\/workers\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === 'POST' && workerRevoke !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.revokeWorker(actor, decodeURIComponent(workerRevoke[1]!)),
    });
    return;
  }

  const assets = /^\/v1\/projects\/([^/]+)\/assets$/.exec(url.pathname);
  if (request.method === 'GET' && assets !== null) {
    const result = await options.controlPlane.assetsForProject(
      actor,
      decodeURIComponent(assets[1]!),
    );
    respondJson(response, 200, { data: result.map(assetForBrowser) });
    return;
  }
  if (request.method === 'POST' && assets !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    const result = await options.controlPlane.registerAsset(
      actor,
      decodeURIComponent(assets[1]!),
      assetRegistration(body),
    );
    respondJson(response, 201, { data: assetForBrowser(result) });
    return;
  }
  const assetById = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname);
  const assetAssociate = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/associate$/.exec(url.pathname);
  if (request.method === 'POST' && assetAssociate !== null) {
    const result = await options.controlPlane.associateAsset(
      actor,
      decodeURIComponent(assetAssociate[1]!),
      decodeURIComponent(assetAssociate[2]!),
    );
    respondJson(response, 200, { data: assetForBrowser(result) });
    return;
  }
  if (request.method === 'DELETE' && assetById !== null) {
    const result = await options.controlPlane.deleteAsset(
      actor,
      decodeURIComponent(assetById[1]!),
      decodeURIComponent(assetById[2]!),
    );
    respondJson(response, 200, { data: { id: result.id } });
    return;
  }
  const assetMetadata = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/metadata$/.exec(url.pathname);
  if (request.method === 'POST' && assetMetadata !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((item): item is string => typeof item === 'string')
      : undefined;
    const sortName = typeof body.sortName === 'string' ? body.sortName : undefined;
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined;
    const result = await options.controlPlane.updateAssetMetadata(
      actor,
      decodeURIComponent(assetMetadata[1]!),
      decodeURIComponent(assetMetadata[2]!),
      {
        ...(tags === undefined ? {} : { tags }),
        ...(sortName === undefined ? {} : { sortName }),
        ...(displayName === undefined ? {} : { displayName }),
      },
    );
    respondJson(response, 200, { data: assetForBrowser(result) });
    return;
  }
  const derivatives = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives$/.exec(url.pathname);
  if (request.method === 'GET' && derivatives !== null) {
    const result = await options.controlPlane.derivativesForAsset(
      actor,
      decodeURIComponent(derivatives[1]!),
      decodeURIComponent(derivatives[2]!),
    );
    respondJson(response, 200, { data: result.map(derivativeForBrowser) });
    return;
  }
  if (request.method === 'POST' && derivatives !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    const derivative = localDerivativeRegistration(body);
    if (derivative.assetId !== decodeURIComponent(derivatives[2]!))
      throw new ControlPlaneError('REQUEST_INVALID', 'derivative assetId must match the route');
    const result = await options.controlPlane.registerLocalDerivative(
      actor,
      decodeURIComponent(derivatives[1]!),
      derivative,
    );
    respondJson(response, 201, { data: derivativeForBrowser(result) });
    return;
  }

  const jobs = /^\/v1\/projects\/([^/]+)\/jobs$/.exec(url.pathname);
  if (request.method === 'GET' && jobs !== null) {
    const result = await options.controlPlane.jobsForProject(actor, decodeURIComponent(jobs[1]!));
    respondJson(response, 200, { data: result.map(jobForBrowser) });
    return;
  }
  if (request.method === 'POST' && jobs !== null) {
    const body = await readJson(request, maxJsonBodyBytes);
    const type = requiredString(body, 'type');
    const maxAttempts = optionalPositiveInteger(body, 'maxAttempts', MAX_WORKER_ATTEMPTS);
    const job =
      type === 'asset.thumbnail'
        ? await options.controlPlane.enqueueAssetThumbnail(
            actor,
            requiredString(body, 'id'),
            decodeURIComponent(jobs[1]!),
            requiredString(body, 'assetId'),
            Date.now(),
            maxAttempts,
          )
        : await options.controlPlane.enqueue(
            actor,
            requiredString(body, 'id'),
            decodeURIComponent(jobs[1]!),
            type,
            Date.now(),
            typeof body.assetId === 'string' ? body.assetId : undefined,
            jobPayload(body),
            maxAttempts,
          );
    respondJson(response, 201, { data: jobForBrowser(job) });
    return;
  }
  const cancel = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && cancel !== null) {
    const result = await options.controlPlane.cancel(
      actor,
      decodeURIComponent(cancel[1]!),
      decodeURIComponent(cancel[2]!),
    );
    respondJson(response, 200, { data: jobForBrowser(result) });
    return;
  }
  const retry = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (request.method === 'POST' && retry !== null) {
    const result = await options.controlPlane.retry(
      actor,
      decodeURIComponent(retry[1]!),
      decodeURIComponent(retry[2]!),
    );
    respondJson(response, 200, { data: jobForBrowser(result) });
    return;
  }
  const events = /^\/v1\/projects\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === 'GET' && events !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.eventsAfter(
        actor,
        decodeURIComponent(events[1]!),
        optionalCursor(url.searchParams.get('cursor')),
      ),
    });
    return;
  }
  respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length'] ?? NaN);
  if (Number.isFinite(maximumBytes) && declaredLength > maximumBytes) {
    request.resume();
    throw new ControlPlaneError('REQUEST_INVALID', 'request body exceeds the size limit');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) {
      request.resume();
      throw new ControlPlaneError('REQUEST_INVALID', 'request body exceeds the size limit');
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('body must be an object');
    return value as Record<string, unknown>;
  } catch {
    throw new ControlPlaneError('REQUEST_INVALID', 'request body must be valid JSON object');
  }
}

async function readBytes(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes)
      throw new ControlPlaneError('REQUEST_INVALID', 'upload exceeds the size limit');
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
  return value;
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${name} header is required`);
  return value;
}

function requiredQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field);
  if (value === null || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} query parameter is required`);
  return value;
}

function optionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a positive integer`);
  if (value > maximum)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be no greater than ${maximum}`);
  return value;
}

function requiredProgress(body: Record<string, unknown>): number {
  const progress = body.progress;
  if (
    typeof progress !== 'number' ||
    !Number.isSafeInteger(progress) ||
    progress < 0 ||
    progress > 100
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'progress must be an integer from 0 to 100');
  return progress;
}

function requiredStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0))
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a string array`);
  return value;
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  if (body[field] === undefined) return undefined;
  return requiredStringArray(body, field);
}

function optionalWorkerModelInventory(value: unknown): WorkerModelInventoryRecord | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'modelInventory must be an object');
  const body = value as Record<string, unknown>;
  if (
    typeof body.managerVersion !== 'string' ||
    body.managerVersion.length === 0 ||
    body.managerVersion.length > 64 ||
    !['ready', 'read-only', 'unavailable'].includes(String(body.cacheStatus)) ||
    !Array.isArray(body.models) ||
    body.models.length > 128
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'modelInventory is invalid');
  return {
    managerVersion: body.managerVersion,
    cacheStatus: body.cacheStatus as WorkerModelInventoryRecord['cacheStatus'],
    ...(typeof body.freeBytes === 'number' &&
    Number.isSafeInteger(body.freeBytes) &&
    body.freeBytes >= 0
      ? { freeBytes: body.freeBytes }
      : {}),
    models: body.models.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item))
        throw new ControlPlaneError(
          'REQUEST_INVALID',
          'modelInventory.models contains an invalid item',
        );
      const model = item as Record<string, unknown>;
      if (
        typeof model.modelId !== 'string' ||
        model.modelId.length === 0 ||
        model.modelId.length > 128 ||
        typeof model.version !== 'string' ||
        model.version.length > 128 ||
        typeof model.state !== 'string' ||
        model.state.length > 64
      )
        throw new ControlPlaneError('REQUEST_INVALID', 'modelInventory model is invalid');
      return {
        modelId: model.modelId,
        version: model.version,
        state: model.state,
        ...(typeof model.progress === 'number' && Number.isFinite(model.progress)
          ? { progress: Math.min(100, Math.max(0, model.progress)) }
          : {}),
        ...(typeof model.installedBytes === 'number' &&
        Number.isSafeInteger(model.installedBytes) &&
        model.installedBytes >= 0
          ? { installedBytes: model.installedBytes }
          : {}),
        ...(typeof model.errorCode === 'string'
          ? { errorCode: model.errorCode.slice(0, 128) }
          : {}),
      };
    }),
  };
}

function jobPayload(body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const explicit = body.payload;
  if (explicit !== undefined) {
    if (explicit === null || typeof explicit !== 'object' || Array.isArray(explicit))
      throw new ControlPlaneError('REQUEST_INVALID', 'payload must be an object');
    return explicit as Readonly<Record<string, unknown>>;
  }
  const payload: Record<string, unknown> = {};
  for (const field of ['prompt', 'negativePrompt', 'imageAssetId', 'model', 'params', 'fixture']) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  return payload;
}

function optionalWorkerResult(
  body: Record<string, unknown>,
): Parameters<ControlPlane['complete']>[3] {
  const value = body.result;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'result must be an object');
  const result = value as Record<string, unknown>;
  if (result.kind === 'fixture.thumbnail' && isReceiptHashAndBytes(result))
    return { kind: result.kind, sha256: result.sha256, bytes: result.bytes };
  const descriptor = result.descriptor;
  const knownKinds = [
    'asset.thumbnail',
    'render.export',
    'image.comfy',
    'audio.ml-denoise',
    'mask.image',
    'mask.video',
    'upscale.image',
    'upscale.video',
  ];
  if (
    !knownKinds.includes(String(result.kind)) ||
    typeof result.assetId !== 'string' ||
    typeof result.localRef !== 'string' ||
    !isReceiptHashAndBytes(result) ||
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    typeof (descriptor as Record<string, unknown>).mimeType !== 'string'
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
  const valueDescriptor = descriptor as Record<string, unknown>;
  const mimeType = valueDescriptor.mimeType as string;
  if (
    (result.kind === 'asset.thumbnail' &&
      (mimeType !== 'image/jpeg' ||
        !Number.isSafeInteger(valueDescriptor.width) ||
        !Number.isSafeInteger(valueDescriptor.height))) ||
    (result.kind === 'render.export' &&
      (mimeType !== 'video/mp4' ||
        !Number.isSafeInteger(valueDescriptor.width) ||
        !Number.isSafeInteger(valueDescriptor.height) ||
        !Number.isSafeInteger(valueDescriptor.durationUs)))
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'result descriptor is invalid');
  return {
    kind: result.kind as NonNullable<Parameters<ControlPlane['complete']>[3]>['kind'],
    assetId: result.assetId,
    sha256: result.sha256,
    bytes: result.bytes,
    localRef: result.localRef,
    descriptor: {
      mimeType,
      ...(typeof valueDescriptor.width === 'number' && Number.isSafeInteger(valueDescriptor.width)
        ? { width: valueDescriptor.width }
        : {}),
      ...(typeof valueDescriptor.height === 'number' && Number.isSafeInteger(valueDescriptor.height)
        ? { height: valueDescriptor.height }
        : {}),
      ...(typeof valueDescriptor.durationUs === 'number' &&
      Number.isSafeInteger(valueDescriptor.durationUs)
        ? { durationUs: valueDescriptor.durationUs }
        : {}),
    },
  } as NonNullable<Parameters<ControlPlane['complete']>[3]>;
}

function isReceiptHashAndBytes(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly sha256: string; readonly bytes: number } {
  return (
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0
  );
}

function serializedGpuPreviewResponse(
  body: Record<string, unknown>,
): SerializedGpuPreviewFrameResponse {
  const { protocolVersion, sessionId, requestId, renderer, quality, width, height, bytesBase64 } =
    body;
  if (
    protocolVersion !== 1 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    !Number.isSafeInteger(requestId) ||
    (requestId as number) < 0 ||
    renderer !== 'hardware-gpu' ||
    (quality !== 'quarter' && quality !== 'half' && quality !== 'full') ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width as number) < 1 ||
    (height as number) < 1 ||
    typeof bytesBase64 !== 'string' ||
    bytesBase64.length === 0 ||
    bytesBase64.length > 22 * 1024 * 1024
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'GPU preview response is invalid');
  return {
    protocolVersion,
    sessionId,
    requestId: requestId as number,
    renderer,
    quality,
    width: width as number,
    height: height as number,
    bytesBase64,
  };
}

function optionalCursor(value: string | null): number {
  if (value === null) return 0;
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ControlPlaneError('REQUEST_INVALID', 'cursor must be a non-negative integer');
  return cursor;
}

function assetForBrowser(asset: MediaAssetRecord) {
  return {
    id: asset.id,
    projectId: asset.projectId,
    kind: asset.kind,
    displayName: asset.displayName,
    sha256: asset.sha256,
    bytes: asset.bytes,
    descriptor: mediaDescriptorForBrowser(asset.descriptor),
    tags: asset.tags,
    sortName: asset.sortName,
    createdAt: asset.createdAt,
    cloudBacked: asset.locations.some((location) => location.kind === 'private-object'),
  };
}

function derivativeForBrowser(derivative: MediaDerivativeRecord) {
  return {
    id: derivative.id,
    projectId: derivative.projectId,
    assetId: derivative.assetId,
    kind: derivative.kind,
    profile: derivative.profile,
    sha256: derivative.sha256,
    bytes: derivative.bytes,
    descriptor: mediaDescriptorForBrowser(derivative.descriptor),
    availability: derivative.availability,
    verifiedAt: derivative.verifiedAt,
  };
}

function mediaDescriptorForBrowser(descriptor: MediaDescriptor): MediaDescriptor {
  return {
    mimeType: descriptor.mimeType,
    ...(descriptor.durationUs === undefined ? {} : { durationUs: descriptor.durationUs }),
    ...(descriptor.width === undefined ? {} : { width: descriptor.width }),
    ...(descriptor.height === undefined ? {} : { height: descriptor.height }),
    ...(descriptor.animation === undefined
      ? {}
      : {
          animation: {
            frameCount: descriptor.animation.frameCount,
            cycleDurationUs: descriptor.animation.cycleDurationUs,
            loopCount: descriptor.animation.loopCount,
            hasAlpha: descriptor.animation.hasAlpha,
          },
        }),
  };
}

function jobForBrowser(job: Job) {
  const derivative = job.derivative;
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type,
    generation: job.generation,
    state: job.state,
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    ...(job.assetId === undefined ? {} : { assetId: job.assetId }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(derivative === undefined
      ? {}
      : {
          derivative: {
            id: derivative.id,
            jobId: derivative.jobId,
            kind: derivative.kind,
            sha256: derivative.sha256,
            bytes: derivative.bytes,
            workerRef: derivative.workerRef,
            resultRef: derivative.resultRef,
            verifiedAt: derivative.verifiedAt,
          },
        }),
  };
}

function assetRegistration(body: Record<string, unknown>): AssetRegistration {
  const registration: AssetRegistration = {
    id: requiredString(body, 'id'),
    kind: requiredAssetKind(body, 'kind'),
    displayName: requiredString(body, 'displayName'),
    sha256: requiredSha256(body, 'sha256'),
    bytes: requiredPositiveInteger(body, 'bytes'),
    descriptor: mediaDescriptor(body),
    locations: assetLocations(body),
  };
  validateBrowserAssetLocations(registration.locations, 'asset');
  return registration;
}

function localDerivativeRegistration(body: Record<string, unknown>): LocalDerivativeRegistration {
  const availability = body.availability;
  if (availability !== 'pending' && availability !== 'available-local')
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      'availability must be pending or available-local',
    );
  const kind = body.kind;
  if (kind !== 'thumbnail' && kind !== 'proxy' && kind !== 'audio')
    throw new ControlPlaneError('REQUEST_INVALID', 'derivative kind is invalid');
  const registration: LocalDerivativeRegistration = {
    id: requiredString(body, 'id'),
    assetId: requiredString(body, 'assetId'),
    kind,
    profile: requiredString(body, 'profile'),
    sha256: requiredSha256(body, 'sha256'),
    bytes: requiredPositiveInteger(body, 'bytes'),
    descriptor: mediaDescriptor(body),
    availability,
    locations: assetLocations(body),
  };
  validateBrowserAssetLocations(registration.locations, 'derivative');
  return registration;
}

function mediaDescriptor(body: Record<string, unknown>): AssetRegistration['descriptor'] {
  const value = requiredObject(body, 'descriptor');
  const descriptor = { mimeType: requiredString(value, 'mimeType') };
  const durationUs = optionalPositiveInteger(value, 'durationUs');
  const width = optionalPositiveInteger(value, 'width');
  const height = optionalPositiveInteger(value, 'height');
  const animation =
    value.animation === undefined ? undefined : animationDescriptor(value.animation);
  return {
    ...descriptor,
    ...(durationUs === undefined ? {} : { durationUs }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(animation === undefined ? {} : { animation }),
  };
}

function animationDescriptor(
  value: unknown,
): NonNullable<AssetRegistration['descriptor']['animation']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'descriptor.animation must be an object');
  const animation = value as Record<string, unknown>;
  const frameCount = requiredPositiveInteger(animation, 'frameCount');
  const cycleDurationUs = requiredPositiveInteger(animation, 'cycleDurationUs');
  const loopCount = requiredNonNegativeInteger(animation, 'loopCount');
  if (frameCount < 2 || frameCount > 10_000)
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      'descriptor.animation.frameCount is out of range',
    );
  if (cycleDurationUs > 86_400_000_000)
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      'descriptor.animation.cycleDurationUs is out of range',
    );
  if (typeof animation.hasAlpha !== 'boolean')
    throw new ControlPlaneError('REQUEST_INVALID', 'descriptor.animation.hasAlpha must be boolean');
  return { frameCount, cycleDurationUs, loopCount, hasAlpha: animation.hasAlpha };
}

function assetLocations(body: Record<string, unknown>): AssetRegistration['locations'] {
  if (!Array.isArray(body.locations))
    throw new ControlPlaneError('REQUEST_INVALID', 'locations must be an array');
  return body.locations.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new ControlPlaneError('REQUEST_INVALID', 'location must be an object');
    const location = item as Record<string, unknown>;
    const kind = location.kind;
    if (kind !== 'opfs-cache' && kind !== 'private-object')
      throw new ControlPlaneError('REQUEST_INVALID', 'location kind is invalid');
    return { kind, ref: requiredString(location, 'ref') };
  });
}

function validateBrowserAssetLocations(
  locations: readonly AssetLocationRecord[],
  subject: 'asset' | 'derivative',
): void {
  if (
    locations.length !== 1 ||
    locations[0]?.kind !== 'opfs-cache' ||
    locations[0].ref.length === 0
  )
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      `${subject} registration must provide exactly one local cache location`,
    );
}

function requiredAssetKind(
  body: Record<string, unknown>,
  field: string,
): AssetRegistration['kind'] {
  const value = body[field];
  if (value !== 'video' && value !== 'audio' && value !== 'image')
    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
  return value;
}

function requiredSha256(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a SHA-256 hex digest`);
  return value;
}

function requiredPositiveInteger(body: Record<string, unknown>, field: string): number {
  const value = optionalPositiveInteger(body, field);
  if (value === undefined) throw new ControlPlaneError('REQUEST_INVALID', `${field} is required`);
  return value;
}

function requiredNonNegativeInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-negative integer`);
  return value;
}

function requiredObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be an object`);
  return value as Record<string, unknown>;
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function respondNoStoreJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store, max-age=0',
    pragma: 'no-cache',
  });
  response.end(JSON.stringify(payload));
}

function consumeRateLimit(
  request: IncomingMessage,
  buckets: Map<string, { windowStart: number; count: number }>,
  windowMs: number,
  maxRequests: number,
  clientAddressResolver: ClientAddressResolver,
): boolean {
  const key = clientAddressResolver(request);
  const now = Date.now();
  const existing = buckets.get(key);
  if (existing === undefined || now - existing.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (existing.count >= maxRequests) return false;
  existing.count += 1;
  return true;
}

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof ControlPlaneError) {
    const status =
      error.code === 'AUTH_REQUIRED' || error.code === 'WORKER_SESSION_REQUIRED'
        ? 401
        : error.code === 'JOB_TYPE_UNSUPPORTED' || error.code === 'REQUEST_INVALID'
          ? 400
          : error.code === 'PROVIDER_BUSY'
            ? 429
            : error.code === 'PROVIDER_OPERATION_NOT_FOUND'
              ? 404
              : error.code === 'PROJECT_DOCUMENT_STORE_UNAVAILABLE' ||
                  error.code === 'PRIVATE_STORE_UNAVAILABLE' ||
                  error.code === 'DERIVATIVE_CLEANUP_FAILED'
                ? 503
                : error.code.startsWith('PAIRING_')
                  ? 403
                  : 409;
    respondJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  respondJson(response, 500, { error: { code: 'INTERNAL_ERROR' } });
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function workerSessionHash(request: IncomingMessage): string {
  const token = bearerToken(request);
  return token === undefined ? '' : secretHash(token);
}

function workerDerivativeObjectRef(
  jobId: string,
  leaseToken: string,
  result: {
    readonly assetId: string;
    readonly kind: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly descriptor: {
      readonly mimeType: string;
      readonly width?: number;
      readonly height?: number;
      readonly durationUs?: number;
    };
  },
): string {
  const jobDigest = createHash('sha256').update(jobId).digest('hex').slice(0, 32);
  const leaseDigest = createHash('sha256').update(leaseToken).digest('hex').slice(0, 24);
  const kind =
    result.kind === 'asset.thumbnail'
      ? 'thumbnail'
      : result.kind === 'audio.ml-denoise'
        ? 'audio'
        : result.kind === 'mask.image' || result.kind === 'mask.video'
          ? 'mask'
          : result.kind === 'upscale.image' || result.kind === 'upscale.video'
            ? 'upscale'
            : result.kind;
  const metadataDigest = createHash('sha256')
    .update(
      JSON.stringify({
        assetId: result.assetId,
        kind,
        sha256: result.sha256,
        bytes: result.bytes,
        mimeType: result.descriptor.mimeType,
        width: result.descriptor.width ?? null,
        height: result.descriptor.height ?? null,
        durationUs: result.descriptor.durationUs ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 32);
  return `derivative-${jobDigest}-${leaseDigest}-${metadataDigest}`;
}

function workerDerivativeHeaders(request: IncomingMessage): {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: 'thumbnail' | 'proxy' | 'audio' | 'mask' | 'upscale';
  readonly leaseToken: string;
  readonly descriptor: {
    readonly mimeType: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationUs?: number;
  };
} {
  const assetId = requiredHeader(request, 'x-joy-asset-id');
  const sha256 = requiredHeader(request, 'x-joy-sha256');
  const bytes = Number(requiredHeader(request, 'x-joy-bytes'));
  const mimeType = requiredHeader(request, 'content-type');
  const widthHeader = request.headers['x-joy-width'];
  const heightHeader = request.headers['x-joy-height'];
  const durationHeader = request.headers['x-joy-duration-us'];
  const declaredKind = request.headers['x-joy-derivative-kind'];
  const leaseToken = requiredHeader(request, 'x-joy-lease-token');
  const width = widthHeader === undefined ? undefined : Number(widthHeader);
  const height = heightHeader === undefined ? undefined : Number(heightHeader);
  const durationUs = durationHeader === undefined ? undefined : Number(durationHeader);
  const isThumbnail =
    declaredKind === undefined ? mimeType === 'image/jpeg' : declaredKind === 'thumbnail';
  const isMask = declaredKind === 'mask';
  const isProxy = declaredKind === 'proxy';
  const isUpscale = declaredKind === 'upscale';
  const declaredKindValid =
    declaredKind === undefined ||
    declaredKind === 'thumbnail' ||
    declaredKind === 'proxy' ||
    declaredKind === 'audio' ||
    declaredKind === 'mask' ||
    declaredKind === 'upscale';
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !declaredKindValid ||
    (isThumbnail &&
      (mimeType !== 'image/jpeg' ||
        width === undefined ||
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        height === undefined ||
        !Number.isSafeInteger(height) ||
        height <= 0)) ||
    (isMask &&
      (width === undefined ||
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        height === undefined ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        (mimeType === 'video/webm' &&
          (durationUs === undefined || !Number.isSafeInteger(durationUs) || durationUs <= 0)))) ||
    (isProxy &&
      (mimeType !== 'video/mp4' ||
        width === undefined ||
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        height === undefined ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        durationUs === undefined ||
        !Number.isSafeInteger(durationUs) ||
        durationUs <= 0)) ||
    (isUpscale && !['image/png', 'image/jpeg', 'video/mp4', 'video/webm'].includes(mimeType)) ||
    (!isThumbnail &&
      !isMask &&
      !isProxy &&
      !isUpscale &&
      !/^audio\/[a-z0-9.+-]+$/i.test(mimeType)) ||
    (isMask && mimeType !== 'image/png' && mimeType !== 'video/webm') ||
    (isUpscale &&
      ((mimeType.startsWith('image/') &&
        (width === undefined ||
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          height === undefined ||
          !Number.isSafeInteger(height) ||
          height <= 0)) ||
        (mimeType.startsWith('video/') &&
          (width === undefined ||
            !Number.isSafeInteger(width) ||
            width <= 0 ||
            height === undefined ||
            !Number.isSafeInteger(height) ||
            height <= 0 ||
            durationUs === undefined ||
            !Number.isSafeInteger(durationUs) ||
            durationUs <= 0)))) ||
    (durationUs !== undefined && (!Number.isSafeInteger(durationUs) || durationUs < 0))
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'derivative upload headers are invalid');
  return {
    assetId,
    sha256,
    bytes,
    kind: isThumbnail
      ? 'thumbnail'
      : isMask
        ? 'mask'
        : isProxy
          ? 'proxy'
          : isUpscale
            ? 'upscale'
            : 'audio',
    leaseToken,
    descriptor: {
      mimeType,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationUs === undefined ? {} : { durationUs }),
    },
  };
}

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
