import { describe, expect, it, vi } from 'vitest';
import { createIpcHandlers, dispatchIpcRequest } from './ipc-handlers.js';
import { createFileRegistry } from './file-registry.js';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';

function deps() {
  const fileRegistry = createFileRegistry(() => 'ref-1');
  const workerSupervisor = createWorkerSupervisor({
    spawn: (): SupervisedChild => ({ once: () => {}, kill: () => true }),
    command: 'node',
    workerId: () => 'w-1',
  });
  const showOpenDialog = vi.fn(async () => ({ canceled: false, path: 'C:\\Media\\clip.mp4' }));
  return { fileRegistry, workerSupervisor, showOpenDialog };
}

describe('IPC dispatch', () => {
  it('rejects requests from an origin outside the allow-list before any handler runs', async () => {
    const d = deps();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://evil.example',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(false);
    expect(d.showOpenDialog).not.toHaveBeenCalled();
  });

  it('rejects an unknown channel even from an allowed origin', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.execute',
    });
    expect(result.ok).toBe(false);
  });

  it('select-file registers the chosen path and returns only the opaque ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.select-file',
    });
    expect(result).toEqual({
      ok: true,
      data: { kind: 'local-file', id: 'ref-1', displayName: 'clip.mp4' },
    });
  });

  it('request-derivative rejects a forged ref', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'http://localhost:5173',
      channel: 'desktop.request-derivative',
      payload: { ref: { kind: 'local-file', id: 'forged', displayName: 'x' }, kind: 'thumbnail' },
    });
    expect(result.ok).toBe(false);
  });

  it('worker-status reflects the supervisor state', async () => {
    const d = deps();
    d.workerSupervisor.start();
    const handlers = createIpcHandlers(d);
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.worker-status',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ connection: 'online', workerId: 'w-1', capabilities: [] });
  });

  it('startup-preference fails closed on garbage input and starts nothing', async () => {
    const handlers = createIpcHandlers(deps());
    const result = await dispatchIpcRequest(handlers, {
      origin: 'https://joyst.ir',
      channel: 'desktop.startup-preference',
      payload: 'not-a-real-preference',
    });
    expect(result).toEqual({ ok: true, data: 'leave-worker-alone' });
  });
});
