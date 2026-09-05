import {
  JOY_AGENT_PROTOCOL_VERSION,
  isWorkerToMainMessage,
  type ByokSessionConfig,
  type ByokSessionStatus,
  type JoyAgentRunRequest,
  type JoyAgentSafeEvent,
} from './protocol.js';
import { normalizeByokSessionConfig } from '@joy-media/joy-agent-engine';

export interface JoyAgentEngineClient {
  configure(config: ByokSessionConfig): Promise<ByokSessionStatus>;
  testConnection(): Promise<ByokSessionStatus>;
  startRun(request: JoyAgentRunRequest): AsyncIterableIterator<JoyAgentSafeEvent>;
  cancel(runId: string): Promise<void>;
  clear(): void;
  dispose(): void;
  getStatus(): ByokSessionStatus | undefined;
}

type Pending = { resolve: (value: ByokSessionStatus) => void; reject: (error: Error) => void };

export function createJoyAgentEngineClient(workerFactory?: () => Worker): JoyAgentEngineClient {
  let worker: Worker | undefined;
  let generation = 0;
  let configured = false;
  let latestStatus: ByokSessionStatus | undefined;
  const pending = new Map<string, Pending>();
  const runQueues = new Map<
    string,
    {
      events: JoyAgentSafeEvent[];
      waiters: ((result: IteratorResult<JoyAgentSafeEvent>) => void)[];
      done: boolean;
      lastSeq: number;
    }
  >();

  const ensureWorker = () => {
    if (worker !== undefined) return worker;
    worker =
      workerFactory?.() ??
      new Worker(new URL('./engine.worker.ts', import.meta.url), {
        type: 'module',
        name: 'joy-agent-engine',
      });
    const expectedGeneration = generation;
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (expectedGeneration !== generation || !isWorkerToMainMessage(event.data)) return;
      const message = event.data;
      if (message.type === 'configured' || message.type === 'test-result') {
        const key = message.type === 'configured' ? 'configure' : 'test';
        const request = pending.get(key);
        if (request) {
          pending.delete(key);
          latestStatus = message.status;
          request.resolve(message.status);
        }
      } else if (message.type === 'event') {
        const queue = runQueues.get(message.event.runId);
        if (!queue || queue.done) return;
        if (message.event.seq <= queue.lastSeq) return;
        queue.lastSeq = message.event.seq;
        if (
          message.event.phase === 'completed' ||
          message.event.phase === 'failed' ||
          message.event.phase === 'cancelled'
        )
          queue.done = true;
        const waiter = queue.waiters.shift();
        if (waiter) waiter({ value: message.event, done: false });
        else queue.events.push(message.event);
        if (queue.done && queue.waiters.length > 0)
          while (queue.waiters.length) queue.waiters.shift()!({ value: undefined, done: true });
        if (queue.done) runQueues.delete(message.event.runId);
      } else if (message.type === 'run-finished') {
        const queue = runQueues.get(message.runId);
        if (queue) {
          queue.done = true;
          while (queue.waiters.length) queue.waiters.shift()!({ value: undefined, done: true });
          runQueues.delete(message.runId);
        }
      } else if (message.type === 'error') {
        const key = pending.has(message.requestId ?? 'configure')
          ? (message.requestId ?? 'configure')
          : 'test';
        const request = pending.get(key);
        if (request) {
          pending.delete(key);
          request.reject(new Error(message.message));
        }
        const run = message.requestId ? runQueues.get(message.requestId) : undefined;
        if (run) {
          run.done = true;
          while (run.waiters.length) run.waiters.shift()!({ value: undefined, done: true });
          runQueues.delete(message.requestId!);
        }
      }
    };
    worker.onerror = () => {
      for (const item of pending.values()) item.reject(new Error('JOY Agent Worker failed'));
      pending.clear();
      clear();
    };
    return worker;
  };
  const requestStatus = (type: 'configure' | 'test', message: unknown) =>
    new Promise<ByokSessionStatus>((resolve, reject) => {
      pending.set(type, { resolve, reject });
      ensureWorker().postMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type,
        ...(message as object),
      });
    });
  const clear = () => {
    generation += 1;
    worker?.terminate();
    worker = undefined;
    configured = false;
    latestStatus = undefined;
    for (const request of pending.values())
      request.reject(new Error('JOY Agent connection cleared'));
    pending.clear();
    for (const queue of runQueues.values()) {
      queue.done = true;
      while (queue.waiters.length) queue.waiters.shift()!({ value: undefined, done: true });
    }
    runQueues.clear();
  };
  return {
    async configure(next) {
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
    startRun(request) {
      if (!configured) throw new Error('Configure a model connection first');
      if (runQueues.has(request.runId)) throw new Error('JOY run is already active');
      const queue: {
        events: JoyAgentSafeEvent[];
        waiters: ((result: IteratorResult<JoyAgentSafeEvent>) => void)[];
        done: boolean;
        lastSeq: number;
      } = { events: [], waiters: [], done: false, lastSeq: -1 };
      runQueues.set(request.runId, queue);
      ensureWorker().postMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'run',
        request,
      });
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: async () => {
          if (queue.events.length) return { value: queue.events.shift()!, done: false };
          if (queue.done) return { value: undefined, done: true };
          return new Promise<IteratorResult<JoyAgentSafeEvent>>((resolve) =>
            queue.waiters.push(resolve),
          );
        },
        return: async () => {
          queue.done = true;
          queue.events.length = 0;
          while (queue.waiters.length) queue.waiters.shift()!({ value: undefined, done: true });
          runQueues.delete(request.runId);
          worker?.postMessage({ protocolVersion: 1, type: 'cancel', runId: request.runId });
          return { value: undefined, done: true };
        },
      };
    },
    async cancel(runId) {
      worker?.postMessage({ protocolVersion: JOY_AGENT_PROTOCOL_VERSION, type: 'cancel', runId });
      const queue = runQueues.get(runId);
      if (queue) {
        queue.done = true;
        queue.events.length = 0;
        while (queue.waiters.length) queue.waiters.shift()!({ value: undefined, done: true });
        runQueues.delete(runId);
      }
    },
    clear,
    dispose: clear,
    getStatus: () => latestStatus,
  };
}
