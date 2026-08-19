import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  ControlPlaneError,
  type Actor,
  type AssetRegistration,
  type ControlPlane,
  type Job,
  type LocalDerivativeRegistration,
  type MediaAssetRecord,
  type MediaDerivativeRecord,
  type WorkerModelInventoryRecord,
} from './control-plane.js';
import {
  DisabledMediaAuth,
  MediaAuthError,
  type MediaAuthApi,
  type MediaAuthMethod,
} from './media-auth.js';
import {
  createRuntimeMistralProviderRegistry,
  MistralProviderError,
  type MistralProviderRegistry,
} from './mistral-provider.js';
import type { PrivateObjectStore } from './private-object-store.js';
import { remuxBrowserMp4Bytes } from './export-remux.js';
import { MAX_DENOISE_JSON_BYTES } from './spectral-denoise.js';
import {
  MemorySpectralDenoiseInvocationLedger,
  SpectralDenoiseService,
} from './spectral-denoise-service.js';
import {
  MAX_PROJECT_DOCUMENT_SYNC_BYTES,
  validateProjectDocumentSyncRequest,
  isProjectDocumentSyncValidationSuccess,
  type ProjectDocumentSyncValidationSuccess,
} from './project-document-sync-request-validation.js';
import { validateCreativeBriefServerRequest } from './creative-brief-request-validation.js';
import type { CreativeBriefServerRequest } from './creative-brief-request-validation.js';
import type { CreativeBriefRuntime } from './creative-brief-runtime.js';
import type { CreativeBriefRuntimeContext } from './creative-brief-runtime.js';
import { DEFAULT_CREATIVE_BRIEF_RUNTIME } from './creative-brief-runtime.js';
import type {
  CreativeBriefInputResolver,
  CreativeBriefInputResolverRequest,
  CreativeBriefInputResolverResult,
  CreativeBriefInputResolverContext,
} from './creative-brief-input-resolver.js';
import { UnavailableCreativeBriefInputResolver } from './creative-brief-input-resolver.js';
import { validateCreativeBriefClientRequest } from './creative-brief-client-request-validation.js';
import type { CreativeBriefClientRequestEnvelope } from './creative-brief-client-request-validation.js';
import type { CreativeBriefInputV1 } from '@joy-media/agent-tools';
import {
  GpuPreviewTransport,
  deserializeGpuPreviewResponse,
  type SerializedGpuPreviewFrameResponse,
} from './gpu-preview-transport.js';
import type { GpuPreviewFrameRequest } from '@joy-media/job-protocol';
import type { CreativeBriefV1, AsyncCreativeBriefOutcome } from '@joy-media/agent-tools';
import { randomUUID } from 'node:crypto';

export interface ApiAuthentication {
  authenticate(request: IncomingMessage): Actor | undefined | Promise<Actor | undefined>;
}

export interface ControlPlaneHttpServerOptions {
  readonly controlPlane: ControlPlane;
  readonly authentication: ApiAuthentication;
  readonly mediaAuth?: MediaAuthApi;
  readonly privateObjectStore?: PrivateObjectStore;
  /** Server-only provider registry; it never serializes a credential. */
  readonly mistral?: MistralProviderRegistry;
  /** Durable in production; injectable so transport tests never need ffmpeg. */
  readonly audioDenoise?: SpectralDenoiseService;
  /** In-memory only; injectable for deterministic transport tests. */
  readonly gpuPreview?: GpuPreviewTransport;
  /**
   * Creative brief runtime for async creative brief generation.
   * Production default is unavailable. Inject for tests or real implementation.
   */
  readonly creativeBriefRuntime?: CreativeBriefRuntime;
  /**
   * Creative brief input resolver for server-side resolution.
   * Production default is UnavailableCreativeBriefInputResolver.
   * Inject for tests or real implementation.
   */
  readonly creativeBriefInputResolver?: CreativeBriefInputResolver;
}

/**
 * Versioned transport boundary for the control-plane contract. Authentication
 * is injected so the public service can use the shared JOY identity boundary;
 * this module deliberately does not contain a header/token fallback.
 */
export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
  const resolvedOptions = {
    ...options,
    mediaAuth: options.mediaAuth ?? new DisabledMediaAuth(),
    mistral: options.mistral ?? createRuntimeMistralProviderRegistry(),
    audioDenoise:
      options.audioDenoise ??
      new SpectralDenoiseService(new MemorySpectralDenoiseInvocationLedger()),
    gpuPreview: options.gpuPreview ?? new GpuPreviewTransport(options.controlPlane),
    creativeBriefRuntime: options.creativeBriefRuntime ?? DEFAULT_CREATIVE_BRIEF_RUNTIME,
    creativeBriefInputResolver: options.creativeBriefInputResolver ?? UnavailableCreativeBriefInputResolver,
  };
  return createServer(async (request, response) => {
    try {
      await route(resolvedOptions, request, response);
    } catch (error) {
      respondError(response, error);
    }
  });
}

async function route(
  options: ControlPlaneHttpServerOptions & {
    readonly mistral: MistralProviderRegistry;
    readonly mediaAuth: MediaAuthApi;
    readonly audioDenoise: SpectralDenoiseService;
    readonly gpuPreview: GpuPreviewTransport;
    readonly creativeBriefRuntime: CreativeBriefRuntime;
    readonly creativeBriefInputResolver: CreativeBriefInputResolver;
  },
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://joy-media.invalid');
  if (request.method === 'GET' && url.pathname === '/health') {
    respondJson(response, 200, { ok: true, service: 'joy-media-api', controlPlane: true });
    return;
  }
  if (!url.pathname.startsWith('/v1/')) {
    respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/worker-pair/offers') {
    const body = await readJson(request);
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
    const body = await readJson(request);
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

  const workerLeaseMatch = /^\/v1\/workers\/([^/]+)\/leases$/.exec(url.pathname);
  const workerHelloMatch = /^\/v1\/workers\/([^/]+)\/hello$/.exec(url.pathname);
  const workerHeartbeatMatch = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/heartbeat$/.exec(
    url.pathname,
  );
  const workerCompleteMatch = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/complete$/.exec(
    url.pathname,
  );
  const workerFailMatch = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/fail$/.exec(url.pathname);
  const workerDerivativeUploadMatch = /^\/v1\/workers\/([^/]+)\/jobs\/([^/]+)\/derivative$/.exec(
    url.pathname,
  );
  const workerPreviewNextMatch = /^\/v1\/workers\/([^/]+)\/preview\/next$/.exec(url.pathname);
  const workerPreviewCompleteMatch =
    /^\/v1\/workers\/([^/]+)\/preview\/frames\/([^/]+)\/([0-9]+)$/.exec(url.pathname);
  if (
    request.method === 'POST' &&
    (workerLeaseMatch !== null ||
      workerHelloMatch !== null ||
      workerHeartbeatMatch !== null ||
      workerCompleteMatch !== null ||
      workerFailMatch !== null ||
      workerDerivativeUploadMatch !== null ||
      workerPreviewNextMatch !== null ||
      workerPreviewCompleteMatch !== null)
  ) {
    const workerId =
      workerLeaseMatch?.[1] ??
      workerHelloMatch?.[1] ??
      workerHeartbeatMatch?.[1] ??
      workerCompleteMatch?.[1] ??
      workerFailMatch?.[1] ??
      workerDerivativeUploadMatch?.[1] ??
      workerPreviewNextMatch?.[1] ??
      workerPreviewCompleteMatch?.[1];
    const sessionWorkerId = await options.controlPlane.authenticateWorker(
      workerSessionHash(request),
    );
    if (workerId === undefined || sessionWorkerId !== workerId)
      throw new ControlPlaneError('WORKER_SESSION_REQUIRED', 'worker session required');
    if (workerLeaseMatch !== null) {
      const body = await readJson(request);
      const durationMs = optionalPositiveInteger(body, 'durationMs') ?? 30_000;
      const job = await options.controlPlane.lease(
        decodeURIComponent(workerId),
        Date.now(),
        durationMs,
      );
      respondJson(response, 200, { data: job ?? null });
      return;
    }
    if (workerPreviewNextMatch !== null) {
      await readJson(request, 1_024);
      respondNoStoreJson(response, 200, {
        data: options.gpuPreview.take(decodeURIComponent(workerId)),
      });
      return;
    }
    if (workerPreviewCompleteMatch !== null) {
      const body = await readJson(request, 24 * 1024 * 1024);
      const serialized = serializedGpuPreviewResponse(body);
      if (
        serialized.sessionId !== decodeURIComponent(workerPreviewCompleteMatch[2]!) ||
        serialized.requestId !== Number(workerPreviewCompleteMatch[3]!)
      )
        throw new ControlPlaneError('REQUEST_INVALID', 'GPU preview response identity mismatch');
      options.gpuPreview.complete(
        decodeURIComponent(workerId),
        deserializeGpuPreviewResponse(serialized),
      );
      respondNoStoreJson(response, 200, { data: { accepted: true } });
      return;
    }
    if (workerHelloMatch !== null) {
      const body = await readJson(request);
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
    if (workerHeartbeatMatch !== null) {
      const body = await readJson(request);
      respondJson(response, 200, {
        data: await options.controlPlane.heartbeat(
          decodeURIComponent(workerId),
          decodeURIComponent(workerHeartbeatMatch[2]!),
          requiredProgress(body),
        ),
      });
      return;
    }
    if (workerFailMatch !== null) {
      const body = await readJson(request);
      respondJson(response, 200, {
        data: await options.controlPlane.fail(
          decodeURIComponent(workerId),
          decodeURIComponent(workerFailMatch[2]!),
          requiredString(body, 'error'),
        ),
      });
      return;
    }
    if (workerDerivativeUploadMatch !== null) {
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
      const jobId = decodeURIComponent(workerDerivativeUploadMatch[2]!);
      // Job ids are project-scoped and may already approach the opaque-id
      // limit. Hash the job id for the private-object key so adding the
      // derivative prefix and content digest can never create an invalid
      // location, while the public derivative record still retains the exact
      // job id below.
      const jobDigest = createHash('sha256').update(jobId).digest('hex').slice(0, 32);
      const ref = `derivative-${jobDigest}-${receipt.sha256.slice(0, 16)}`;
      await store.put(
        {
          ref,
          sha256: receipt.sha256,
          bytes: receipt.bytes,
          mimeType: receipt.descriptor.mimeType,
        },
        bytes,
      );
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
      );
      respondJson(response, 201, { data: derivativeForBrowser(derivative) });
      return;
    }
    respondJson(response, 200, {
      data: await options.controlPlane.complete(
        decodeURIComponent(workerId),
        decodeURIComponent(workerCompleteMatch![2]!),
        undefined,
        optionalWorkerResult(await readJson(request)),
      ),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/request-otp') {
    const body = await readJson(request);
    const data = await options.mediaAuth.requestOtp(
      requiredString(body, 'contact'),
      requiredAuthMethod(body),
      request,
    );
    respondJson(response, 200, { data });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/verify-otp') {
    const body = await readJson(request);
    const token = await options.mediaAuth.verifyOtp(
      requiredString(body, 'contact'),
      requiredAuthMethod(body),
      requiredString(body, 'code'),
    );
    respondJson(response, 200, { data: { token } });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
    const token = bearerToken(request);
    if (token !== undefined) await options.mediaAuth.logout(token);
    respondJson(response, 200, { data: { ok: true } });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/auth/session') {
    const profile = await options.mediaAuth.sessionProfile(request);
    if (profile === undefined)
      throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');
    respondJson(response, 200, { data: profile });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/auth/avatar') {
    const avatar = await options.mediaAuth.avatarBytes(request);
    if (avatar === undefined) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { code: 'AVATAR_NOT_FOUND', message: 'no avatar' } }));
      return;
    }
    response.writeHead(200, {
      'content-type': avatar.mimeType,
      'cache-control': 'private, max-age=3600',
      'content-length': avatar.bytes.length,
    });
    response.end(avatar.bytes);
    return;
  }

  const actor = await options.authentication.authenticate(request);
  if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');

  const creativeBriefMatch = /^\/v1\/projects\/([^/]+)\/creative-brief$/.exec(url.pathname);
  if (request.method === 'POST' && creativeBriefMatch !== null) {
    const projectId = decodeURIComponent(creativeBriefMatch[1]!);
    const project = await options.controlPlane.getProject(actor, projectId);
    if (!project.creativeBriefOptIn) {
      throw new ControlPlaneError('POLICY_DENIED', 'creative brief not opted in for this project');
    }

    // Step 3: Strict client-envelope validation (browser-safe envelope only)
    const body = await readJson(request);
    const clientValidation = validateCreativeBriefClientRequest(body);
    if (!clientValidation.valid) {
      const firstError = clientValidation.errors[0];
      if (firstError) {
        throw new ControlPlaneError(
          firstError.code === 'invalid-envelope' ? 'REQUEST_INVALID' :
          firstError.code === 'payload-too-large' ? 'PAYLOAD_TOO_LARGE' :
          firstError.code === 'unknown-field' ? 'REQUEST_INVALID' :
          firstError.code === 'forbidden-field' ? 'REQUEST_INVALID' :
          firstError.code === 'project-mismatch' ? 'PROJECT_MISMATCH' :
          firstError.code === 'revision-mismatch' ? 'REVISION_MISMATCH' :
          firstError.code === 'invalid-request' ? 'REQUEST_INVALID' :
          'REQUEST_INVALID',
          firstError.message,
        );
      }
      throw new ControlPlaneError('REQUEST_INVALID', 'Creative brief client request validation failed');
    }

    // Type assertion is safe because we just validated it
    const clientEnvelope = body as unknown as CreativeBriefClientRequestEnvelope;

    // Step 4: Input resolver - resolve server-side canonical input
    const resolverRequest: CreativeBriefInputResolverRequest = {
      projectId: clientEnvelope.projectId,
      snapshotRevisionId: clientEnvelope.snapshotRevisionId,
      request: clientEnvelope.request,
    };
    const resolverContext: CreativeBriefInputResolverContext = {
      actor,
    };
    const resolverResult: CreativeBriefInputResolverResult = await options.creativeBriefInputResolver.resolve(resolverRequest, resolverContext);

    // Handle resolver failures
    if (resolverResult.status === 'unavailable') {
      respondJson(response, 503, {
        data: {
          kind: 'unavailable',
          code: resolverResult.code,
          message: resolverResult.message,
        },
      });
      return;
    }

    if (resolverResult.status === 'stale-revision') {
      respondJson(response, 409, {
        error: {
          code: 'REVISION_MISMATCH',
          message: resolverResult.message,
        },
      });
      return;
    }

    // Step 5: Runtime with resolved input
    const runtimeContext: CreativeBriefRuntimeContext = {
      correlationId: randomUUID(),
      signal: request.socket?.destroyed ? AbortSignal.abort() : undefined,
      timeoutMs: 30_000, // 30 second default timeout
      spendLimitUsdCents: 0, // Free-only policy
    };

    const resolvedInput: CreativeBriefInputV1 = resolverResult.input;
    const outcome: AsyncCreativeBriefOutcome = await options.creativeBriefRuntime.execute(
      resolvedInput,
      runtimeContext,
    );

    // Map outcome to HTTP response
    const httpResponse = mapCreativeBriefOutcomeToHttpResponse(outcome);
    respondJson(response, httpResponse.statusCode, httpResponse.body);
    return;
  }

  const openPreviewSessionMatch = /^\/v1\/projects\/([^/]+)\/preview-sessions$/.exec(url.pathname);
  if (request.method === 'POST' && openPreviewSessionMatch !== null) {
    await readJson(request, 1_024);
    const session = await options.gpuPreview.open(
      actor,
      decodeURIComponent(openPreviewSessionMatch[1]!),
    );
    respondNoStoreJson(response, 201, { data: session });
    return;
  }
  const previewFrameMatch = /^\/v1\/preview-sessions\/([^/]+)\/frames$/.exec(url.pathname);
  if (request.method === 'POST' && previewFrameMatch !== null) {
    const body = await readJson(request, 24 * 1024 * 1024);
    const frame = body as unknown as GpuPreviewFrameRequest;
    if (frame.sessionId !== decodeURIComponent(previewFrameMatch[1]!))
      throw new ControlPlaneError('REQUEST_INVALID', 'GPU preview request identity mismatch');
    options.gpuPreview.offer(actor, frame);
    respondNoStoreJson(response, 202, { data: { accepted: true, requestId: frame.requestId } });
    return;
  }
  const previewResultMatch = /^\/v1\/preview-sessions\/([^/]+)\/frames\/([0-9]+)$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && previewResultMatch !== null) {
    const result = options.gpuPreview.result(
      actor,
      decodeURIComponent(previewResultMatch[1]!),
      Number(previewResultMatch[2]!),
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
  const previewSessionMatch = /^\/v1\/preview-sessions\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && previewSessionMatch !== null) {
    options.gpuPreview.close(actor, decodeURIComponent(previewSessionMatch[1]!));
    respondNoStoreJson(response, 200, { data: { closed: true } });
    return;
  }

  const browserRemuxMatch = /^\/v1\/projects\/([^/]+)\/export\/remux$/.exec(url.pathname);
  if (request.method === 'POST' && browserRemuxMatch !== null) {
    const projectId = decodeURIComponent(browserRemuxMatch[1]!);
    await options.controlPlane.getProject(actor, projectId);
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('video/mp4'))
      throw new ControlPlaneError('REQUEST_INVALID', 'browser export must be video/mp4');
    const bytes = await readBytes(request, 512 * 1024 * 1024);
    const requestedFrameRate = Number(request.headers['x-joy-frame-rate'] ?? 30);
    const requestedFrameCountHeader = request.headers['x-joy-frame-count'];
    const requestedFrameCount =
      requestedFrameCountHeader === undefined ? undefined : Number(requestedFrameCountHeader);
    let result: ReturnType<typeof remuxBrowserMp4Bytes>;
    try {
      result = remuxBrowserMp4Bytes(bytes, requestedFrameRate, requestedFrameCount);
    } catch {
      throw new ControlPlaneError('PROVIDER_FAILED', 'browser export remux failed');
    }
    response.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(result.bytes.byteLength),
      'cache-control': 'private, no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      'x-joy-video-codec': result.probe.videoCodec,
      'x-joy-audio-codec': result.probe.audioCodec,
    });
    response.end(Buffer.from(result.bytes));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/providers/reasoning') {
    respondJson(response, 200, { data: { providers: [options.mistral.summary()] } });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/providers/mistral/complete') {
    const body = await readJson(request);
    const result = await options.mistral.complete(actor.id, mistralCompletionRequest(body));
    respondJson(response, 200, { data: result });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/workers') {
    respondJson(response, 200, { data: await options.controlPlane.workersForOwner(actor) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/library/cloud-assets') {
    const assets = await options.controlPlane.sharedCloudAssets(actor);
    respondJson(response, 200, { data: assets.map(assetForBrowser) });
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

  const sharedCloudContentMatch = /^\/v1\/library\/cloud-assets\/([^/]+)\/content$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && sharedCloudContentMatch !== null) {
    const store = options.privateObjectStore;
    if (store === undefined)
      throw new ControlPlaneError(
        'PRIVATE_STORE_UNAVAILABLE',
        'private media storage is unavailable',
      );
    const asset = await options.controlPlane.sharedCloudAsset(
      actor,
      decodeURIComponent(sharedCloudContentMatch[1]!),
    );
    const location = asset.locations.find((candidate) => candidate.kind === 'private-object');
    if (location === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', asset.id);
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

  const derivativeContentMatch =
    /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives\/([^/]+)\/content$/.exec(url.pathname);
  if (request.method === 'GET' && derivativeContentMatch !== null) {
    const store = options.privateObjectStore;
    if (store === undefined)
      throw new ControlPlaneError(
        'PRIVATE_STORE_UNAVAILABLE',
        'private media storage is unavailable',
      );
    const derivative = await options.controlPlane.cloudDerivativeForOwner(
      actor,
      decodeURIComponent(derivativeContentMatch[1]!),
      decodeURIComponent(derivativeContentMatch[2]!),
      decodeURIComponent(derivativeContentMatch[3]!),
    );
    const location = derivative.locations.find((candidate) => candidate.kind === 'private-object');
    if (location === undefined)
      throw new ControlPlaneError('DERIVATIVE_UNAVAILABLE', derivative.id);
    const bytes = await store.get({
      ref: location.ref,
      sha256: derivative.sha256,
      bytes: derivative.bytes,
      mimeType: derivative.descriptor.mimeType,
    });
    response.writeHead(200, {
      'content-type': derivative.descriptor.mimeType,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    response.end(bytes);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/projects/ensure') {
    const body = await readJson(request);
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
    const body = await readJson(request);
    respondJson(response, 201, {
      data: await options.controlPlane.createProject(
        actor,
        requiredString(body, 'id'),
        requiredString(body, 'title'),
      ),
    });
    return;
  }

  const projectDocumentSyncMatch = /^\/v1\/projects\/([^/]+)\/document$/.exec(url.pathname);
  if (request.method === 'PUT' && projectDocumentSyncMatch !== null) {
    const pathProjectId = decodeURIComponent(projectDocumentSyncMatch[1]!);
    const body = await readJson(request, MAX_PROJECT_DOCUMENT_SYNC_BYTES);
    const validation = validateProjectDocumentSyncRequest(body, pathProjectId);
    if (!isProjectDocumentSyncValidationSuccess(validation)) {
      respondJson(response, 400, { error: { code: 'REQUEST_INVALID' } });
      return;
    }
    const result = await options.controlPlane.writeProjectDocument(
      actor,
      {
        projectId: pathProjectId,
        ownerId: actor.id,
        revisionId: validation.envelope.revisionId,
        document: validation.envelope.document,
      },
      validation.envelope.baseRevisionId,
    );
    if (result.kind === 'stored') {
      respondJson(response, 200, { data: { projectId: result.projectId, revisionId: result.revisionId } });
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

  const projectLifecycleMatch = /^\/v1\/projects\/([^/]+)$/.exec(url.pathname);
  if (projectLifecycleMatch !== null) {
    const projectId = decodeURIComponent(projectLifecycleMatch[1]!);
    if (request.method === 'GET') {
      respondJson(response, 200, { data: await options.controlPlane.getProject(actor, projectId) });
      return;
    }
    if (request.method === 'PATCH') {
      const body = await readJson(request);
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
      let cloudObjectsPurged = 0;
      let cloudObjectPurgeFailures = 0;
      for (const ref of deleted.orphanedPrivateObjectRefs) {
        try {
          if (options.privateObjectStore === undefined)
            throw new Error('private store unavailable');
          await options.privateObjectStore.remove(ref);
          cloudObjectsPurged += 1;
        } catch {
          cloudObjectPurgeFailures += 1;
        }
      }
      respondJson(response, 200, {
        data: { id: deleted.id, cloudObjectsPurged, cloudObjectPurgeFailures },
      });
      return;
    }
  }

  const duplicateProjectMatch = /^\/v1\/projects\/([^/]+)\/duplicate$/.exec(url.pathname);
  if (request.method === 'POST' && duplicateProjectMatch !== null) {
    const body = await readJson(request);
    respondJson(response, 201, {
      data: await options.controlPlane.duplicateProject(
        actor,
        decodeURIComponent(duplicateProjectMatch[1]!),
        requiredString(body, 'id'),
        requiredString(body, 'title'),
        requiredNonNegativeInteger(body, 'baseRevision'),
      ),
    });
    return;
  }

  const projectStateMatch = /^\/v1\/projects\/([^/]+)\/(trash|restore)$/.exec(url.pathname);
  if (request.method === 'POST' && projectStateMatch !== null) {
    const body = await readJson(request);
    const projectId = decodeURIComponent(projectStateMatch[1]!);
    const baseRevision = requiredNonNegativeInteger(body, 'baseRevision');
    const data =
      projectStateMatch[2] === 'trash'
        ? await options.controlPlane.trashProject(actor, projectId, baseRevision)
        : await options.controlPlane.restoreProject(actor, projectId, baseRevision);
    respondJson(response, 200, { data });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/providers/speech/transcribe') {
    const { runWhisperOnReferenceAsset, runWhisperTranscription } =
      await import('./whisper-transcribe.js');
    const contentType = request.headers['content-type'] ?? '';
    let transcript;
    if (contentType.includes('application/json')) {
      const body = await readJson(request);
      const language = requiredString(body, 'language');
      const referenceAssetId =
        typeof body.referenceAssetId === 'string' ? body.referenceAssetId : undefined;
      if (referenceAssetId !== undefined) {
        transcript = runWhisperOnReferenceAsset(referenceAssetId, language);
      } else {
        throw new ControlPlaneError(
          'REQUEST_INVALID',
          'JSON body requires referenceAssetId (or send raw media bytes)',
        );
      }
    } else {
      const language = url.searchParams.get('language');
      if (language === null || language.length === 0) {
        throw new ControlPlaneError('REQUEST_INVALID', 'language query parameter is required');
      }
      const media = await readBytes(request, 64 * 1024 * 1024);
      if (media.byteLength === 0) {
        throw new ControlPlaneError('REQUEST_INVALID', 'media body is required');
      }
      const extension = contentType.includes('wav')
        ? 'wav'
        : contentType.includes('mpeg') || contentType.includes('mp3')
          ? 'mp3'
          : contentType.includes('mp4') || contentType.includes('video')
            ? 'mp4'
            : 'bin';
      transcript = runWhisperTranscription(media, language, { mediaExtension: extension });
    }
    respondJson(response, 200, {
      data: {
        language: transcript.language,
        words: transcript.words,
        speakers: transcript.speakers,
        provenance: {
          providerId: 'joy.faster-whisper',
          modelId: transcript.modelId,
          createdAt: new Date().toISOString(),
        },
      },
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/providers/speech/synthesize') {
    const { runSpeechSynthesis, resolveSpeechEngine } = await import('./speech-synthesize.js');
    const body = await readJson(request);
    const text = requiredString(body, 'text');
    const language = typeof body.language === 'string' ? body.language : undefined;
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : undefined;
    const speed = typeof body.speed === 'number' ? body.speed : undefined;
    const engine = resolveSpeechEngine(body.engine);
    const synthesized = runSpeechSynthesis({
      text,
      engine,
      ...(language !== undefined ? { language } : {}),
      ...(voiceId !== undefined ? { voiceId } : {}),
      ...(speed !== undefined ? { speed } : {}),
    });
    respondJson(response, 200, { data: synthesized });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/providers/audio/denoise') {
    const projectId = requiredQuery(url, 'projectId');
    const operationId = requiredQuery(url, 'operationId');
    await options.controlPlane.getProject(actor, projectId);
    const operation = await options.audioDenoise.find(actor.id, projectId, operationId);
    if (operation === undefined)
      throw new ControlPlaneError('PROVIDER_OPERATION_NOT_FOUND', operationId);
    response.setHeader('cache-control', 'private, no-store');
    respondJson(response, 200, { data: operation });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/providers/audio/denoise') {
    const body = await readJson(request, MAX_DENOISE_JSON_BYTES);
    const projectId = requiredString(body, 'projectId');
    const operationId = requiredString(body, 'operationId');
    const project = await options.controlPlane.getProject(actor, projectId);
    if (project.trashedAt !== undefined) throw new ControlPlaneError('PROJECT_TRASHED', projectId);
    const assetId = requiredString(body, 'assetId');
    const mediaBase64 = requiredString(body, 'mediaBase64');
    const sampleRate = typeof body.sampleRate === 'number' ? body.sampleRate : undefined;
    const strength = typeof body.strength === 'number' ? body.strength : undefined;
    const operation = await options.audioDenoise.run(actor.id, {
      projectId,
      operationId,
      assetId,
      mediaBase64,
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(strength !== undefined ? { strength } : {}),
    });
    if (operation.result === undefined)
      throw new ControlPlaneError(
        'PROVIDER_FAILED',
        'Cloud denoise completed without a recoverable result',
      );
    response.setHeader('cache-control', 'private, no-store');
    respondJson(response, 200, { data: operation.result });
    return;
  }

  const assetSyncMatch = /^\/v1\/projects\/([^/]+)\/asset-sync$/.exec(url.pathname);
  if (request.method === 'POST' && assetSyncMatch !== null) {
    const body = await readJson(request);
    if (typeof body.enabled !== 'boolean')
      throw new ControlPlaneError('REQUEST_INVALID', 'enabled must be boolean');
    respondJson(response, 200, {
      data: await options.controlPlane.setAssetSync(
        actor,
        decodeURIComponent(assetSyncMatch[1]!),
        body.enabled,
      ),
    });
    return;
  }

  const workerPairMatch = /^\/v1\/workers\/([^/]+)\/pair$/.exec(url.pathname);
  if (request.method === 'POST' && workerPairMatch !== null) {
    const [, workerId] = workerPairMatch;
    const body = await readJson(request);
    respondJson(response, 200, {
      data: await options.controlPlane.approvePairing(
        actor,
        decodeURIComponent(workerId!),
        secretHash(requiredString(body, 'pairingCode')),
      ),
    });
    return;
  }

  const workerRevokeMatch = /^\/v1\/workers\/([^/]+)\/revoke$/.exec(url.pathname);
  if (request.method === 'POST' && workerRevokeMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.revokeWorker(
        actor,
        decodeURIComponent(workerRevokeMatch[1]!),
      ),
    });
    return;
  }

  const assetMatch = /^\/v1\/projects\/([^/]+)\/assets$/.exec(url.pathname);
  if (request.method === 'GET' && assetMatch !== null) {
    const assets = await options.controlPlane.assetsForProject(
      actor,
      decodeURIComponent(assetMatch[1]!),
    );
    respondJson(response, 200, {
      data: assets.map(assetForBrowser),
    });
    return;
  }
  if (request.method === 'POST' && assetMatch !== null) {
    const body = await readJson(request);
    const asset = await options.controlPlane.registerAsset(
      actor,
      decodeURIComponent(assetMatch[1]!),
      assetRegistration(body),
    );
    respondJson(response, 201, {
      data: assetForBrowser(asset),
    });
    return;
  }

  const assetByIdMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && assetByIdMatch !== null) {
    const deleted = await options.controlPlane.deleteAsset(
      actor,
      decodeURIComponent(assetByIdMatch[1]!),
      decodeURIComponent(assetByIdMatch[2]!),
    );
    let cloudObjectsPurged = 0;
    let cloudObjectPurgeFailures = 0;
    for (const ref of deleted.orphanedPrivateObjectRefs) {
      try {
        if (options.privateObjectStore === undefined) throw new Error('private store unavailable');
        await options.privateObjectStore.remove(ref);
        cloudObjectsPurged += 1;
      } catch {
        cloudObjectPurgeFailures += 1;
      }
    }
    respondJson(response, 200, {
      data: { id: deleted.id, cloudObjectsPurged, cloudObjectPurgeFailures },
    });
    return;
  }

  const assetOriginalMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/original$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && assetOriginalMatch !== null) {
    const store = options.privateObjectStore;
    if (store === undefined)
      throw new ControlPlaneError(
        'PRIVATE_STORE_UNAVAILABLE',
        'private media storage is unavailable',
      );
    const projectId = decodeURIComponent(assetOriginalMatch[1]!);
    const assetId = decodeURIComponent(assetOriginalMatch[2]!);
    const assets = await options.controlPlane.assetsForProject(actor, projectId);
    const asset = assets.find((entry) => entry.id === assetId);
    if (asset === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const location = asset.locations.find((candidate) => candidate.kind === 'private-object');
    if (location === undefined) throw new ControlPlaneError('ASSET_UNAVAILABLE', assetId);
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
  if (request.method === 'POST' && assetOriginalMatch !== null) {
    const store = options.privateObjectStore;
    if (store === undefined)
      throw new ControlPlaneError(
        'PRIVATE_STORE_UNAVAILABLE',
        'private media storage is unavailable',
      );
    const projectId = decodeURIComponent(assetOriginalMatch[1]!);
    const assetId = decodeURIComponent(assetOriginalMatch[2]!);
    const assets = await options.controlPlane.assetsForProject(actor, projectId);
    const asset = assets.find((entry) => entry.id === assetId);
    if (asset === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const mimeType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!new RegExp(`^${asset.kind}/[a-z0-9.+-]+$`).test(mimeType))
      throw new ControlPlaneError(
        'REQUEST_INVALID',
        'original upload MIME type must match the registered asset kind',
      );
    const declaredSha = String(request.headers['x-joy-sha256'] ?? '').toLowerCase();
    const declaredBytes = Number(request.headers['x-joy-bytes'] ?? NaN);
    if (
      !/^[a-f0-9]{64}$/.test(declaredSha) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1
    )
      throw new ControlPlaneError('REQUEST_INVALID', 'original integrity headers are invalid');
    if (declaredSha !== asset.sha256 || declaredBytes !== asset.bytes)
      throw new ControlPlaneError('REQUEST_INVALID', 'original does not match registered asset');
    const bytes = await readBytes(request, 512 * 1024 * 1024);
    if (bytes.byteLength !== asset.bytes)
      throw new ControlPlaneError('REQUEST_INVALID', 'original byte length does not match asset');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.sha256)
      throw new ControlPlaneError('REQUEST_INVALID', 'original sha256 does not match asset');
    await options.controlPlane.setAssetSync(actor, projectId, true);
    const ref = `orig-${asset.sha256.slice(0, 32)}`;
    await store.put({ ref, sha256: asset.sha256, bytes: asset.bytes, mimeType }, bytes);
    const { tagAssetWithHermes } = await import('./asset-hermes-tags.js');
    const tagged = await tagAssetWithHermes({
      kind: asset.kind,
      displayName: asset.displayName,
      mimeType: asset.descriptor.mimeType,
      bytes: asset.bytes,
      ...(asset.descriptor.width !== undefined ? { width: asset.descriptor.width } : {}),
      ...(asset.descriptor.height !== undefined ? { height: asset.descriptor.height } : {}),
      ...(asset.kind === 'image' ? { imageBytes: bytes } : {}),
    });
    let updated = await options.controlPlane.attachCloudOriginal(actor, projectId, assetId, {
      kind: 'private-object',
      ref,
    });
    updated = await options.controlPlane.updateAssetMetadata(actor, projectId, assetId, {
      tags: tagged.tags,
      sortName: tagged.sortName,
    });
    respondJson(response, 201, {
      data: {
        asset: assetForBrowser(updated),
        tagProvenance: tagged.provenance,
      },
    });
    return;
  }

  const assetMetadataMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/metadata$/.exec(
    url.pathname,
  );
  if (request.method === 'POST' && assetMetadataMatch !== null) {
    const body = await readJson(request);
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((item): item is string => typeof item === 'string')
      : undefined;
    const sortName = typeof body.sortName === 'string' ? body.sortName : undefined;
    const displayName = typeof body.displayName === 'string' ? body.displayName : undefined;
    const asset = await options.controlPlane.updateAssetMetadata(
      actor,
      decodeURIComponent(assetMetadataMatch[1]!),
      decodeURIComponent(assetMetadataMatch[2]!),
      {
        ...(tags !== undefined ? { tags } : {}),
        ...(sortName !== undefined ? { sortName } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      },
    );
    respondJson(response, 200, { data: assetForBrowser(asset) });
    return;
  }

  const assetRetagMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/retag$/.exec(url.pathname);
  if (request.method === 'POST' && assetRetagMatch !== null) {
    const projectId = decodeURIComponent(assetRetagMatch[1]!);
    const assetId = decodeURIComponent(assetRetagMatch[2]!);
    const assets = await options.controlPlane.assetsForProject(actor, projectId);
    const asset = assets.find((entry) => entry.id === assetId);
    if (asset === undefined) throw new ControlPlaneError('ASSET_NOT_FOUND', assetId);
    const { tagAssetWithHermes } = await import('./asset-hermes-tags.js');
    const tagged = await tagAssetWithHermes({
      kind: asset.kind,
      displayName: asset.displayName,
      mimeType: asset.descriptor.mimeType,
      bytes: asset.bytes,
      ...(asset.descriptor.width !== undefined ? { width: asset.descriptor.width } : {}),
      ...(asset.descriptor.height !== undefined ? { height: asset.descriptor.height } : {}),
    });
    const updated = await options.controlPlane.updateAssetMetadata(actor, projectId, assetId, {
      tags: tagged.tags,
      sortName: tagged.sortName,
    });
    respondJson(response, 200, { data: assetForBrowser(updated) });
    return;
  }

  const derivativeMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && derivativeMatch !== null) {
    const derivatives = await options.controlPlane.derivativesForAsset(
      actor,
      decodeURIComponent(derivativeMatch[1]!),
      decodeURIComponent(derivativeMatch[2]!),
    );
    respondJson(response, 200, {
      data: derivatives.map(derivativeForBrowser),
    });
    return;
  }
  if (request.method === 'POST' && derivativeMatch !== null) {
    const body = await readJson(request);
    const derivative = localDerivativeRegistration(body);
    if (derivative.assetId !== decodeURIComponent(derivativeMatch[2]!))
      throw new ControlPlaneError('REQUEST_INVALID', 'derivative assetId must match the route');
    const registered = await options.controlPlane.registerLocalDerivative(
      actor,
      decodeURIComponent(derivativeMatch[1]!),
      derivative,
    );
    respondJson(response, 201, {
      data: derivativeForBrowser(registered),
    });
    return;
  }

  const jobMatch = /^\/v1\/projects\/([^/]+)\/jobs$/.exec(url.pathname);
  if (request.method === 'GET' && jobMatch !== null) {
    const jobs = await options.controlPlane.jobsForProject(actor, decodeURIComponent(jobMatch[1]!));
    respondJson(response, 200, {
      data: jobs.map(jobForBrowser),
    });
    return;
  }
  if (request.method === 'POST' && jobMatch !== null) {
    const body = await readJson(request);
    const type = requiredString(body, 'type');
    const job =
      type === 'asset.thumbnail'
        ? await options.controlPlane.enqueueAssetThumbnail(
            actor,
            requiredString(body, 'id'),
            decodeURIComponent(jobMatch[1]!),
            requiredString(body, 'assetId'),
          )
        : type === 'image.comfy' ||
            type === 'audio.ml-denoise' ||
            type === 'mask.image' ||
            type === 'mask.video' ||
            type === 'upscale.image' ||
            type === 'upscale.video'
          ? await options.controlPlane.enqueue(
              actor,
              requiredString(body, 'id'),
              decodeURIComponent(jobMatch[1]!),
              type,
              Date.now(),
              requiredString(body, 'assetId'),
              jobPayload(body),
            )
          : await options.controlPlane.enqueue(
              actor,
              requiredString(body, 'id'),
              decodeURIComponent(jobMatch[1]!),
              type,
              Date.now(),
              typeof body.assetId === 'string' ? body.assetId : undefined,
              jobPayload(body),
            );
    respondJson(response, 201, { data: jobForBrowser(job) });
    return;
  }

  const cancelMatch = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && cancelMatch !== null) {
    const job = await options.controlPlane.cancel(
      actor,
      decodeURIComponent(cancelMatch[1]!),
      decodeURIComponent(cancelMatch[2]!),
    );
    respondJson(response, 200, { data: jobForBrowser(job) });
    return;
  }
  const retryMatch = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (request.method === 'POST' && retryMatch !== null) {
    const job = await options.controlPlane.retry(
      actor,
      decodeURIComponent(retryMatch[1]!),
      decodeURIComponent(retryMatch[2]!),
    );
    respondJson(response, 200, { data: jobForBrowser(job) });
    return;
  }

  const eventsMatch = /^\/v1\/projects\/([^/]+)\/events$/.exec(url.pathname);
  if (request.method === 'GET' && eventsMatch !== null) {
    const cursor = optionalCursor(url.searchParams.get('cursor'));
    respondJson(response, 200, {
      data: await options.controlPlane.eventsAfter(
        actor,
        decodeURIComponent(eventsMatch[1]!),
        cursor,
      ),
    });
    return;
  }

  respondJson(response, 404, { error: { code: 'ROUTE_NOT_FOUND' } });
}

async function readJson(
  request: IncomingMessage,
  maximumBytes = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length'] ?? NaN);
  if (Number.isFinite(maximumBytes) && declaredLength > maximumBytes) {
    throw new ControlPlaneError('REQUEST_INVALID', 'request body exceeds the size limit');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximumBytes) {
      throw new ControlPlaneError('REQUEST_INVALID', 'request body exceeds the size limit');
    }
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('body must be an object');
    }
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

function requiredAuthMethod(body: Record<string, unknown>): MediaAuthMethod {
  const value = body.method;
  if (value !== 'gmail' && value !== 'telegram')
    throw new ControlPlaneError('REQUEST_INVALID', 'method must be gmail or telegram');
  return value;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
  return value;
}

function requiredQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field);
  if (value === null || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} query parameter is required`);
  return value;
}

function mistralCompletionRequest(body: Record<string, unknown>) {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 64)
    throw new ControlPlaneError(
      'REQUEST_INVALID',
      'messages must contain between 1 and 64 entries',
    );
  const parsedMessages = messages.map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message))
      throw new ControlPlaneError('REQUEST_INVALID', 'message must be an object');
    const value = message as Record<string, unknown>;
    if (
      (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant') ||
      typeof value.content !== 'string' ||
      value.content.length === 0
    )
      throw new ControlPlaneError('REQUEST_INVALID', 'message role/content is invalid');
    return { role: value.role, content: value.content } as const;
  });
  const optionalNumber = (field: string): number | undefined =>
    body[field] === undefined
      ? undefined
      : typeof body[field] === 'number' && Number.isFinite(body[field])
        ? body[field]
        : (() => {
            throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a number`);
          })();
  const privacyMode = body.privacyMode;
  if (privacyMode !== 'local-only' && privacyMode !== 'ask-before-remote')
    throw new ControlPlaneError('REQUEST_INVALID', 'privacyMode is invalid');
  const maxTokens = optionalNumber('maxTokens');
  const temperature = optionalNumber('temperature');
  return {
    model: requiredString(body, 'model'),
    messages: parsedMessages,
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    privacyMode: privacyMode as 'local-only' | 'ask-before-remote',
    approvedRemoteProcessing: body.approvedRemoteProcessing === true,
    approvedSpend: body.approvedSpend === true,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
  };
}

function optionalPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a positive integer`);
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
  const managerVersion = body.managerVersion;
  const cacheStatus = body.cacheStatus;
  const models = body.models;
  if (
    typeof managerVersion !== 'string' ||
    managerVersion.length === 0 ||
    managerVersion.length > 64 ||
    !['ready', 'read-only', 'unavailable'].includes(String(cacheStatus)) ||
    !Array.isArray(models) ||
    models.length > 128
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'modelInventory is invalid');
  return {
    managerVersion,
    cacheStatus: cacheStatus as WorkerModelInventoryRecord['cacheStatus'],
    ...(typeof body.freeBytes === 'number' &&
    Number.isSafeInteger(body.freeBytes) &&
    body.freeBytes >= 0
      ? { freeBytes: body.freeBytes }
      : {}),
    models: models.map((item) => {
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

/**
 * Keeps execution parameters in the private Worker lease while browser job
 * projections remain metadata-only. `payload` is the canonical form; the
 * legacy top-level AI fields are normalized for existing clients.
 */
function jobPayload(body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const explicit = body.payload;
  if (explicit !== undefined) {
    if (explicit === null || typeof explicit !== 'object' || Array.isArray(explicit))
      throw new ControlPlaneError('REQUEST_INVALID', 'payload must be an object');
    return explicit as Readonly<Record<string, unknown>>;
  }
  const payload: Record<string, unknown> = {};
  for (const field of [
    'prompt',
    'negativePrompt',
    'imageAssetId',
    'model',
    'params',
    'fixture',
  ] as const) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  return payload;
}

function optionalWorkerResult(body: Record<string, unknown>):
  | { readonly kind: 'fixture.thumbnail'; readonly sha256: string; readonly bytes: number }
  | {
      readonly kind: 'asset.thumbnail';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: 'image/jpeg';
        readonly width: number;
        readonly height: number;
      };
    }
  | {
      readonly kind:
        | 'image.comfy'
        | 'audio.ml-denoise'
        | 'mask.image'
        | 'mask.video'
        | 'upscale.image'
        | 'upscale.video';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: string;
        readonly width?: number;
        readonly height?: number;
        readonly durationUs?: number;
      };
    }
  | undefined {
  const value = body.result;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'result must be an object');
  const result = value as Record<string, unknown>;
  if (result.kind === 'fixture.thumbnail' && isReceiptHashAndBytes(result)) {
    return { kind: result.kind, sha256: result.sha256, bytes: result.bytes };
  }
  const descriptor = result.descriptor;
  if (
    (result.kind === 'image.comfy' ||
      result.kind === 'audio.ml-denoise' ||
      result.kind === 'mask.image' ||
      result.kind === 'mask.video' ||
      result.kind === 'upscale.image' ||
      result.kind === 'upscale.video') &&
    typeof result.assetId === 'string' &&
    typeof result.localRef === 'string' &&
    isReceiptHashAndBytes(result) &&
    descriptor !== null &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    typeof (descriptor as Record<string, unknown>).mimeType === 'string'
  ) {
    const mimeType = (descriptor as Record<string, unknown>).mimeType as string;
    const width = (descriptor as Record<string, unknown>).width;
    const height = (descriptor as Record<string, unknown>).height;
    const durationUs = (descriptor as Record<string, unknown>).durationUs;
    return {
      kind: result.kind,
      assetId: result.assetId,
      sha256: result.sha256,
      bytes: result.bytes,
      localRef: result.localRef,
      descriptor: {
        mimeType,
        ...(typeof width === 'number' && Number.isSafeInteger(width) ? { width } : {}),
        ...(typeof height === 'number' && Number.isSafeInteger(height) ? { height } : {}),
        ...(typeof durationUs === 'number' && Number.isSafeInteger(durationUs)
          ? { durationUs }
          : {}),
      },
      ...(typeof result.modelId === 'string' ? { modelId: result.modelId } : {}),
      ...(typeof result.modelVersion === 'string' ? { modelVersion: result.modelVersion } : {}),
    };
  }
  if (
    result.kind !== 'asset.thumbnail' ||
    typeof result.assetId !== 'string' ||
    typeof result.localRef !== 'string' ||
    !isReceiptHashAndBytes(result) ||
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    (descriptor as Record<string, unknown>).mimeType !== 'image/jpeg' ||
    !Number.isSafeInteger((descriptor as Record<string, unknown>).width) ||
    !Number.isSafeInteger((descriptor as Record<string, unknown>).height)
  ) {
    throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
  }
  return {
    kind: result.kind,
    assetId: result.assetId,
    sha256: result.sha256,
    bytes: result.bytes,
    localRef: result.localRef,
    descriptor: {
      mimeType: 'image/jpeg',
      width: (descriptor as Record<string, unknown>).width as number,
      height: (descriptor as Record<string, unknown>).height as number,
    },
  };
}

function workerDerivativeHeaders(request: IncomingMessage): {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly kind: 'thumbnail' | 'audio' | 'mask' | 'upscale';
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
  const width = widthHeader === undefined ? undefined : Number(widthHeader);
  const height = heightHeader === undefined ? undefined : Number(heightHeader);
  const durationUs = durationHeader === undefined ? undefined : Number(durationHeader);
  const isThumbnail =
    declaredKind === undefined ? mimeType === 'image/jpeg' : declaredKind === 'thumbnail';
  const isMask = declaredKind === 'mask';
  const isUpscale = declaredKind === 'upscale';
  const declaredKindValid =
    declaredKind === undefined ||
    declaredKind === 'thumbnail' ||
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
    (isUpscale && !['image/png', 'image/jpeg', 'video/mp4', 'video/webm'].includes(mimeType)) ||
    (!isThumbnail && !isMask && !isUpscale && !/^audio\/[a-z0-9.+-]+$/i.test(mimeType)) ||
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
    kind: isThumbnail ? 'thumbnail' : isMask ? 'mask' : isUpscale ? 'upscale' : 'audio',
    descriptor: {
      mimeType,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(durationUs === undefined ? {} : { durationUs }),
    },
  };
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${name} header is required`);
  return value;
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
    descriptor: asset.descriptor,
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
    descriptor: derivative.descriptor,
    availability: derivative.availability,
    verifiedAt: derivative.verifiedAt,
  };
}

function jobForBrowser(job: Job) {
  const derivative = job.derivative;
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type,
    state: job.state,
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    ...(job.assetId === undefined ? {} : { assetId: job.assetId }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(derivative === undefined
      ? {}
      : {
          derivative: {
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
  return {
    id: requiredString(body, 'id'),
    kind: requiredAssetKind(body, 'kind'),
    displayName: requiredString(body, 'displayName'),
    sha256: requiredSha256(body, 'sha256'),
    bytes: requiredPositiveInteger(body, 'bytes'),
    descriptor: mediaDescriptor(body),
    locations: assetLocations(body),
  };
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
  return {
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
}

function mediaDescriptor(body: Record<string, unknown>): AssetRegistration['descriptor'] {
  const value = requiredObject(body, 'descriptor');
  const descriptor: AssetRegistration['descriptor'] = {
    mimeType: requiredString(value, 'mimeType'),
  };
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'descriptor.animation must be an object');
  }
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
  const value = body.locations;
  if (!Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'locations must be an array');
  return value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      throw new ControlPlaneError('REQUEST_INVALID', 'location must be an object');
    const location = item as Record<string, unknown>;
    const kind = location.kind;
    if (kind !== 'opfs-cache' && kind !== 'private-object')
      throw new ControlPlaneError('REQUEST_INVALID', 'location kind is invalid');
    return { kind, ref: requiredString(location, 'ref') };
  });
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

function serializedGpuPreviewResponse(
  body: Record<string, unknown>,
): SerializedGpuPreviewFrameResponse {
  const protocolVersion = body.protocolVersion;
  const sessionId = body.sessionId;
  const requestId = body.requestId;
  const renderer = body.renderer;
  const quality = body.quality;
  const width = body.width;
  const height = body.height;
  const bytesBase64 = body.bytesBase64;
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

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof MistralProviderError) {
    const status =
      error.code === 'PROVIDER_UNCONFIGURED' ||
      error.code === 'MISTRAL_UNAUTHORIZED' ||
      error.code === 'MISTRAL_UNAVAILABLE'
        ? 503
        : error.code.endsWith('APPROVAL_REQUIRED') || error.code === 'REMOTE_PROCESSING_BLOCKED'
          ? 409
          : 502;
    respondJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof MediaAuthError) {
    const status =
      error.code === 'RATE_LIMITED' ? 429 : error.code === 'REQUEST_INVALID' ? 400 : 401;
    respondJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ControlPlaneError) {
    const status =
      error.code === 'AUTH_REQUIRED' || error.code === 'WORKER_SESSION_REQUIRED'
        ? 401
        : error.code === 'PROVIDER_BUSY'
          ? 429
          : error.code === 'PROVIDER_OPERATION_NOT_FOUND' || error.code === 'PROJECT_NOT_FOUND'
            ? 404
            : error.code === 'REQUEST_INVALID'
              ? 400
              : error.code === 'PROVIDER_UNAVAILABLE' ||
                error.code === 'PROVIDER_FAILED' ||
                error.code === 'PROJECT_DOCUMENT_STORE_UNAVAILABLE'
                ? 503
                : error.code === 'DOCUMENT_REVISION_CONFLICT'
                  ? 409
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

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// ============================================================================
// Creative Brief Outcome Mapping
// ============================================================================

/**
 * HTTP response for creative brief outcomes.
 */
interface CreativeBriefHttpResponse {
  readonly statusCode: number;
  readonly body: { data: unknown } | { error: { code: string; message?: string } };
}

/**
 * Map async creative brief outcome to HTTP response.
 *
 * Mapping:
 * - ready -> 200 with validated CreativeBriefV1
 * - unavailable -> 503
 * - policy-denied -> 403 (existing policy-denied status)
 * - invalid-output / provider-failed -> 502
 * - timeout -> 504
 * - cancelled -> 499 (safe cancellation)
 */
function mapCreativeBriefOutcomeToHttpResponse(
  outcome: AsyncCreativeBriefOutcome,
): CreativeBriefHttpResponse {
  switch (outcome.category) {
    case 'ready':
      // Success - return validated CreativeBriefV1
      return {
        statusCode: 200,
        body: { data: outcome.brief },
      };

    case 'unavailable':
      // Provider/runtime not configured
      return {
        statusCode: 503,
        body: {
          error: {
            code: outcome.errorCode ?? 'UNAVAILABLE',
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          } as { code: string; message?: string },
        },
      };

    case 'policy-denied':
      // Policy denial (opt-in, ownership, etc.) - 403 Forbidden
      return {
        statusCode: 403,
        body: {
          error: {
            code: outcome.errorCode ?? 'POLICY_DENIED',
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          } as { code: string; message?: string },
        },
      };

    case 'invalid-output':
    case 'provider-failed':
      // Model returned invalid output or provider failed - 502 Bad Gateway
      return {
        statusCode: 502,
        body: {
          error: {
            code: outcome.errorCode ?? outcome.category.toUpperCase(),
            ...(outcome.message !== undefined ? { message: outcome.message } : {}),
          } as { code: string; message?: string },
        },
      };

    case 'timeout':
      // Request timed out - 504 Gateway Timeout
      return {
        statusCode: 504,
        body: {
          error: {
            code: outcome.errorCode ?? 'TIMEOUT',
            message: outcome.message ?? 'Creative brief generation timed out',
          },
        },
      };

    case 'cancelled':
      // Request was cancelled - 499 Client Closed Request (safe cancellation)
      return {
        statusCode: 499,
        body: {
          error: {
            code: outcome.errorCode ?? 'CANCELLED',
            message: outcome.message ?? 'Creative brief generation was cancelled',
          },
        },
      };

    default:
      // Unknown category - treat as unavailable
      return {
        statusCode: 503,
        body: {
          error: {
            code: 'UNKNOWN_OUTCOME',
            message: 'Unknown creative brief outcome category',
          },
        },
      };
  }
}
