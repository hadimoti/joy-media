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
    throw new BrowserControlPlaneRequestError(
      500,
      undefined,
      error instanceof Error ? error.message : 'The local media request failed',
    );
  }
}

function trackedJob(projectId: string, jobId: string): TrackedJob {
  const tracked = trackedJobs.get(jobId);
  if (tracked === undefined || tracked.projectId !== projectId) {
    throw new BrowserControlPlaneRequestError(404, 'JOB_NOT_FOUND', 'Unknown job');
  }
  return tracked;
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
            kind: 'proxy',
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
    kind: 'proxy',
    profile: 'render-export',
    sha256: job.derivative.sha256,
    bytes: job.derivative.bytes,
    descriptor: { mimeType: job.derivative.mimeType },
    availability: 'available-local',
    verifiedAt: Date.now(),
  };
}

export class BrowserControlPlaneClient {
  constructor(private readonly bridge: DesktopMediaBridge = defaultBridge()) {}

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
    const tracked = [...trackedJobs.values()].filter((job) => job.projectId === projectId);
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
      (job) => job.projectId === projectId && job.assetId === assetId,
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

  async associateAsset(_projectId: string, _assetId: string): Promise<BrowserAsset> {
    throw notAvailable('Associating a catalog asset');
  }

  /** Forgets the asset in this session. Its stored original stays on disk until a cleanup exists. */
  async deleteAsset(
    _projectId: string,
    assetId: string,
  ): Promise<{
    readonly id: string;
    readonly cloudObjectsPurged: number;
    readonly cloudObjectPurgeFailures: number;
  }> {
    registeredAssets.delete(assetId);
    return { id: assetId, cloudObjectsPurged: 0, cloudObjectPurgeFailures: 0 };
  }

  async uploadAssetOriginal(
    projectId: string,
    asset: Pick<BrowserAsset, 'id' | 'sha256' | 'bytes' | 'descriptor'>,
    file: Blob,
    onProgress?: (ratio: number) => void,
  ): Promise<BrowserAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await call(this.bridge, 'desktop.media.asset.upload-original', { assetId: asset.id, bytes });
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
    _projectId: string,
    _id: string,
    _type: 'mask.image' | 'mask.video',
    _assetId: string,
    _payload: Readonly<Record<string, unknown>>,
  ): Promise<BrowserJob> {
    throw notAvailable('Masking');
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

  async derivativeBytes(projectId: string, _assetId: string, derivativeId: string): Promise<Blob> {
    const tracked = trackedJob(projectId, derivativeId);
    const derivative = await call<{ readonly mimeType: string; readonly bytes: Uint8Array }>(
      this.bridge,
      'desktop.media.derivative.bytes',
      { jobId: tracked.desktopJobId },
    );
    return new Blob([derivative.bytes as BlobPart], { type: derivative.mimeType });
  }

  async transcribeSpeech(
    _language: string,
    _options: {
      readonly referenceAssetId?: string;
      readonly media?: Blob;
      readonly mediaType?: string;
    } = {},
  ): Promise<BrowserSpeechTranscript> {
    throw notAvailable('Speech transcription');
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
