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
  startRun(request: JoyAgentRunRequest): AsyncIterable<JoyAgentSafeEvent>;
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
        if (!queue) return;
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
      } else if (message.type === 'error') {
        const request = pending.get(message.requestId ?? 'configure') ?? pending.get('test');
        if (request) {
          pending.delete(message.requestId ?? 'configure');
          request.reject(new Error(message.message));
        }
        const run = message.requestId ? runQueues.get(message.requestId) : undefined;
        if (run) run.done = true;
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
    pending.clear();
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
      const queue = { events: [], waiters: [], done: false };
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
      };
    },
    async cancel(runId) {
      worker?.postMessage({ protocolVersion: JOY_AGENT_PROTOCOL_VERSION, type: 'cancel', runId });
    },
    clear,
    dispose: clear,
    getStatus: () => latestStatus,
  };
}
