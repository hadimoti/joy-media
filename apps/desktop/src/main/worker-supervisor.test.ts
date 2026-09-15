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
        if (event === 'exit') exitListener = () => (listener as () => void)();
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
});
