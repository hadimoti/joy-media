import type { GpuPreviewFrameRequest } from '@joy-media/job-protocol';
import type {
  JoyProjectV1,
  LookInstancesDocument,
  ProjectRevisionId,
} from '@joy-media/project-schema';
import type {
  BrowserAsset,
  BrowserAssetRegistration,
  BrowserDerivative,
  BrowserGpuPreviewFrame,
  BrowserGpuPreviewSession,
  BrowserJob,
  BrowserProjectDocument,
  BrowserProjectDuplicateResult,
  BrowserProjectMetadata,
  BrowserReasoningProvider,
  BrowserSpectralDenoiseOperation,
  BrowserSpectralDenoiseResult,
  BrowserWorker,
} from './control-plane-client.js';

/**
 * The editor's client for the local desktop host (PLAN-v4 §6i). Each operation that the local
 * build supports calls a `desktop.media.*` channel. Every other operation refuses with
 * `NOT_AVAILABLE_LOCALLY`, so a feature that needs a remote service fails loudly instead of
 * reaching out. Nothing here calls the network.
 */

export class BrowserControlPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserControlPlaneRequestError';
  }
}

/** The part of `window.joyDesktop` this client uses. */
export interface DesktopMediaBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

export interface BrowserSpeechTranscript {
  readonly language: string;
  readonly words: readonly {
    readonly text: string;
    readonly startUs: number;
    readonly endUs: number;
    readonly confidence?: number;
    readonly speakerId?: string;
  }[];
  readonly speakers: readonly { readonly id: string; readonly name: string }[];
  readonly provenance: {
    readonly providerId: string;
    readonly modelId: string;
    readonly createdAt: string;
  };
}

export type SpeechLanguage = 'fa-IR' | 'en-US';
export type SpeechModel =
  'faster-whisper-large-v3-turbo' | 'kokoro-82m' | 'chatterbox-en' | 'chatterbox-fa';
export type SpeechErrorCode =
  'SETUP_REQUIRED' | 'SOURCE_UNAVAILABLE' | 'CONSENT_DENIED' | 'CANCELED';

export interface SpeechWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
}

export interface SpeechTranscript {
  readonly language: SpeechLanguage;
  readonly words: readonly SpeechWord[];
  readonly speakers: readonly [];
  readonly provenance: {
    readonly providerId: 'local';
    readonly modelId: SpeechModel;
    readonly createdAt: string;
  };
}

export interface SpeechTranscribeV1 {
  readonly schemaVersion: 1;
  readonly language: SpeechLanguage;
  readonly modelId: 'faster-whisper-large-v3-turbo';
  readonly range?: { readonly startUs: number; readonly endUs: number };
}

export interface SpeechSynthesizeV1 {
  readonly schemaVersion: 1;
  readonly language: SpeechLanguage;
  readonly modelId: 'kokoro-82m' | 'chatterbox-en' | 'chatterbox-fa';
  readonly text: string;
  readonly voiceId?: string;
  readonly purpose?: 'general' | 'personal-noncommercial';
}

export interface SpeechConsentRequest {
  readonly acknowledged: true;
  readonly purpose: 'general' | 'personal-noncommercial';
}

export interface SpeechSynthesisTiming {
  readonly durationUs: number;
  readonly timingSource: 'native' | 'aligned' | 'unavailable';
  readonly words: readonly SpeechWord[];
}

export interface SpeechModelStatus {
  readonly modelId: SpeechModel;
  readonly state: 'ready' | 'setup-required' | 'incompatible';
  readonly reasonCode?: string;
}

export class DesktopSpeechError extends Error {
  constructor(
    readonly code: SpeechErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopSpeechError';
  }
}

export interface BrowserSpeechSynthesis {
  readonly assetId: string;
  readonly mimeType: string;
  readonly bytesBase64: string;
  readonly voiceId: string;
  readonly engine: string;
  readonly modelId: string;
  readonly dataLeavesDevice: true;
  readonly retentionDisclosure: string;
  readonly durationUs: number;
}

/** The job as the desktop reports it (`publicJob` in media-channel.ts). */
interface DesktopJobView {
  readonly id: string;
  readonly jobType: string;
  readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: number;
  readonly error?: string | null;
  readonly cancelRequested: boolean;
  readonly errorCode?: string | null;
  readonly speech?: SpeechSynthesisTiming;
  readonly derivative?: {
    readonly sha256: string;
    readonly bytes: number;
    readonly mimeType: string;
  };
}

interface DesktopWorkerView {
  readonly workerId: string;
  readonly capabilities: readonly string[];
  readonly lastHelloAt: string;
}

interface DesktopDocumentView {
  readonly projectId: string;
  readonly revisionId: string;
  readonly document: unknown;
  readonly lookInstances?: unknown;
}

type DesktopDocumentPutOutcome =
  | { readonly kind: 'saved'; readonly projectId: string; readonly revisionId: string }
  | { readonly kind: 'conflict'; readonly revisionId: string }
  | { readonly kind: 'missing' };

/** A render job the editor queued, and the desktop job that runs it. */
interface TrackedJob {
  readonly editorId: string;
  readonly projectId: string;
  readonly assetId: string;
  readonly type: string;
  readonly desktopJobId: string;
}

// Module-level on purpose: panels create their own client, and they must see the same jobs.
const trackedJobs = new Map<string, TrackedJob>();
const projectTitles = new Map<string, string>();
const registeredAssets = new Map<string, BrowserAsset>();
const LIBRARY_ASSET_ID_PATTERN = /^joylib-[a-f0-9]{64}$/;
const MAX_LOCAL_WHISPER_MEDIA_BYTES = 200 * 1024 * 1024;
const LOCAL_WHISPER_MEDIA_TOO_LARGE = 'Local Whisper media exceeds the 200 MB limit.';
const MAX_LOCAL_DERIVATIVE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_DERIVATIVE_CHUNK_BYTES = 4 * 1024 * 1024;
const BUILT_IN_SPEECH_OUTPUT_REF_ID = 'joy-speech-output';
let speechJobSequence = 0;

function defaultBridge(): DesktopMediaBridge {
  return {
    invoke: (channel, payload) => {
      const bridge = (window as unknown as { joyDesktop?: DesktopMediaBridge }).joyDesktop;
      if (bridge === undefined) {
        return Promise.reject(notAvailable('The JOY Media desktop app'));
      }
      return bridge.invoke(channel, payload);
    },
  };
}

function notAvailable(what: string): BrowserControlPlaneRequestError {
  return new BrowserControlPlaneRequestError(
    501,
    'NOT_AVAILABLE_LOCALLY',
    `${what} is not available in this build`,
  );
}

async function call<T>(bridge: DesktopMediaBridge, channel: string, payload?: unknown): Promise<T> {
  try {
    return (await bridge.invoke(channel, payload)) as T;
  } catch (error) {
    if (error instanceof BrowserControlPlaneRequestError) throw error;
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { readonly code?: unknown }).code === 'string'
        ? (error as { readonly code: string }).code
        : undefined;
    throw new BrowserControlPlaneRequestError(
      500,
      code,
      error instanceof Error ? error.message : 'The local media request failed',
    );
  }
}

function speechErrorFrom(error: unknown): DesktopSpeechError | undefined {
  const candidate = error as { readonly code?: unknown; readonly message?: unknown } | null;
  const rawCode =
    typeof candidate?.code === 'string'
      ? candidate.code
      : typeof error === 'string'
        ? error
        : typeof candidate?.message === 'string'
          ? candidate.message
          : '';
  const code = rawCode.match(
    /\b(SETUP_REQUIRED|SOURCE_UNAVAILABLE|CONSENT_DENIED|CANCELED)\b/,
  )?.[1];
  if (
    code === 'SETUP_REQUIRED' ||
    code === 'SOURCE_UNAVAILABLE' ||
    code === 'CONSENT_DENIED' ||
    code === 'CANCELED'
  ) {
    return new DesktopSpeechError(
      code,
      typeof candidate?.message === 'string' ? candidate.message : code,
    );
  }
  return undefined;
}

function asSpeechWords(value: unknown): readonly SpeechWord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  let previousStart = -1;
  const words: SpeechWord[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const word = item as Record<string, unknown>;
    if (
      typeof word['text'] !== 'string' ||
      word['text'].trim().length === 0 ||
      !Number.isSafeInteger(word['startUs']) ||
      !Number.isSafeInteger(word['endUs']) ||
      (word['startUs'] as number) < 0 ||
      (word['endUs'] as number) <= (word['startUs'] as number) ||
      (word['startUs'] as number) < previousStart ||
      (word['confidence'] !== undefined &&
        (typeof word['confidence'] !== 'number' ||
          !Number.isFinite(word['confidence']) ||
          word['confidence'] < 0 ||
          word['confidence'] > 1))
    ) {
      return undefined;
    }
    previousStart = word['startUs'] as number;
    words.push({
      text: word['text'],
      startUs: word['startUs'] as number,
      endUs: word['endUs'] as number,
      ...(word['confidence'] === undefined ? {} : { confidence: word['confidence'] as number }),
    });
  }
  return words;
}

function asSpeechTranscript(value: unknown, request: SpeechTranscribeV1): SpeechTranscript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop returned an invalid speech transcript');
  }
  const transcript = value as Record<string, unknown>;
  const provenanceValue = transcript['provenance'];
  const provenance =
    typeof provenanceValue === 'object' &&
    provenanceValue !== null &&
    !Array.isArray(provenanceValue)
      ? (provenanceValue as Record<string, unknown>)
      : undefined;
  const words = asSpeechWords(transcript['words']);
  const models: readonly SpeechModel[] = [
    'faster-whisper-large-v3-turbo',
    'kokoro-82m',
    'chatterbox-en',
    'chatterbox-fa',
  ];
  if (
    transcript['language'] !== request.language ||
    !Array.isArray(transcript['speakers']) ||
    transcript['speakers'].length !== 0 ||
    words === undefined ||
    provenance === undefined ||
    provenance['providerId'] !== 'local' ||
    provenance['modelId'] !== request.modelId ||
    !models.includes(request.modelId) ||
    typeof provenance['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(provenance['createdAt']))
  ) {
    throw new Error('The desktop returned an invalid speech transcript');
  }
  return {
    language: request.language,
    words,
    speakers: [],
    provenance: {
      providerId: 'local',
      modelId: provenance['modelId'] as SpeechModel,
      createdAt: provenance['createdAt'],
    },
  };
}

function throwIfSpeechAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
}

function asSynthesisTiming(value: unknown): SpeechSynthesisTiming {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The desktop returned invalid speech timing');
  }
  const timing = value as Record<string, unknown>;
  const words = asSpeechWords(timing['words']);
  if (
    !Number.isSafeInteger(timing['durationUs']) ||
    (timing['durationUs'] as number) <= 0 ||
    (timing['timingSource'] !== 'native' &&
      timing['timingSource'] !== 'aligned' &&
      timing['timingSource'] !== 'unavailable') ||
    words === undefined ||
    (timing['timingSource'] === 'unavailable' && words.length > 0)
  ) {
    throw new Error('The desktop returned invalid speech timing');
  }
  return {
    durationUs: timing['durationUs'] as number,
    timingSource: timing['timingSource'],
    words,
  };
}

function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Speech job canceled', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Speech job canceled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function abortableCall<T>(
  bridge: DesktopMediaBridge,
  channel: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Transfer cancelled', 'AbortError'));
  const request = call<T>(bridge, channel, payload);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Transfer cancelled', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function trackedJob(projectId: string, jobId: string): TrackedJob {
  const tracked = trackedJobs.get(jobId);
  if (tracked === undefined || tracked.projectId !== projectId) {
    throw new BrowserControlPlaneRequestError(404, 'JOB_NOT_FOUND', 'Unknown job');
  }
  return tracked;
}

/** A mask job's result is a matte; every other job here still reports a proxy, as before. */
function derivativeKind(type: string): 'proxy' | 'mask' {
  return type.startsWith('mask.') ? 'mask' : 'proxy';
}

function jobState(status: DesktopJobView['status']): BrowserJob['state'] {
  switch (status) {
    case 'running':
      return 'leased';
    case 'done':
      return 'completed';
    case 'cancelled':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

function toBrowserJob(tracked: TrackedJob, job: DesktopJobView): BrowserJob {
  return {
    id: tracked.editorId,
    projectId: tracked.projectId,
    type: tracked.type,
    assetId: tracked.assetId,
    state: jobState(job.status),
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    ...(job.error ? { error: job.error } : {}),
    ...(job.status === 'done' && job.derivative !== undefined
      ? {
          derivative: {
            id: tracked.editorId,
            jobId: tracked.editorId,
            kind: derivativeKind(tracked.type),
            sha256: job.derivative.sha256,
            bytes: job.derivative.bytes,
            workerRef: '',
            resultRef: '',
            verifiedAt: Date.now(),
          },
        }
      : {}),
  };
}

function toBrowserDerivative(tracked: TrackedJob, job: DesktopJobView): BrowserDerivative {
  if (job.derivative === undefined) throw new Error('The job has no derivative');
  return {
    id: tracked.editorId,
    projectId: tracked.projectId,
    assetId: tracked.assetId,
    kind: derivativeKind(tracked.type),
    profile: tracked.type.startsWith('mask.') ? 'mask-matte' : 'render-export',
    sha256: job.derivative.sha256,
    bytes: job.derivative.bytes,
    descriptor: { mimeType: job.derivative.mimeType },
    availability: 'available-local',
    verifiedAt: Date.now(),
  };
}

/**
 * Originals above `chunkedAboveBytes` are sent in pieces of `chunkBytes`, one desktop message each,
 * so no single message has to carry the whole file.
 */
export interface OriginalUploadLimits {
  readonly chunkedAboveBytes: number;
  readonly chunkBytes: number;
}

const DEFAULT_ORIGINAL_UPLOAD_LIMITS: OriginalUploadLimits = {
  chunkedAboveBytes: 64 * 1024 * 1024,
  chunkBytes: 8 * 1024 * 1024,
};

export class BrowserControlPlaneClient {
  constructor(
    private readonly bridge: DesktopMediaBridge = defaultBridge(),
    private readonly uploads: OriginalUploadLimits = DEFAULT_ORIGINAL_UPLOAD_LIMITS,
  ) {}

  async workers(): Promise<readonly BrowserWorker[]> {
    const workers = await call<readonly DesktopWorkerView[]>(
      this.bridge,
      'desktop.media.workers.list',
      {},
    );
    return workers.map((worker) => ({
      id: worker.workerId,
      paired: true,
      revoked: false,
      capabilities: [...worker.capabilities],
      // The local route resolves any registered asset itself; there is no per-asset list to report.
      holdsAllLocalAssets: true,
      lastSeenAt: Date.parse(worker.lastHelloAt),
    }));
  }

  async openGpuPreviewSession(_projectId: string): Promise<BrowserGpuPreviewSession> {
    throw notAvailable('GPU preview');
  }

  async submitGpuPreviewFrame(_request: GpuPreviewFrameRequest): Promise<void> {
    throw notAvailable('GPU preview');
  }

  async gpuPreviewFrame(
    _sessionId: string,
    _requestId: number,
    _signal?: AbortSignal,
  ): Promise<BrowserGpuPreviewFrame | undefined> {
    throw notAvailable('GPU preview');
  }

  async closeGpuPreviewSession(_sessionId: string): Promise<void> {
    throw notAvailable('GPU preview');
  }

  async jobs(projectId: string): Promise<readonly BrowserJob[]> {
    const tracked = [...trackedJobs.values()].filter(
      (job) => job.projectId === projectId && !job.type.startsWith('speech.'),
    );
    return Promise.all(
      tracked.map(async (job) =>
        toBrowserJob(
          job,
          await call<DesktopJobView>(this.bridge, 'desktop.media.job.status', {
            jobId: job.desktopJobId,
          }),
        ),
      ),
    );
  }

  /** The local asset list has no channel yet. Local imports appear in the asset library panel. */
  async assets(_projectId: string): Promise<readonly BrowserAsset[]> {
    return [];
  }

  async reasoningProviders(): Promise<readonly BrowserReasoningProvider[]> {
    // No remote reasoning provider exists in the local build.
    return [];
  }

  async ensureProject(id: string, title: string): Promise<void> {
    projectTitles.set(id, title);
  }

  async derivatives(projectId: string, assetId: string): Promise<readonly BrowserDerivative[]> {
    const tracked = [...trackedJobs.values()].filter(
      (job) =>
        job.projectId === projectId && job.assetId === assetId && !job.type.startsWith('speech.'),
    );
    const views = await Promise.all(
      tracked.map(async (job) => {
        const view = await call<DesktopJobView>(this.bridge, 'desktop.media.job.status', {
          jobId: job.desktopJobId,
        });
        return { job, view };
      }),
    );
    return views
      .filter(({ view }) => view.status === 'done' && view.derivative !== undefined)
      .map(({ job, view }) => toBrowserDerivative(job, view));
  }

  async registerAsset(projectId: string, asset: BrowserAssetRegistration): Promise<BrowserAsset> {
    await call(this.bridge, 'desktop.media.asset.register', {
      id: asset.id,
      kind: asset.kind,
      displayName: asset.displayName,
      sha256: asset.sha256,
      bytes: asset.bytes,
      descriptor: asset.descriptor,
      ...(asset.internal === true ? { internal: true } : {}),
    });
    const registered: BrowserAsset = {
      id: asset.id,
      projectId,
      kind: asset.kind,
      displayName: asset.displayName,
      sha256: asset.sha256,
      bytes: asset.bytes,
      descriptor: asset.descriptor,
      createdAt: Date.now(),
      cloudBacked: false,
    };
    registeredAssets.set(asset.id, registered);
    return registered;
  }

  /** Imports a main-process ticket by path; only catalog metadata returns to the renderer. */
  async importDroppedAsset(
    projectId: string,
    ticketId: string,
    descriptor: BrowserAsset['descriptor'],
  ): Promise<BrowserAsset> {
    const imported = await call<{
      readonly id: string;
      readonly kind: BrowserAsset['kind'];
      readonly displayName: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly descriptor: BrowserAsset['descriptor'];
    }>(this.bridge, 'desktop.media.asset.import-dropped', { ticketId, descriptor });
    const asset: BrowserAsset = {
      ...imported,
      projectId,
      createdAt: Date.now(),
      cloudBacked: false,
    };
    registeredAssets.set(asset.id, asset);
    return asset;
  }

  async cancelDroppedImport(ticketId: string): Promise<void> {
    await call(this.bridge, 'desktop.media.asset.cancel-dropped-import', { ticketId });
  }

  async associateAsset(_projectId: string, _assetId: string): Promise<BrowserAsset> {
    throw notAvailable('Associating a catalog asset');
  }

  /** Forgets the asset in this session. Its stored original stays on disk until a cleanup exists. */
  async deleteAsset(
    _projectId: string,
    assetId: string,
  ): Promise<{
    readonly id: string;
    readonly removed: boolean;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    let removed: boolean;
    if (LIBRARY_ASSET_ID_PATTERN.test(assetId)) {
      const result = await call<{ readonly removed: boolean }>(
        this.bridge,
        'desktop.asset-library.remove-entry',
        { id: assetId },
      );
      removed = result.removed;
      registeredAssets.delete(assetId);
    } else {
      removed = registeredAssets.delete(assetId);
    }
    return { id: assetId, removed, cloudObjectsPurged: 0, cloudObjectPurgeFailures: 0 };
  }

  async deleteInternalAsset(
    _projectId: string,
    assetId: string,
  ): Promise<{
    readonly id: string;
    readonly removed: boolean;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    const result = await call<{ readonly removed: boolean }>(
      this.bridge,
      'desktop.media.asset.remove-internal',
      { assetId },
    );
    registeredAssets.delete(assetId);
    return {
      id: assetId,
      removed: result.removed,
      cloudObjectsPurged: 0,
      cloudObjectPurgeFailures: 0,
    };
  }

  async uploadAssetOriginal(
    projectId: string,
    asset: Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>,
    file: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<BrowserAsset> {
    if (file.size > this.uploads.chunkedAboveBytes) {
      await this.uploadOriginalInChunks(asset.id, file, onProgress);
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await call(this.bridge, 'desktop.media.asset.upload-original', { assetId: asset.id, bytes });
    }
    onProgress?.(1);
    return (
      registeredAssets.get(asset.id) ?? {
        id: asset.id,
        projectId,
        kind: 'video',
        displayName: asset.id,
        sha256: asset.sha256,
        bytes: asset.bytes,
        descriptor: asset.descriptor,
        createdAt: Date.now(),
        cloudBacked: false,
      }
    );
  }

  /** Sends a large original in pieces, then asks the desktop to check and commit the whole file. */
  private async uploadOriginalInChunks(
    assetId: string,
    file: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<void> {
    try {
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(file.size, offset + this.uploads.chunkBytes);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        await call(this.bridge, 'desktop.media.asset.upload-original-chunk', {
          assetId,
          offset,
          bytes,
        });
        offset = end;
        onProgress?.(offset / file.size);
      }
      await call(this.bridge, 'desktop.media.asset.upload-original-finish', { assetId });
    } catch (error) {
      await call(this.bridge, 'desktop.media.asset.upload-original-abort', { assetId }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async originalBytes(_projectId: string, _assetId: string): Promise<Blob> {
    throw notAvailable('Reading an original back from the desktop');
  }

  async retagAsset(_projectId: string, _assetId: string): Promise<BrowserAsset> {
    throw notAvailable('Retagging an asset');
  }

  async setAssetSync(
    _projectId: string,
    _enabled: boolean,
  ): Promise<{ readonly assetSyncEnabled: boolean }> {
    throw notAvailable('Asset sync');
  }

  async createProject(id: string, title: string): Promise<void> {
    projectTitles.set(id, title);
  }

  async project(id: string): Promise<BrowserProjectMetadata> {
    return {
      id,
      title: projectTitles.get(id) ?? id,
      revision: 0,
      ownerId: 'local',
      assetSyncEnabled: false,
      activeJobCount: 0,
    };
  }

  async renameProject(
    _id: string,
    _title: string,
    _baseRevision: number,
  ): Promise<BrowserProjectMetadata> {
    throw notAvailable('Renaming a remote project');
  }

  async duplicateProject(
    _sourceId: string,
    _id: string,
    _title: string,
    _baseRevision: number,
  ): Promise<BrowserProjectDuplicateResult> {
    throw notAvailable('Duplicating a remote project');
  }

  async trashProject(_id: string, _baseRevision: number): Promise<BrowserProjectMetadata> {
    throw notAvailable('Trashing a remote project');
  }

  async restoreProject(_id: string, _baseRevision: number): Promise<BrowserProjectMetadata> {
    throw notAvailable('Restoring a remote project');
  }

  async deleteProject(_id: string): Promise<{
    readonly id: string;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    throw notAvailable('Deleting a remote project');
  }

  async syncProjectDocument(
    projectId: string,
    params: {
      readonly baseRevisionId: ProjectRevisionId;
      readonly revisionId: ProjectRevisionId;
      readonly document: JoyProjectV1;
      readonly lookInstances?: LookInstancesDocument;
    },
  ): Promise<{ readonly projectId: string; readonly revisionId: ProjectRevisionId }> {
    const outcome = await call<DesktopDocumentPutOutcome>(
      this.bridge,
      'desktop.media.project.document.put',
      { projectId, ...params },
    );
    if (outcome.kind === 'saved') {
      return { projectId: outcome.projectId, revisionId: outcome.revisionId as ProjectRevisionId };
    }
    if (outcome.kind === 'conflict') {
      throw new BrowserControlPlaneRequestError(
        409,
        'DOCUMENT_REVISION_CONFLICT',
        'The stored project document has a different revision',
      );
    }
    throw new BrowserControlPlaneRequestError(
      404,
      'PROJECT_DOCUMENT_NOT_FOUND',
      'Project document not found',
    );
  }

  async projectDocument(
    projectId: string,
    revisionId?: ProjectRevisionId,
  ): Promise<BrowserProjectDocument | undefined> {
    const stored = await call<DesktopDocumentView | null>(
      this.bridge,
      'desktop.media.project.document.get',
      { projectId, ...(revisionId === undefined ? {} : { revisionId }) },
    );
    if (stored === null) return undefined;
    return {
      projectId: stored.projectId,
      revisionId: stored.revisionId as ProjectRevisionId,
      document: stored.document as JoyProjectV1,
      ...(stored.lookInstances === undefined
        ? {}
        : { lookInstances: stored.lookInstances as LookInstancesDocument }),
    };
  }

  async speechStatus(): Promise<{ readonly models: readonly SpeechModelStatus[] }> {
    return call(this.bridge, 'desktop.media.speech.status');
  }

  private async runSpeechJob(
    projectId: string,
    jobType: 'speech.transcribe' | 'speech.synthesize',
    refId: string | undefined,
    payload: SpeechTranscribeV1 | SpeechSynthesizeV1,
    consent: SpeechConsentRequest | undefined,
    signal: AbortSignal | undefined,
    onProgress: ((percent: number) => void) | undefined,
  ): Promise<{ readonly editorJobId: string; readonly job: DesktopJobView }> {
    throwIfSpeechAborted(signal);
    let started: { readonly jobId: string };
    try {
      started = await call(this.bridge, 'desktop.media.speech.run', {
        jobType,
        ...(refId === undefined ? {} : { refId }),
        payload,
        ...(consent === undefined ? {} : { consent }),
      });
    } catch (error) {
      throw speechErrorFrom(error) ?? error;
    }
    if (typeof started.jobId !== 'string' || started.jobId.length === 0) {
      throw new Error('The desktop did not return a speech job ID');
    }
    const editorJobId = `speech-${++speechJobSequence}-${started.jobId}`;
    trackedJobs.set(editorJobId, {
      editorId: editorJobId,
      projectId,
      assetId: refId ?? BUILT_IN_SPEECH_OUTPUT_REF_ID,
      type: jobType,
      desktopJobId: started.jobId,
    });

    let cancelSent = false;
    const cancelOnce = async (): Promise<void> => {
      if (cancelSent) return;
      cancelSent = true;
      await call(this.bridge, 'desktop.media.job.cancel', { jobId: started.jobId }).catch(
        () => undefined,
      );
    };
    const onAbort = (): void => {
      void cancelOnce();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) void cancelOnce();
    try {
      while (true) {
        signal?.throwIfAborted();
        let job: DesktopJobView;
        try {
          job = await (signal === undefined
            ? call(this.bridge, 'desktop.media.job.status', { jobId: started.jobId })
            : abortableCall(
                this.bridge,
                'desktop.media.job.status',
                { jobId: started.jobId },
                signal,
              ));
        } catch (error) {
          throw speechErrorFrom(error) ?? error;
        }
        signal?.throwIfAborted();
        if (Number.isFinite(job.progress)) {
          onProgress?.(Math.max(0, Math.min(100, job.progress)));
        }
        if (job.status === 'done') return { editorJobId, job };
        if (job.status === 'failed') {
          const typed = speechErrorFrom({ code: job.errorCode, message: job.error });
          throw typed ?? new Error(job.error || 'The local speech job failed');
        }
        if (job.status === 'cancelled')
          throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
        await (signal === undefined
          ? new Promise<void>((resolve) => setTimeout(resolve, 250))
          : abortableDelay(signal, 250));
      }
    } catch (error) {
      if (signal?.aborted) {
        await cancelOnce();
        throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
      }
      throw speechErrorFrom(error) ?? error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async runLocalTranscription(
    projectId: string,
    assetId: string,
    request: SpeechTranscribeV1,
    signal?: AbortSignal,
    onProgress?: (percent: number) => void,
  ): Promise<SpeechTranscript> {
    if (
      request.schemaVersion !== 1 ||
      (request.language !== 'fa-IR' && request.language !== 'en-US') ||
      request.modelId !== 'faster-whisper-large-v3-turbo' ||
      (request.range !== undefined &&
        (!Number.isSafeInteger(request.range.startUs) ||
          !Number.isSafeInteger(request.range.endUs) ||
          request.range.startUs < 0 ||
          request.range.endUs <= request.range.startUs))
    ) {
      throw new Error('Invalid local speech transcription request');
    }
    const { editorJobId } = await this.runSpeechJob(
      projectId,
      'speech.transcribe',
      assetId,
      request,
      undefined,
      signal,
      onProgress,
    );
    throwIfSpeechAborted(signal);
    let derivative: Blob;
    try {
      derivative = await this.derivativeBytes(projectId, editorJobId, editorJobId, signal);
    } catch (error) {
      if (signal?.aborted) throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
      throw speechErrorFrom(error) ?? error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await derivative.text()) as unknown;
    } catch {
      throw new Error('The desktop returned an invalid speech transcript derivative');
    }
    return asSpeechTranscript(parsed, request);
  }

  async runLocalSynthesis(
    projectId: string,
    request: SpeechSynthesizeV1,
    options: {
      readonly referenceAssetId?: string;
      readonly consent?: SpeechConsentRequest;
      readonly signal?: AbortSignal;
      readonly onProgress?: (percent: number) => void;
    },
  ): Promise<{ readonly audio: Blob; readonly timing: SpeechSynthesisTiming }> {
    if (
      request.schemaVersion !== 1 ||
      (request.language !== 'fa-IR' && request.language !== 'en-US') ||
      (request.modelId !== 'kokoro-82m' &&
        request.modelId !== 'chatterbox-en' &&
        request.modelId !== 'chatterbox-fa') ||
      typeof request.text !== 'string'
    ) {
      throw new Error('Invalid local speech synthesis request');
    }
    const graphemeCount = Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(request.text),
    ).length;
    if (
      request.schemaVersion !== 1 ||
      request.text.trim().length === 0 ||
      graphemeCount > 1000 ||
      new TextEncoder().encode(request.text).byteLength > 16 * 1024
    ) {
      throw new Error('Speech text must contain 1,000 graphemes or fewer and fit within 16 KiB');
    }
    const refId = options.referenceAssetId;
    const { editorJobId, job } = await this.runSpeechJob(
      projectId,
      'speech.synthesize',
      refId,
      request,
      options.consent,
      options.signal,
      options.onProgress,
    );
    if (job.speech === undefined) throw new Error('The desktop omitted speech synthesis timing');
    const timing = asSynthesisTiming(job.speech);
    throwIfSpeechAborted(options.signal);
    let audio: Blob;
    try {
      audio = await this.derivativeBytes(projectId, editorJobId, editorJobId, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
      throw speechErrorFrom(error) ?? error;
    }
    return { audio, timing };
  }

  async enqueueAssetThumbnail(
    _projectId: string,
    _id: string,
    _assetId: string,
  ): Promise<BrowserJob> {
    throw notAvailable('Thumbnail generation');
  }

  async enqueueComfyRemoveBg(
    _projectId: string,
    _id: string,
    _assetId: string,
  ): Promise<BrowserJob> {
    throw notAvailable('Remote background removal');
  }

  async enqueueWorkerGeneration(
    _projectId: string,
    _id: string,
    _type: string,
    _assetId: string,
    _payload?: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    throw notAvailable('Remote generation');
  }

  async enqueueRenderExport(
    projectId: string,
    id: string,
    assetId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    const { jobId } = await call<{ readonly jobId: string }>(
      this.bridge,
      'desktop.media.render.enqueue',
      { refId: assetId, payload },
    );
    trackedJobs.set(id, {
      editorId: id,
      projectId,
      assetId,
      type: 'render.export',
      desktopJobId: jobId,
    });
    return {
      id,
      projectId,
      type: 'render.export',
      assetId,
      state: 'queued',
      progress: 0,
      cancelRequested: false,
    };
  }

  async enqueueMask(
    projectId: string,
    id: string,
    type: 'mask.image' | 'mask.video',
    assetId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    // The desktop checks that the local Worker reports the capability and refuses with SETUP_REQUIRED if not.
    const { jobId } = await call<{ readonly jobId: string }>(
      this.bridge,
      'desktop.media.mask.run',
      {
        refId: assetId,
        jobType: type,
        payload,
      },
    );
    trackedJobs.set(id, { editorId: id, projectId, assetId, type, desktopJobId: jobId });
    return { id, projectId, type, assetId, state: 'queued', progress: 0, cancelRequested: false };
  }

  async enqueueUpscale(
    _projectId: string,
    _id: string,
    _type: 'upscale.image' | 'upscale.video',
    _assetId: string,
    _payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    throw notAvailable('Upscaling');
  }

  async enqueueAiGeneration(
    _projectId: string,
    _id: string,
    _type: string,
    _prompt: string,
    _options?: {
      readonly imageAssetId?: string;
      readonly model?: string;
      readonly params?: Record<string, unknown>;
    },
  ): Promise<BrowserJob> {
    throw notAvailable('AI generation');
  }

  async cancel(projectId: string, jobId: string): Promise<BrowserJob> {
    const tracked = trackedJob(projectId, jobId);
    return toBrowserJob(
      tracked,
      await call<DesktopJobView>(this.bridge, 'desktop.media.job.cancel', {
        jobId: tracked.desktopJobId,
      }),
    );
  }

  async retry(_projectId: string, _jobId: string): Promise<BrowserJob> {
    throw notAvailable('Retrying a job');
  }

  async derivativeBytes(
    projectId: string,
    _assetId: string,
    derivativeId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const tracked = trackedJob(projectId, derivativeId);
    signal?.throwIfAborted();
    const transfer = await call<{
      readonly transferId: string;
      readonly mimeType: string;
      readonly sha256: string;
      readonly size: number;
      readonly chunkBytes: number;
    }>(this.bridge, 'desktop.media.derivative.transfer.begin', { jobId: tracked.desktopJobId });
    const parts: BlobPart[] = [];
    let completed = false;
    try {
      if (signal?.aborted) throw new DOMException('Transfer cancelled', 'AbortError');
      if (
        !Number.isSafeInteger(transfer.size) ||
        transfer.size < 0 ||
        transfer.size > MAX_LOCAL_DERIVATIVE_BYTES ||
        !Number.isSafeInteger(transfer.chunkBytes) ||
        transfer.chunkBytes < 1 ||
        transfer.chunkBytes > MAX_DERIVATIVE_CHUNK_BYTES ||
        !/^[a-f0-9]{64}$/.test(transfer.sha256)
      ) {
        throw new Error('The desktop returned invalid derivative transfer metadata');
      }
      let offset = 0;
      while (offset < transfer.size) {
        signal?.throwIfAborted();
        const request = {
          transferId: transfer.transferId,
          offset,
        };
        const chunk = await (signal === undefined
          ? call<{ readonly offset: number; readonly bytes: Uint8Array }>(
              this.bridge,
              'desktop.media.derivative.transfer.chunk',
              request,
            )
          : abortableCall<{ readonly offset: number; readonly bytes: Uint8Array }>(
              this.bridge,
              'desktop.media.derivative.transfer.chunk',
              request,
              signal,
            ));
        signal?.throwIfAborted();
        const rawBytes: unknown = chunk.bytes;
        const bytes =
          rawBytes instanceof Uint8Array
            ? rawBytes
            : rawBytes instanceof ArrayBuffer
              ? new Uint8Array(rawBytes)
              : undefined;
        const expectedBytes = Math.min(transfer.chunkBytes, transfer.size - offset);
        if (chunk.offset !== offset || bytes === undefined || bytes.byteLength !== expectedBytes) {
          throw new Error('The desktop returned an invalid derivative transfer chunk');
        }
        parts.push(bytes as BlobPart);
        offset += bytes.byteLength;
      }
      signal?.throwIfAborted();
      const verified = await (signal === undefined
        ? call<{ readonly sha256: string; readonly size: number }>(
            this.bridge,
            'desktop.media.derivative.transfer.finish',
            { transferId: transfer.transferId },
          )
        : abortableCall<{ readonly sha256: string; readonly size: number }>(
            this.bridge,
            'desktop.media.derivative.transfer.finish',
            { transferId: transfer.transferId },
            signal,
          ));
      if (verified.sha256 !== transfer.sha256 || verified.size !== transfer.size) {
        throw new Error('The desktop returned an invalid derivative checksum');
      }
      completed = true;
      return new Blob(parts, { type: transfer.mimeType });
    } finally {
      if (!completed) {
        try {
          await call(this.bridge, 'desktop.media.derivative.transfer.cancel', {
            transferId: transfer.transferId,
          });
        } catch {
          // The transfer expires on the main process if cancellation cannot cross IPC.
        }
      }
      parts.length = 0;
    }
  }

  async transcribeSpeech(
    language: string,
    options: {
      readonly referenceAssetId?: string;
      readonly media?: Blob;
      readonly mediaType?: string;
    } = {},
  ): Promise<BrowserSpeechTranscript> {
    if (options.media === undefined) throw notAvailable('Reference speech transcription');
    if (options.media.size > MAX_LOCAL_WHISPER_MEDIA_BYTES)
      throw new Error(LOCAL_WHISPER_MEDIA_TOO_LARGE);
    const mediaType = options.mediaType ?? options.media.type ?? 'application/octet-stream';
    if (!/^(audio|video)\/[^\s;\r\n]+(?:\s*;[^\r\n]*)?$/i.test(mediaType)) {
      throw new Error('Local Whisper only accepts audio or video media.');
    }
    const media = new Uint8Array(await options.media.arrayBuffer());
    return call<BrowserSpeechTranscript>(this.bridge, 'desktop.media.speech.transcribe', {
      language,
      media,
      mediaType,
    });
  }

  async synthesizeSpeech(_input: {
    readonly text: string;
    readonly language?: string;
    readonly voiceId?: string;
    readonly speed?: number;
  }): Promise<BrowserSpeechSynthesis> {
    throw notAvailable('Speech synthesis');
  }

  async denoiseAudio(_input: {
    readonly projectId: string;
    readonly operationId: string;
    readonly assetId: string;
    readonly media: Blob;
    readonly sampleRate?: number;
    readonly strength?: number;
  }): Promise<BrowserSpectralDenoiseResult> {
    throw notAvailable('Audio denoise');
  }

  async denoiseAudioOperation(
    _projectId: string,
    _operationId: string,
  ): Promise<BrowserSpectralDenoiseOperation | undefined> {
    // No denoise operation is ever recorded locally, so there is nothing to recover.
    return undefined;
  }
}

export { BrowserControlPlaneClient as DesktopMediaClient };
