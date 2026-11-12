import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectFolderClient,
  type ProjectFolderWorkerData,
} from './project-folder-client.js';

/**
 * A worker stand-in. `respond` decides the reply to each message: a value to send back, or undefined for silence.
 * A shutdown message makes the fake exit, as the real worker does once it has closed the registry.
 */
class FakeWorker extends EventEmitter {
  readonly sent: { id: number; op: string; payload: unknown }[] = [];

  constructor(
    private readonly respond: (message: { id: number; op: string; payload: unknown }) => unknown,
  ) {
    super();
  }

  postMessage(message: { id: number; op: string; payload: unknown }): void {
    this.sent.push(message);
    if (message.op === 'shutdown') {
      queueMicrotask(() => this.emit('exit', 0));
      return;
    }
    const reply = this.respond(message);
    if (reply !== undefined) queueMicrotask(() => this.emit('message', reply));
  }

  terminate(): Promise<number> {
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

function clientWith(
  workers: FakeWorker[],
  respond: (message: { id: number; op: string; payload: unknown }) => unknown,
  timeoutMs = 1000,
  started: { readonly data: ProjectFolderWorkerData[] } = { data: [] },
) {
  const startWorker = vi.fn((_file: string, data: ProjectFolderWorkerData) => {
    started.data.push(data);
    const worker = new FakeWorker(respond);
    workers.push(worker);
    return worker as unknown as Worker;
  });
  const client = createProjectFolderClient({
    workerFile: 'C:/app/dist/main/project-folder-worker.js',
    registryPath: 'C:/app/userData/project-claims.sqlite',
    directory: 'C:/Users/me/Documents/JOY Projects',
    timeoutMs,
    startWorker,
  });
  return { client, startWorker };
}

describe('the project-folder client', () => {
  it('refuses a request that arrives during shutdown, and starts no new worker for it', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, (message) => ({
      id: message.id,
      ok: true,
      value: { kind: 'listed', folders: [] },
    }));
    await client.request('list', {});
    await client.shutdown({ final: true });

    await expect(client.request('list', {})).rejects.toThrow('The project folder worker stopped');
    expect(startWorker).toHaveBeenCalledTimes(1);
  });

  it('starts the worker with the registry and the folder, and resolves a request with its reply', async () => {
    const workers: FakeWorker[] = [];
    const started = { data: [] as ProjectFolderWorkerData[] };
    const { client, startWorker } = clientWith(
      workers,
      (message) => ({ id: message.id, ok: true, value: { kind: 'listed', folders: [] } }),
      1000,
      started,
    );

    await expect(client.request('list', {})).resolves.toEqual({ kind: 'listed', folders: [] });
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(started.data).toEqual([
      {
        registryPath: 'C:/app/userData/project-claims.sqlite',
        directory: 'C:/Users/me/Documents/JOY Projects',
      },
    ]);
    expect(workers[0]?.sent).toEqual([{ id: 1, op: 'list', payload: {} }]);
    await client.shutdown();
  });

  it('rejects a request with the worker refusal text, and keeps the worker for the next request', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, (message) =>
      message.op === 'create'
        ? { id: message.id, ok: false, error: 'Invalid project folder request' }
        : { id: message.id, ok: true, value: { kind: 'listed', folders: [] } },
    );

    await expect(client.request('create', { title: '' })).rejects.toThrow(
      'Invalid project folder request',
    );
    await expect(client.request('list', {})).resolves.toEqual({ kind: 'listed', folders: [] });
    expect(startWorker).toHaveBeenCalledTimes(1);
    await client.shutdown();
  });

  it('refuses a request that gets no reply in time', async () => {
    const workers: FakeWorker[] = [];
    const { client } = clientWith(workers, () => undefined, 20);
    await expect(client.request('open', { key: 'folder-1' })).rejects.toThrow(
      'The project folder check took too long',
    );
    await client.shutdown();
  });

  it('fails the requests waiting on a worker that stops, and starts a new worker for the next one', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, (message) =>
      workers.length === 1
        ? undefined
        : { id: message.id, ok: true, value: { kind: 'listed', folders: [] } },
    );

    const waiting = client.request('list', {});
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    workers[0]?.emit('exit', 1);
    await expect(waiting).rejects.toThrow('The project folder worker stopped');

    await expect(client.request('list', {})).resolves.toEqual({ kind: 'listed', folders: [] });
    expect(startWorker).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('ignores a reply to a request that already timed out', async () => {
    const workers: FakeWorker[] = [];
    const { client } = clientWith(workers, () => undefined, 20);
    await expect(client.request('list', {})).rejects.toThrow('took too long');
    workers[0]?.emit('message', { id: 1, ok: true, value: 'late' });
    await client.shutdown();
  });

  it('shuts the worker down, waits for it to exit, and starts a new one for a later request', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, (message) => ({
      id: message.id,
      ok: true,
      value: { kind: 'listed', folders: [] },
    }));

    await client.request('list', {});
    await client.shutdown();
    expect(workers[0]?.sent.map((message) => message.op)).toEqual(['list', 'shutdown']);

    await expect(client.request('list', {})).resolves.toEqual({ kind: 'listed', folders: [] });
    expect(startWorker).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('lets a late exit from a replaced worker leave its replacement’s requests alone', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, (message) =>
      workers.length === 1
        ? undefined
        : { id: message.id, ok: true, value: { kind: 'listed', folders: [] } },
    );

    const first = client.request('list', {}).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    workers[0]?.emit('exit', 1);
    await expect(first).resolves.toBe('The project folder worker stopped');

    const second = client.request('list', {});
    await vi.waitFor(() => expect(workers[1]?.sent).toHaveLength(1));
    // A second exit report from the first worker arrives while the second one is working.
    workers[0]?.emit('exit', 1);
    await expect(second).resolves.toEqual({ kind: 'listed', folders: [] });
    expect(startWorker).toHaveBeenCalledTimes(2);
    await client.shutdown();
  });

  it('does nothing on shutdown when no worker was started', async () => {
    const workers: FakeWorker[] = [];
    const { client, startWorker } = clientWith(workers, () => undefined);
    await client.shutdown();
    expect(startWorker).not.toHaveBeenCalled();
  });
});

describe('the project-folder requests run off the main thread (condition (q))', () => {
  it('keeps the main thread running while the worker is busy with a slow check', async () => {
    // A real worker thread that blocks itself for 400 ms on each request, as a slow Windows volume check would.
    const code = `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', (message) => {
        if (message.op === 'shutdown') { process.exit(0); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        parentPort.postMessage({ id: message.id, ok: true, value: { kind: 'listed', folders: [] } });
      });
    `;
    const client = createProjectFolderClient({
      workerFile: 'unused.js',
      registryPath: 'unused.sqlite',
      directory: 'unused',
      timeoutMs: 10_000,
      startWorker: (_file, data) => new Worker(code, { eval: true, workerData: data }),
    });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await expect(client.request('list', {})).resolves.toEqual({ kind: 'listed', folders: [] });
    } finally {
      clearInterval(timer);
      await client.shutdown({ final: true });
    }
    // Had the 400 ms block run on this thread, no timer could have fired before the reply.
    expect(ticks).toBeGreaterThanOrEqual(15);
  });
});
