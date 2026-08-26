import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  terminateWorkerProcessTree,
  verifyWorkerIntegrity,
  WorkerController,
} from './lifecycle.js';

function fakeChild(): EventEmitter & {
  pid: number;
  kill: () => boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: () => boolean;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 4321;
  child.kill = () => {
    child.emit('exit', 0, null);
    return true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('worker lifecycle', () => {
  it('refuses startup when the API URL is missing, before spawning a Worker', async () => {
    const controller = new WorkerController({
      config: {
        apiUrl: '',
        ffmpegPath: 'C:\\missing\\ffmpeg.exe',
        ffprobePath: 'C:\\missing\\ffprobe.exe',
      },
      userDataPath: 'C:\\joy-media-test',
      platform: 'win32',
    });
    expect(controller.status().state).toBe('stopped');
    const status = await controller.start();
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/API URL is required/);
  });

  it('refuses startup when required media tools are unavailable', async () => {
    const controller = new WorkerController({
      config: {
        apiUrl: 'https://media.example.test',
        ffmpegPath: 'C:\\missing\\ffmpeg.exe',
        ffprobePath: 'C:\\missing\\ffprobe.exe',
      },
      userDataPath: 'C:\\joy-media-test',
      platform: 'win32',
    });
    const status = await controller.start();
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/FFmpeg and ffprobe/);
  });

  it('terminates the entire Windows Worker process tree', async () => {
    const child = fakeChild();
    const taskkill = vi.fn(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit('exit', 0));
      return killer;
    });
    await terminateWorkerProcessTree(child as never, 'win32', taskkill as never);
    expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false,
    });
  });

  it('fails closed when the packaged Worker integrity digest does not match', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-desktop-integrity-'));
    const worker = join(directory, 'worker.js');
    const manifest = join(directory, 'worker-integrity.json');
    writeFileSync(worker, 'console.log("worker");');
    writeFileSync(
      manifest,
      JSON.stringify({ algorithm: 'sha256', file: 'worker.js', sha256: '0'.repeat(64) }),
    );
    expect(() => verifyWorkerIntegrity(worker, manifest)).toThrow(/integrity verification failed/);
  });

  it('preserves the existing Worker state default unless an explicit path is configured', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-desktop-state-'));
    const worker = join(directory, 'worker.js');
    writeFileSync(worker, 'console.log("worker");');
    const child = fakeChild();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const controller = new WorkerController({
      config: { apiUrl: 'https://media.example.test' },
      userDataPath: directory,
      workerEntry: worker,
      platform: 'win32',
      discoverMediaTools: () => ({
        ready: true,
        ffmpegPath: 'ffmpeg.exe',
        ffprobePath: 'ffprobe.exe',
      }),
      spawnWorker: ((
        _file: string,
        _args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        spawnedEnv = options.env;
        return child as never;
      }) as never,
      terminateProcessTree: async () => {
        child.emit('exit', 0, null);
      },
    });
    const previous = process.env.JOY_MEDIA_WORKER_STATE_PATH;
    process.env.JOY_MEDIA_WORKER_STATE_PATH = 'existing-worker-default.json';
    try {
      await controller.start();
      expect(spawnedEnv?.JOY_MEDIA_WORKER_STATE_PATH).toBe('existing-worker-default.json');
      await controller.dispose();
    } finally {
      if (previous === undefined) delete process.env.JOY_MEDIA_WORKER_STATE_PATH;
      else process.env.JOY_MEDIA_WORKER_STATE_PATH = previous;
    }
  });

  it('waits for disposal while bounding a stuck Worker shutdown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'joy-desktop-shutdown-'));
    const worker = join(directory, 'worker.js');
    writeFileSync(worker, 'console.log("worker");');
    const child = fakeChild();
    const controller = new WorkerController({
      config: { apiUrl: 'https://media.example.test' },
      userDataPath: directory,
      workerEntry: worker,
      platform: 'win32',
      shutdownTimeoutMs: 10,
      discoverMediaTools: () => ({
        ready: true,
        ffmpegPath: 'ffmpeg.exe',
        ffprobePath: 'ffprobe.exe',
      }),
      spawnWorker: ((_file: string, _args: readonly string[], _options: unknown) =>
        child as never) as never,
      terminateProcessTree: async () => undefined,
    });
    await controller.start();
    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(controller.status().state).toBe('stopped');
  });
});
