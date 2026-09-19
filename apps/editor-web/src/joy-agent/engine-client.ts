import { normalizeByokSessionConfig } from '@joy-media/joy-agent-engine';
import {
  createHostRpcHost,
  type HostRpcHost,
  type HostRpcMethods,
  type HostRpcRun,
} from './host-rpc.js';
import {
  isDualBrainConfig,
  isWorkerToMainMessage,
  JOY_AGENT_PROTOCOL_VERSION,
  type ByokSessionConfig,
  type ByokSessionStatus,
  type DualBrainConfig,
  type JoyAgentMediaCapabilityReport,
  type JoyAgentRunRequest,
  type JoyAgentSafeEvent,
} from './protocol.js';
import type { JoyAgentHostToolName } from './host-tool-contract.js';
import type { ObservationTransferEvidenceResolver } from './observation-transfer-service.js';
import {
  createPrivateObservationPortBind,
  isPrivateObservationWorkerToMainMessage,
  type PrivateObservationAuthority,
  type PrivateObservationEvidence,
  type PrivateObservationRange,
  type PrivateObservationTransferResult,
  type PrivateObservationWorkerToMainMessage,
} from './observation-transfer-port-protocol.js';

const RELOAD_RECONNECT_MESSAGE =
  'JOY Agent Engine updated. Reconnect the model and reload this page.';
// The Worker deliberately gives connection probes 15 seconds. This outer
// watchdog must remain longer, otherwise a bounded provider timeout races the
// Worker’s safe `test-result` and is misreported as a stale Worker update.
const STATUS_TIMEOUT_MS = 20_000;

export interface JoyAgentRunHost {
  /** Main-thread-only methods; this object is never posted to the Worker. */
  readonly methods: HostRpcMethods;
  /**
   * Optional closed provider catalog derived from these host methods. The
   * client, rather than a UI-originated run request, owns forwarding it to the
   * Worker so a model is never advertised a method absent from its host.
   */
  readonly allowedToolNames?: readonly JoyAgentHostToolName[];
  /** Revoke any staged preview when the epoch is cancelled or abandoned. */
  readonly onCancelled?: () => void;
}

/**
 * Main-thread lifecycle observer. It is deliberately separate from Host RPC so
 * plan-only tasks have the same terminal cleanup guarantees as tool-loop runs.
 */
export interface JoyAgentRunLifecycleHooks {
  /**
   * Clear only the exact project-owned lifecycle when the BYOK session is
   * intentionally cleared or reconfigured. This is display/lifecycle cleanup
   * only; it never grants editor authority.
   */
  readonly onConnectionCleared?: () => void;
}

/**
 * The main thread owns this outer scope. Exposing it with the iterator lets a
 * project lifecycle controller fence the exact Worker epoch without trusting
 * an event to establish authority after the fact.
 */
export interface JoyAgentRunIterator extends AsyncIterableIterator<JoyAgentSafeEvent> {
  readonly run: HostRpcRun;
}

/**
 * Main-thread-only registration for evidence that was created by a live tool
 * run. It carries no media bytes, endpoint, or credential. The Worker issues
 * the opaque lease only while it can verify the exact run epoch.
 */
export interface JoyAgentObservationReviewLeaseRequest {
  readonly authority: PrivateObservationAuthority;
  readonly manifestId: string;
  readonly range: PrivateObservationRange;
  readonly evidenceIds: readonly string[];
  readonly expiresAtMs: number;
}

/** Opaque, Worker-created lease; never render or persist it. */
export interface JoyAgentObservationReviewLease {
  readonly leaseId: string;
  readonly expiresAtMs: number;
}

/**
 * Private explicit-review request. `evidenceResolver` remains in a closure on
 * the main thread; its bytes cross only the dedicated MessagePort on a Worker
 * `need-evidence` packet. No key/base URL is accepted by this API.
 */
export interface JoyAgentApprovedImageObservationRequest {
  readonly leaseId: string;
  readonly authority: PrivateObservationAuthority;
  readonly range: PrivateObservationRange;
  readonly evidenceIds: readonly string[];
  readonly maxBytes: number;
  readonly expiresAtMs: number;
  readonly prompt: string;
  readonly evidenceResolver: ObservationTransferEvidenceResolver;
  readonly signal?: AbortSignal;
}

export interface JoyAgentEngineClient {
  configure(config: ByokSessionConfig | DualBrainConfig): Promise<ByokSessionStatus>;
  testConnection(): Promise<ByokSessionStatus>;
  /**
   * Explicit-only, session-scoped synthetic media probe. Calling configure,
   * testConnection, startRun, clear, or dispose never triggers it implicitly.
   */
  probeMediaCapabilities(): Promise<JoyAgentMediaCapabilityReport>;
  startRun(
    request: Omit<JoyAgentRunRequest, 'runEpoch'>,
    host?: JoyAgentRunHost,
    lifecycleHooks?: JoyAgentRunLifecycleHooks,
  ): JoyAgentRunIterator;
  cancel(runId: string): Promise<void>;
  clear(): void;
  dispose(): void;
  getStatus(): ByokSessionStatus | undefined;
  /** Undefined until this exact configured session is explicitly probed. */
  getMediaCapabilities(): JoyAgentMediaCapabilityReport | undefined;
  /**
   * Registers a short-lived, private review lease while the source Worker run
   * is still live. It does not call a provider or resolve any owner media.
   */
  registerObservationReviewLease(
    input: JoyAgentObservationReviewLeaseRequest,
  ): Promise<JoyAgentObservationReviewLease | undefined>;
  /**
   * Explicit human-review path only. Evidence uses a private MessagePort; the
   * Worker owns the configured endpoint/key and returns redacted analysis.
   */
  sendApprovedImageObservation(
    input: JoyAgentApprovedImageObservationRequest,
  ): Promise<PrivateObservationTransferResult>;
  getDualBrainConfig?(): DualBrainConfig | undefined;
}

type Pending = {
  readonly resolve: (value: ByokSessionStatus) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type PendingMediaProbe = {
  readonly requestId: string;
  readonly resolve: (value: JoyAgentMediaCapabilityReport) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type PendingObservationLease = {
  readonly requestId: string;
  readonly resolve: (value: JoyAgentObservationReviewLease | undefined) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type PendingObservationTransfer = {
  readonly transferId: string;
  readonly sessionEpoch: number;
  readonly request: JoyAgentApprovedImageObservationRequest;
  readonly controller: AbortController;
  readonly resolve: (value: PrivateObservationTransferResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly unlinkAbort: () => void;
};

type RunWaiter = {
  readonly resolve: (value: IteratorResult<JoyAgentSafeEvent>) => void;
  readonly reject: (error: Error) => void;
};

interface RunQueue {
  readonly run: HostRpcRun;
  readonly events: JoyAgentSafeEvent[];
  readonly waiters: RunWaiter[];
  host?: HostRpcHost;
  onCancelled?: () => void;
  onConnectionCleared?: () => void;
  done: boolean;
  lastSeq: number;
  keepHostUntilCancel: boolean;
  hostDisposed: boolean;
  error?: Error;
}

/** Run IDs cannot contain `:`, making this a stable outer-epoch queue key. */
function runQueueKey(run: HostRpcRun): string {
  return `${run.runId}:${run.epoch}`;
}

function isStructuredRun(request: Omit<JoyAgentRunRequest, 'runEpoch'>): boolean {
  return request.mode !== 'plan-only' && request.taskKind !== 'creative-brief';
}

function samePrivateAuthority(
  left: PrivateObservationAuthority,
  right: PrivateObservationAuthority,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.revision === right.revision &&
    left.run.runId === right.run.runId &&
    left.run.epoch === right.run.epoch &&
    left.modelId === right.modelId &&
    left.promptPolicyDigest === right.promptPolicyDigest
  );
}

function samePrivateRange(left: PrivateObservationRange, right: PrivateObservationRange): boolean {
  return (
    left.domain === right.domain && left.startUs === right.startUs && left.endUs === right.endUs
  );
}

function samePrivateIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The single production Worker client. Structured runs get a per-run host RPC
 * endpoint; no editor object, writer, storage surface, or credential crosses
 * this boundary. Epochs are minted here rather than trusted from callers.
 */
export function createSingleWorkerEngineClient(workerFactory?: () => Worker): JoyAgentEngineClient {
  let worker: Worker | undefined;
  let generation = 0;
  let configured = false;
  let latestStatus: ByokSessionStatus | undefined;
  let latestMediaCapabilities: JoyAgentMediaCapabilityReport | undefined;
  const pending = new Map<'configure' | 'test', Pending>();
  let pendingMediaProbe: PendingMediaProbe | undefined;
  let nextMediaProbeId = 0;
  let observationPort: MessagePort | undefined;
  let observationSessionEpoch: number | undefined;
  let nextObservationLeaseRequestId = 0;
  let nextObservationTransferId = 0;
  const pendingObservationLeases = new Map<string, PendingObservationLease>();
  const pendingObservationTransfers = new Map<string, PendingObservationTransfer>();
  const runQueues = new Map<string, RunQueue>();
  const activeQueueKeysByRunId = new Map<string, string>();
  const latestEpochByRunId = new Map<string, number>();

  const queueFor = (runId: string, runEpoch: number): RunQueue | undefined =>
    runQueues.get(`${runId}:${runEpoch}`);

  const removeQueue = (queue: RunQueue): void => {
    const key = runQueueKey(queue.run);
    runQueues.delete(key);
    if (activeQueueKeysByRunId.get(queue.run.runId) === key)
      activeQueueKeysByRunId.delete(queue.run.runId);
  };

  const disposeHost = (queue: RunQueue, cancelled: boolean): void => {
    if (queue.hostDisposed) return;
    queue.hostDisposed = true;
    if (cancelled) {
      try {
        queue.host?.cancelRun(queue.run);
      } catch {
        // Host cancellation is best effort; prepared authority still fences apply.
      }
      try {
        queue.onCancelled?.();
      } catch {
        // UI cleanup cannot create an alternate capability path.
      }
    }
    queue.host?.dispose();
  };

  const notifyConnectionCleared = (queue: RunQueue): void => {
    try {
      queue.onConnectionCleared?.();
    } catch {
      // App lifecycle display cleanup cannot create an alternate capability path.
    }
  };

  const finishQueue = (queue: RunQueue, options: { readonly cancelled: boolean }): void => {
    if (queue.done) return;
    queue.done = true;
    while (queue.waiters.length) queue.waiters.shift()!.resolve({ value: undefined, done: true });
    if (!queue.keepHostUntilCancel || options.cancelled) {
      disposeHost(queue, options.cancelled);
      removeQueue(queue);
    }
  };

  const failQueue = (queue: RunQueue, error: Error): void => {
    if (queue.done) return;
    queue.error = error;
    queue.done = true;
    while (queue.waiters.length) queue.waiters.shift()!.reject(error);
    disposeHost(queue, true);
    removeQueue(queue);
  };

  const settleObservationTransfer = (
    item: PendingObservationTransfer,
    result: PrivateObservationTransferResult,
  ): void => {
    if (pendingObservationTransfers.get(item.transferId) !== item) return;
    pendingObservationTransfers.delete(item.transferId);
    clearTimeout(item.timer);
    item.unlinkAbort();
    item.controller.abort();
    item.resolve(result);
  };

  const rejectObservationTransfer = (item: PendingObservationTransfer, error: Error): void => {
    if (pendingObservationTransfers.get(item.transferId) !== item) return;
    pendingObservationTransfers.delete(item.transferId);
    clearTimeout(item.timer);
    item.unlinkAbort();
    item.controller.abort();
    item.reject(error);
  };

  const closeObservationPort = (error?: Error): void => {
    const failure = error ?? new Error('JOY Agent connection cleared');
    for (const item of pendingObservationLeases.values()) {
      clearTimeout(item.timer);
      if (error === undefined) item.resolve(undefined);
      else item.reject(failure);
    }
    pendingObservationLeases.clear();
    for (const item of [...pendingObservationTransfers.values()]) {
      if (error === undefined) settleObservationTransfer(item, { ok: false, code: 'cancelled' });
      else rejectObservationTransfer(item, failure);
    }
    observationSessionEpoch = undefined;
    try {
      observationPort?.close();
    } catch {
      // No public transport fallback may replace a closed private port.
    }
    observationPort = undefined;
  };

  const cancelObservationTransfer = (item: PendingObservationTransfer): void => {
    if (pendingObservationTransfers.get(item.transferId) !== item) return;
    try {
      observationPort?.postMessage({
        type: 'cancel',
        transferId: item.transferId,
        sessionEpoch: item.sessionEpoch,
      });
    } catch {
      // Local cancellation below still revokes the resolver closure immediately.
    }
    settleObservationTransfer(item, { ok: false, code: 'cancelled' });
  };

  const replyWithPrivateEvidence = async (
    item: PendingObservationTransfer,
    message: Extract<PrivateObservationWorkerToMainMessage, { readonly type: 'need-evidence' }>,
  ): Promise<void> => {
    if (
      pendingObservationTransfers.get(item.transferId) !== item ||
      item.controller.signal.aborted ||
      item.sessionEpoch !== message.sessionEpoch ||
      !samePrivateAuthority(item.request.authority, message.authority) ||
      !samePrivateRange(item.request.range, message.range) ||
      !samePrivateIds(item.request.evidenceIds, message.evidenceIds) ||
      item.request.maxBytes !== message.maxBytes
    ) {
      cancelObservationTransfer(item);
      return;
    }
    let payloads: Awaited<ReturnType<ObservationTransferEvidenceResolver['resolve']>>;
    try {
      payloads = await item.request.evidenceResolver.resolve({
        authority: item.request.authority,
        range: item.request.range,
        evidenceIds: item.request.evidenceIds,
        allowedModalities: ['image'],
        signal: item.controller.signal,
      });
    } catch {
      cancelObservationTransfer(item);
      return;
    }
    if (
      pendingObservationTransfers.get(item.transferId) !== item ||
      item.controller.signal.aborted
    ) {
      cancelObservationTransfer(item);
      return;
    }
    const evidence: PrivateObservationEvidence[] = [];
    let totalBytes = 0;
    try {
      if (
        payloads === undefined ||
        payloads.length !== item.request.evidenceIds.length ||
        payloads.some(
          (payload, index) =>
            payload.modality !== 'image' || payload.evidenceId !== item.request.evidenceIds[index],
        )
      ) {
        throw new Error('invalid evidence');
      }
      for (const payload of payloads) {
        const copy = payload.data.slice();
        if (!(copy.buffer instanceof ArrayBuffer) || !payload.mimeType.startsWith('image/')) {
          throw new Error('invalid evidence');
        }
        totalBytes += copy.byteLength;
        if (copy.byteLength === 0 || totalBytes > item.request.maxBytes) {
          throw new Error('invalid evidence');
        }
        evidence.push({
          evidenceId: payload.evidenceId,
          mimeType: payload.mimeType,
          data: copy.buffer,
        });
      }
      const port = observationPort;
      if (port === undefined) throw new Error('missing private port');
      port.postMessage(
        {
          type: 'evidence',
          transferId: item.transferId,
          sessionEpoch: item.sessionEpoch,
          evidence,
        },
        evidence.map((payload) => payload.data),
      );
    } catch {
      for (const payload of evidence) {
        try {
          new Uint8Array(payload.data).fill(0);
        } catch {
          // A detached temporary buffer cannot be reused or rendered.
        }
      }
      cancelObservationTransfer(item);
    }
  };

  const receiveObservationPortMessage = (value: unknown): void => {
    if (!isPrivateObservationWorkerToMainMessage(value)) {
      closeObservationPort(
        new Error('JOY Agent private observation channel rejected invalid data'),
      );
      return;
    }
    if (value.type === 'session-ready') {
      observationSessionEpoch = value.sessionEpoch;
      return;
    }
    if (value.type === 'lease-registered' || value.type === 'lease-rejected') {
      const pendingLease = pendingObservationLeases.get(value.requestId);
      if (pendingLease === undefined) return;
      pendingObservationLeases.delete(value.requestId);
      clearTimeout(pendingLease.timer);
      if (
        observationSessionEpoch === undefined ||
        value.sessionEpoch !== observationSessionEpoch ||
        value.type === 'lease-rejected'
      ) {
        pendingLease.resolve(undefined);
        return;
      }
      pendingLease.resolve(
        Object.freeze({ leaseId: value.leaseId, expiresAtMs: value.expiresAtMs }),
      );
      return;
    }
    if (value.type === 'need-evidence') {
      const item = pendingObservationTransfers.get(value.transferId);
      if (item === undefined) return;
      void replyWithPrivateEvidence(item, value);
      return;
    }
    const item = pendingObservationTransfers.get(value.transferId);
    if (item === undefined || item.sessionEpoch !== value.sessionEpoch) return;
    settleObservationTransfer(item, value.result);
  };

  const bindObservationPort = (target: Worker, expectedGeneration: number): void => {
    if (typeof MessageChannel !== 'function') return;
    let channel: MessageChannel;
    try {
      channel = new MessageChannel();
      observationPort = channel.port1;
      observationPort.onmessage = (event: MessageEvent<unknown>) => {
        if (expectedGeneration !== generation || observationPort !== channel.port1) return;
        receiveObservationPortMessage(event.data);
      };
      observationPort.start();
      target.postMessage(createPrivateObservationPortBind(expectedGeneration + 1), [channel.port2]);
    } catch {
      try {
        observationPort?.close();
      } catch {
        // The private port remains unavailable; no public fallback exists.
      }
      observationPort = undefined;
    }
  };

  const failProtocolMismatch = (): void => {
    const error = new Error(RELOAD_RECONNECT_MESSAGE);
    closeObservationPort(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    if (pendingMediaProbe !== undefined) {
      clearTimeout(pendingMediaProbe.timer);
      pendingMediaProbe.reject(error);
      pendingMediaProbe = undefined;
    }
    for (const queue of [...runQueues.values()]) failQueue(queue, error);
    generation += 1;
    worker?.terminate();
    worker = undefined;
    configured = false;
    latestStatus = undefined;
    latestMediaCapabilities = undefined;
  };

  const ensureWorker = (): Worker => {
    if (worker !== undefined) return worker;
    worker =
      workerFactory?.() ??
      new Worker(new URL('./engine.worker.ts', import.meta.url), {
        type: 'module',
        name: 'joy-agent-engine',
      });
    const expectedGeneration = generation;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (expectedGeneration !== generation) return;
      if (!isWorkerToMainMessage(event.data)) {
        failProtocolMismatch();
        return;
      }
      const message = event.data;
      if (message.type === 'configured' || message.type === 'test-result') {
        const key = message.type === 'configured' ? 'configure' : 'test';
        const item = pending.get(key);
        if (item !== undefined) {
          pending.delete(key);
          clearTimeout(item.timer);
          latestStatus = message.status;
          item.resolve(message.status);
        }
        return;
      }
      if (message.type === 'media-capability-result') {
        const item = pendingMediaProbe;
        if (item === undefined || item.requestId !== message.requestId) return;
        pendingMediaProbe = undefined;
        clearTimeout(item.timer);
        latestMediaCapabilities = message.report;
        item.resolve(message.report);
        return;
      }
      if (message.type === 'host-rpc') {
        const nested = message.message;
        if (nested.type !== 'host-rpc-request' && nested.type !== 'host-rpc-cancel') return;
        const queue = queueFor(nested.runId, nested.runEpoch);
        if (
          queue === undefined ||
          queue.done ||
          queue.run.epoch !== nested.runEpoch ||
          queue.host === undefined
        )
          return;
        if (nested.type === 'host-rpc-cancel') queue.host.cancelRun(queue.run);
        else queue.host.receive(nested);
        return;
      }
      if (message.type === 'event') {
        const queue = queueFor(message.event.runId, message.event.runEpoch);
        if (
          queue === undefined ||
          queue.done ||
          queue.run.epoch !== message.event.runEpoch ||
          message.event.seq <= queue.lastSeq
        )
          return;
        queue.lastSeq = message.event.seq;
        if (message.event.proposal !== undefined) queue.keepHostUntilCancel = true;
        const terminal =
          message.event.phase === 'completed' ||
          message.event.phase === 'failed' ||
          message.event.phase === 'cancelled';
        const waiter = queue.waiters.shift();
        if (waiter !== undefined) waiter.resolve({ value: message.event, done: false });
        else queue.events.push(message.event);
        if (terminal) finishQueue(queue, { cancelled: message.event.phase !== 'completed' });
        return;
      }
      if (message.type === 'run-finished') {
        const queue = queueFor(message.runId, message.runEpoch);
        if (queue !== undefined) finishQueue(queue, { cancelled: false });
        return;
      }
      if (message.type === 'error') {
        if (message.code === 'JOY_AGENT_PROTOCOL_MISMATCH') {
          failProtocolMismatch();
          return;
        }
        if (pendingMediaProbe !== undefined && message.requestId === pendingMediaProbe.requestId) {
          const item = pendingMediaProbe;
          pendingMediaProbe = undefined;
          clearTimeout(item.timer);
          // Even a protocol-safe Worker error must not become a channel for a
          // provider body, endpoint, credential, prompt, or synthetic media.
          item.reject(new Error('Media capability probe unavailable'));
          return;
        }
        const key = message.requestId === 'test' ? 'test' : 'configure';
        const item = pending.get(key);
        if (item !== undefined) {
          pending.delete(key);
          clearTimeout(item.timer);
          item.reject(new Error(message.message));
        }
        if (message.requestId !== undefined) {
          const activeQueueKey = activeQueueKeysByRunId.get(message.requestId);
          const queue = activeQueueKey === undefined ? undefined : runQueues.get(activeQueueKey);
          if (queue !== undefined) failQueue(queue, new Error(message.message));
        }
      }
    };
    worker.onerror = () => {
      const error = new Error('JOY Agent Worker failed');
      closeObservationPort(error);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
      if (pendingMediaProbe !== undefined) {
        clearTimeout(pendingMediaProbe.timer);
        pendingMediaProbe.reject(error);
        pendingMediaProbe = undefined;
      }
      for (const queue of [...runQueues.values()]) failQueue(queue, error);
      generation += 1;
      worker?.terminate();
      worker = undefined;
      configured = false;
      latestStatus = undefined;
      latestMediaCapabilities = undefined;
    };
    bindObservationPort(worker, expectedGeneration);
    return worker;
  };

  const requestStatus = (
    type: 'configure' | 'test',
    message: Record<string, unknown>,
  ): Promise<ByokSessionStatus> =>
    new Promise<ByokSessionStatus>((resolve, reject) => {
      const previous = pending.get(type);
      if (previous !== undefined) {
        clearTimeout(previous.timer);
        previous.reject(new Error('JOY Agent connection request was superseded'));
      }
      const timer = setTimeout(() => {
        const item = pending.get(type);
        if (item === undefined) return;
        pending.delete(type);
        item.reject(new Error(RELOAD_RECONNECT_MESSAGE));
        failProtocolMismatch();
      }, STATUS_TIMEOUT_MS);
      pending.set(type, { resolve, reject, timer });
      ensureWorker().postMessage({ protocolVersion: JOY_AGENT_PROTOCOL_VERSION, type, ...message });
    });

  const requestMediaCapabilities = (): Promise<JoyAgentMediaCapabilityReport> =>
    new Promise<JoyAgentMediaCapabilityReport>((resolve, reject) => {
      if (pendingMediaProbe !== undefined) {
        reject(new Error('A media capability probe is already running'));
        return;
      }
      const requestId = `media-probe-${++nextMediaProbeId}`;
      const timer = setTimeout(() => {
        const item = pendingMediaProbe;
        if (item === undefined || item.requestId !== requestId) return;
        pendingMediaProbe = undefined;
        item.reject(new Error(RELOAD_RECONNECT_MESSAGE));
        failProtocolMismatch();
      }, STATUS_TIMEOUT_MS);
      pendingMediaProbe = { requestId, resolve, reject, timer };
      ensureWorker().postMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'probe-media-capabilities',
        requestId,
      });
    });

  const clear = (): void => {
    closeObservationPort();
    generation += 1;
    worker?.terminate();
    worker = undefined;
    configured = false;
    latestStatus = undefined;
    latestMediaCapabilities = undefined;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('JOY Agent connection cleared'));
    }
    pending.clear();
    if (pendingMediaProbe !== undefined) {
      clearTimeout(pendingMediaProbe.timer);
      pendingMediaProbe.reject(new Error('JOY Agent connection cleared'));
      pendingMediaProbe = undefined;
    }
    for (const queue of [...runQueues.values()]) {
      queue.done = true;
      queue.events.length = 0;
      disposeHost(queue, true);
      notifyConnectionCleared(queue);
      while (queue.waiters.length) queue.waiters.shift()!.resolve({ value: undefined, done: true });
    }
    runQueues.clear();
    activeQueueKeysByRunId.clear();
  };

  const cancelQueue = (queue: RunQueue): void => {
    if (!queue.done || queue.keepHostUntilCancel) {
      worker?.postMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'cancel',
        runId: queue.run.runId,
        runEpoch: queue.run.epoch,
      });
      disposeHost(queue, true);
      queue.done = true;
      queue.events.length = 0;
      while (queue.waiters.length) queue.waiters.shift()!.resolve({ value: undefined, done: true });
      removeQueue(queue);
    }
  };

  const registerObservationReviewLease = (
    input: JoyAgentObservationReviewLeaseRequest,
  ): Promise<JoyAgentObservationReviewLease | undefined> => {
    const port = observationPort;
    const sessionEpoch = observationSessionEpoch;
    const now = Date.now();
    if (
      !configured ||
      port === undefined ||
      sessionEpoch === undefined ||
      input.expiresAtMs <= now ||
      input.expiresAtMs - now > 5 * 60 * 1_000
    )
      return Promise.resolve(undefined);
    const requestId = `review-lease-${++nextObservationLeaseRequestId}`;
    return new Promise<JoyAgentObservationReviewLease | undefined>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          const pendingLease = pendingObservationLeases.get(requestId);
          if (pendingLease === undefined) return;
          pendingObservationLeases.delete(requestId);
          pendingLease.resolve(undefined);
        },
        Math.min(15_000, input.expiresAtMs - now),
      );
      const pendingLease: PendingObservationLease = { requestId, resolve, reject, timer };
      pendingObservationLeases.set(requestId, pendingLease);
      try {
        port.postMessage({
          type: 'register-review-lease',
          requestId,
          sessionEpoch,
          authority: input.authority,
          manifestId: input.manifestId,
          range: input.range,
          evidenceIds: input.evidenceIds,
          expiresAtMs: input.expiresAtMs,
        });
      } catch {
        pendingObservationLeases.delete(requestId);
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  };

  const sendApprovedImageObservation = (
    input: JoyAgentApprovedImageObservationRequest,
  ): Promise<PrivateObservationTransferResult> => {
    const port = observationPort;
    const sessionEpoch = observationSessionEpoch;
    const now = Date.now();
    if (
      !configured ||
      port === undefined ||
      sessionEpoch === undefined ||
      input.signal?.aborted === true
    )
      return Promise.resolve({
        ok: false,
        code: input.signal?.aborted === true ? 'cancelled' : 'capability-unavailable',
      });
    if (input.expiresAtMs <= now) return Promise.resolve({ ok: false, code: 'consent-denied' });
    if (
      input.evidenceResolver === undefined ||
      typeof input.evidenceResolver.resolve !== 'function' ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1
    )
      return Promise.resolve({ ok: false, code: 'invalid-request' });
    const transferId = `image-review-${++nextObservationTransferId}`;
    return new Promise<PrivateObservationTransferResult>((resolve, reject) => {
      // Declared ahead of the abort/timeout closures that capture it; the entry
      // object is only constructed once those handlers exist.
      // eslint-disable-next-line prefer-const
      let item: PendingObservationTransfer | undefined;
      const abort = () => {
        if (item !== undefined) cancelObservationTransfer(item);
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      const unlinkAbort = () => input.signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        if (item !== undefined) cancelObservationTransfer(item);
      }, input.expiresAtMs - now);
      item = {
        transferId,
        sessionEpoch,
        request: input,
        controller: new AbortController(),
        resolve,
        reject,
        timer,
        unlinkAbort,
      };
      pendingObservationTransfers.set(transferId, item);
      try {
        port.postMessage({
          type: 'start',
          transferId,
          sessionEpoch,
          leaseId: input.leaseId,
          authority: input.authority,
          range: input.range,
          evidenceIds: input.evidenceIds,
          maxBytes: input.maxBytes,
          expiresAtMs: input.expiresAtMs,
          prompt: input.prompt,
        });
      } catch {
        cancelObservationTransfer(item);
      }
    });
  };

  return {
    async configure(next) {
      if (isDualBrainConfig(next)) {
        throw new Error('Single worker engine client cannot configure dual-brain directly');
      }
      const safe = normalizeByokSessionConfig(next);
      clear();
      latestStatus = { provider: safe.provider, modelId: safe.modelId, capability: 'untested' };
      const result = await requestStatus('configure', { config: safe });
      configured = true;
      return result;
    },
    testConnection() {
      if (!configured) return Promise.reject(new Error('Configure a model connection first'));
      return requestStatus('test', {});
    },
    probeMediaCapabilities() {
      if (!configured) return Promise.reject(new Error('Configure a model connection first'));
      return requestMediaCapabilities();
    },
    startRun(request, runHost, lifecycleHooks) {
      if (!configured) throw new Error('Configure a model connection first');
      const activeQueueKey = activeQueueKeysByRunId.get(request.runId);
      if (activeQueueKey !== undefined && runQueues.has(activeQueueKey))
        throw new Error('JOY run is already active');
      if (activeQueueKey !== undefined) activeQueueKeysByRunId.delete(request.runId);
      const structured = isStructuredRun(request);
      if (structured && runHost === undefined)
        throw new Error('Structured JOY runs require a trusted main-thread host');
      const epoch = (latestEpochByRunId.get(request.runId) ?? 0) + 1;
      latestEpochByRunId.set(request.runId, epoch);
      const run = Object.freeze({ runId: request.runId, epoch });
      const workerRequest: JoyAgentRunRequest = {
        runId: request.runId,
        runEpoch: epoch,
        prompt: request.prompt,
        ...(request.taskKind === undefined ? {} : { taskKind: request.taskKind }),
        ...(request.baseRevision === undefined ? {} : { baseRevision: request.baseRevision }),
        ...(request.mode === undefined ? {} : { mode: request.mode }),
        ...(structured && runHost?.allowedToolNames !== undefined
          ? { allowedToolNames: [...runHost.allowedToolNames] }
          : {}),
        ...(!structured && request.context !== undefined ? { context: request.context } : {}),
      };
      const queue: RunQueue = {
        run,
        events: [],
        waiters: [],
        done: false,
        lastSeq: -1,
        keepHostUntilCancel: false,
        hostDisposed: false,
      };
      if (lifecycleHooks?.onConnectionCleared !== undefined)
        queue.onConnectionCleared = lifecycleHooks.onConnectionCleared;
      if (runHost !== undefined) {
        if (runHost.onCancelled !== undefined) queue.onCancelled = runHost.onCancelled;
        queue.host = createHostRpcHost({
          methods: runHost.methods,
          transport: {
            postMessage(message): void {
              const current = queueFor(run.runId, run.epoch);
              if (current !== queue || current.done) return;
              worker?.postMessage({
                protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
                type: 'host-rpc',
                message,
              });
            },
          },
        });
      }
      const queueKey = runQueueKey(run);
      runQueues.set(queueKey, queue);
      activeQueueKeysByRunId.set(run.runId, queueKey);
      ensureWorker().postMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'run',
        request: workerRequest,
      });
      const iterator: JoyAgentRunIterator = {
        run,
        [Symbol.asyncIterator]() {
          return this;
        },
        next: async (): Promise<IteratorResult<JoyAgentSafeEvent>> => {
          if (queue.events.length > 0) return { value: queue.events.shift()!, done: false };
          if (queue.error !== undefined) throw queue.error;
          if (queue.done) return { value: undefined, done: true };
          return new Promise<IteratorResult<JoyAgentSafeEvent>>((resolve, reject) =>
            queue.waiters.push({ resolve, reject }),
          );
        },
        return: async (): Promise<IteratorResult<JoyAgentSafeEvent>> => {
          cancelQueue(queue);
          return { value: undefined, done: true };
        },
      };
      return Object.freeze(iterator);
    },
    async cancel(runId) {
      const activeQueueKey = activeQueueKeysByRunId.get(runId);
      const queue = activeQueueKey === undefined ? undefined : runQueues.get(activeQueueKey);
      if (queue !== undefined) cancelQueue(queue);
    },
    clear,
    dispose: clear,
    getStatus: () => latestStatus,
    getMediaCapabilities: () => latestMediaCapabilities,
    registerObservationReviewLease,
    sendApprovedImageObservation,
  };
}

/**
 * Main-thread Intelligent Agent Dispatcher & Dual-Brain Runtime.
 * Manages Model 1 (Workhorse / Router) for text, cuts, trims, ripple, labeling, tool orchestration,
 * and Model 2 (Creative / Visual Brain) for frames, scene description, Living Looks color grading.
 * Automatically dispatches tasks based on taskKind and prompt intent with automatic fallback.
 */
export function createJoyAgentEngineClient(workerFactory?: () => Worker): JoyAgentEngineClient {
  let singleClient: JoyAgentEngineClient | undefined;
  let workhorseClient: JoyAgentEngineClient | undefined;
  let creativeClient: JoyAgentEngineClient | undefined;
  let dualBrainConfig: DualBrainConfig | undefined;
  let currentStatus: ByokSessionStatus | undefined;

  const ensureSingleClient = (): JoyAgentEngineClient => {
    if (!singleClient) {
      singleClient = createSingleWorkerEngineClient(workerFactory);
    }
    return singleClient;
  };

  const clearClients = () => {
    singleClient?.clear();
    singleClient?.dispose();
    singleClient = undefined;
    workhorseClient?.clear();
    workhorseClient?.dispose();
    workhorseClient = undefined;
    creativeClient?.clear();
    creativeClient?.dispose();
    creativeClient = undefined;
    dualBrainConfig = undefined;
    currentStatus = undefined;
  };

  return {
    async configure(config: ByokSessionConfig | DualBrainConfig): Promise<ByokSessionStatus> {
      clearClients();

      if (isDualBrainConfig(config)) {
        dualBrainConfig = config;
        workhorseClient = createSingleWorkerEngineClient(workerFactory);
        creativeClient = createSingleWorkerEngineClient(workerFactory);

        const [wStatus, cStatus] = await Promise.all([
          workhorseClient.configure(config.workhorse),
          creativeClient.configure(config.creative),
        ]);

        const capability =
          wStatus.capability === 'tool-loop' || cStatus.capability === 'tool-loop'
            ? 'tool-loop'
            : wStatus.capability;

        currentStatus = {
          provider: 'dual-brain',
          modelId: `${config.workhorse.modelId} + ${config.creative.modelId}`,
          capability,
          message: `Workhorse (${config.workhorse.modelId}): ${wStatus.capability} | Creative (${config.creative.modelId}): ${cStatus.capability}`,
          dualBrain: {
            workhorse: wStatus,
            creative: cStatus,
          },
        };
        return currentStatus;
      }

      const client = ensureSingleClient();
      currentStatus = await client.configure(config);
      return currentStatus;
    },

    async testConnection(): Promise<ByokSessionStatus> {
      if (dualBrainConfig && workhorseClient && creativeClient) {
        const [wStatus, cStatus] = await Promise.all([
          workhorseClient.testConnection(),
          creativeClient.testConnection(),
        ]);

        const capability =
          wStatus.capability === 'tool-loop' || cStatus.capability === 'tool-loop'
            ? 'tool-loop'
            : wStatus.capability;

        currentStatus = {
          provider: 'dual-brain',
          modelId: `${dualBrainConfig.workhorse.modelId} + ${dualBrainConfig.creative.modelId}`,
          capability,
          message: `Workhorse (${dualBrainConfig.workhorse.modelId}): ${wStatus.capability} | Creative (${dualBrainConfig.creative.modelId}): ${cStatus.capability}`,
          dualBrain: {
            workhorse: wStatus,
            creative: cStatus,
          },
        };
        return currentStatus;
      }
      if (!singleClient) throw new Error('Configure a model connection first');
      currentStatus = await singleClient.testConnection();
      return currentStatus;
    },

    async probeMediaCapabilities(): Promise<JoyAgentMediaCapabilityReport> {
      if (dualBrainConfig && creativeClient) {
        try {
          return await creativeClient.probeMediaCapabilities();
        } catch {
          if (workhorseClient) return await workhorseClient.probeMediaCapabilities();
          throw new Error('Media capability probe failed across dual-brain runtime');
        }
      }
      if (!singleClient) throw new Error('Configure a model connection first');
      return singleClient.probeMediaCapabilities();
    },

    startRun(request, runHost, lifecycleHooks): JoyAgentRunIterator {
      if (dualBrainConfig && workhorseClient && creativeClient) {
        const isCreativeTask =
          request.taskKind === 'color' ||
          request.taskKind === 'effects' ||
          request.taskKind === 'filters' ||
          request.taskKind === 'motion' ||
          request.taskKind === 'camera' ||
          request.taskKind === '3d' ||
          request.taskKind === 'creative-brief' ||
          request.taskKind === 'asset-edit' ||
          /\b(look|grade|color|visual|filter|aesthetic|style|palette|camera|lens|frame)\b/i.test(
            request.prompt,
          );

        const primary = isCreativeTask ? creativeClient : workhorseClient;
        const fallback = isCreativeTask ? workhorseClient : creativeClient;

        try {
          return primary.startRun(request, runHost, lifecycleHooks);
        } catch {
          return fallback.startRun(request, runHost, lifecycleHooks);
        }
      }

      if (!singleClient) throw new Error('Configure a model connection first');
      return singleClient.startRun(request, runHost, lifecycleHooks);
    },

    async cancel(runId: string): Promise<void> {
      if (dualBrainConfig) {
        await Promise.allSettled([
          workhorseClient?.cancel(runId),
          creativeClient?.cancel(runId),
        ]);
        return;
      }
      await singleClient?.cancel(runId);
    },

    clear(): void {
      clearClients();
    },

    dispose(): void {
      clearClients();
    },

    getStatus(): ByokSessionStatus | undefined {
      return currentStatus ?? singleClient?.getStatus();
    },

    getMediaCapabilities(): JoyAgentMediaCapabilityReport | undefined {
      if (dualBrainConfig) {
        return creativeClient?.getMediaCapabilities() ?? workhorseClient?.getMediaCapabilities();
      }
      return singleClient?.getMediaCapabilities();
    },

    registerObservationReviewLease(
      input: JoyAgentObservationReviewLeaseRequest,
    ): Promise<JoyAgentObservationReviewLease | undefined> {
      if (dualBrainConfig && creativeClient) {
        return creativeClient.registerObservationReviewLease(input);
      }
      if (!singleClient) return Promise.resolve(undefined);
      return singleClient.registerObservationReviewLease(input);
    },

    sendApprovedImageObservation(
      input: JoyAgentApprovedImageObservationRequest,
    ): Promise<PrivateObservationTransferResult> {
      if (dualBrainConfig && creativeClient) {
        return creativeClient.sendApprovedImageObservation(input);
      }
      if (!singleClient) {
        return Promise.resolve({ ok: false, code: 'capability-unavailable' });
      }
      return singleClient.sendApprovedImageObservation(input);
    },

    getDualBrainConfig(): DualBrainConfig | undefined {
      return dualBrainConfig;
    },
  };
}
