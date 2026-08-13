/**
 * Shared transient edit controller for inspector-style property controls.
 *
 * Pointer movement updates only the in-memory preview. A durable history
 * command is created exactly once when the gesture is committed; cancellation
 * restores the snapshot captured at begin time and creates no history entry.
 */
export interface PropertyInteractionHost<T> {
  readonly read: () => T;
  readonly preview: (value: T) => void;
  readonly restore: (value: T) => void;
  readonly commit: (change: PropertyInteractionCommit<T>) => void;
}

export interface PropertyInteractionCommit<T> {
  readonly label: string;
  readonly previous: T;
  readonly next: T;
}

/**
 * Owns one pointer/keyboard property gesture. The caller may use the same
 * controller for sliders, wheels, curve handles, or an Enter/blur commit.
 */
export class TransientPropertyInteraction<T> {
  #previous: T | undefined;
  #active = false;

  constructor(private readonly host: PropertyInteractionHost<T>) {}

  get active(): boolean {
    return this.#active;
  }

  begin(): void {
    if (this.#active) {
      throw new Error('A property interaction is already active');
    }

    this.#previous = this.host.read();
    this.#active = true;
  }

  update(value: T): void {
    this.requireActive();
    this.host.preview(value);
  }

  commit(label: string): void {
    this.requireActive();

    const previous = this.#previous as T;
    const next = this.host.read();
    this.clear();

    if (Object.is(previous, next)) return;
    this.host.commit({ label, previous, next });
  }

  cancel(): void {
    this.requireActive();
    const previous = this.#previous as T;
    this.clear();
    this.host.restore(previous);
  }

  private clear(): void {
    this.#previous = undefined;
    this.#active = false;
  }

  private requireActive(): void {
    if (!this.#active) {
      throw new Error('No property interaction is active');
    }
  }
}
