import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  ControlPlaneError,
  type Actor,
  type AssetRegistration,
  type ControlPlane,
  type LocalDerivativeRegistration,
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
import {
  ProviderApprovalError,
  ProviderApprovalService,
  providerApprovalRequiredPayload,
} from './provider-approval.js';
import {
  type ProductionRunAuthority,
  type ProductionRunRecordV1,
  type ProductionRunStateV1,
  type ProductionRunStore,
} from './production-runs.js';
import type { PrivateObjectStore } from './private-object-store.js';
import { WORKER_PROTOCOL_VERSION } from '@joy-media/job-protocol';
import type { WorkerJobV1, WorkerResultReceiptV1 } from '@joy-media/job-protocol';
import {
  computeProviderApprovalPreflight,
  type ProviderApprovalGrant,
} from '@joy-media/provider-sdk';

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
  readonly providerApprovals?: ProviderApprovalService;
}

/**
 * Versioned transport boundary for the control-plane contract. Authentication
 * is injected so the public service can use the shared JOY identity boundary;
 * this module deliberately does not contain a header/token fallback.
 */
export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
  const providerApprovals = options.providerApprovals ?? new ProviderApprovalService();
  const resolvedOptions = {
    ...options,
    mediaAuth: options.mediaAuth ?? new DisabledMediaAuth(),
    providerApprovals,
    mistral:
      options.mistral ?? createRuntimeMistralProviderRegistry({ approvals: providerApprovals }),
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
    readonly providerApprovals: ProviderApprovalService;
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
  if (
    request.method === 'POST' &&
    (workerLeaseMatch !== null ||
      workerHelloMatch !== null ||
      workerHeartbeatMatch !== null ||
      workerCompleteMatch !== null ||
      workerFailMatch !== null ||
      workerDerivativeUploadMatch !== null)
  ) {
    const workerId =
      workerLeaseMatch?.[1] ??
      workerHelloMatch?.[1] ??
      workerHeartbeatMatch?.[1] ??
      workerCompleteMatch?.[1] ??
      workerFailMatch?.[1] ??
      workerDerivativeUploadMatch?.[1];
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
    if (workerHelloMatch !== null) {
      const body = await readJson(request);
      respondJson(response, 200, {
        data: await options.controlPlane.helloWorker(
          decodeURIComponent(workerId),
          requiredStringArray(body, 'capabilities'),
          optionalStringArray(body, 'assetIds') ?? [],
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
      const bytes = await readBytes(request, 2 * 1024 * 1024);
      const receipt = workerThumbnailHeaders(request);
      if (bytes.byteLength !== receipt.bytes)
        throw new ControlPlaneError(
          'REQUEST_INVALID',
          'derivative byte length does not match receipt',
        );
      const ref = `thumb-${decodeURIComponent(workerDerivativeUploadMatch[2]!)}-${receipt.sha256.slice(0, 16)}`;
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
          decodeURIComponent(workerDerivativeUploadMatch[2]!),
          {
            id: `derivative-${decodeURIComponent(workerDerivativeUploadMatch[2]!)}`,
            assetId: receipt.assetId,
            kind: 'thumbnail',
            profile: 'jpeg-640',
            sha256: receipt.sha256,
            bytes: receipt.bytes,
            descriptor: receipt.descriptor,
            availability: 'available-cloud',
            locations: [{ kind: 'private-object', ref }],
          },
        );
        respondJson(response, 201, { data: derivative });
      } catch (error) {
        await store.remove(ref).catch(() => undefined);
        throw error;
      }
      return;
    }
    respondJson(response, 200, {
      data: await options.controlPlane.complete(
        decodeURIComponent(workerId),
        decodeURIComponent(workerCompleteMatch![2]!),
        undefined,
        requiredWorkerResult(await readJson(request)),
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

  if (request.method === 'GET' && url.pathname === '/v1/providers/reasoning') {
    respondJson(response, 200, { data: { providers: [options.mistral.summary()] } });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/providers/approvals/audit') {
    respondJson(response, 200, { data: await options.providerApprovals.auditRows(actor.id) });
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
    respondJson(response, 200, { data: await options.controlPlane.sharedCloudAssets(actor) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/library/my-assets') {
    respondJson(response, 200, { data: await options.controlPlane.assetsForOwner(actor) });
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

  const productionRunCollectionMatch = /^\/v1\/projects\/([^/]+)\/production-runs$/.exec(
    url.pathname,
  );
  if (productionRunCollectionMatch !== null) {
    const projectId = decodeURIComponent(productionRunCollectionMatch[1]!);
    const store = productionRunStore(options.controlPlane);
    if (request.method === 'GET') {
      const limit = optionalLimit(url.searchParams.get('limit'));
      const cursor = optionalOpaqueQuery(url.searchParams.get('cursor'), 'cursor');
      const state = optionalProductionRunState(url.searchParams.get('state'));
      respondJson(response, 200, {
        data: await store.listProductionRuns(actor, projectId, {
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(state === undefined ? {} : { state }),
        }),
      });
      return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const approvalExpiresAt = optionalTimestamp(body, 'approvalExpiresAt');
      respondJson(response, 201, {
        data: await store.createProductionRun(actor, projectId, {
          runKey: requiredString(body, 'runKey'),
          record: requiredProductionRunRecord(body),
          authority: requiredProductionRunAuthority(body, 'authority'),
          ...(approvalExpiresAt === undefined ? {} : { approvalExpiresAt }),
        }),
      });
      return;
    }
  }

  const productionRunMatch = /^\/v1\/projects\/([^/]+)\/production-runs\/([^/]+)$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && productionRunMatch !== null) {
    respondJson(response, 200, {
      data: await productionRunStore(options.controlPlane).getProductionRun(
        actor,
        decodeURIComponent(productionRunMatch[1]!),
        decodeURIComponent(productionRunMatch[2]!),
      ),
    });
    return;
  }

  const productionRunApprovalMatch =
    /^\/v1\/projects\/([^/]+)\/production-runs\/([^/]+)\/approvals\/([^/]+)\/respond$/.exec(
      url.pathname,
    );
  if (request.method === 'POST' && productionRunApprovalMatch !== null) {
    const body = await readJson(request);
    const expectedUpdatedSeq = optionalNonNegativeInteger(body, 'expectedUpdatedSeq');
    respondJson(response, 200, {
      data: await productionRunStore(options.controlPlane).respondToProductionApproval(
        actor,
        decodeURIComponent(productionRunApprovalMatch[1]!),
        decodeURIComponent(productionRunApprovalMatch[2]!),
        {
          approvalId: decodeURIComponent(productionRunApprovalMatch[3]!),
          approved: requiredBoolean(body, 'approved'),
          responseRef: requiredString(body, 'responseRef'),
          ...(!('response' in body) ? {} : { response: body.response }),
          ...(typeof body.rejectionReason === 'string'
            ? { rejectionReason: body.rejectionReason }
            : body.rejectionReason === undefined
              ? {}
              : invalidRequest('rejectionReason must be a string')),
          authority: requiredProductionRunAuthority(body, 'authority'),
          ...(expectedUpdatedSeq === undefined ? {} : { expectedUpdatedSeq }),
        },
      ),
    });
    return;
  }

  const productionRunCancelMatch =
    /^\/v1\/projects\/([^/]+)\/production-runs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && productionRunCancelMatch !== null) {
    const body = await readJson(request);
    const expectedUpdatedSeq = optionalNonNegativeInteger(body, 'expectedUpdatedSeq');
    respondJson(response, 200, {
      data: await productionRunStore(options.controlPlane).cancelProductionRun(
        actor,
        decodeURIComponent(productionRunCancelMatch[1]!),
        decodeURIComponent(productionRunCancelMatch[2]!),
        {
          authority: requiredProductionRunAuthority(body, 'authority'),
          ...(expectedUpdatedSeq === undefined ? {} : { expectedUpdatedSeq }),
        },
      ),
    });
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
    const {
      runSpeechSynthesis,
      resolveSpeechEngine,
      speechSynthesisCapabilityRequest,
      speechSynthesisProvider,
    } = await import('./speech-synthesize.js');
    const body = await readJson(request);
    const text = requiredString(body, 'text');
    const language = typeof body.language === 'string' ? body.language : undefined;
    const voiceId = typeof body.voiceId === 'string' ? body.voiceId : undefined;
    const speed = typeof body.speed === 'number' ? body.speed : undefined;
    const engine = resolveSpeechEngine(body.engine);
    const idempotencyKey =
      optionalString(body, 'idempotencyKey') ??
      providerRouteIdempotencyKey({
        capability: 'speech.synthesize',
        text,
        language,
        voiceId,
        speed,
        engine,
      });
    const synthesisRequest = {
      text,
      engine,
      idempotencyKey,
      ...(language !== undefined ? { language } : {}),
      ...(voiceId !== undefined ? { voiceId } : {}),
      ...(speed !== undefined ? { speed } : {}),
    };
    const capabilityRequest = speechSynthesisCapabilityRequest(synthesisRequest);
    const preflight = computeProviderApprovalPreflight(
      actor.id,
      capabilityRequest,
      speechSynthesisProvider(engine),
    );
    const approvalInput = {
      actorId: actor.id,
      idempotencyKey,
      preflight,
      privacyMode:
        optionalPrivacyMode(body, 'privacyMode') ??
        (engine === 'edge-tts' ? 'ask-before-remote' : 'local-only'),
      grant: optionalProviderApprovalGrant(body),
      fallbackCostCap: { amount: '0.00', currency: 'USD' },
    } as const;
    const approval = await options.providerApprovals.verify(approvalInput);
    try {
      const synthesized = runSpeechSynthesis(synthesisRequest);
      await options.providerApprovals.recordSucceeded(approvalInput, approval.reservation);
      respondJson(response, 200, { data: synthesized, preflight });
    } catch (error) {
      await options.providerApprovals.recordFailed(
        approvalInput,
        approval.reservation,
        error instanceof Error ? error.message : 'speech-synthesis-failed',
      );
      throw error;
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/providers/audio/denoise') {
    const { runSpectralDenoise, spectralDenoiseCapabilityRequest, spectralDenoiseProvider } =
      await import('./spectral-denoise.js');
    const body = await readJson(request);
    const assetId = requiredString(body, 'assetId');
    const mediaBase64 = requiredString(body, 'mediaBase64');
    const sampleRate = typeof body.sampleRate === 'number' ? body.sampleRate : undefined;
    const strength = typeof body.strength === 'number' ? body.strength : undefined;
    const idempotencyKey =
      optionalString(body, 'idempotencyKey') ??
      providerRouteIdempotencyKey({
        capability: 'audio.denoise',
        assetId,
        mediaDigest: secretHash(mediaBase64),
        sampleRate,
        strength,
      });
    const denoiseRequest = {
      assetId,
      mediaBase64,
      idempotencyKey,
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(strength !== undefined ? { strength } : {}),
    };
    const capabilityRequest = spectralDenoiseCapabilityRequest(denoiseRequest);
    const preflight = computeProviderApprovalPreflight(
      actor.id,
      capabilityRequest,
      spectralDenoiseProvider(),
    );
    await options.providerApprovals.verify({
      actorId: actor.id,
      idempotencyKey,
      preflight,
      privacyMode: 'local-only',
      fallbackCostCap: { amount: '0.00', currency: 'USD' },
    });
    const denoised = runSpectralDenoise(denoiseRequest);
    respondJson(response, 200, { data: denoised, preflight });
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
    respondJson(response, 200, {
      data: await options.controlPlane.assetsForProject(actor, decodeURIComponent(assetMatch[1]!)),
    });
    return;
  }
  if (request.method === 'POST' && assetMatch !== null) {
    const body = await readJson(request);
    respondJson(response, 201, {
      data: await options.controlPlane.registerAsset(
        actor,
        decodeURIComponent(assetMatch[1]!),
        assetRegistration(body),
      ),
    });
    return;
  }

  const assetByIdMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'DELETE' && assetByIdMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.deleteAsset(
        actor,
        decodeURIComponent(assetByIdMatch[1]!),
        decodeURIComponent(assetByIdMatch[2]!),
      ),
    });
    return;
  }

  const assetOriginalMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/original$/.exec(
    url.pathname,
  );
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
    if (asset.kind !== 'image')
      throw new ControlPlaneError('ASSET_INVALID', 'cloud original backup is image-only in v1');
    const mimeType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!/^image\/[a-z0-9.+-]+$/.test(mimeType))
      throw new ControlPlaneError('REQUEST_INVALID', 'original upload must be an image MIME type');
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
    const bytes = await readBytes(request, 50 * 1024 * 1024);
    if (bytes.byteLength !== asset.bytes)
      throw new ControlPlaneError('REQUEST_INVALID', 'original byte length does not match asset');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.sha256)
      throw new ControlPlaneError('REQUEST_INVALID', 'original sha256 does not match asset');
    await options.controlPlane.setAssetSync(actor, projectId, true);
    const ref = `orig-${asset.sha256.slice(0, 32)}`;
    await store.put({ ref, sha256: asset.sha256, bytes: asset.bytes, mimeType }, bytes);
    try {
      const { tagAssetWithHermes } = await import('./asset-hermes-tags.js');
      const tagged = await tagAssetWithHermes({
        kind: asset.kind,
        displayName: asset.displayName,
        mimeType: asset.descriptor.mimeType,
        bytes: asset.bytes,
        ...(asset.descriptor.width !== undefined ? { width: asset.descriptor.width } : {}),
        ...(asset.descriptor.height !== undefined ? { height: asset.descriptor.height } : {}),
        imageBytes: bytes,
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
          asset: updated,
          cloudRef: ref,
          tagProvenance: tagged.provenance,
        },
      });
    } catch (error) {
      await store.remove(ref).catch(() => undefined);
      throw error;
    }
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
    respondJson(response, 200, {
      data: await options.controlPlane.updateAssetMetadata(
        actor,
        decodeURIComponent(assetMetadataMatch[1]!),
        decodeURIComponent(assetMetadataMatch[2]!),
        {
          ...(tags !== undefined ? { tags } : {}),
          ...(sortName !== undefined ? { sortName } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
        },
      ),
    });
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
    respondJson(response, 200, {
      data: await options.controlPlane.updateAssetMetadata(actor, projectId, assetId, {
        tags: tagged.tags,
        sortName: tagged.sortName,
      }),
    });
    return;
  }

  const derivativeMatch = /^\/v1\/projects\/([^/]+)\/assets\/([^/]+)\/derivatives$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && derivativeMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.derivativesForAsset(
        actor,
        decodeURIComponent(derivativeMatch[1]!),
        decodeURIComponent(derivativeMatch[2]!),
      ),
    });
    return;
  }
  if (request.method === 'POST' && derivativeMatch !== null) {
    const body = await readJson(request);
    const derivative = localDerivativeRegistration(body);
    if (derivative.assetId !== decodeURIComponent(derivativeMatch[2]!))
      throw new ControlPlaneError('REQUEST_INVALID', 'derivative assetId must match the route');
    respondJson(response, 201, {
      data: await options.controlPlane.registerLocalDerivative(
        actor,
        decodeURIComponent(derivativeMatch[1]!),
        derivative,
      ),
    });
    return;
  }

  const jobMatch = /^\/v1\/projects\/([^/]+)\/jobs$/.exec(url.pathname);
  if (request.method === 'GET' && jobMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.jobsForProject(actor, decodeURIComponent(jobMatch[1]!)),
    });
    return;
  }
  if (request.method === 'POST' && jobMatch !== null) {
    const body = await readJson(request);
    const type = requiredString(body, 'type');
    const id = requiredString(body, 'id');
    const projectId = decodeURIComponent(jobMatch[1]!);
    respondJson(response, 201, {
      data:
        type === 'asset.thumbnail'
          ? await options.controlPlane.enqueueAssetThumbnail(
              actor,
              id,
              projectId,
              requiredString(body, 'assetId'),
            )
          : type === 'image.comfy' || type === 'audio.ml-denoise'
            ? await options.controlPlane.enqueue(
                actor,
                id,
                projectId,
                type,
                Date.now(),
                requiredString(body, 'assetId'),
                workerJobEnvelope(projectId, body),
              )
            : await options.controlPlane.enqueue(
                actor,
                id,
                projectId,
                type,
                Date.now(),
                undefined,
                workerJobEnvelope(projectId, body),
              ),
    });
    return;
  }

  const cancelMatch = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === 'POST' && cancelMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.cancel(
        actor,
        decodeURIComponent(cancelMatch[1]!),
        decodeURIComponent(cancelMatch[2]!),
      ),
    });
    return;
  }
  const retryMatch = /^\/v1\/projects\/([^/]+)\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
  if (request.method === 'POST' && retryMatch !== null) {
    respondJson(response, 200, {
      data: await options.controlPlane.retry(
        actor,
        decodeURIComponent(retryMatch[1]!),
        decodeURIComponent(retryMatch[2]!),
      ),
    });
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
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

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
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
    ...(optionalProviderApprovalGrant(body) === undefined
      ? {}
      : { approvalGrant: optionalProviderApprovalGrant(body) }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
  };
}

function optionalPrivacyMode(
  body: Record<string, unknown>,
  field: string,
): 'local-only' | 'ask-before-remote' | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value !== 'local-only' && value !== 'ask-before-remote') {
    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
  }
  return value;
}

function optionalProviderApprovalGrant(
  body: Record<string, unknown>,
): ProviderApprovalGrant | undefined {
  const value = body.providerApprovalGrant ?? body.approvalGrant;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant must be an object');
  }
  const grant = value as Record<string, unknown>;
  if (
    grant.grantVersion !== 1 ||
    typeof grant.grantId !== 'string' ||
    typeof grant.grantSignature !== 'string' ||
    typeof grant.actorId !== 'string' ||
    typeof grant.providerId !== 'string' ||
    typeof grant.capability !== 'string' ||
    typeof grant.requestDigest !== 'string' ||
    typeof grant.expiresAt !== 'string' ||
    (grant.status !== 'approved' && grant.status !== 'denied')
  ) {
    throw new ControlPlaneError('REQUEST_INVALID', 'providerApprovalGrant is invalid');
  }
  let costCap: ProviderApprovalGrant['costCap'];
  if (grant.costCap !== undefined) {
    if (
      grant.costCap === null ||
      typeof grant.costCap !== 'object' ||
      Array.isArray(grant.costCap)
    ) {
      invalidRequest('providerApprovalGrant.costCap is invalid');
    }
    const cap = grant.costCap as Record<string, unknown>;
    if (typeof cap.amount !== 'string' || typeof cap.currency !== 'string') {
      invalidRequest('providerApprovalGrant.costCap is invalid');
    }
    costCap = { amount: cap.amount, currency: cap.currency };
  }
  const parsed: ProviderApprovalGrant = {
    grantVersion: 1,
    grantId: grant.grantId,
    grantSignature: grant.grantSignature,
    actorId: grant.actorId,
    providerId: grant.providerId,
    capability: grant.capability as ProviderApprovalGrant['capability'],
    requestDigest: grant.requestDigest,
    expiresAt: grant.expiresAt,
    status: grant.status,
    ...(costCap === undefined ? {} : { costCap }),
  };
  return parsed;
}

function optionalPositiveInteger(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a positive integer`);
  return value;
}

function optionalNonNegativeInteger(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-negative integer`);
  return value;
}

function requiredBoolean(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean')
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a boolean`);
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

function workerJobEnvelope(
  projectId: string,
  body: Record<string, unknown>,
): WorkerJobV1 | undefined {
  if (
    body.payload === undefined &&
    body.requirements === undefined &&
    body.idempotencyKey === undefined &&
    body.maxAttempts === undefined
  ) {
    return undefined;
  }
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    jobId: requiredString(body, 'id'),
    type: requiredString(body, 'type') as WorkerJobV1['type'],
    payload: requiredObject(body, 'payload') as WorkerJobV1['payload'],
    requirements: requiredObject(body, 'requirements') as WorkerJobV1['requirements'],
    idempotencyKey: requiredString(body, 'idempotencyKey'),
    maxAttempts: requiredPositiveInteger(body, 'maxAttempts'),
  } as WorkerJobV1;
}

function requiredWorkerResult(body: Record<string, unknown>): WorkerResultReceiptV1 {
  const value = body.result;
  if (value === undefined)
    throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is required');
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'result must be an object');
  const result = value as Record<string, unknown>;
  if (
    result.kind === 'fixture.thumbnail' &&
    hasOnlyKeys(result, ['kind', 'sha256', 'bytes']) &&
    isReceiptHashAndBytes(result)
  ) {
    return { kind: result.kind, sha256: result.sha256, bytes: result.bytes };
  }
  if (
    result.kind === 'render.export' &&
    hasOnlyKeys(result, ['kind', 'reportRef', 'outputRef', 'sha256', 'bytes', 'qualityReport']) &&
    typeof result.reportRef === 'string' &&
    typeof result.outputRef === 'string' &&
    isReceiptHashAndBytes(result)
  ) {
    return {
      kind: result.kind,
      reportRef: result.reportRef,
      outputRef: result.outputRef,
      sha256: result.sha256,
      bytes: result.bytes,
      ...(result.qualityReport === undefined ? {} : { qualityReport: result.qualityReport }),
    };
  }
  if (
    result.kind === 'render.inspect' &&
    hasOnlyKeys(result, ['kind', 'reportRef', 'findings']) &&
    typeof result.reportRef === 'string' &&
    typeof result.findings === 'number' &&
    Number.isSafeInteger(result.findings) &&
    result.findings >= 0
  ) {
    return { kind: result.kind, reportRef: result.reportRef, findings: result.findings };
  }
  if (
    (result.kind === 'text.lm-studio' || result.kind === 'text.openrouter') &&
    hasOnlyKeys(result, ['kind', 'resultRef', 'sha256', 'bytes', 'model']) &&
    typeof result.resultRef === 'string' &&
    isReceiptHashAndBytes(result) &&
    (result.model === undefined || typeof result.model === 'string')
  ) {
    return {
      kind: result.kind,
      resultRef: result.resultRef,
      sha256: result.sha256,
      bytes: result.bytes,
      ...(result.model === undefined ? {} : { model: result.model }),
    };
  }
  if (
    result.kind === 'video.reference-analyze' &&
    hasOnlyKeys(result, [
      'kind',
      'assetId',
      'sha256',
      'bytes',
      'descriptor',
      'summary',
      'evidence',
      'evidenceIds',
      'findings',
      'model',
    ]) &&
    typeof result.assetId === 'string' &&
    isReceiptHashAndBytes(result) &&
    result.descriptor !== null &&
    typeof result.descriptor === 'object' &&
    !Array.isArray(result.descriptor) &&
    result.summary !== null &&
    typeof result.summary === 'object' &&
    !Array.isArray(result.summary) &&
    Array.isArray(result.evidence) &&
    Array.isArray(result.evidenceIds) &&
    (result.findings === undefined || Array.isArray(result.findings)) &&
    (result.model === undefined || typeof result.model === 'string')
  ) {
    return result as WorkerResultReceiptV1;
  }
  const descriptor = result.descriptor;
  if (
    (result.kind === 'image.comfy' ||
      result.kind === 'audio.ml-denoise' ||
      result.kind === 'video.runway' ||
      result.kind === 'edit.higgsfield') &&
    hasOnlyKeys(result, [
      'kind',
      'assetId',
      'sha256',
      'bytes',
      'localRef',
      'descriptor',
      'model',
    ]) &&
    typeof result.assetId === 'string' &&
    typeof result.localRef === 'string' &&
    isReceiptHashAndBytes(result) &&
    descriptor !== null &&
    typeof descriptor === 'object' &&
    !Array.isArray(descriptor) &&
    hasOnlyKeys(descriptor as Record<string, unknown>, ['mimeType', 'width', 'height']) &&
    typeof (descriptor as Record<string, unknown>).mimeType === 'string' &&
    ((descriptor as Record<string, unknown>).mimeType as string).length > 0 &&
    (result.model === undefined || typeof result.model === 'string')
  ) {
    const mimeType = (descriptor as Record<string, unknown>).mimeType as string;
    const width = (descriptor as Record<string, unknown>).width;
    const height = (descriptor as Record<string, unknown>).height;
    if (
      (width !== undefined && (!Number.isSafeInteger(width) || (width as number) < 1)) ||
      (height !== undefined && (!Number.isSafeInteger(height) || (height as number) < 1))
    ) {
      throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
    }
    if (result.kind === 'image.comfy') {
      if (!mimeType.startsWith('image/') || width === undefined || height === undefined) {
        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
      }
    }
    if (result.kind === 'audio.ml-denoise') {
      if (!mimeType.startsWith('audio/') || width !== undefined || height !== undefined) {
        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
      }
    }
    if (result.kind === 'video.runway') {
      if (!mimeType.startsWith('video/')) {
        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
      }
    }
    if (result.kind === 'edit.higgsfield') {
      if (!mimeType.startsWith('image/') || width === undefined || height === undefined) {
        throw new ControlPlaneError('REQUEST_INVALID', 'result receipt is invalid');
      }
    }
    return {
      kind: result.kind,
      assetId: result.assetId,
      sha256: result.sha256,
      bytes: result.bytes,
      localRef: result.localRef,
      descriptor: {
        mimeType,
        ...(width === undefined ? {} : { width: width as number }),
        ...(height === undefined ? {} : { height: height as number }),
      },
      ...(result.model === undefined ? {} : { model: result.model }),
    };
  }
  if (
    result.kind !== 'asset.thumbnail' ||
    !hasOnlyKeys(result, ['kind', 'assetId', 'sha256', 'bytes', 'localRef', 'descriptor']) ||
    typeof result.assetId !== 'string' ||
    typeof result.localRef !== 'string' ||
    !isReceiptHashAndBytes(result) ||
    descriptor === null ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    !hasOnlyKeys(descriptor as Record<string, unknown>, ['mimeType', 'width', 'height']) ||
    (descriptor as Record<string, unknown>).mimeType !== 'image/jpeg' ||
    !Number.isSafeInteger((descriptor as Record<string, unknown>).width) ||
    ((descriptor as Record<string, unknown>).width as number) < 1 ||
    !Number.isSafeInteger((descriptor as Record<string, unknown>).height) ||
    ((descriptor as Record<string, unknown>).height as number) < 1
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function workerThumbnailHeaders(request: IncomingMessage): {
  readonly assetId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: 'image/jpeg';
    readonly width: number;
    readonly height: number;
  };
} {
  const assetId = requiredHeader(request, 'x-joy-asset-id');
  const sha256 = requiredHeader(request, 'x-joy-sha256');
  const bytes = Number(requiredHeader(request, 'x-joy-bytes'));
  const width = Number(requiredHeader(request, 'x-joy-width'));
  const height = Number(requiredHeader(request, 'x-joy-height'));
  const mimeType = requiredHeader(request, 'content-type');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(assetId) ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    mimeType !== 'image/jpeg'
  )
    throw new ControlPlaneError('REQUEST_INVALID', 'derivative upload headers are invalid');
  return { assetId, sha256, bytes, descriptor: { mimeType: 'image/jpeg', width, height } };
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

function optionalLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new ControlPlaneError('REQUEST_INVALID', 'limit must be between 1 and 100');
  return limit;
}

function optionalOpaqueQuery(value: string | null, field: string): string | undefined {
  if (value === null) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new ControlPlaneError('REQUEST_INVALID', `${field} is invalid`);
  return value;
}

function optionalProductionRunState(value: string | null): ProductionRunStateV1 | undefined {
  if (value === null) return undefined;
  if (
    value !== 'queued' &&
    value !== 'running' &&
    value !== 'parked' &&
    value !== 'failed' &&
    value !== 'canceled' &&
    value !== 'succeeded'
  ) {
    throw new ControlPlaneError('REQUEST_INVALID', 'production run state is invalid');
  }
  return value;
}

function requiredProductionRunRecord(body: Record<string, unknown>): ProductionRunRecordV1 {
  const value = body.record;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('REQUEST_INVALID', 'record must be an object');
  return value as ProductionRunRecordV1;
}

function requiredProductionRunAuthority(
  body: Record<string, unknown>,
  field: string,
): ProductionRunAuthority {
  const value = requiredObject(body, field);
  const principalId = requiredString(value, 'principalId');
  const role = value.role;
  if (role !== 'system' && role !== 'owner' && role !== 'operator' && role !== 'reviewer')
    throw new ControlPlaneError('REQUEST_INVALID', 'authority role is invalid');
  const displayName = typeof value.displayName === 'string' ? value.displayName : undefined;
  return {
    principalId,
    role,
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function optionalTimestamp(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a timestamp`);
}

function productionRunStore(controlPlane: ControlPlane): ProductionRunStore {
  if (
    'createProductionRun' in controlPlane &&
    typeof controlPlane.createProductionRun === 'function' &&
    'listProductionRuns' in controlPlane &&
    typeof controlPlane.listProductionRuns === 'function' &&
    'getProductionRun' in controlPlane &&
    typeof controlPlane.getProductionRun === 'function' &&
    'respondToProductionApproval' in controlPlane &&
    typeof controlPlane.respondToProductionApproval === 'function' &&
    'cancelProductionRun' in controlPlane &&
    typeof controlPlane.cancelProductionRun === 'function'
  ) {
    return controlPlane as ControlPlane & ProductionRunStore;
  }
  throw new ControlPlaneError(
    'PRODUCTION_RUN_STORE_UNAVAILABLE',
    'production run storage is unavailable',
  );
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
  if (kind !== 'thumbnail' && kind !== 'proxy')
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
  return {
    ...descriptor,
    ...(durationUs === undefined ? {} : { durationUs }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
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

function invalidRequest(message: string): never {
  throw new ControlPlaneError('REQUEST_INVALID', message);
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

function respondError(response: ServerResponse, error: unknown): void {
  if (error instanceof ProviderApprovalError) {
    const status =
      error.code === 'PROVIDER_APPROVAL_REQUIRED' ||
      error.code === 'REMOTE_PROCESSING_BLOCKED' ||
      error.code === 'PROVIDER_APPROVAL_EXPIRED' ||
      error.code === 'PROVIDER_APPROVAL_REPLAY_REJECTED' ||
      error.code === 'PROVIDER_APPROVAL_DENIED' ||
      error.code === 'PROVIDER_SPEND_CAP_EXCEEDED'
        ? 409
        : 502;
    respondJson(response, status, { error: providerApprovalRequiredPayload(error) });
    return;
  }
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
        : error.code === 'REQUEST_INVALID'
          ? 400
          : error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_FAILED'
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

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function providerRouteIdempotencyKey(value: unknown): string {
  return `provider-${createHash('sha256').update(stableJson(value)).digest('base64url')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
