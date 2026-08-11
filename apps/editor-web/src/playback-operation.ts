/**
 * Owns the latest transport intent while asynchronous media work is in flight.
 * A completed operation may affect playback only while its epoch is current.
 */
export class PlaybackOperationGate {
  private epoch = 0;
  private playIntent = false;

  begin(play: boolean): number {
    this.playIntent = play;
    this.epoch += 1;
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  get intendsToPlay(): boolean {
    return this.playIntent;
  }
}

/**
 * Starts media only for the current transport operation. If Space pauses while
 * play() is pending, the stale completion is put back into the paused state.
 * A newer Play operation is never paused by an older completion.
 */
export async function playMediaWhenCurrent(
  gate: PlaybackOperationGate,
  epoch: number,
  play: () => Promise<void>,
  pause: () => void,
): Promise<boolean> {
  if (!gate.isCurrent(epoch)) return false;
  await play();
  if (gate.isCurrent(epoch)) return true;
  if (!gate.intendsToPlay) pause();
  return false;
}
