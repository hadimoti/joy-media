import { describe, expect, it, vi } from 'vitest';
import {
  TransientPropertyInteraction,
  type PropertyInteractionCommit,
} from './property-interaction.js';

function createHarness(initial = 10) {
  let value = initial;
  const preview = vi.fn((next: number) => {
    value = next;
  });
  const restore = vi.fn((next: number) => {
    value = next;
  });
  const commit = vi.fn<(change: PropertyInteractionCommit<number>) => void>();

  return {
    preview,
    restore,
    commit,
    get value() {
      return value;
    },
    controller: new TransientPropertyInteraction({
      read: () => value,
      preview,
      restore,
      commit,
    }),
  };
}

describe('TransientPropertyInteraction', () => {
  it('previews each pointer update but creates one durable commit on release', () => {
    const harness = createHarness();

    harness.controller.begin();
    harness.controller.update(11);
    harness.controller.update(12);
    harness.controller.update(13);

    expect(harness.preview).toHaveBeenCalledTimes(3);
    expect(harness.commit).not.toHaveBeenCalled();

    harness.controller.commit('Adjust exposure');

    expect(harness.controller.active).toBe(false);
    expect(harness.commit).toHaveBeenCalledTimes(1);
    expect(harness.commit).toHaveBeenCalledWith({
      label: 'Adjust exposure',
      previous: 10,
      next: 13,
    });
  });

  it('restores the pre-gesture value and creates no durable command on Escape', () => {
    const harness = createHarness();

    harness.controller.begin();
    harness.controller.update(24);
    harness.controller.cancel();

    expect(harness.controller.active).toBe(false);
    expect(harness.value).toBe(10);
    expect(harness.restore).toHaveBeenCalledOnce();
    expect(harness.restore).toHaveBeenCalledWith(10);
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it('does not create a no-op history entry', () => {
    const harness = createHarness();

    harness.controller.begin();
    harness.controller.update(10);
    harness.controller.commit('No-op');

    expect(harness.commit).not.toHaveBeenCalled();
  });

  it('requires explicit begin and prevents overlapping gestures', () => {
    const harness = createHarness();

    expect(() => harness.controller.update(12)).toThrow('No property interaction is active');
    expect(() => harness.controller.commit('Invalid')).toThrow('No property interaction is active');

    harness.controller.begin();
    expect(() => harness.controller.begin()).toThrow('A property interaction is already active');
    harness.controller.cancel();
  });
});
