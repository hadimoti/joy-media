/**
 * Narrow boundary between JOY's model agent and media executors. A media
 * provider never receives the model BYOK key; the agent sees only opaque job
 * identity and safe progress metadata.
 */
export interface JoyMediaJobRequest {
  readonly jobId: string;
  readonly kind: 'audio' | 'captions' | 'image' | 'video' | 'render';
  readonly assetId?: string;
  readonly providerId: string;
  readonly estimatedCostUsd?: number;
  readonly remoteUpload: boolean;
  readonly approved: boolean;
}

export interface JoyMediaJobProgress {
  readonly jobId: string;
  readonly status: 'queued' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled';
  readonly current?: number;
  readonly total?: number;
  readonly resultRef?: string;
}

export interface JoyMediaJobExecutor {
  readonly submit: (request: JoyMediaJobRequest) => Promise<void>;
  readonly cancel?: (jobId: string) => Promise<'cancelled' | 'pending'>;
}

export class JoyMediaJobBridgeError extends Error {
  readonly code:
    | 'approval-required'
    | 'invalid-request'
    | 'invalid-progress'
    | 'missing-provider'
    | 'cancel-unsupported';

  constructor(code: JoyMediaJobBridgeError['code'], message: string) {
    super(message);
    this.name = 'JoyMediaJobBridgeError';
    this.code = code;
  }
}

function validRequest(request: JoyMediaJobRequest): void {
  if (
    !request.jobId.trim() ||
    request.jobId.length > 128 ||
    !['audio', 'captions', 'image', 'video', 'render'].includes(request.kind) ||
    typeof request.remoteUpload !== 'boolean' ||
    typeof request.approved !== 'boolean'
  )
    throw new JoyMediaJobBridgeError('invalid-request', 'Media job request is invalid');
  if (!request.providerId.trim())
    throw new JoyMediaJobBridgeError('missing-provider', 'A media provider must be selected');
  if (request.remoteUpload && !request.approved)
    throw new JoyMediaJobBridgeError(
      'approval-required',
      'Remote media jobs require explicit approval before upload',
    );
  if (
    request.estimatedCostUsd !== undefined &&
    (!Number.isFinite(request.estimatedCostUsd) || request.estimatedCostUsd < 0)
  )
    throw new JoyMediaJobBridgeError('approval-required', 'Media job cost is invalid');
  if (request.providerId.length > 256 || (request.assetId?.length ?? 0) > 256)
    throw new JoyMediaJobBridgeError('invalid-request', 'Media job identifiers are too long');
}

export function validateJoyMediaJobProgress(progress: JoyMediaJobProgress): JoyMediaJobProgress {
  if (
    !progress.jobId ||
    progress.jobId.length > 128 ||
    !['queued', 'running', 'review', 'completed', 'failed', 'cancelled'].includes(progress.status)
  )
    throw new JoyMediaJobBridgeError('invalid-progress', 'Media job progress is incomplete');
  const hasCurrent = progress.current !== undefined || progress.total !== undefined;
  if (
    hasCurrent &&
    (!Number.isSafeInteger(progress.current) ||
      !Number.isSafeInteger(progress.total) ||
      progress.total! <= 0 ||
      progress.current! < 0 ||
      progress.current! > progress.total!)
  )
    throw new JoyMediaJobBridgeError('invalid-progress', 'Media job progress is not determinate');
  if (
    progress.resultRef !== undefined &&
    (typeof progress.resultRef !== 'string' ||
      progress.resultRef.length > 256 ||
      /apiKey|authorization|https?:\/\//i.test(progress.resultRef))
  )
    throw new JoyMediaJobBridgeError('invalid-progress', 'Media job result reference is invalid');
  return Object.freeze({
    jobId: progress.jobId.slice(0, 128),
    status: progress.status,
    ...(hasCurrent ? { current: progress.current, total: progress.total } : {}),
    ...(progress.resultRef === undefined ? {} : { resultRef: progress.resultRef.slice(0, 256) }),
  });
}

export function createJoyMediaJobBridge(executor: JoyMediaJobExecutor) {
  return {
    async submit(request: JoyMediaJobRequest): Promise<void> {
      validRequest(request);
      await executor.submit({ ...request, jobId: request.jobId.slice(0, 128) });
    },
    async cancel(jobId: string): Promise<'cancelled' | 'pending'> {
      if (executor.cancel === undefined)
        throw new JoyMediaJobBridgeError(
          'cancel-unsupported',
          'Cancellation is pending at the provider',
        );
      return executor.cancel(jobId.slice(0, 128));
    },
    validateProgress: validateJoyMediaJobProgress,
  };
}
