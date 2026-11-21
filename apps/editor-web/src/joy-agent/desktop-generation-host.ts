import type { AudioState } from '@joy-media/commands';
import type { BrowserControlPlaneClient } from '../control-plane-client.js';
import type { EditorSession } from '../editor-session.js';
import { attachGeneratedJob, type AttachableGenerationJob } from '../generation-attach.js';
import type { MediaImportOptions } from '../media-import.js';
import type { JoyCodeMediaPartsProps } from '../joy-code-media-parts.js';
import type {
  JoyAgentAttachGeneratedMediaRequest,
  JoyAgentGenerateMediaRequest,
  JoyAgentGenerationToolAdapter,
} from './tool-bridge.js';

type GenerationState =
  | 'queued'
  | 'running'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'abandoned-locally'
  | 'timed-out';

interface DesktopGenerationJob extends AttachableGenerationJob {
  readonly state: GenerationState;
  readonly error?: string;
}

interface DesktopGenerationBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
  readonly job: DesktopGenerationJob;
}

export interface DesktopGenerationHostOptions {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly session: EditorSession;
  readonly audioState: AudioState;
  readonly client: Pick<
    BrowserControlPlaneClient,
    'ensureProject' | 'registerAsset' | 'assets' | 'uploadAssetOriginal'
  >;
  readonly getPlayheadUs: () => number;
  readonly onAudioState: (audio: AudioState) => void;
  readonly originalAssetCache?: MediaImportOptions['originalAssetCache'];
  readonly describeMedia?: MediaImportOptions['describeMedia'];
  readonly pollIntervalMs?: number;
}

export interface DesktopGenerationHost {
  readonly adapter: JoyAgentGenerationToolAdapter;
  readonly generatedMedia: Omit<JoyCodeMediaPartsProps, 'parts'>;
}

/** Main-thread desktop adapter. Job records and media bytes never enter Worker messages. */
export function createDesktopGenerationHost(
  options: DesktopGenerationHostOptions,
): DesktopGenerationHost {
  const invoke = async <T>(channel: string, payload?: unknown): Promise<T | undefined> => {
    const bridge = typeof window === 'undefined' ? undefined : window.joyDesktop;
    if (bridge === undefined) throw new Error('Desktop generation is unavailable.');
    const response = await bridge.invoke(channel, payload);
    if (isRecord(response) && typeof response.ok === 'boolean') {
      if (!response.ok) return undefined;
      return response.data as T;
    }
    return response as T | undefined;
  };

  const status = (jobId: string) =>
    invoke<DesktopGenerationJob>('desktop.generation.status', { jobId });
  const bytes = (jobId: string) =>
    invoke<DesktopGenerationBytes>('desktop.generation.bytes', { jobId });
  const cancel = async (jobId: string): Promise<void> => {
    await invoke('desktop.generation.cancel', { jobId });
  };
  const attach = async (input: JoyAgentAttachGeneratedMediaRequest) => {
    const [job, generated] = await Promise.all([status(input.jobId), bytes(input.jobId)]);
    if (job?.state !== 'completed' || generated === undefined)
      throw new Error('The generation job is not ready to attach.');
    const fileBytes = new Uint8Array(generated.bytes).buffer.slice(0) as ArrayBuffer;
    const file = new File([fileBytes], generated.fileName, { type: generated.mimeType });
    const jobRecord = { ...job, ...generated.job, id: job.id, state: job.state };
    const baseAttachOptions = {
      projectId: options.projectId,
      projectTitle: options.projectTitle,
      job: jobRecord,
      file,
      session: options.session,
      audioState: options.audioState,
      ...(options.originalAssetCache === undefined
        ? {}
        : { originalAssetCache: options.originalAssetCache }),
      placeOnTimeline: input.target === 'timeline',
      playheadUs:
        input.atSeconds !== undefined
          ? Math.round(input.atSeconds * 1_000_000)
          : options.getPlayheadUs(),
      ...(options.describeMedia === undefined ? {} : { describeMedia: options.describeMedia }),
    };
    let attached: Awaited<ReturnType<typeof attachGeneratedJob>>;
    try {
      attached = await attachGeneratedJob({ ...baseAttachOptions, client: options.client });
    } catch {
      // Desktop offline sessions may not have a running HTTP control-plane server;
      // fall back to local OPFS cache + project registration so library/timeline attach still works.
      const sha = jobRecord.sha256 ?? '';
      const offlineClient: typeof options.client = {
        ensureProject: async () => ({ id: options.projectId, title: options.projectTitle }) as never,
        registerAsset: async (_projectId, reg) =>
          ({ ...reg, projectId: options.projectId }) as never,
        assets: async () => [],
        uploadAssetOriginal: async (_projectId, assetId, uploadedFile) =>
          ({ assetId, sha256: sha, bytes: uploadedFile.size }) as never,
      };
      attached = await attachGeneratedJob({ ...baseAttachOptions, client: offlineClient });
    }
    options.onAudioState(attached.audioState);
    return { assetId: attached.assetId, placed: attached.clipId !== undefined };
  };

  const adapter: JoyAgentGenerationToolAdapter = {
    enqueue: () => `generation-request-${crypto.randomUUID()}`,
    status,
    list: async () =>
      (await invoke<readonly DesktopGenerationJob[]>('desktop.generation.list')) ?? [],
    cancel: async (jobId) => {
      await cancel(jobId);
      return status(jobId);
    },
    requestApproval: async () => false,
    start: async (request: JoyAgentGenerateMediaRequest) => {
      const slots = await invoke<
        readonly {
          readonly id: string;
          readonly profileId?: string | null;
          readonly ready?: boolean;
        }[]
      >('desktop.agent-slots.list');
      const workhorse = slots?.find((slot) => slot.id === 'workhorse' && slot.ready !== false);
      if (workhorse?.profileId == null)
        throw new Error('Connect a Workhorse provider before generating media.');
      const job = await invoke<DesktopGenerationJob>('desktop.generation.start', {
        profileId: workhorse.profileId,
        kind: request.kind,
        prompt: request.prompt,
      });
      if (job?.id === undefined) throw new Error('The generation job could not be started.');
      return job.id;
    },
    awaitJob: async (jobId) => {
      for (;;) {
        const job = await status(jobId);
        if (job === undefined) throw new Error('The generation job is unavailable.');
        if (isTerminal(job.state))
          return {
            jobId,
            kind: job.kind,
            status:
              job.state === 'completed'
                ? 'completed'
                : job.state === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
          };
        await new Promise((resolve) => window.setTimeout(resolve, options.pollIntervalMs ?? 750));
      }
    },
    canAttachCompletedJob: async (jobId) => (await status(jobId))?.state === 'completed',
    attach,
  };

  return {
    adapter,
    generatedMedia: {
      readMedia: async (jobId) => {
        const result = await bytes(jobId);
        return result === undefined
          ? undefined
          : { bytes: result.bytes, mimeType: result.mimeType };
      },
      onCancel: (jobId) => void cancel(jobId),
      onAddToLibrary: (jobId) => {
        void attach({ jobId, target: 'library' }).catch((error) => {
          console.error('[joy-generation] Add to library failed:', error);
        });
      },
      onPlaceOnTimeline: (jobId) => {
        void attach({ jobId, target: 'timeline' }).catch((error) => {
          console.error('[joy-generation] Place on timeline failed:', error);
        });
      },
      onSaveAs: (jobId) => {
        void bytes(jobId)
          .then((generated) => {
            if (generated === undefined || typeof document === 'undefined') return;
            const blob = new Blob([new Uint8Array(generated.bytes)], { type: generated.mimeType });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = generated.fileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
          })
          .catch((error) => {
            console.error('[joy-generation] Save as failed:', error);
          });
      },
    },
  };
}

function isTerminal(state: GenerationState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'abandoned-locally' ||
    state === 'timed-out'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
