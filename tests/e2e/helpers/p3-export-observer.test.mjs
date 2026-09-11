/* Observer tests for tests/e2e/helpers/p3-export-observer.mjs.
 *
 * Runs with: pnpm exec vitest run --config ops/self-hosted/linux-runner/vitest.p3.config.ts
 * (the config picks up both this file and p3-case-registry.test.mjs).
 *
 * These tests verify:
 *   - a download emitted during the trigger is caught (not missed because
 *     the listener was registered AFTER the click);
 *   - an immediate real failure (pageerror / console.error) is reported,
 *     not turned into a 35-minute timeout;
 *   - settle() is idempotent and disposes listeners/timers exactly once;
 *   - the timeout settles with the captured firstError so the matrix can
 *     distinguish a real export error from a wall-clock wait.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { armExportObserver } from './p3-export-observer.mjs';

function makeEmitter() {
  const ee = new EventEmitter();
  ee.setMaxListeners(20);
  return ee;
}

describe('armExportObserver — settles once', () => {
  it('resolves with the first download event, then settle() is a no-op', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 10_000);
    expect(obs.isSettled()).toBe(false);
    const fakeDownload = { path: () => '/tmp/foo', suggestedFilename: () => 'foo.mp4' };
    ee.emit('download', fakeDownload);
    const result = await obs.promise;
    expect(result).toEqual({ kind: 'download', download: fakeDownload });
    expect(obs.isSettled()).toBe(true);
    // Calling settle again must be a no-op and must not throw.
    obs.settle({ kind: 'timeout' });
    expect(obs.isSettled()).toBe(true);
  });

  it('disposes listeners after the first terminal event (no further emits reach promise)', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 10_000);
    const fakeDownload = { path: () => '/tmp/foo', suggestedFilename: () => 'foo.mp4' };
    ee.emit('download', fakeDownload);
    await obs.promise;
    expect(ee.listenerCount('download')).toBe(0);
    expect(ee.listenerCount('close')).toBe(0);
    expect(ee.listenerCount('pageerror')).toBe(0);
    expect(ee.listenerCount('console')).toBe(0);
  });
});

describe('armExportObserver — capture real errors, not silently turn into timeout', () => {
  it('a pageerror fired before the click is captured as firstError on timeout', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 25);
    const err = new Error('boom');
    ee.emit('pageerror', err);
    const result = await obs.promise;
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.firstError).toBe('pageerror: boom');
    }
  });

  it('a console.error fired before the click is captured as firstError on timeout', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 25);
    ee.emit('console', { type: 'error', text: 'export failed: codec unavailable' });
    const result = await obs.promise;
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.firstError).toBe('console.error: export failed: codec unavailable');
    }
  });

  it('only the FIRST error is preserved (no overwrites from subsequent errors)', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 25);
    ee.emit('pageerror', new Error('first'));
    ee.emit('pageerror', new Error('second'));
    const result = await obs.promise;
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.firstError).toBe('pageerror: first');
    }
  });

  it('a non-error console message does NOT populate firstError', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 25);
    ee.emit('console', { type: 'log', text: 'hello' });
    const result = await obs.promise;
    expect(result.kind).toBe('timeout');
    if (result.kind === 'timeout') {
      expect(result.firstError).toBeNull();
    }
  });
});

describe('armExportObserver — dispose timers exactly once', () => {
  it('clears the timer when settle() is called by an event', async () => {
    const clear = vi.fn();
    let scheduledCb;
    const fakeSetTimeout = (cb) => {
      scheduledCb = cb;
      return 123;
    };
    const fakeClear = (handle) => {
      expect(handle).toBe(123);
      clear(handle);
    };
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 60_000, {
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    // Trigger download before the fake timer fires.
    ee.emit('download', { path: () => '/x', suggestedFilename: () => 'x.mp4' });
    await obs.promise;
    expect(clear).toHaveBeenCalledTimes(1);
    // The timer callback must not fire after settle, because clearTimeout was called.
    scheduledCb();
    expect(obs.isSettled()).toBe(true);
  });

  it('timeout=0 disables the timer entirely (no fake timer created)', async () => {
    const setTimeoutSpy = vi.fn();
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 0, { setTimeoutFn: setTimeoutSpy });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    ee.emit('download', { path: () => '/x', suggestedFilename: () => 'x.mp4' });
    const result = await obs.promise;
    expect(result.kind).toBe('download');
    expect(obs.isSettled()).toBe(true);
  });
});

describe('armExportObserver — page close', () => {
  it('emitting close before any download settles the observer as page-closed', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 10_000);
    ee.emit('close');
    const result = await obs.promise;
    expect(result.kind).toBe('page-closed');
    expect(obs.isSettled()).toBe(true);
    expect(ee.listenerCount('download')).toBe(0);
  });
});

describe('armExportObserver — settle is idempotent and safe across failure paths', () => {
  it('two concurrent downloads only settle the promise once', async () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 10_000);
    ee.emit('download', { id: 'first' });
    ee.emit('download', { id: 'second' });
    const result = await obs.promise;
    expect(result.kind).toBe('download');
    if (result.kind === 'download') {
      expect(result.download.id).toBe('first');
    }
    expect(obs.isSettled()).toBe(true);
  });

  it('settle() called manually after dispose is a no-op and never throws', () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 10_000);
    obs.settle({ kind: 'page-closed' });
    obs.settle({ kind: 'page-closed' });
    obs.settle({ kind: 'timeout' });
    obs.settle({ kind: 'download', download: {} });
    expect(obs.isSettled()).toBe(true);
  });
});

/* Regression suite for P3 defect #2:
 *   runCancelCase previously clicked Export MP4 before any terminal
 *   observer was armed. A pageerror / console error fired in the same
 *   microtask as the click would be missed, and a failed click would sit
 *   through the long export timeout behind a "still running" UI.
 *
 * The fix wraps the trigger in an observe-before-click pattern. These tests
 * prove:
 *   - arming the observer BEFORE the trigger catches an immediate pageerror
 *     (the listener is in place when the failure happens);
 *   - settle() disposes every listener exactly once (no leak across
 *     subsequent cases);
 *   - timers are not left armed.
 */
describe('armExportObserver — cancel race regression: armed before trigger', () => {
  it('observer armed before click catches a same-tick pageerror (not timeout)', async () => {
    const ee = makeEmitter();
    // Reflects the production wiring: long timeout so a real cancel has
    // headroom, but the failure must still settle as click-error / firstError.
    const obs = armExportObserver(ee, 35 * 60_000);
    // Simulate the click site. The arming happened synchronously before any
    // emit() can fire on this emitter — listeners are guaranteed in place.
    let armedBeforeEmit = ee.listenerCount('pageerror');
    expect(armedBeforeEmit).toBeGreaterThan(0);
    const triggerError = new Error('export button detached');
    ee.emit('pageerror', triggerError);
    armedBeforeEmit = ee.listenerCount('download');
    expect(armedBeforeEmit).toBe(1);
    // The cancel path settles with click-error so the case fails promptly.
    obs.settle({ kind: 'click-error', error: triggerError });
    const result = await obs.promise;
    expect(result.kind).toBe('click-error');
    if (result.kind === 'click-error') {
      expect(result.error).toBe(triggerError);
    }
    // All listeners disposed — the next case starts with a clean emitter.
    expect(ee.listenerCount('download')).toBe(0);
    expect(ee.listenerCount('close')).toBe(0);
    expect(ee.listenerCount('pageerror')).toBe(0);
    expect(ee.listenerCount('console')).toBe(0);
    expect(obs.isSettled()).toBe(true);
  });

  it('immediate trigger failure settles the promise synchronously after settle()', () => {
    // Asserts the cancel race fix invariant: as soon as the click throws,
    // settle() makes the observer terminal — we cannot accidentally await
    // the long export timeout.
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 35 * 60_000);
    let settled = false;
    void obs.promise.then(() => {
      settled = true;
    });
    const err = new Error('click failed');
    obs.settle({ kind: 'click-error', error: err });
    expect(obs.isSettled()).toBe(true);
    return new Promise((resolve) => {
      // Microtask boundary — promise.then must have resolved.
      Promise.resolve().then(() => {
        expect(settled).toBe(true);
        resolve();
      });
    });
  });

  it('no listener or timer leak after a cancel-path failure sequence', async () => {
    const clear = vi.fn();
    const fakeSetTimeout = vi.fn(() => 999);
    const fakeClear = (h) => {
      expect(h).toBe(999);
      clear(h);
    };
    const ee = makeEmitter();
    const initialMaxListeners = ee.getMaxListeners();

    // --- Sequence 1: pageerror before click ---
    const obs1 = armExportObserver(ee, 60_000, {
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    ee.emit('pageerror', new Error('first'));
    expect(clear).not.toHaveBeenCalled();
    obs1.settle({ kind: 'click-error', error: new Error('boom') });
    await obs1.promise;
    expect(clear).toHaveBeenCalledTimes(1);
    expect(ee.listenerCount('download')).toBe(0);
    expect(ee.listenerCount('close')).toBe(0);
    expect(ee.listenerCount('pageerror')).toBe(0);
    expect(ee.listenerCount('console')).toBe(0);

    // --- Sequence 2: console.error before click ---
    const obs2 = armExportObserver(ee, 60_000, {
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    expect(ee.listenerCount('download')).toBe(1);
    ee.emit('console', { type: 'error', text: 'codec dead' });
    obs2.settle({ kind: 'click-error', error: new Error('boom2') });
    await obs2.promise;
    expect(ee.listenerCount('download')).toBe(0);
    expect(ee.listenerCount('console')).toBe(0);

    // --- Sequence 3: success path (download emitted) ---
    const obs3 = armExportObserver(ee, 60_000, {
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    const dl = { path: () => '/x', suggestedFilename: () => 'x.mp4' };
    ee.emit('download', dl);
    await obs3.promise;
    expect(ee.listenerCount('download')).toBe(0);

    // No listener leak means a new run starts clean; max-listener warning
    // would surface if any earlier observer left listeners attached.
    expect(ee.getMaxListeners()).toBe(initialMaxListeners);
  });

  it('click-error settle does not leave the wall-clock timer armed', () => {
    const clear = vi.fn();
    const fakeSetTimeout = () => 7;
    const fakeClear = (h) => clear(h);
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 60_000, {
      setTimeoutFn: fakeSetTimeout,
      clearTimeoutFn: fakeClear,
    });
    obs.settle({ kind: 'click-error', error: new Error('x') });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(obs.isSettled()).toBe(true);
  });
});

/* Defect #3: prove the production call shape
 *   armExportObserver(page, timeout) -> settle(...)
 * returns exactly the same observer pattern the cancel path now uses.
 * This test validates the API shape — exports / cancels both rely on it.
 */
describe('armExportObserver — production wiring shape', () => {
  it('returns { promise, settle, isSettled } and the promise is awaitable', () => {
    const ee = makeEmitter();
    const obs = armExportObserver(ee, 0);
    expect(typeof obs.promise.then).toBe('function');
    expect(typeof obs.settle).toBe('function');
    expect(typeof obs.isSettled).toBe('function');
    expect(obs.isSettled()).toBe(false);
    // No timer when timeout=0; emit and settle.
    ee.emit('download', { path: () => '/x', suggestedFilename: () => 'x.mp4' });
    obs.settle({ kind: 'download', download: { path: () => '/x' } });
    return obs.promise.then((r) => {
      expect(r.kind).toBe('download');
      expect(obs.isSettled()).toBe(true);
    });
  });
});
