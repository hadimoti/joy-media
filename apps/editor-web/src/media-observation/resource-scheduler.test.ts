import { describe, expect, it } from 'vitest';
import { ObservationResourceScheduler } from './resource-scheduler.js';

describe('ObservationResourceScheduler', () => {
  it('enforces byte and in-flight budgets with explicit backpressure', () => {
    const scheduler = new ObservationResourceScheduler({ maxWorkingSetBytes: 100, maxInFlight: 2 });
    expect(
      scheduler.tryAcquire({ id: 'frame-a', bytes: 60, epoch: 1, priority: 'background' }),
    ).toMatchObject({
      state: 'acquired',
    });
    expect(
      scheduler.tryAcquire({ id: 'frame-b', bytes: 60, epoch: 1, priority: 'background' }),
    ).toEqual({
      state: 'backpressure',
      reason: 'working-set-budget',
    });
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, workingSetBytes: 60 });
  });

  it('releases exactly once on cancellation and stale epoch cleanup', () => {
    const scheduler = new ObservationResourceScheduler({ maxWorkingSetBytes: 100, maxInFlight: 2 });
    const lease = scheduler.tryAcquire({
      id: 'frame-a',
      bytes: 40,
      epoch: 1,
      priority: 'background',
    });
    expect(lease.state).toBe('acquired');
    if (lease.state !== 'acquired') return;
    expect(lease.release()).toBe(true);
    expect(lease.release()).toBe(false);
    scheduler.tryAcquire({ id: 'frame-b', bytes: 40, epoch: 1, priority: 'background' });
    scheduler.tryAcquire({ id: 'frame-c', bytes: 40, epoch: 2, priority: 'background' });
    expect(scheduler.cancelEpoch(1)).toEqual(['frame-b']);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, workingSetBytes: 40 });
  });

  it('does not let a stale lease release a later lease with the same resource ID', () => {
    const scheduler = new ObservationResourceScheduler({ maxWorkingSetBytes: 100, maxInFlight: 2 });
    const stale = scheduler.tryAcquire({
      id: 'frame-a',
      bytes: 80,
      epoch: 1,
      priority: 'background',
    });
    expect(stale.state).toBe('acquired');
    if (stale.state !== 'acquired') return;

    expect(scheduler.cancelEpoch(1)).toEqual(['frame-a']);
    const current = scheduler.tryAcquire({
      id: 'frame-a',
      bytes: 80,
      epoch: 2,
      priority: 'background',
    });
    expect(current.state).toBe('acquired');
    expect(stale.release()).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({ activeCount: 1, workingSetBytes: 80 });
    expect(
      scheduler.tryAcquire({ id: 'frame-b', bytes: 80, epoch: 2, priority: 'background' }),
    ).toEqual({ state: 'backpressure', reason: 'working-set-budget' });
  });

  it('pauses background observation while playback owns a lease without preempting user playback', () => {
    const scheduler = new ObservationResourceScheduler({ maxWorkingSetBytes: 100, maxInFlight: 3 });
    const playback = scheduler.tryAcquire({
      id: 'preview',
      bytes: 20,
      epoch: 1,
      priority: 'playback',
    });
    expect(playback.state).toBe('acquired');
    expect(
      scheduler.tryAcquire({ id: 'background', bytes: 20, epoch: 1, priority: 'background' }),
    ).toEqual({
      state: 'backpressure',
      reason: 'playback-priority',
    });
  });
});
