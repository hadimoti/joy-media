import { isAllowedIpcRequest } from '../ipc.js';
import type { IpcChannel, IpcRequest } from '../ipc.js';
import type { DerivativeKind, OpaqueFileRef } from '../file-boundary.js';
import { normalizeStartupPreference } from '../worker-status.js';
import type { WorkerStatus } from '../worker-status.js';
import type { FileRegistry } from './file-registry.js';
import type { WorkerSupervisor } from './worker-supervisor.js';
import type { JobRecord, LocalDatabase, MediaKind } from '../store/local-database.js';

/** Native "select a file" prompt, injected so main-process wiring stays unit-testable. */
export type ShowOpenDialog = () => Promise<{
  readonly canceled: boolean;
  readonly path: string | undefined;
}>;

/** Records a freshly selected file into the media manifest. Injected so ipc-handlers.ts never
 * touches real disk I/O directly — see main/media-checksum.ts for the real implementation. */
export type ProbeMedia = (path: string) => Promise<{
  readonly checksum: string;
  readonly byteSize: number;
  readonly kind: MediaKind;
}>;

export interface IpcHandlerDeps {
  readonly fileRegistry: FileRegistry;
  readonly workerSupervisor: WorkerSupervisor;
  readonly showOpenDialog: ShowOpenDialog;
  readonly localDatabase: LocalDatabase;
  readonly probeMedia: ProbeMedia;
  readonly now?: () => string;
}

export interface IpcResult {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type IpcHandler = (payload: unknown) => Promise<IpcResult> | IpcResult;

/** Builds the channel -> handler dispatch table. Never exposed directly to the renderer. */
export function createIpcHandlers(deps: IpcHandlerDeps): Record<IpcChannel, IpcHandler> {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    'desktop.select-file': async () => {
      const result = await deps.showOpenDialog();
      if (result.canceled || result.path === undefined) return { ok: true, data: undefined };
      const ref = deps.fileRegistry.registerSelection(result.path);
      // Record what we know locally right away; the Worker remains the owner of real probing
      // (demuxing, precise duration/codec) once it picks up a job for this ref.
      const probe = await deps.probeMedia(result.path);
      deps.localDatabase.recordMedia({
        refId: ref.id,
        checksum: probe.checksum,
        kind: probe.kind,
        byteSize: probe.byteSize,
        lastVerifiedAt: now(),
      });
      return { ok: true, data: ref };
    },
    'desktop.revoke-file': (payload) => {
      const ref = asOpaqueFileRef(payload);
      if (ref === undefined) return { ok: false, error: 'Invalid file reference' };
      deps.fileRegistry.revoke(ref);
      deps.localDatabase.removeMedia(ref.id);
      return { ok: true };
    },
    'desktop.request-derivative': (payload) => {
      const request = asDerivativeRequest(payload);
      if (request === undefined) return { ok: false, error: 'Invalid derivative request' };
      try {
        const approval = deps.fileRegistry.requestDerivative(request.ref, request.kind);
        const job = deps.localDatabase.enqueueJob(`derivative:${request.kind}`, request.ref.id);
        return { ok: true, data: { ...approval, jobId: job.id } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    },
    'desktop.worker-status': (): IpcResult => ({ ok: true, data: deps.workerSupervisor.status() }),
    'desktop.startup-preference': (payload): IpcResult => {
      const preference = normalizeStartupPreference(payload);
      if (preference === 'start-worker') deps.workerSupervisor.start();
      return { ok: true, data: preference };
    },
    'desktop.job-status': (payload): IpcResult => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const job = deps.localDatabase.getJob(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job id' };
      return { ok: true, data: job };
    },
    'desktop.cancel-job': (payload): IpcResult => {
      const jobId = asJobId(payload);
      if (jobId === undefined) return { ok: false, error: 'Invalid job id' };
      const job = deps.localDatabase.getJob(jobId);
      if (job === undefined) return { ok: false, error: 'Unknown job id' };
      if (job.status !== 'queued' && job.status !== 'running') {
        return { ok: false, error: `Cannot cancel a job in status "${job.status}"` };
      }
      const updated: JobRecord | undefined = deps.localDatabase.updateJobStatus(
        jobId,
        'cancelled',
        'cancelled by user',
      );
      return { ok: true, data: updated };
    },
  };
}

/**
 * Dispatches a raw IPC request through the origin/channel policy in `../ipc.ts` before
 * running the matching handler. This is the only place a request payload should touch
 * a handler function.
 */
/** isAllowedIpcRequest throws on a disallowed origin (see ../ipc.ts) and returns false for a
 * disallowed channel; both must fail closed here without ever reaching a handler. */
function safeIsAllowedIpcRequest(
  request: IpcRequest,
): request is IpcRequest & { channel: IpcChannel } {
  try {
    return isAllowedIpcRequest(request);
  } catch {
    return false;
  }
}

export async function dispatchIpcRequest(
  handlers: Record<IpcChannel, IpcHandler>,
  request: IpcRequest,
): Promise<IpcResult> {
  if (!safeIsAllowedIpcRequest(request)) {
    return { ok: false, error: `Blocked IPC request: ${request.channel}` };
  }
  return handlers[request.channel](request.payload);
}

function asOpaqueFileRef(value: unknown): OpaqueFileRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<OpaqueFileRef>;
  if (
    candidate.kind === 'local-file' &&
    typeof candidate.id === 'string' &&
    typeof candidate.displayName === 'string'
  ) {
    return { kind: 'local-file', id: candidate.id, displayName: candidate.displayName };
  }
  return undefined;
}

function asDerivativeRequest(
  value: unknown,
): { readonly ref: OpaqueFileRef; readonly kind: DerivativeKind } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { ref?: unknown; kind?: unknown };
  const ref = asOpaqueFileRef(candidate.ref);
  if (ref === undefined) return undefined;
  if (candidate.kind !== 'thumbnail' && candidate.kind !== 'proxy') return undefined;
  return { ref, kind: candidate.kind };
}

function asJobId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { jobId?: unknown }).jobId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export type { WorkerStatus };
