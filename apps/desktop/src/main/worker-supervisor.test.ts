import { describe, expect, it, vi } from 'vitest';
import { createWorkerSupervisor } from './worker-supervisor.js';
import type { SupervisedChild } from './worker-supervisor.js';

function fakeChild(): {
  child: SupervisedChild;
  triggerExit: () => void;
  kill: ReturnType<typeof vi.fn>;
} {
  let exitListener: (() => void) | undefined;
  const kill = vi.fn();
  return {
    child: {
      once: (event, listener) => {
        if (event === 'exit') {
          exitListener = () =>
            (listener as (code: number | null, signal: string | null) => void)(1, null);
        }
      },
      kill: (signal?: NodeJS.Signals) => {
        kill(signal);
        return true;
      },
    },
    triggerExit: () => exitListener?.(),
    kill,
  };
}

describe('createWorkerSupervisor', () => {
  it('reports online with a workerId once spawned', () => {
    const { child } = fakeChild();
    const supervisor = createWorkerSupervisor({
      spawn: () => child,
      command: 'node',
      workerId: () => 'w-1',
    });
    supervisor.start();
    expect(supervisor.status()).toMatchObject({ connection: 'online', workerId: 'w-1' });
  });

  it('does not spawn a second child while one is already running', () => {
    const spawn = vi.fn(() => fakeChild().child);
    const supervisor = createWorkerSupervisor({ spawn, command: 'node' });
    supervisor.start();
    supervisor.start();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('restarts on an unexpected exit up to maxRestarts, then degrades', () => {
    let spawnCount = 0;
    let currentTrigger: (() => void) | undefined;
    const pendingRestarts: Array<() => void> = [];
    const supervisor = createWorkerSupervisor({
      spawn: () => {
        spawnCount += 1;
        const { child, triggerExit } = fakeChild();
        currentTrigger = triggerExit;
        return child;
      },
      command: 'node',
      maxRestarts: 2,
      scheduleRestart: (run) => pendingRestarts.push(run),
    });

    supervisor.start();
    expect(spawnCount).toBe(1);

    currentTrigger?.(); // crash #1: restarts 0 -> 1, scheduled
    expect(supervisor.status().connection).toBe('starting');
    pendingRestarts.shift()?.();
    expect(spawnCount).toBe(2);

    currentTrigger?.(); // crash #2: restarts 1 -> 2, scheduled
    pendingRestarts.shift()?.();
    expect(spawnCount).toBe(3);

    currentTrigger?.(); // crash #3: restarts already at maxRestarts -> degrade, no more spawns
    expect(supervisor.status().connection).toBe('degraded');
    expect(pendingRestarts).toHaveLength(0);
    expect(spawnCount).toBe(3);
  });

  it('marks the worker offline after an intentional stop', () => {
    const { child, triggerExit, kill } = fakeChild();
    const supervisor = createWorkerSupervisor({ spawn: () => child, command: 'node' });
    supervisor.start();
    supervisor.stop();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    triggerExit();
    expect(supervisor.status().connection).toBe('offline');
  });

  it('reports offline immediately if stop is called before start', () => {
    const supervisor = createWorkerSupervisor({ spawn: () => fakeChild().child, command: 'node' });
    supervisor.stop();
    expect(supervisor.status().connection).toBe('offline');
  });

  it('keeps the crash reason, and a manual retry starts a new attempt budget', () => {
    const exits: Array<(code: number | null, signal: string | null) => void> = [];
    let spawnCount = 0;
    const pendingRestarts: Array<() => void> = [];
    const supervisor = createWorkerSupervisor({
      spawn: () => {
        spawnCount += 1;
        return {
          once: (event, listener) => {
            if (event === 'exit')
              exits.push(listener as (code: number | null, signal: string | null) => void);
          },
          kill: () => true,
        };
      },
      command: 'node',
      maxRestarts: 1,
      scheduleRestart: (run) => pendingRestarts.push(run),
    });

    supervisor.start();
    exits[0]?.(1, null); // automatic attempt 1 is scheduled
    pendingRestarts.shift()?.();
    exits[1]?.(137, null); // no attempts left: degraded, and the reason is kept
    expect(supervisor.status()).toMatchObject({
      connection: 'degraded',
      lastError: 'Worker exited with code 137',
    });
    expect(pendingRestarts).toHaveLength(0);

    supervisor.start(); // the owner's manual retry
    expect(spawnCount).toBe(3);
    expect(supervisor.status().connection).toBe('online');
    expect(supervisor.status().lastError).toBeUndefined();
  });

  it('waits twice as long before each automatic attempt', () => {
    const delays: number[] = [];
    let currentExit: ((code: number | null, signal: string | null) => void) | undefined;
    const supervisor = createWorkerSupervisor({
      spawn: () => ({
        once: (event, listener) => {
          if (event === 'exit')
            currentExit = listener as (code: number | null, signal: string | null) => void;
        },
        kill: () => true,
      }),
      command: 'node',
      maxRestarts: 3,
      restartDelayMs: 1000,
      scheduleRestart: (run, delayMs) => {
        delays.push(delayMs);
        run();
      },
    });

    supervisor.start();
    currentExit?.(1, null);
    currentExit?.(1, null);
    currentExit?.(1, null);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(supervisor.status().connection).toBe('online');
  });

  it('lets a long healthy run start a new attempt budget', () => {
    let clock = Date.parse('2026-10-29T00:00:00.000Z');
    const exits: Array<(code: number | null, signal: string | null) => void> = [];
    const pendingRestarts: Array<() => void> = [];
    const supervisor = createWorkerSupervisor({
      spawn: () => ({
        once: (event, listener) => {
          if (event === 'exit')
            exits.push(listener as (code: number | null, signal: string | null) => void);
        },
        kill: () => true,
      }),
      command: 'node',
      maxRestarts: 1,
      stableRunMs: 60_000,
      now: () => new Date(clock).toISOString(),
      scheduleRestart: (run) => pendingRestarts.push(run),
    });

    supervisor.start();
    clock += 1_000;
    exits[0]?.(1, null); // a quick crash uses the only automatic attempt
    pendingRestarts.shift()?.();
    clock += 300_000; // the second run was healthy for five minutes
    exits[1]?.(1, null);
    expect(supervisor.status().connection).toBe('starting');
    expect(pendingRestarts).toHaveLength(1);
  });
});
