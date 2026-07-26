import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  ControlPlaneError,
  type Actor,
  type AssetRegistration,
  type ControlPlane,
  type LocalDerivativeRegistration,
} from './control-plane.js';
import type { PrivateObjectStore } from './private-object-store.js';

export interface ApiAuthentication {
  authenticate(request: IncomingMessage): Actor | undefined | Promise<Actor | undefined>;
}

export interface ControlPlaneHttpServerOptions {
  readonly controlPlane: ControlPlane;
  readonly authentication: ApiAuthentication;
  readonly privateObjectStore?: PrivateObjectStore;
}

/**
 * Versioned transport boundary for the control-plane contract. Authentication
 * is injected so the public service can use the shared JOY identity boundary;
 * this module deliberately does not contain a header/token fallback.
 */
export function createControlPlaneHttpServer(options: ControlPlaneHttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      await route(options, request, response);
    } catch (error) {
      respondError(response, error);
    }
  });
}

async function route(
  options: ControlPlaneHttpServerOptions,
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
        optionalWorkerResult(await readJson(request)),
      ),
    });
    return;
  }

  const actor = await options.authentication.authenticate(request);
  if (actor === undefined) throw new ControlPlaneError('AUTH_REQUIRED', 'authentication required');

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

  if (request.method === 'POST' && url.pathname === '/v1/providers/speech/transcribe') {
    const { runWhisperOnReferenceAsset, runWhisperTranscription } = await import(
      './whisper-transcribe.js'
    );
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

  if (request.method === 'POST' && url.pathname === '/v1/providers/audio/denoise') {
    const { runSpectralDenoise } = await import('./spectral-denoise.js');
    const body = await readJson(request);
    const assetId = requiredString(body, 'assetId');
    const mediaBase64 = requiredString(body, 'mediaBase64');
    const sampleRate = typeof body.sampleRate === 'number' ? body.sampleRate : undefined;
    const strength = typeof body.strength === 'number' ? body.strength : undefined;
    const denoised = runSpectralDenoise({
      assetId,
      mediaBase64,
      ...(sampleRate !== undefined ? { sampleRate } : {}),
      ...(strength !== undefined ? { strength } : {}),
    });
    respondJson(response, 200, { data: denoised });
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
    if (!/^[a-f0-9]{64}$/.test(declaredSha) || !Number.isSafeInteger(declaredBytes) || declaredBytes < 1)
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
    await store.put(
      { ref, sha256: asset.sha256, bytes: asset.bytes, mimeType },
      bytes,
    );
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
    respondJson(response, 201, {
      data:
        type === 'asset.thumbnail'
          ? await options.controlPlane.enqueueAssetThumbnail(
              actor,
              requiredString(body, 'id'),
              decodeURIComponent(jobMatch[1]!),
              requiredString(body, 'assetId'),
            )
          : type === 'image.comfy' || type === 'audio.ml-denoise'
            ? await options.controlPlane.enqueue(
                actor,
                requiredString(body, 'id'),
                decodeURIComponent(jobMatch[1]!),
                type,
                Date.now(),
                requiredString(body, 'assetId'),
              )
            : await options.controlPlane.enqueue(
                actor,
                requiredString(body, 'id'),
                decodeURIComponent(jobMatch[1]!),
                type,
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

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0)
    throw new ControlPlaneError('REQUEST_INVALID', `${field} must be a non-empty string`);
  return value;
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
      readonly kind: 'image.comfy' | 'audio.ml-denoise';
      readonly assetId: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly localRef: string;
      readonly descriptor: {
        readonly mimeType: string;
        readonly width?: number;
        readonly height?: number;
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
    (result.kind === 'image.comfy' || result.kind === 'audio.ml-denoise') &&
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
      },
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
