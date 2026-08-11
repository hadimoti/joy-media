import { describe, expect, it, vi } from 'vitest';
import { PlaybackOperationGate, playMediaWhenCurrent } from './playback-operation.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('PlaybackOperationGate', () => {
  it('does not start media after Space paused a pending load', async () => {
    const gate = new PlaybackOperationGate();
    const staleEpoch = gate.begin(true);
    gate.begin(false);
    const play = vi.fn(async () => undefined);

    await expect(playMediaWhenCurrent(gate, staleEpoch, play, vi.fn())).resolves.toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('re-pauses when Space wins while video.play is pending', async () => {
    const gate = new PlaybackOperationGate();
    const epoch = gate.begin(true);
    const pending = deferred();
    const pause = vi.fn();
    const result = playMediaWhenCurrent(gate, epoch, () => pending.promise, pause);

    gate.begin(false);
    pending.resolve();

    await expect(result).resolves.toBe(false);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('does not let an old completion pause a newer Play operation', async () => {
    const gate = new PlaybackOperationGate();
    const oldEpoch = gate.begin(true);
    const pending = deferred();
    const pause = vi.fn();
    const result = playMediaWhenCurrent(gate, oldEpoch, () => pending.promise, pause);

    gate.begin(true);
    pending.resolve();

    await expect(result).resolves.toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });
});
